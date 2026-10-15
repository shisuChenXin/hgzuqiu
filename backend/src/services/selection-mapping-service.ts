import { pool, query } from '../models/database';

export type SelectionMappingMode = 'identity' | 'inverse';
export type MarketSide = 'home' | 'away' | 'draw' | 'over' | 'under';
export type MarketChoseTeam = 'H' | 'C' | 'N';

export interface SelectionMappingSettings {
    id: number;
    whitelabel_id: number;
    mapping_mode: SelectionMappingMode;
    enabled: boolean;
    version: number;
    updated_by: number | null;
    created_at?: Date | string;
    updated_at?: Date | string;
}

export interface ResolvedSelectionMapping {
    whitelabelId: number;
    mappingMode: SelectionMappingMode;
    mappingEnabled: boolean;
    mappingVersion: number;
    displayedMarketSide: MarketSide | null;
    executedMarketSide: MarketSide | null;
    displayedMarketRtype: string | null;
    executedMarketRtype: string | null;
    displayedMarketChoseTeam: MarketChoseTeam | null;
    executedMarketChoseTeam: MarketChoseTeam | null;
    mappingApplied: boolean;
}

export interface SelectionMappingAuditLog {
    id: number;
    whitelabel_id: number;
    from_mode: SelectionMappingMode;
    to_mode: SelectionMappingMode;
    from_enabled: boolean;
    to_enabled: boolean;
    from_version: number;
    to_version: number;
    operator_user_id: number | null;
    reason: string | null;
    created_at: string;
}

export class SelectionMappingError extends Error {
    status: number;

    constructor(message: string, status = 400) {
        super(message);
        this.name = 'SelectionMappingError';
        this.status = status;
    }
}

const ALLOWED_SIDES: ReadonlySet<string> = new Set(['home', 'away', 'draw', 'over', 'under']);
const INVERSE_SIDE: Record<Exclude<MarketSide, 'draw'>, Exclude<MarketSide, 'draw'>> = {
    home: 'away',
    away: 'home',
    over: 'under',
    under: 'over',
};

const normalizeSide = (value: unknown): MarketSide | null => {
    if (value === undefined || value === null || value === '') return null;
    const normalized = String(value).trim().toLowerCase();
    if (!ALLOWED_SIDES.has(normalized)) {
        throw new SelectionMappingError(`无效 market_side: ${String(value)}`);
    }
    return normalized as MarketSide;
};

const normalizeChoseTeam = (value: unknown): MarketChoseTeam | null => {
    if (value === undefined || value === null || value === '') return null;
    const normalized = String(value).trim().toUpperCase();
    if (!['H', 'C', 'N'].includes(normalized)) {
        throw new SelectionMappingError(`无效 market_chose_team: ${String(value)}`);
    }
    return normalized as MarketChoseTeam;
};

const inverseChoseTeam = (value: MarketChoseTeam): MarketChoseTeam => {
    if (value === 'H') return 'C';
    if (value === 'C') return 'H';
    return 'N';
};

const inverseTerminalApiSide = (value: string): string => {
    const upper = value.trim().toUpperCase();
    if (!upper) return upper;
    const last = upper.charAt(upper.length - 1);
    if (last === 'H') return `${upper.slice(0, -1)}C`;
    if (last === 'C') return `${upper.slice(0, -1)}H`;
    if (last === 'N') return upper;
    throw new SelectionMappingError(`无法安全映射 market_rtype: ${value}`);
};

function validateCategorySide(category: string | null, side: MarketSide): void {
    if (category === 'moneyline') return;
    if (category === 'handicap' && (side === 'home' || side === 'away')) return;
    if (category === 'overunder' && (side === 'over' || side === 'under')) return;
    throw new SelectionMappingError(
        `market_category=${category || '(空)'} 与 market_side=${side} 不匹配，拒绝执行反向映射`
    );
}

export function calculateSelectionMapping(input: {
    whitelabelId: number;
    settings: {
        mapping_mode: SelectionMappingMode | string;
        enabled: boolean;
        version: number;
    };
    market_category?: string | null;
    market_side?: string | null;
    market_rtype?: string | null;
    market_chose_team?: string | null;
}): ResolvedSelectionMapping {
    const mode: SelectionMappingMode = input.settings.mapping_mode === 'inverse' ? 'inverse' : 'identity';
    const enabled = input.settings.enabled === true;
    const displayedSide = normalizeSide(input.market_side);
    const displayedRtypeRaw = input.market_rtype === undefined || input.market_rtype === null || input.market_rtype === ''
        ? null
        : String(input.market_rtype);
    const displayedRtype = displayedRtypeRaw === null ? null : displayedRtypeRaw.trim().toUpperCase() || null;
    const displayedChoseTeam = normalizeChoseTeam(input.market_chose_team);

    let executedSide = displayedSide;
    let executedRtype = displayedRtype;
    let executedChoseTeam = displayedChoseTeam;
    let mappingApplied = false;

    if (mode === 'inverse' && enabled) {
        if (!displayedSide) {
            throw new SelectionMappingError('反向映射启用时 market_side 不能为空');
        }
        const category = (input.market_category ?? '').toString().trim().toLowerCase() || null;
        validateCategorySide(category, displayedSide);

        executedSide = displayedSide === 'draw' ? 'draw' : INVERSE_SIDE[displayedSide];
        mappingApplied = displayedSide !== executedSide;

        if (displayedRtype) {
            executedRtype = inverseTerminalApiSide(displayedRtype);
        }
        if (displayedChoseTeam) {
            executedChoseTeam = inverseChoseTeam(displayedChoseTeam);
        }
    }

    return {
        whitelabelId: Number(input.whitelabelId),
        mappingMode: mode,
        mappingEnabled: enabled,
        mappingVersion: Number(input.settings.version),
        displayedMarketSide: displayedSide,
        executedMarketSide: executedSide,
        displayedMarketRtype: displayedRtype,
        executedMarketRtype: executedRtype,
        displayedMarketChoseTeam: displayedChoseTeam,
        executedMarketChoseTeam: executedChoseTeam,
        mappingApplied,
    };
}

