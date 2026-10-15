import type { Request } from 'express';
import { pool, query } from '../models/database';

export interface WhitelabelRecord {
    id: number;
    name: string;
    domain: string;
    status: 'active' | 'disabled';
    is_default: boolean;
    owner_user_id: number | null;
    created_at?: Date | string;
    updated_at?: Date | string;
}

export class WhitelabelResolutionError extends Error {
    status: number;

    constructor(message: string, status = 400) {
        super(message);
        this.name = 'WhitelabelResolutionError';
        this.status = status;
    }
}

const normalizeCase = (value: string): string => value.trim().toLowerCase();

export function normalizeDomain(input: unknown): string {
    let raw = String(input ?? '').trim();
    if (!raw) {
        throw new WhitelabelResolutionError('白标域名不能为空');
    }

    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
        raw = `http://${raw}`;
    }

    try {
        const url = new URL(raw);
        const host = normalizeCase(url.hostname);
        if (!host || host === 'localhost' || host === '127.0.0.1' || host === '[::1]') {
            throw new WhitelabelResolutionError('本地主机名不能作为白标域名');
        }
        if (!/^[a-z0-9.-]+$/i.test(host) || !host.includes('.')) {
            throw new WhitelabelResolutionError(`无效白标域名: ${host}`);
        }
        return host;
    } catch (error) {
        if (error instanceof WhitelabelResolutionError) {
            throw error;
        }
        throw new WhitelabelResolutionError(`无效白标域名: ${String(input)}`);
    }
}

const rowToWhitelabel = (row: any): WhitelabelRecord => ({
    id: Number(row.id),
    name: String(row.name),
    domain: String(row.domain),
    status: row.status === 'disabled' ? 'disabled' : 'active',
    is_default: Boolean(row.is_default),
    owner_user_id: row.owner_user_id === null || row.owner_user_id === undefined ? null : Number(row.owner_user_id),
    created_at: row.created_at,
    updated_at: row.updated_at,
});

function extractRequestDomain(req: Request): string | null {
    const explicit = req.headers['x-whitelabel-domain'];
    if (typeof explicit === 'string' && explicit.trim()) {
        return explicit;
    }
    if (Array.isArray(explicit) && explicit.length > 0) {
        return explicit[0];
    }

    const queryDomain = req.query?.whitelabelDomain;
    if (typeof queryDomain === 'string' && queryDomain.trim()) {
        return queryDomain;
    }

    const origin = req.headers.origin;
    if (typeof origin === 'string' && origin.trim()) {
        try {
            const parsed = new URL(origin);
            return normalizeCase(parsed.hostname);
        } catch {
            return origin;
        }
    }

    const host = req.headers.host;
    if (typeof host === 'string' && host.trim()) {
        return host.split(':')[0];
    }

    return null;
}

const isLocalRequestHost = (input: unknown): boolean => {
    let raw = String(input ?? '').trim().toLowerCase();
    if (!raw) return false;
    if (!/^[a-z][a-z0-9+.-]*:\/\//.test(raw)) {
        raw = `http://${raw}`;
    }
    try {
        const host = normalizeCase(new URL(raw).hostname).replace(/^\[|\]$/g, '');
        return host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '::1';
    } catch {
        return false;
    }
};

async function getDefaultWhitelabel(): Promise<WhitelabelRecord> {
    const result = await query(
        `SELECT * FROM whitelabels
         WHERE is_default = TRUE AND status = 'active'
         ORDER BY id LIMIT 1`
    );
    if (result.rows.length === 0) {
        throw new WhitelabelResolutionError('系统缺少默认白标配置', 500);
    }
    return rowToWhitelabel(result.rows[0]);
}

export async function resolveWhitelabelForRequest(req: Request): Promise<WhitelabelRecord> {
    const rawDomain = extractRequestDomain(req);
    // Local development clients (127.0.0.1/localhost) have no public OEM host.
    // They must resolve to the default tenant rather than being treated as an invalid domain.
    if (!rawDomain || isLocalRequestHost(rawDomain)) {
        return getDefaultWhitelabel();
    }

    const domain = normalizeDomain(rawDomain);
    const result = await query(
        `SELECT * FROM whitelabels
         WHERE domain = $1 AND status = 'active'
         LIMIT 1`,
        [domain]
    );
    if (result.rows.length === 0) {
        throw new WhitelabelResolutionError(`白标站点不存在或已停用: ${domain}`, 404);
    }
    return rowToWhitelabel(result.rows[0]);
}

