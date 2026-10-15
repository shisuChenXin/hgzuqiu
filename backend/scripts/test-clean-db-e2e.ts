/// <reference lib="dom" />
import { ChildProcess, spawn } from 'child_process';
import { once } from 'events';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { Client } from 'pg';
import bcrypt from 'bcrypt';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const repoRoot = path.resolve(__dirname, '../..');
const runId = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')}-${process.pid}`;
const evidenceDir = path.join(repoRoot, '证据', 'clean-db-e2e', runId);
const evidenceFile = path.join(evidenceDir, 'result.json');
const backendPort = Number(process.env.CLEAN_E2E_PORT || 3101);
const backendHost = '127.0.0.1';
const backendUrl = `http://${backendHost}:${backendPort}`;
const dbHost = process.env.DB_HOST || '127.0.0.1';
const dbPort = Number(process.env.DB_PORT || 5432);
const dbUser = process.env.DB_USER || 'lt';
const dbPassword = process.env.DB_PASSWORD || '';
const guardDbName = process.env.DB_NAME || 'bclogin_system';
const adminUsername = 'clean-admin';
const adminPassword = 'CleanE2E!123456';
const tenantDomain = 'clean-oem.test';
const disabledTenantDomain = 'clean-disabled.test';
const nonAdminPassword = 'CleanNonAdmin!123456';
const runStamp = Date.now();
const cleanDbName = `hgzuqiu_clean_e2e_${runStamp}`;
const jwtSecret = `clean-e2e-jwt-${runStamp}`;

if (!/^[a-z0-9_]+$/.test(cleanDbName)) {
    throw new Error(`Generated database name is unsafe: ${cleanDbName}`);
}
if (!Number.isInteger(backendPort) || backendPort <= 0 || backendPort > 65535) {
    throw new Error(`Invalid CLEAN_E2E_PORT: ${backendPort}`);
}
if (!dbPassword) {
    throw new Error('DB_PASSWORD is required by backend/.env for local PostgreSQL tests');
}

type Evidence = Record<string, unknown>;
type UpstreamMode = 'success' | 'business_failure' | 'network_failure';
type UpstreamHit = {
    method: string;
    url: string;
    at: string;
    params: Record<string, string>;
    response: string;
};
const evidence: Evidence = {
    run_id: runId,
    started_at: new Date().toISOString(),
    scope: 'isolated local PostgreSQL database + loopback backend',
    config: {
        backend_host: backendHost,
        backend_port: backendPort,
        clean_database: cleanDbName,
        guarded_database: guardDbName,
        crown_base_url: 'local blocking mock, selected after startup',
        dry_run_only: false,
        upstream_mock: 'controlled loopback XML/JSON mock',
    },
};
const failures: string[] = [];
let passed = 0;