export function buildAutomationMarketFields(mapping: ResolvedSelectionMapping): {
    market_side: MarketSide | null;
    marketSide: MarketSide | null;
    market_rtype: string | null;
    marketRtype: string | null;
    market_chose_team: MarketChoseTeam | null;
    marketChoseTeam: MarketChoseTeam | null;
} {
    return {
        market_side: mapping.executedMarketSide,
        marketSide: mapping.executedMarketSide,
        market_rtype: mapping.executedMarketRtype,
        marketRtype: mapping.executedMarketRtype,
        market_chose_team: mapping.executedMarketChoseTeam,
        marketChoseTeam: mapping.executedMarketChoseTeam,
    };
}

const rowToSettings = (row: any): SelectionMappingSettings => ({
    id: Number(row.id),
    whitelabel_id: Number(row.whitelabel_id),
    mapping_mode: row.mapping_mode === 'inverse' ? 'inverse' : 'identity',
    enabled: Boolean(row.enabled),
    version: Number(row.version),
    updated_by: row.updated_by === null || row.updated_by === undefined ? null : Number(row.updated_by),
    created_at: row.created_at,
    updated_at: row.updated_at,
});

export async function getMappingSettings(whitelabelId: number): Promise<SelectionMappingSettings> {
    const result = await query(
        `SELECT * FROM selection_mapping_settings
         WHERE whitelabel_id = $1
         LIMIT 1`,
        [whitelabelId]
    );
    if (result.rows.length === 0) {
        throw new SelectionMappingError('白标缺少映射配置', 404);
    }
    return rowToSettings(result.rows[0]);
}

export async function updateMappingSettings(input: {
    whitelabelId: number;
    operatorUserId: number;
    mode: SelectionMappingMode | string;
    enabled: unknown;
    reason?: string | null;
}): Promise<{ settings: SelectionMappingSettings; changed: boolean }> {
    const whitelabelId = Number(input.whitelabelId);
    if (!Number.isInteger(whitelabelId) || whitelabelId <= 0) {
        throw new SelectionMappingError('白标 ID 无效');
    }
    const mode = String(input.mode ?? '').trim().toLowerCase();
    if (mode !== 'identity' && mode !== 'inverse') {
        throw new SelectionMappingError('mapping_mode 只支持 identity 或 inverse');
    }
    if (typeof input.enabled !== 'boolean') {
        throw new SelectionMappingError('enabled 必须是布尔值');
    }
    const reason = input.reason === undefined || input.reason === null ? null : String(input.reason).trim() || null;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const currentResult = await client.query(
            `SELECT s.*
             FROM selection_mapping_settings s
             JOIN whitelabels w ON w.id = s.whitelabel_id
             WHERE s.whitelabel_id = $1 AND w.status = 'active'
             FOR UPDATE OF s`,
            [whitelabelId]
        );
        if (currentResult.rows.length === 0) {
            throw new SelectionMappingError('白标不存在、已停用或缺少映射配置', 404);
        }

        const current = rowToSettings(currentResult.rows[0]);
        const changed = current.mapping_mode !== mode || current.enabled !== input.enabled;
        if (!changed) {
            await client.query('COMMIT');
            return { settings: current, changed: false };
        }

        const nextVersion = current.version + 1;
        const updated = await client.query(
            `UPDATE selection_mapping_settings
             SET mapping_mode = $2,
                 enabled = $3,
                 version = $4,
                 updated_by = $5,
                 updated_at = CURRENT_TIMESTAMP
             WHERE whitelabel_id = $1
             RETURNING *`,
            [whitelabelId, mode, input.enabled, nextVersion, input.operatorUserId]
        );
        await client.query(
            `INSERT INTO selection_mapping_audit_logs (
                 whitelabel_id, from_mode, to_mode, from_enabled, to_enabled,
                 from_version, to_version, operator_user_id, reason
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
                whitelabelId,
                current.mapping_mode,
                mode,
                current.enabled,
                input.enabled,
                current.version,
                nextVersion,
                input.operatorUserId,
                reason,
            ]
        );
        await client.query('COMMIT');
        return { settings: rowToSettings(updated.rows[0]), changed: true };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

export async function listMappingAuditLogs(
    whitelabelId: number,
    limit = 100
): Promise<SelectionMappingAuditLog[]> {
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const result = await query(
        `SELECT a.*, u.username AS operator_username
         FROM selection_mapping_audit_logs a
         LEFT JOIN users u ON u.id = a.operator_user_id
         WHERE a.whitelabel_id = $1
         ORDER BY a.created_at DESC, a.id DESC
         LIMIT $2`,
        [whitelabelId, safeLimit]
    );
    return result.rows.map((row: any) => ({
        id: Number(row.id),
        whitelabel_id: Number(row.whitelabel_id),
        from_mode: row.from_mode === 'inverse' ? 'inverse' : 'identity',
        to_mode: row.to_mode === 'inverse' ? 'inverse' : 'identity',
        from_enabled: Boolean(row.from_enabled),
        to_enabled: Boolean(row.to_enabled),
        from_version: Number(row.from_version),
        to_version: Number(row.to_version),
        operator_user_id: row.operator_user_id === null || row.operator_user_id === undefined
            ? null
            : Number(row.operator_user_id),
        operator_username: row.operator_username,
        reason: row.reason,
        created_at: row.created_at,
    }));
}