export async function getUserWhitelabelContext(userId: number): Promise<WhitelabelRecord> {
    const result = await query(
        `SELECT w.*
         FROM users u
         JOIN whitelabels w ON u.whitelabel_id = w.id
         WHERE u.id = $1
         LIMIT 1`,
        [userId]
    );
    if (result.rows.length === 0) {
        throw new WhitelabelResolutionError('当前用户缺少白标归属，请联系管理员', 403);
    }
    return rowToWhitelabel(result.rows[0]);
}

export async function assertUserBelongsToWhitelabel(
    userId: number,
    whitelabelId: number
): Promise<void> {
    const userWhitelabel = await getUserWhitelabelContext(userId);
    if (userWhitelabel.id !== whitelabelId) {
        throw new WhitelabelResolutionError('当前账号不属于该白标站点', 403);
    }
}

export async function listWhitelabels(): Promise<Array<WhitelabelRecord & {
    mapping_mode: 'identity' | 'inverse';
    mapping_enabled: boolean;
    mapping_version: number;
    user_count: number;
}>> {
    const result = await query(
        `SELECT w.*,
                COALESCE(s.mapping_mode, 'identity') AS mapping_mode,
                COALESCE(s.enabled, FALSE) AS mapping_enabled,
                COALESCE(s.version, 1) AS mapping_version,
                (SELECT COUNT(*) FROM users u WHERE u.whitelabel_id = w.id) AS user_count
         FROM whitelabels w
         LEFT JOIN selection_mapping_settings s ON s.whitelabel_id = w.id
         ORDER BY w.is_default DESC, w.id`
    );
    return result.rows.map((row: any) => ({
        ...rowToWhitelabel(row),
        mapping_mode: row.mapping_mode === 'inverse' ? 'inverse' : 'identity',
        mapping_enabled: Boolean(row.mapping_enabled),
        mapping_version: Number(row.mapping_version),
        user_count: Number(row.user_count),
    }));
}