function assertTrue(actual: boolean, label: string): void {
    if (actual !== true) {
        failures.push(`${label}: actual=${JSON.stringify(actual)}`);
        throw new Error(`${label}: expected true, got ${JSON.stringify(actual)}`);
    }
    passed += 1;
}
function assertEqual<T>(actual: T, expected: T, label: string): void {
    if (actual !== expected) {
        failures.push(`${label}: expected=${JSON.stringify(expected)}, actual=${JSON.stringify(actual)}`);
        throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
    passed += 1;
}
function num(value: unknown): number {
    const parsed = Number(value ?? 0);
    if (!Number.isFinite(parsed)) throw new Error(`Expected finite number, got ${String(value)}`);
    return parsed;
}
function quoteIdent(value: string): string {
    if (!/^[a-z0-9_]+$/.test(value)) throw new Error(`Unsafe SQL identifier: ${value}`);
    return `"${value}"`;
}
async function connect(database: string): Promise<Client> {
    const client = new Client({ host: dbHost, port: dbPort, database, user: dbUser, password: dbPassword });
    await client.connect();
    return client;
}
async function queryOne<T>(db: Client, sql: string, params: unknown[] = []): Promise<T> {
    const result = await db.query(sql, params);
    assertEqual(result.rowCount ?? result.rows.length, 1, `exactly one row: ${sql.slice(0, 60)}`);
    return result.rows[0] as T;
}
type MutationCounts = {
    bets: number; coin_transactions: number; matches: number;
    max_bet_id: number; max_transaction_id: number; max_match_id: number;
};
async function getMutationCounts(db: Client): Promise<MutationCounts> {
    const row = await queryOne<Record<string, string | null>>(db, `
        SELECT
            (SELECT COUNT(*) FROM bets) AS bets,
            (SELECT COUNT(*) FROM coin_transactions) AS coin_transactions,
            (SELECT COUNT(*) FROM matches) AS matches,
            (SELECT COALESCE(MAX(id), 0) FROM bets) AS max_bet_id,
            (SELECT COALESCE(MAX(id), 0) FROM coin_transactions) AS max_transaction_id,
            (SELECT COALESCE(MAX(id), 0) FROM matches) AS max_match_id
    `);
    return {
        bets: num(row.bets), coin_transactions: num(row.coin_transactions), matches: num(row.matches),
        max_bet_id: num(row.max_bet_id), max_transaction_id: num(row.max_transaction_id), max_match_id: num(row.max_match_id),
    };
}
async function getGuardSnapshot(db: Client): Promise<Record<string, unknown>> {
    const counts = await getMutationCounts(db);
    const mapping = await db.query(`
        SELECT s.whitelabel_id, s.mapping_mode, s.enabled, s.version
        FROM selection_mapping_settings s ORDER BY s.whitelabel_id
    `);
    const users = await db.query(`
        SELECT id, username, role, whitelabel_id FROM users ORDER BY id
    `);
    const accounts = await db.query(`
        SELECT id, username, is_online, credit, is_enabled
        FROM crown_accounts ORDER BY id
    `);
    return { counts, mapping: mapping.rows, users: users.rows, accounts: accounts.rows };
}
async function requestJson(
    method: string,
    urlPath: string,
    options: { token?: string; domain?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    if (options.domain) headers['x-whitelabel-domain'] = options.domain;
    const response = await fetch(`${backendUrl}${urlPath}`, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    let body: any;
    try {
        body = text ? JSON.parse(text) : null;
    } catch {
        body = { raw: text };
    }
    return { status: response.status, body };
}
function runNode(args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; logFile: string }): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, args, { cwd: options.cwd, env: options.env, windowsHide: true });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => { stdout += String(chunk); });
        child.stderr.on('data', chunk => { stderr += String(chunk); });
        child.on('error', reject);
        child.on('close', code => {
            fs.writeFileSync(options.logFile, `COMMAND: ${args.join(' ')}\nEXIT: ${code}\n\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
            resolve({ code: code ?? -1, stdout, stderr });
        });
    });
}
async function waitForHealth(timeoutMs = 20000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError = 'not attempted';
    while (Date.now() < deadline) {
        try {
            const response = await fetch(`${backendUrl}/api/health`);
            if (response.status === 200) {
                const body = await response.json();
                assertEqual(body.status, 'ok', 'isolated backend health status');
                return;
            }
            lastError = `HTTP ${response.status}`;
        } catch (error: any) {
            lastError = error?.message || String(error);
        }
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error(`isolated backend did not become healthy: ${lastError}`);
}
async function waitForValue<T>(
    label: string,
    timeoutMs: number,
    callback: () => Promise<T | undefined>,
): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = await callback();
        if (value !== undefined) return value;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`timed out waiting for ${label}`);
}

function countBackendJobCompletions(log: string): number {
    return log.split('[后台下注任务完成]').length - 1;
}

async function waitForBackendJobCompletion(
    getLog: () => string,
    expectedCount: number,
    timeoutMs = 15000,
): Promise<void> {
    await waitForValue('backend job completion', timeoutMs, async () =>
        countBackendJobCompletions(getLog()) >= expectedCount ? true : undefined,
    );
}

async function stopBackend(child: ChildProcess | undefined): Promise<void> {
    if (!child || child.exitCode !== null) return;
    child.kill();
    try {
        await once(child, 'exit');
        return;
    } catch {
        // Fall through to taskkill.
    }
    if (child.pid) {
        const killed = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
        await once(killed, 'exit');
    }
}
async function dropCleanDatabase(admin: Client): Promise<void> {
    await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [cleanDbName]);
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(cleanDbName)}`);
}

async function main(): Promise<void> {
    fs.mkdirSync(evidenceDir, { recursive: true });
    let admin: Client | undefined;
    let db: Client | undefined;
    let backend: ChildProcess | undefined;
    let upstream: http.Server | undefined;
    const upstreamHits: UpstreamHit[] = [];
        let backendStdout = '';
        let backendStderr = '';
    let guardBefore: Record<string, unknown> | undefined;
    let guardAfter: Record<string, unknown> | undefined;

    try {
        // 只读守护：证明本测试没有改动当前开发数据库。
        const guard = await connect(guardDbName);
        guardBefore = await getGuardSnapshot(guard);
        await guard.end();
        evidence.guard_before = guardBefore;

        admin = await connect('postgres');
        const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [cleanDbName]);
        assertEqual(existing.rowCount ?? 0, 0, 'generated clean database does not pre-exist');
        await admin.query(`CREATE DATABASE ${quoteIdent(cleanDbName)}`);
        evidence.clean_database_created_at = new Date().toISOString();

        const cleanDb = await connect(cleanDbName);
        db = cleanDb;
        await db.query(fs.readFileSync(path.join(repoRoot, 'database', 'schema.sql'), 'utf8'));
        evidence.schema_applied = true;

        const migrationEnv: NodeJS.ProcessEnv = {
            ...process.env,
            DB_HOST: dbHost,
            DB_PORT: String(dbPort),
            DB_NAME: cleanDbName,
            DB_USER: dbUser,
            DB_PASSWORD: dbPassword,
        };
        const migration = await runNode(['migrate.js'], {
            cwd: path.resolve(__dirname, '..'),
            env: migrationEnv,
            logFile: path.join(evidenceDir, 'migrate.log'),
        });
        assertEqual(migration.code, 0, 'migration process exit code');
        const applied = await db.query('SELECT filename FROM _migrations ORDER BY filename');
        assertEqual(applied.rows.length, 15, 'applied migration count');
        const tables = await db.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`);
        const tableNames = tables.rows.map(row => String(row.table_name));
        for (const required of ['bets', 'coin_transactions', 'crown_accounts', 'login_history', 'matches', 'selection_mapping_audit_logs', 'selection_mapping_settings', 'users', 'whitelabels']) {
            assertTrue(tableNames.includes(required), `clean database contains ${required}`);
        }
        evidence.migrations = applied.rows.map(row => row.filename);
        evidence.tables = tableNames;

        const passwordHash = await bcrypt.hash(adminPassword, 4);
        await db.query(`
            UPDATE users
            SET username = 'default-admin',
                email = 'default-admin@clean.local',
                password_hash = $1,
                role = 'admin',
                email_verified = TRUE,
                whitelabel_id = 1,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = 1
        `, [passwordHash]);
        const tenant = await queryOne<{ id: number; domain: string }>(db, `
            INSERT INTO whitelabels (name, domain, status, is_default, owner_user_id)
            VALUES ('Clean OEM', $1, 'active', FALSE, 1)
            RETURNING id, domain
        `, [tenantDomain]);
        await db.query(`
            INSERT INTO selection_mapping_settings (whitelabel_id, mapping_mode, enabled, version, updated_by)
            VALUES ($1, 'identity', FALSE, 1, 1)
        `, [tenant.id]);
        const cleanAdmin = await queryOne<{ id: number }>(db, `
            INSERT INTO users (
                username, email, password_hash, role, whitelabel_id, email_verified, trusted_ips
            ) VALUES (
                $1, 'clean-admin@clean.local', $2, 'admin', $3, TRUE, $4::text[]
            )
            RETURNING id
        `, [adminUsername, passwordHash, tenant.id, ['127.0.0.1', '::1', '::ffff:127.0.0.1']]);
        const nonAdminPasswordHash = await bcrypt.hash(nonAdminPassword, 4);
        const cleanAgent = await queryOne<{ id: number }>(db, `
            INSERT INTO users (
                username, email, password_hash, role, whitelabel_id, email_verified, trusted_ips
            ) VALUES (
                'clean-agent', 'clean-agent@clean.local', $1, 'agent', $2, TRUE, $3::text[]
            )
            RETURNING id
        `, [nonAdminPasswordHash, tenant.id, ['127.0.0.1', '::1', '::ffff:127.0.0.1']]);
        const cleanStaff = await queryOne<{ id: number }>(db, `
            INSERT INTO users (
                username, email, password_hash, role, whitelabel_id, email_verified, trusted_ips
            ) VALUES (
                'clean-staff', 'clean-staff@clean.local', $1, 'staff', $2, TRUE, $3::text[]
            )
            RETURNING id
        `, [nonAdminPasswordHash, tenant.id, ['127.0.0.1', '::1', '::ffff:127.0.0.1']]);
        const disabledTenant = await queryOne<{ id: number; domain: string }>(db, `
            INSERT INTO whitelabels (name, domain, status, is_default, owner_user_id)
            VALUES ('Clean Disabled OEM', $1, 'disabled', FALSE, 1)
            RETURNING id, domain
        `, [disabledTenantDomain]);
        await db.query(`
            INSERT INTO selection_mapping_settings (whitelabel_id, mapping_mode, enabled, version, updated_by)
            VALUES ($1, 'identity', FALSE, 1, 1)
        `, [disabledTenant.id]);
        const group = await queryOne<{ id: number }>(db, `
            INSERT INTO groups (user_id, name, description)
            VALUES ($1, 'Clean E2E', 'Isolated clean database fixture')
            RETURNING id
        `, [cleanAdmin.id]);
        const account = await queryOne<{ id: number; credit: string; discount: string }>(db, `
            INSERT INTO crown_accounts (
                user_id, group_id, username, password, original_username, initialized_username,
                discount, balance, credit, stop_profit_limit, is_enabled, is_online, status,
                football_prematch_limit, football_live_limit
            ) VALUES (
                $1, $2, 'clean-crown-account', 'local-only-not-real-password',
                'clean-crown-account', 'clean-crown-account',
                0.80, 100, 100, 0, TRUE, TRUE, 'active', 100000, 100000
            )
            RETURNING id, credit::text AS credit, discount::text AS discount
        `, [cleanAdmin.id, group.id]);
        const failureAccountRows = await db.query(`
            INSERT INTO crown_accounts (
                user_id, group_id, username, password, original_username, initialized_username,
                discount, balance, credit, stop_profit_limit, is_enabled, is_online, status,
                football_prematch_limit, football_live_limit
            ) VALUES
                ($1, $2, 'biz-line-a', 'local-only-not-real-password', 'biz-line-a', 'biz-line-a', 0.80, 100, 100, 0, TRUE, TRUE, 'active', 100000, 100000),
                ($1, $2, 'net-line-b', 'local-only-not-real-password', 'net-line-b', 'net-line-b', 0.80, 100, 100, 0, TRUE, TRUE, 'active', 100000, 100000)
            RETURNING id
        `, [cleanAdmin.id, group.id]);
        assertEqual(failureAccountRows.rows.length, 2, 'clean distinct failure account count');
        const businessAccount = { id: Number(failureAccountRows.rows[0].id) };
        const networkAccount = { id: Number(failureAccountRows.rows[1].id) };
        const match = await queryOne<{ id: number; match_id: string; league_name: string; home_team: string; away_team: string }>(db, `
            INSERT INTO matches (match_id, league_name, home_team, away_team, match_time, status)
            VALUES ('clean-match-1', 'Clean League', 'Clean Home', 'Clean Away', NOW() + INTERVAL '2 hours', 'scheduled')
            RETURNING id, match_id, league_name, home_team, away_team
        `);
        const fixture = await queryOne<{
            id: number; displayed_market_side: string; executed_market_side: string;
            displayed_market_rtype: string; executed_market_rtype: string;
            displayed_market_chose_team: string; executed_market_chose_team: string;
        }>(db, `
            INSERT INTO bets (
                user_id, account_id, match_id, bet_type, bet_option, bet_amount, odds,
                market_category, market_scope, market_side, whitelabel_id,
                displayed_market_side, executed_market_side,
                displayed_market_rtype, executed_market_rtype,
                displayed_market_chose_team, executed_market_chose_team,
                mapping_mode, mapping_version, mapping_applied,
                status, error_message, virtual_bet_amount
            ) VALUES (
                $1, $2, $3, '让球', '主队', 40, 1.90,
                'handicap', 'full', 'home', $4,
                'home', 'away', 'CNRH', 'CNRC', 'H', 'C',
                'inverse', 1, TRUE, 'cancelled', 'clean fixture', 50
            )
            RETURNING id, displayed_market_side, executed_market_side,
                      displayed_market_rtype, executed_market_rtype,
                      displayed_market_chose_team, executed_market_chose_team
        `, [cleanAdmin.id, account.id, match.id, tenant.id]);
        const initialCounts = await getMutationCounts(db);
        assertEqual(initialCounts.bets, 1, 'clean initial bets count');
        assertEqual(initialCounts.coin_transactions, 0, 'clean initial transaction count');
        assertEqual(initialCounts.matches, 1, 'clean initial match count');
        evidence.seed = {
            tenant,
            users: [
                { username: 'default-admin', role: 'admin', whitelabel_id: 1 },
                { username: adminUsername, role: 'admin', whitelabel_id: tenant.id },
                { username: 'clean-agent', role: 'agent', whitelabel_id: tenant.id },
                { username: 'clean-staff', role: 'staff', whitelabel_id: tenant.id },
            ],
            disabled_tenant: disabledTenant,
            account: { id: account.id, credit: account.credit, discount: account.discount, is_online: true },
            match: { id: match.id, names: `${match.home_team} vs ${match.away_team}` },
            fixture,
            initial_counts: initialCounts,
        };

        // 可控本地上游：仅监听 loopback；dry-run 阶段仍必须零请求。
        let upstreamMode: UpstreamMode = 'success';
        let upstreamTicketSequence = 0;
        const sendUpstreamXml = (response: http.ServerResponse, xml: string): void => {
            response.statusCode = 200;
            response.setHeader('content-type', 'application/xml; charset=utf-8');
            response.end(xml);
        };
        upstream = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
            req.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf8');
                const params: Record<string, string> = {};
                for (const [key, value] of new URLSearchParams(body)) params[key] = value;
                const hit: UpstreamHit = {
                    method: req.method || '',
                    url: req.url || '',
                    at: new Date().toISOString(),
                    params,
                    response: 'pending',
                };
                upstreamHits.push(hit);

                if (hit.method === 'GET' && hit.url === '/') {
                    hit.response = 'version_page';
                    res.statusCode = 200;
                    res.setHeader('content-type', 'text/html; charset=utf-8');
                    res.end(`<html><script>top.ver='clean-e2e'</script></html>`);
                    return;
                }

                const action = params.p;
                if (action === 'chk_login') {
                    hit.response = 'login_success';
                    sendUpstreamXml(res, `<serverresponse><msg>100</msg><uid>mock-uid</uid></serverresponse>`);
                    return;
                }
                if (action === 'FT_order_view') {
                    hit.response = 'odds_success';
                    sendUpstreamXml(res, `
                        <serverresponse>
                            <code>501</code>
                            <ioratio>1.90</ioratio>
                            <ratio>1900</ratio>
                            <con>1</con>
                            <spread>1</spread>
                        </serverresponse>`);
                    return;
                }
                if (action === 'FT_bet') {
                    hit.response = upstreamMode;
                    if (upstreamMode === 'network_failure') {
                        res.destroy();
                        return;
                    }
                    if (upstreamMode === 'business_failure') {
                        sendUpstreamXml(res, `
                            <serverresponse>
                                <code>999</code>
                                <msg>mock upstream rejected</msg>
                            </serverresponse>`);
                        return;
                    }
                    upstreamTicketSequence += 1;
                    const ticketId = `MOCK-BET-${String(upstreamTicketSequence).padStart(3, '0')}`;
                    sendUpstreamXml(res, `
                        <serverresponse>
                            <code>560</code>
                            <ticket_id>${ticketId}</ticket_id>
                            <ioratio>1.90</ioratio>
                            <gold>80</gold>
                        </serverresponse>`);
                    return;
                }
                if (action === 'get_today_wagers') {
                    hit.response = 'empty_wagers';
                    res.statusCode = 200;
                    res.setHeader('content-type', 'application/json; charset=utf-8');
                    res.end(JSON.stringify({ wagers: [] }));
                    return;
                }

                hit.response = 'unrecognized';
                res.statusCode = 500;
                res.setHeader('content-type', 'text/plain; charset=utf-8');
                res.end(`unrecognized clean mock action: ${action || '<empty>'}`);
            });
            req.on('error', error => {
                res.statusCode = 500;
                res.end(`mock request error: ${error.message}`);
            });
        });
        const upstreamPort = await new Promise<number>((resolve, reject) => {
            const onError = (error: Error) => reject(error);
            upstream!.once('error', onError);
            upstream!.listen(0, backendHost, () => {
                const address = upstream!.address();
                if (address && typeof address === 'object') resolve(address.port);
                else reject(new Error('upstream mock did not return a TCP port'));
            });
        });
        (evidence.config as Record<string, unknown>).crown_base_url = `http://${backendHost}:${upstreamPort}`;
        evidence.upstream_hits_before_tests = upstreamHits.length;

        const backendEnv: NodeJS.ProcessEnv = {
            ...process.env,
            NODE_ENV: 'test',
            HOST: backendHost,
            PORT: String(backendPort),
            DB_HOST: dbHost,
            DB_PORT: String(dbPort),
            DB_NAME: cleanDbName,
            DB_USER: dbUser,
            DB_PASSWORD: dbPassword,
            JWT_SECRET: jwtSecret,
            CROWN_BASE_URL: `http://${backendHost}:${upstreamPort}`,
            CROWN_BASE_URL_CANDIDATES: `http://${backendHost}:${upstreamPort}`,
            CROWN_API_KEEPALIVE_ENABLED: 'false',
            CROWN_ONLINE_CHECK_INTERVAL_MS: '600000',
            PLAYWRIGHT_HEADLESS: 'true',
        };
        backend = spawn(process.execPath, ['dist/app.js'], {
            cwd: path.resolve(__dirname, '..'),
            env: backendEnv,
            windowsHide: true,
        });
        backend.stdout?.on('data', chunk => { backendStdout += String(chunk); });
        backend.stderr?.on('data', chunk => { backendStderr += String(chunk); });
        await waitForHealth();
        evidence.backend_started_at = new Date().toISOString();

        const login = await requestJson('POST', '/api/auth/login', {
            domain: tenantDomain,
            body: { username: adminUsername, password: adminPassword },
        });
        assertEqual(login.status, 200, 'clean admin login HTTP status');
        assertEqual(login.body.success, true, 'clean admin login API success');
        assertEqual(login.body.data.user.username, adminUsername, 'clean admin login username');
        assertEqual(num(login.body.data.user.whitelabel_id), tenant.id, 'clean admin login tenant');
        const token = String(login.body.data.token || '');
        assertTrue(token.length > 20, 'clean admin token exists');
        evidence.login = {
            status: login.status,
            user: login.body.data.user,
            token_length: token.length,
        };

        const crossDomainLogin = await requestJson('POST', '/api/auth/login', {
            domain: 'local.test',
            body: { username: adminUsername, password: adminPassword },
        });
        assertEqual(crossDomainLogin.status, 403, 'clean admin login on default domain is rejected');
        assertEqual(crossDomainLogin.body.success, false, 'clean admin cross-domain login API success is false');

        const defaultAdminOnOem = await requestJson('POST', '/api/auth/login', {
            domain: tenantDomain,
            body: { username: 'default-admin', password: adminPassword },
        });
        assertEqual(defaultAdminOnOem.status, 403, 'default admin login on clean OEM domain is rejected');
        assertEqual(defaultAdminOnOem.body.success, false, 'default admin cross-domain login API success is false');

        const defaultAdminLocal = await requestJson('POST', '/api/auth/login', {
            body: { username: 'default-admin', password: adminPassword },
        });
        assertEqual(defaultAdminLocal.status, 200, 'default admin local login HTTP status');
        assertEqual(num(defaultAdminLocal.body.data.user.whitelabel_id), 1, 'default admin local login tenant');
        const defaultToken = String(defaultAdminLocal.body.data.token || '');
        assertTrue(defaultToken.length > 20, 'default admin token exists');

        const missingDomainLogin = await requestJson('POST', '/api/auth/login', {
            domain: 'missing-clean.test',
            body: { username: adminUsername, password: adminPassword },
        });
        assertEqual(missingDomainLogin.status, 404, 'missing whitelabel domain login HTTP status');
        assertEqual(missingDomainLogin.body.success, false, 'missing whitelabel domain login API success is false');
        assertEqual(missingDomainLogin.body.error, '白标站点不存在或已停用: missing-clean.test', 'missing whitelabel domain login message');

        const disabledDomainLogin = await requestJson('POST', '/api/auth/login', {
            domain: disabledTenantDomain,
            body: { username: adminUsername, password: adminPassword },
        });
        assertEqual(disabledDomainLogin.status, 404, 'disabled whitelabel domain login HTTP status');
        assertEqual(disabledDomainLogin.body.success, false, 'disabled whitelabel domain login API success is false');
        assertEqual(disabledDomainLogin.body.error, '白标站点不存在或已停用: ' + disabledTenantDomain, 'disabled whitelabel domain login message');

        evidence.login_domain_matrix = {
            clean_admin_on_default: { status: crossDomainLogin.status, body: crossDomainLogin.body },
            default_admin_on_clean_oem: { status: defaultAdminOnOem.status, body: defaultAdminOnOem.body },
            default_admin_local: { status: defaultAdminLocal.status, tenant: defaultAdminLocal.body.data?.user?.whitelabel_id },
            missing_domain: { status: missingDomainLogin.status, body: missingDomainLogin.body },
            disabled_domain: { status: disabledDomainLogin.status, body: disabledDomainLogin.body },
        };

        const mappingPath = '/api/whitelabels/' + tenant.id + '/mapping';
        const noTokenMapping = await requestJson('GET', mappingPath);
        assertEqual(noTokenMapping.status, 401, 'mapping GET without token status');
        const forgedTokenMapping = await requestJson('GET', mappingPath, { token: 'forged-token' });
        assertEqual(forgedTokenMapping.status, 403, 'mapping GET with forged token status');

        const agentLogin = await requestJson('POST', '/api/auth/login', {
            domain: tenantDomain,
            body: { username: 'clean-agent', password: nonAdminPassword },
        });
        assertEqual(agentLogin.status, 200, 'clean agent login HTTP status');
        const agentToken = String(agentLogin.body.data.token || '');
        const staffLogin = await requestJson('POST', '/api/auth/login', {
            domain: tenantDomain,
            body: { username: 'clean-staff', password: nonAdminPassword },
        });
        assertEqual(staffLogin.status, 200, 'clean staff login HTTP status');
        const staffToken = String(staffLogin.body.data.token || '');
        assertTrue(agentToken.length > 20, 'clean agent token exists');
        assertTrue(staffToken.length > 20, 'clean staff token exists');

        const agentGetMapping = await requestJson('GET', mappingPath, { token: agentToken });
        assertEqual(agentGetMapping.status, 403, 'mapping GET as agent status');
        const staffGetMapping = await requestJson('GET', mappingPath, { token: staffToken });
        assertEqual(staffGetMapping.status, 403, 'mapping GET as staff status');
        const agentPutMapping = await requestJson('PUT', mappingPath, {
            token: agentToken,
            body: { mode: 'inverse', enabled: true, reason: 'unauthorized agent update' },
        });
        assertEqual(agentPutMapping.status, 403, 'mapping PUT as agent status');
        const staffPutMapping = await requestJson('PUT', mappingPath, {
            token: staffToken,
            body: { mode: 'inverse', enabled: true, reason: 'unauthorized staff update' },
        });
        assertEqual(staffPutMapping.status, 403, 'mapping PUT as staff status');

        const prePermissionMapping = await queryOne<any>(db, "SELECT mapping_mode, enabled, version::int AS version FROM selection_mapping_settings WHERE whitelabel_id = $1", [tenant.id]);
        assertEqual(prePermissionMapping.version, 1, 'rejected mapping updates leave version unchanged');
        assertEqual(
            await db.query('SELECT COUNT(*)::int AS n FROM selection_mapping_audit_logs WHERE whitelabel_id = $1', [tenant.id]).then(r => num(r.rows[0].n)),
            0,
            'rejected mapping updates leave audit count unchanged',
        );
        evidence.mapping_permission_matrix = {
            no_token: { status: noTokenMapping.status },
            forged_token: { status: forgedTokenMapping.status },
            agent_get: { status: agentGetMapping.status },
            staff_get: { status: staffGetMapping.status },
            agent_put: { status: agentPutMapping.status, body: agentPutMapping.body },
            staff_put: { status: staffPutMapping.status, body: staffPutMapping.body },
            mapping_after_rejections: prePermissionMapping,
        };

        const initialMapping = await requestJson('GET', `/api/whitelabels/${tenant.id}/mapping`, { token });
        assertEqual(initialMapping.status, 200, 'initial mapping GET status');
        assertEqual(initialMapping.body.data.mapping_mode, 'identity', 'initial mapping mode');
        assertEqual(initialMapping.body.data.enabled, false, 'initial mapping enabled');
        assertEqual(num(initialMapping.body.data.version), 1, 'initial mapping version');

        const noChange = await requestJson('PUT', `/api/whitelabels/${tenant.id}/mapping`, {
            token,
            body: { mode: 'identity', enabled: false, reason: `clean no-op ${runId}` },
        });
        assertEqual(noChange.status, 200, 'no-op mapping PUT status');
        assertEqual(noChange.body.data.version, 1, 'no-op mapping version remains v1');
        assertEqual(await db.query('SELECT COUNT(*)::int AS n FROM selection_mapping_audit_logs WHERE whitelabel_id = $1', [tenant.id]).then(r => num(r.rows[0].n)), 0, 'no-op mapping audit count');

        const inverse = await requestJson('PUT', `/api/whitelabels/${tenant.id}/mapping`, {
            token,
            body: { mode: 'inverse', enabled: true, reason: `clean enable inverse ${runId}` },
        });
        assertEqual(inverse.status, 200, 'inverse mapping PUT status');
        assertEqual(inverse.body.data.mapping_mode, 'inverse', 'inverse mapping mode');
        assertEqual(inverse.body.data.enabled, true, 'inverse mapping enabled');
        assertEqual(num(inverse.body.data.version), 2, 'inverse mapping version increments to v2');
        const inverseAudit = await queryOne<any>(cleanDb, `
            SELECT from_mode, to_mode, from_enabled, to_enabled,
                   from_version::int AS from_version, to_version::int AS to_version,
                   operator_user_id, reason
            FROM selection_mapping_audit_logs
            WHERE whitelabel_id = $1
            ORDER BY created_at DESC, id DESC LIMIT 1
        `, [tenant.id]);
        assertEqual(inverseAudit.from_mode, 'identity', 'inverse audit from mode');
        assertEqual(inverseAudit.to_mode, 'inverse', 'inverse audit to mode');
        assertEqual(inverseAudit.from_enabled, false, 'inverse audit from enabled');
        assertEqual(inverseAudit.to_enabled, true, 'inverse audit to enabled');
        assertEqual(inverseAudit.from_version, 1, 'inverse audit from version');
        assertEqual(inverseAudit.to_version, 2, 'inverse audit to version');
        assertEqual(num(inverseAudit.operator_user_id), cleanAdmin.id, 'inverse audit operator');
        assertEqual(inverseAudit.reason, `clean enable inverse ${runId}`, 'inverse audit reason');

        const dryRunPayload = {
            account_ids: [account.id],
            match_id: match.id,
            league_name: match.league_name,
            home_team: match.home_team,
            away_team: match.away_team,
            match_time: new Date().toISOString(),
            match_status: 'scheduled',
            bet_type: '让球',
            bet_option: '主队',
            odds: 1.9,
            total_amount: 64,
            quantity: 1,
            market_category: 'handicap',
            market_side: fixture.displayed_market_side,
            market_line: '1',
            market_index: 1,
            market_wtype: 'R',
            market_rtype: fixture.displayed_market_rtype,
            market_chose_team: fixture.displayed_market_chose_team,
            dry_run: true,
        };
        const inverseDryRun = await requestJson('POST', '/api/bets', { token, domain: tenantDomain, body: dryRunPayload });
        assertEqual(inverseDryRun.status, 200, 'inverse dry-run HTTP status');
        assertEqual(inverseDryRun.body.success, true, 'inverse dry-run API success');
        assertEqual(inverseDryRun.body.data.dry_run, true, 'inverse dry-run flag');
        assertEqual(inverseDryRun.body.data.queued, 0, 'inverse dry-run queued count');
        assertEqual(inverseDryRun.body.data.processing, 0, 'inverse dry-run processing count');
        assertEqual(inverseDryRun.body.data.cancelled, 0, 'inverse dry-run cancelled count');
        assertEqual(inverseDryRun.body.data.bet_ids.length, 0, 'inverse dry-run created bet IDs');
        assertEqual(inverseDryRun.body.data.planned_splits.length, 1, 'inverse dry-run planned split count');
        assertEqual(num(inverseDryRun.body.data.planned_splits[0].virtual_amount), 80, 'inverse dry-run virtual amount');
        assertEqual(num(inverseDryRun.body.data.planned_splits[0].real_amount), 64, 'inverse dry-run real amount');
        const inverseMapping = inverseDryRun.body.data.selection_mapping;
        assertEqual(num(inverseMapping.whitelabel_id), tenant.id, 'inverse dry-run tenant');
        assertEqual(inverseMapping.mapping_mode, 'inverse', 'inverse dry-run mode');
        assertEqual(inverseMapping.mapping_enabled, true, 'inverse dry-run enabled');
        assertEqual(num(inverseMapping.mapping_version), 2, 'inverse dry-run version');
        assertEqual(inverseMapping.mapping_applied, true, 'inverse dry-run applied');
        assertEqual(inverseMapping.displayed_market_side, 'home', 'inverse dry-run displayed side');
        assertEqual(inverseMapping.executed_market_side, 'away', 'inverse dry-run executed side');
        assertEqual(inverseMapping.displayed_market_rtype, 'CNRH', 'inverse dry-run displayed rtype');
        assertEqual(inverseMapping.executed_market_rtype, 'CNRC', 'inverse dry-run executed rtype');
        assertEqual(inverseMapping.displayed_market_chose_team, 'H', 'inverse dry-run displayed team');
        assertEqual(inverseMapping.executed_market_chose_team, 'C', 'inverse dry-run executed team');
        const afterInverseCounts = await getMutationCounts(db);
        assertEqual(afterInverseCounts.bets, initialCounts.bets, 'inverse dry-run bets count unchanged');
        assertEqual(afterInverseCounts.coin_transactions, initialCounts.coin_transactions, 'inverse dry-run transactions unchanged');
        assertEqual(afterInverseCounts.matches, initialCounts.matches, 'inverse dry-run matches unchanged');
        assertEqual(afterInverseCounts.max_bet_id, initialCounts.max_bet_id, 'inverse dry-run max bet id unchanged');
        assertEqual(afterInverseCounts.max_transaction_id, initialCounts.max_transaction_id, 'inverse dry-run max transaction id unchanged');
        assertEqual(afterInverseCounts.max_match_id, initialCounts.max_match_id, 'inverse dry-run max match id unchanged');
        evidence.inverse_dry_run = {
            http_status: inverseDryRun.status,
            response_data: inverseDryRun.body.data,
            counts_after: afterInverseCounts,
        };

        const conflictA = requestJson('PUT', mappingPath, {
            token,
            body: { mode: 'identity', enabled: false, reason: 'clean conflict A ' + runId },
        });
        const conflictB = requestJson('PUT', mappingPath, {
            token,
            body: { mode: 'identity', enabled: true, reason: 'clean conflict B ' + runId },
        });
        const conflictResponses = await Promise.all([conflictA, conflictB]);
        for (const response of conflictResponses) {
            assertEqual(response.status, 200, 'concurrent conflicting mapping PUT HTTP status');
        }
        const conflictVersions = conflictResponses
            .map(response => num(response.body.data.version))
            .sort((a, b) => a - b);
        assertEqual(JSON.stringify(conflictVersions), JSON.stringify([3, 4]), 'concurrent conflicting mapping versions are contiguous');
        const conflictAuditRows = await db.query("SELECT from_mode, to_mode, from_enabled, to_enabled, from_version::int AS from_version, to_version::int AS to_version, operator_user_id, reason FROM selection_mapping_audit_logs WHERE whitelabel_id = $1 ORDER BY to_version ASC", [tenant.id]);
        const conflictAudits = conflictAuditRows.rows;
        assertEqual(conflictAudits.length, 3, 'concurrent conflict total audit count');
        assertEqual(conflictAudits[1].from_version, 2, 'first concurrent audit from version');
        assertEqual(conflictAudits[1].to_version, 3, 'first concurrent audit to version');
        assertEqual(conflictAudits[2].from_version, 3, 'second concurrent audit from version');
        assertEqual(conflictAudits[2].to_version, 4, 'second concurrent audit to version');
        assertEqual(num(conflictAudits[1].operator_user_id), cleanAdmin.id, 'first concurrent audit operator');
        assertEqual(num(conflictAudits[2].operator_user_id), cleanAdmin.id, 'second concurrent audit operator');
        evidence.concurrent_conflict = {
            versions: conflictVersions,
            audits: conflictAudits,
        };

        const restore = await requestJson('PUT', mappingPath, {
            token,
            body: { mode: 'identity', enabled: false, reason: 'clean restore identity ' + runId },
        });
        assertEqual(restore.status, 200, 'restore mapping PUT status');
        assertEqual(restore.body.data.mapping_mode, 'identity', 'restore mapping mode');
        assertEqual(restore.body.data.enabled, false, 'restore mapping enabled');
        assertEqual(num(restore.body.data.version), 5, 'restore mapping version increments to v5');

        const identityDryRun = await requestJson('POST', '/api/bets', { token, domain: tenantDomain, body: dryRunPayload });
        assertEqual(identityDryRun.status, 200, 'identity dry-run HTTP status');
        const identityMapping = identityDryRun.body.data.selection_mapping;
        assertEqual(identityMapping.mapping_mode, 'identity', 'identity dry-run mode');
        assertEqual(identityMapping.mapping_enabled, false, 'identity dry-run enabled');
        assertEqual(num(identityMapping.mapping_version), 5, 'identity dry-run version');
        assertEqual(identityMapping.mapping_applied, false, 'identity dry-run applied');
        assertEqual(identityMapping.displayed_market_side, identityMapping.executed_market_side, 'identity dry-run sides equal');
        assertEqual(identityMapping.displayed_market_rtype, identityMapping.executed_market_rtype, 'identity dry-run rtypes equal');
        assertEqual(identityMapping.displayed_market_chose_team, identityMapping.executed_market_chose_team, 'identity dry-run teams equal');
        const noopA = requestJson('PUT', mappingPath, {
            token,
            body: { mode: 'identity', enabled: false, reason: 'clean concurrent no-op A ' + runId },
        });
        const noopB = requestJson('PUT', mappingPath, {
            token,
            body: { mode: 'identity', enabled: false, reason: 'clean concurrent no-op B ' + runId },
        });
        const noopResponses = await Promise.all([noopA, noopB]);
        for (const response of noopResponses) {
            assertEqual(response.status, 200, 'concurrent no-op mapping PUT HTTP status');
            assertEqual(num(response.body.data.version), 5, 'concurrent no-op mapping version remains v5');
        }
        assertEqual(
            await db.query('SELECT COUNT(*)::int AS n FROM selection_mapping_audit_logs WHERE whitelabel_id = $1', [tenant.id]).then(r => num(r.rows[0].n)),
            4,
            'concurrent no-op mapping audit count',
        );

        const crossTenantA = requestJson('PUT', '/api/whitelabels/1/mapping', {
            token: defaultToken,
            body: { mode: 'inverse', enabled: true, reason: 'clean default tenant inverse ' + runId },
        });
        const crossTenantB = requestJson('PUT', mappingPath, {
            token,
            body: { mode: 'inverse', enabled: true, reason: 'clean OEM tenant inverse ' + runId },
        });
        const crossTenantResponses = await Promise.all([crossTenantA, crossTenantB]);
        for (const response of crossTenantResponses) {
            assertEqual(response.status, 200, 'cross-tenant concurrent mapping PUT HTTP status');
        }
        assertEqual(num(crossTenantResponses[0].body.data.version), 2, 'default tenant concurrent mapping version');
        assertEqual(num(crossTenantResponses[1].body.data.version), 6, 'clean OEM concurrent mapping version');
        assertEqual(
            await db.query('SELECT COUNT(*)::int AS n FROM selection_mapping_audit_logs WHERE whitelabel_id = 1').then(r => num(r.rows[0].n)),
            1,
            'default tenant concurrent audit count',
        );
        assertEqual(
            await db.query('SELECT COUNT(*)::int AS n FROM selection_mapping_audit_logs WHERE whitelabel_id = $1', [tenant.id]).then(r => num(r.rows[0].n)),
            5,
            'clean OEM cross-tenant audit count',
        );

        const restoreDefaultTenant = await requestJson('PUT', '/api/whitelabels/1/mapping', {
            token: defaultToken,
            body: { mode: 'identity', enabled: false, reason: 'clean restore default tenant ' + runId },
        });
        assertEqual(restoreDefaultTenant.status, 200, 'restore default tenant mapping PUT status');
        assertEqual(num(restoreDefaultTenant.body.data.version), 3, 'restore default tenant mapping version');
        const restoreCleanOem = await requestJson('PUT', mappingPath, {
            token,
            body: { mode: 'identity', enabled: false, reason: 'clean restore OEM after concurrency ' + runId },
        });
        assertEqual(restoreCleanOem.status, 200, 'restore clean OEM mapping PUT status');
        assertEqual(num(restoreCleanOem.body.data.version), 7, 'restore clean OEM mapping after concurrency version');
        evidence.mapping_concurrency = {
            noop: { statuses: noopResponses.map(response => response.status), version: 5 },
            cross_tenant: {
                statuses: crossTenantResponses.map(response => response.status),
                versions: crossTenantResponses.map(response => num(response.body.data.version)),
                restored_versions: [num(restoreDefaultTenant.body.data.version), num(restoreCleanOem.body.data.version)],
            },
        };

        const dryRunFinalCounts = await getMutationCounts(db);
        assertEqual(dryRunFinalCounts.bets, initialCounts.bets, 'dry-run final bets count unchanged');
        assertEqual(dryRunFinalCounts.coin_transactions, initialCounts.coin_transactions, 'dry-run final transactions unchanged');
        assertEqual(dryRunFinalCounts.matches, initialCounts.matches, 'dry-run final matches unchanged');
        assertEqual(upstreamHits.length, 0, 'dry-run produced zero upstream HTTP requests');
        evidence.identity_dry_run = {
            http_status: identityDryRun.status,
            selection_mapping: identityMapping,
            counts_after: dryRunFinalCounts,
        };

        // 非 dry-run 三态：只指向 loopback mock，不访问真实上游。
        const coinSeed = await queryOne<any>(cleanDb, `
            INSERT INTO coin_transactions (
                user_id, account_id, bet_id, transaction_id, transaction_type,
                description, amount, balance_before, balance_after
            ) VALUES ($1, NULL, NULL, $2, '充值', 'clean non-dry-run seed', 1000, 0, 1000)
            RETURNING id, transaction_id, amount::text AS amount, balance_after::text AS balance_after
        `, [cleanAdmin.id, `CLEAN-SEED-${runStamp}`]);
        const nonDryEvidence: Record<string, unknown> = { coin_seed: coinSeed };
        evidence.non_dry_run = nonDryEvidence;

        const enableNonDryInverse = await requestJson('PUT', mappingPath, {
            token,
            body: { mode: 'inverse', enabled: true, reason: `clean non-dry-run inverse ${runId}` },
        });
        assertEqual(enableNonDryInverse.status, 200, 'non-dry-run inverse mapping PUT status');
        assertEqual(num(enableNonDryInverse.body.data.version), 8, 'non-dry-run inverse mapping version');

        const nonDryRunPayload = { ...dryRunPayload, dry_run: false };
        const hitCount = (action: string): number => upstreamHits.filter(hit => hit.params.p === action).length;

        // 1) 上游成功：用户展示 home/CNRH/H，实际提交 away/CNRC/C。
        const jobsBeforeSuccess = countBackendJobCompletions(backendStdout);
        const successSubmit = await requestJson('POST', '/api/bets', { token, domain: tenantDomain, body: nonDryRunPayload });
        assertEqual(successSubmit.status, 202, 'upstream success bet submit HTTP status');
        assertEqual(successSubmit.body.success, true, 'upstream success bet submit API success');
        assertEqual(successSubmit.body.data.processing, 1, 'upstream success processing count');
        assertEqual(successSubmit.body.data.bet_ids.length, 1, 'upstream success bet ID count');
        assertEqual(num(successSubmit.body.data.selection_mapping.mapping_version), 8, 'upstream success mapping version');
        const successBetId = num(successSubmit.body.data.bet_ids[0]);
        assertTrue(successBetId > dryRunFinalCounts.max_bet_id, 'upstream success bet ID is newly created');

        const successResult = await waitForValue('confirmed upstream success bet', 15000, async () => {
            const row = await queryOne<any>(cleanDb, `
                SELECT id, status, official_bet_id, official_odds::text AS official_odds, error_message, confirmed_at,
                       displayed_market_side, executed_market_side,
                       displayed_market_rtype, executed_market_rtype,
                       displayed_market_chose_team, executed_market_chose_team,
                       mapping_mode, mapping_version::int AS mapping_version, mapping_applied
                  FROM bets WHERE id = $1
            `, [successBetId]);
            const betHit = upstreamHits.find(hit => hit.params.p === 'FT_bet' && hit.params.gid === match.match_id);
            return row.status === 'confirmed' && row.official_bet_id && betHit ? { row, hit: betHit } : undefined;
        });
        const successBet = successResult.row;
        const successUpstreamHit = successResult.hit;
        assertEqual(successBet.status, 'confirmed', 'upstream success bet status');
        assertEqual(successBet.official_bet_id, 'MOCK-BET-001', 'upstream success official bet ID');
        assertEqual(num(successBet.official_odds), 1.9, 'upstream success official odds');
        assertTrue(Boolean(successBet.confirmed_at), 'upstream success confirmed timestamp exists');
        assertEqual(successBet.displayed_market_side, 'home', 'upstream success displayed side');
        assertEqual(successBet.executed_market_side, 'away', 'upstream success executed side');
        assertEqual(successBet.displayed_market_rtype, 'CNRH', 'upstream success displayed rtype');
        assertEqual(successBet.executed_market_rtype, 'CNRC', 'upstream success executed rtype');
        assertEqual(successBet.displayed_market_chose_team, 'H', 'upstream success displayed team');
        assertEqual(successBet.executed_market_chose_team, 'C', 'upstream success executed team');
        assertEqual(successBet.mapping_mode, 'inverse', 'upstream success mapping mode');
        assertEqual(successBet.mapping_version, 8, 'upstream success mapping version');
        assertEqual(successBet.mapping_applied, true, 'upstream success mapping applied');
        assertEqual(successUpstreamHit.response, 'success', 'upstream success mock response mode');
        assertEqual(successUpstreamHit.params.gid, match.match_id, 'upstream success crown match ID');
        assertEqual(successUpstreamHit.params.rtype, 'CNRC', 'upstream success submitted rtype');
        assertEqual(successUpstreamHit.params.chose_team, 'C', 'upstream success submitted team');
        assertEqual(successUpstreamHit.params.golds, '80', 'upstream success submitted virtual amount');
        await waitForBackendJobCompletion(() => backendStdout, jobsBeforeSuccess + 1);

        const successTransaction = await queryOne<any>(cleanDb, `
            SELECT transaction_type, amount::text AS amount,
                   balance_before::text AS balance_before, balance_after::text AS balance_after
              FROM coin_transactions WHERE bet_id = $1
        `, [successBetId]);
        assertEqual(successTransaction.transaction_type, '消耗', 'upstream success transaction type');
        assertEqual(num(successTransaction.amount), -64, 'upstream success transaction amount');
        assertEqual(num(successTransaction.balance_before), 1000, 'upstream success balance before');
        assertEqual(num(successTransaction.balance_after), 936, 'upstream success balance after');
        const accountSession = await queryOne<any>(cleanDb, `
            SELECT is_online, api_uid, api_cookies FROM crown_accounts WHERE id = $1
        `, [account.id]);
        assertEqual(accountSession.is_online, true, 'upstream success account online');
        assertEqual(accountSession.api_uid, 'mock-uid', 'upstream success API UID');
        nonDryEvidence.success = {
            http_status: successSubmit.status,
            response_data: successSubmit.body.data,
            bet: successBet,
            upstream_ft_bet: successUpstreamHit,
            transaction: successTransaction,
            account_session: { is_online: accountSession.is_online, api_uid: accountSession.api_uid },
        };

        // 2) 上游业务失败：返回 code=999 与明确 msg，不写金币消耗。
        upstreamMode = 'business_failure';
        const jobsBeforeBusinessFailure = countBackendJobCompletions(backendStdout);
        const businessFailurePayload = { ...nonDryRunPayload, account_ids: [businessAccount.id] };
        const businessFailureSubmit = await requestJson('POST', '/api/bets', { token, domain: tenantDomain, body: businessFailurePayload });
        nonDryEvidence.business_failure_submit_response = businessFailureSubmit.body;
        assertEqual(businessFailureSubmit.status, 202, 'upstream business failure submit HTTP status');
        assertEqual(businessFailureSubmit.body.success, true, 'upstream business failure submit API success');
        const businessFailureBetId = num(businessFailureSubmit.body.data.bet_ids[0]);
        assertTrue(businessFailureBetId > successBetId, 'upstream business failure bet ID is newer');

        const businessFailureResult = await waitForValue('cancelled upstream business failure bet', 15000, async () => {
            const row = await queryOne<any>(cleanDb, `
                SELECT id, status, official_bet_id, official_odds, error_message, confirmed_at,
                       displayed_market_side, executed_market_side,
                       displayed_market_rtype, executed_market_rtype,
                       displayed_market_chose_team, executed_market_chose_team,
                       mapping_mode, mapping_version::int AS mapping_version, mapping_applied
                  FROM bets WHERE id = $1
            `, [businessFailureBetId]);
            const betHit = upstreamHits.filter(hit => hit.params.p === 'FT_bet' && hit.params.gid === match.match_id).pop();
            return row.status === 'cancelled' && row.error_message === 'mock upstream rejected' && betHit ? { row, hit: betHit } : undefined;
        });
        const businessFailureBet = businessFailureResult.row;
        const businessFailureUpstreamHit = businessFailureResult.hit;
        assertEqual(businessFailureBet.status, 'cancelled', 'upstream business failure bet status');
        assertEqual(businessFailureBet.error_message, 'mock upstream rejected', 'upstream business failure message');
        assertEqual(businessFailureBet.official_bet_id, null, 'upstream business failure official bet ID');
        assertEqual(businessFailureBet.official_odds, null, 'upstream business failure official odds');
        assertEqual(businessFailureBet.confirmed_at, null, 'upstream business failure confirmed timestamp');
        assertEqual(businessFailureBet.displayed_market_side, 'home', 'upstream business failure displayed side');
        assertEqual(businessFailureBet.executed_market_side, 'away', 'upstream business failure executed side');
        assertEqual(businessFailureBet.displayed_market_rtype, 'CNRH', 'upstream business failure displayed rtype');
        assertEqual(businessFailureBet.executed_market_rtype, 'CNRC', 'upstream business failure executed rtype');
        assertEqual(businessFailureBet.displayed_market_chose_team, 'H', 'upstream business failure displayed team');
        assertEqual(businessFailureBet.executed_market_chose_team, 'C', 'upstream business failure executed team');
        assertEqual(businessFailureUpstreamHit.response, 'business_failure', 'upstream business failure mock response mode');
        assertEqual(businessFailureUpstreamHit.params.rtype, 'CNRC', 'upstream business failure submitted rtype');
        assertEqual(businessFailureUpstreamHit.params.chose_team, 'C', 'upstream business failure submitted team');
        await waitForBackendJobCompletion(() => backendStdout, jobsBeforeBusinessFailure + 1);
        assertEqual(
            await db.query('SELECT COUNT(*)::int AS n FROM coin_transactions WHERE bet_id = $1', [businessFailureBetId]).then(r => num(r.rows[0].n)),
            0,
            'upstream business failure transaction count',
        );
        nonDryEvidence.business_failure = {
            http_status: businessFailureSubmit.status,
            response_data: businessFailureSubmit.body.data,
            bet: businessFailureBet,
            upstream_ft_bet: businessFailureUpstreamHit,
        };

        // 3) 上游网络失败：mock 主动断开，不虚构成功，不写金币消耗。
        upstreamMode = 'network_failure';
        const jobsBeforeNetworkFailure = countBackendJobCompletions(backendStdout);
        const networkFailurePayload = { ...nonDryRunPayload, account_ids: [networkAccount.id] };
        const networkFailureSubmit = await requestJson('POST', '/api/bets', { token, domain: tenantDomain, body: networkFailurePayload });
        nonDryEvidence.network_failure_submit_response = networkFailureSubmit.body;
        assertEqual(networkFailureSubmit.status, 202, 'upstream network failure submit HTTP status');
        assertEqual(networkFailureSubmit.body.success, true, 'upstream network failure submit API success');
        const networkFailureBetId = num(networkFailureSubmit.body.data.bet_ids[0]);
        assertTrue(networkFailureBetId > businessFailureBetId, 'upstream network failure bet ID is newer');

        const networkFailureResult = await waitForValue('cancelled upstream network failure bet', 15000, async () => {
            const row = await queryOne<any>(cleanDb, `
                SELECT id, status, official_bet_id, official_odds, error_message, confirmed_at,
                       displayed_market_side, executed_market_side,
                       displayed_market_rtype, executed_market_rtype,
                       displayed_market_chose_team, executed_market_chose_team,
                       mapping_mode, mapping_version::int AS mapping_version, mapping_applied
                  FROM bets WHERE id = $1
            `, [networkFailureBetId]);
            const betHit = upstreamHits.filter(hit => hit.params.p === 'FT_bet' && hit.params.gid === match.match_id).pop();
            return row.status === 'cancelled' && row.error_message && betHit ? { row, hit: betHit } : undefined;
        });
        const networkFailureBet = networkFailureResult.row;
        const networkFailureUpstreamHit = networkFailureResult.hit;
        assertEqual(networkFailureBet.status, 'cancelled', 'upstream network failure bet status');
        assertTrue(Boolean(networkFailureBet.error_message), 'upstream network failure error message exists');
        assertEqual(networkFailureBet.official_bet_id, null, 'upstream network failure official bet ID');
        assertEqual(networkFailureBet.official_odds, null, 'upstream network failure official odds');
        assertEqual(networkFailureBet.confirmed_at, null, 'upstream network failure confirmed timestamp');
        assertEqual(networkFailureBet.displayed_market_side, 'home', 'upstream network failure displayed side');
        assertEqual(networkFailureBet.executed_market_side, 'away', 'upstream network failure executed side');
        assertEqual(networkFailureBet.displayed_market_rtype, 'CNRH', 'upstream network failure displayed rtype');
        assertEqual(networkFailureBet.executed_market_rtype, 'CNRC', 'upstream network failure executed rtype');
        assertEqual(networkFailureBet.displayed_market_chose_team, 'H', 'upstream network failure displayed team');
        assertEqual(networkFailureBet.executed_market_chose_team, 'C', 'upstream network failure executed team');
        assertEqual(networkFailureUpstreamHit.response, 'network_failure', 'upstream network failure mock response mode');
        assertEqual(networkFailureUpstreamHit.params.rtype, 'CNRC', 'upstream network failure submitted rtype');
        assertEqual(networkFailureUpstreamHit.params.chose_team, 'C', 'upstream network failure submitted team');
        await waitForBackendJobCompletion(() => backendStdout, jobsBeforeNetworkFailure + 1);
        assertEqual(
            await db.query('SELECT COUNT(*)::int AS n FROM coin_transactions WHERE bet_id = $1', [networkFailureBetId]).then(r => num(r.rows[0].n)),
            0,
            'upstream network failure transaction count',
        );
        nonDryEvidence.network_failure = {
            http_status: networkFailureSubmit.status,
            response_data: networkFailureSubmit.body.data,
            bet: networkFailureBet,
            upstream_ft_bet: networkFailureUpstreamHit,
        };

        assertEqual(upstreamHits.filter(hit => hit.method === 'GET' && hit.url === '/').length, 3, 'controlled upstream version-page request count');
        assertEqual(hitCount('chk_login'), 3, 'controlled upstream login request count');
        assertEqual(hitCount('FT_order_view'), 3, 'controlled upstream odds request count');
        assertEqual(hitCount('FT_bet'), 3, 'controlled upstream bet request count');
        assertEqual(hitCount('get_today_wagers'), 3, 'controlled upstream today-wagers request count');
        assertEqual(upstreamHits.length, 15, 'controlled upstream total request count');
        const finalUserBalance = await queryOne<any>(db, 'SELECT COALESCE(SUM(amount), 0)::text AS balance FROM coin_transactions WHERE user_id = $1', [cleanAdmin.id]);
        assertEqual(num(finalUserBalance.balance), 936, 'final clean user coin balance');

        const restoreAfterNonDryRun = await requestJson('PUT', mappingPath, {
            token,
            body: { mode: 'identity', enabled: false, reason: `clean restore after non-dry-run ${runId}` },
        });
        assertEqual(restoreAfterNonDryRun.status, 200, 'restore after non-dry-run mapping PUT status');
        assertEqual(num(restoreAfterNonDryRun.body.data.version), 9, 'restore after non-dry-run mapping version');

        const finalCounts = await getMutationCounts(db);
        assertEqual(finalCounts.bets, 4, 'final clean bets count after non-dry-run');
        assertEqual(finalCounts.coin_transactions, 2, 'final clean transactions count after non-dry-run');
        assertEqual(finalCounts.matches, 1, 'final clean matches count after non-dry-run');
        assertEqual(finalCounts.max_bet_id, 4, 'final clean max bet ID after non-dry-run');
        assertEqual(finalCounts.max_transaction_id, 2, 'final clean max transaction ID after non-dry-run');
        assertEqual(finalCounts.max_match_id, 1, 'final clean max match ID after non-dry-run');

        await stopBackend(backend);
        backend = undefined;
        fs.writeFileSync(path.join(evidenceDir, 'backend.stdout.log'), backendStdout);
        fs.writeFileSync(path.join(evidenceDir, 'backend.stderr.log'), backendStderr);
        evidence.backend_stopped_at = new Date().toISOString();
        evidence.upstream_hits_final = upstreamHits;
        await new Promise<void>((resolve, reject) => upstream!.close(error => error ? reject(error) : resolve()));
        upstream = undefined;

        const finalDbState = await db.query(`
            SELECT s.whitelabel_id, s.mapping_mode, s.enabled, s.version::int AS version
            FROM selection_mapping_settings s ORDER BY s.whitelabel_id
        `);
        evidence.final_clean_db_state = {
            mapping: finalDbState.rows,
            counts: finalCounts,
            audits: await db.query('SELECT COUNT(*)::int AS n FROM selection_mapping_audit_logs').then(r => r.rows[0]),
        };
        assertEqual(finalDbState.rows[1].mapping_mode, 'identity', 'final clean mapping mode');
        assertEqual(finalDbState.rows[1].enabled, false, 'final clean mapping enabled');
        assertEqual(finalDbState.rows[0].version, 3, 'final default tenant mapping version');
        assertEqual(finalDbState.rows[1].version, 9, 'final clean mapping version');
        assertEqual(num((evidence.final_clean_db_state as any).audits.n), 10, 'final clean total audit count');

        await db.end();
        db = undefined;
        await dropCleanDatabase(admin);
        evidence.clean_database_dropped_at = new Date().toISOString();

        const guard2 = await connect(guardDbName);
        guardAfter = await getGuardSnapshot(guard2);
        await guard2.end();
        evidence.guard_after = guardAfter;
        assertEqual(JSON.stringify(guardAfter), JSON.stringify(guardBefore), 'guarded development database snapshot unchanged');

        evidence.result = { passed, failed: failures.length, status: 'passed' };
    } catch (error: any) {
        evidence.error = { message: error?.message || String(error), stack: error?.stack };
        evidence.result = { passed, failed: failures.length || 1, status: 'failed' };
        throw error;
    } finally {
        try { await stopBackend(backend); } catch (error: any) { evidence.backend_stop_error = error?.message || String(error); }
        try {
            fs.writeFileSync(path.join(evidenceDir, 'backend.stdout.log'), backendStdout, 'utf8');
            fs.writeFileSync(path.join(evidenceDir, 'backend.stderr.log'), backendStderr, 'utf8');
        } catch (error: any) { evidence.backend_log_write_error = error?.message || String(error); }
        try { if (upstream) await new Promise<void>((resolve, reject) => upstream!.close(error => error ? reject(error) : resolve())); } catch (error: any) { evidence.upstream_stop_error = error?.message || String(error); }
        try { if (db) await db.end(); } catch (error: any) { evidence.db_close_error = error?.message || String(error); }
        try {
            if (admin) {
                await dropCleanDatabase(admin);
                await admin.end();
            }
        } catch (error: any) {
            evidence.clean_database_cleanup_error = error?.message || String(error);
            try { await admin?.end(); } catch { /* ignore */ }
        }
        evidence.finished_at = new Date().toISOString();
        fs.writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2), 'utf8');
    }
}

main().then(() => {
    console.log(`CLEAN_DB_E2E-PASSED passed=${passed} failed=0 evidence=${evidenceFile}`);
    process.exit(0);
}).catch(error => {
    console.error(`CLEAN_DB_E2E-FAILED passed=${passed} failed=${failures.length || 1}`);
    console.error(error);
    console.error(`evidence=${evidenceFile}`);
    process.exit(1);
});