export async function createWhitelabel(input: {
    name: string;
    domain: string;
    owner_user_id?: number | string | null;
}): Promise<WhitelabelRecord> {
    const name = String(input.name ?? '').trim();
    if (!name) {
        throw new WhitelabelResolutionError('白标名称不能为空');
    }
    const domain = normalizeDomain(input.domain);

    let ownerUserId: number | null = null;
    if (input.owner_user_id !== undefined && input.owner_user_id !== null && input.owner_user_id !== '') {
        ownerUserId = Number(input.owner_user_id);
        if (!Number.isInteger(ownerUserId) || ownerUserId <= 0) {
            throw new WhitelabelResolutionError('owner_user_id 无效');
        }
        const owner = await query('SELECT id FROM users WHERE id = $1', [ownerUserId]);
        if (owner.rows.length === 0) {
            throw new WhitelabelResolutionError('owner_user_id 不存在', 404);
        }
    }

    const duplicate = await query(
        'SELECT id, name, domain FROM whitelabels WHERE name = $1 OR domain = $2',
        [name, domain]
    );
    if (duplicate.rows.length > 0) {
        throw new WhitelabelResolutionError('白标名称或域名已存在', 409);
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const inserted = await client.query(
            `INSERT INTO whitelabels (name, domain, status, is_default, owner_user_id)
             VALUES ($1, $2, 'active', FALSE, $3)
             RETURNING *`,
            [name, domain, ownerUserId]
        );
        await client.query(
            `INSERT INTO selection_mapping_settings (whitelabel_id, mapping_mode, enabled, version)
             VALUES ($1, 'identity', FALSE, 1)`,
            [inserted.rows[0].id]
        );
        await client.query('COMMIT');
        return rowToWhitelabel(inserted.rows[0]);
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

export async function updateWhitelabel(
    id: number,
    input: { name?: string; domain?: string; status?: 'active' | 'disabled'; owner_user_id?: number | string | null }
): Promise<WhitelabelRecord> {
    if (!Number.isInteger(id) || id <= 0) {
        throw new WhitelabelResolutionError('白标 ID 无效');
    }

    const updates: string[] = [];
    const params: any[] = [];
    const add = (sql: string, value: any) => {
        params.push(value);
        updates.push(sql.replace('?', `$${params.length}`));
    };

    if (input.name !== undefined) {
        const name = String(input.name).trim();
        if (!name) throw new WhitelabelResolutionError('白标名称不能为空');
        add('name = ?', name);
    }
    if (input.domain !== undefined) {
        add('domain = ?', normalizeDomain(input.domain));
    }
    if (input.status !== undefined) {
        if (!['active', 'disabled'].includes(input.status)) {
            throw new WhitelabelResolutionError('白标状态无效');
        }
        add('status = ?', input.status);
    }
    if (input.owner_user_id !== undefined) {
        const value = input.owner_user_id;
        if (value === null || value === '') {
            add('owner_user_id = ?', null);
        } else {
            const ownerId = Number(value);
            if (!Number.isInteger(ownerId) || ownerId <= 0) {
                throw new WhitelabelResolutionError('owner_user_id 无效');
            }
            const owner = await query('SELECT id FROM users WHERE id = $1', [ownerId]);
            if (owner.rows.length === 0) {
                throw new WhitelabelResolutionError('owner_user_id 不存在', 404);
            }
            add('owner_user_id = ?', ownerId);
        }
    }

    if (updates.length === 0) {
        throw new WhitelabelResolutionError('没有需要更新的白标字段');
    }

    updates.push(`updated_at = CURRENT_TIMESTAMP`);
    params.push(id);
    const result = await query(
        `UPDATE whitelabels SET ${updates.join(', ')} WHERE id = $${params.length} RETURNING *`,
        params
    );
    if (result.rows.length === 0) {
        throw new WhitelabelResolutionError('白标不存在', 404);
    }
    return rowToWhitelabel(result.rows[0]);
}

export async function listWhitelabelUsers(id: number): Promise<Array<{
    id: number;
    username: string;
    email: string | null;
    role: string;
    created_at: string;
}>> {
    if (!Number.isInteger(id) || id <= 0) {
        throw new WhitelabelResolutionError('白标 ID 无效');
    }
    const result = await query(
        `SELECT id, username, email, role, created_at
         FROM users
         WHERE whitelabel_id = $1
         ORDER BY id`,
        [id]
    );
    return result.rows.map((row: any) => ({
        id: Number(row.id),
        username: String(row.username),
        email: row.email,
        role: String(row.role),
        created_at: row.created_at,
    }));
}

export async function assignUsersToWhitelabel(
    id: number,
    userIds: Array<number>
): Promise<number> {
    if (!Number.isInteger(id) || id <= 0) {
        throw new WhitelabelResolutionError('白标 ID 无效');
    }
    const normalized = Array.from(new Set(
        userIds.map(Number).filter((value) => Number.isInteger(value) && value > 0)
    ));
    if (normalized.length === 0) {
        throw new WhitelabelResolutionError('user_ids 不能为空');
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const whitelabel = await client.query(
            `SELECT id, status, is_default FROM whitelabels WHERE id = $1 FOR UPDATE`,
            [id]
        );
        if (whitelabel.rows.length === 0) {
            throw new WhitelabelResolutionError('白标不存在', 404);
        }
        if (whitelabel.rows[0].status !== 'active') {
            throw new WhitelabelResolutionError('不能把用户归属到已停用白标');
        }

        const existing = await client.query(
            `SELECT id FROM users WHERE id = ANY($1::integer[])`,
            [normalized]
        );
        const found = new Set(existing.rows.map((row: any) => Number(row.id)));
        const missing = normalized.filter((userId) => !found.has(userId));
        if (missing.length > 0) {
            throw new WhitelabelResolutionError(`以下用户不存在: ${missing.join(', ')}`, 404);
        }

        const updated = await client.query(
            `UPDATE users
             SET whitelabel_id = $1,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ANY($2::integer[])
             RETURNING id`,
            [id, normalized]
        );
        await client.query('COMMIT');
        return updated.rowCount ?? updated.rows.length;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}
