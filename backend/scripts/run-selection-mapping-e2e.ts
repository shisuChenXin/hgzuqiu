/// <reference lib="dom" />
import { ChildProcess, spawn } from 'child_process';
import { once } from 'events';
import fs from 'fs';
import http from 'http';
import net from 'net';
import path from 'path';
import { Client } from 'pg';
import bcrypt from 'bcrypt';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const repoRoot = path.resolve(__dirname, '../..');
const runStamp = Date.now().toString();
const runId = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')}-${process.pid}`;
const evidenceDir = path.join(repoRoot, '证据', 'selection-mapping-e2e', runId);
const evidenceFile = path.join(evidenceDir, 'result.json');
const backendHost = '127.0.0.1';
const backendPort = Number(process.env.MAPPING_E2E_BACKEND_PORT || 3102);
const frontendHost = 'localhost';
const frontendPort = Number(process.env.MAPPING_E2E_FRONTEND_PORT || 10088);
const backendUrl = `http://${backendHost}:${backendPort}`;
const frontendUrl = `http://${frontendHost}:${frontendPort}`;
const dbHost = process.env.DB_HOST || '127.0.0.1';
const dbPort = Number(process.env.DB_PORT || 5432);
const dbUser = process.env.DB_USER || 'lt';
const dbPassword = process.env.DB_PASSWORD || '';
const guardDbName = process.env.DB_NAME || 'bclogin_system';
const isolatedDbName = `hgzuqiu_mapping_e2e_${runStamp}`;
const tenantDomain = 'mapping-oem.test';
const adminUsername = 'mapping-admin';
const adminPassword = 'MappingE2E!123456';
const jwtSecret = `mapping-e2e-jwt-${runStamp}`;
const upstreamHits: Array<{ method: string; url: string; at: string }> = [];

type Evidence = Record<string, unknown>;
type MutationCounts = {
    bets: number;
    coin_transactions: number;
    matches: number;
    max_bet_id: number;
    max_transaction_id: number;
    max_match_id: number;
};
type GuardSnapshot = {
    counts: MutationCounts;
    mapping: unknown[];
    users: unknown[];
    accounts: unknown[];
    audit: unknown[];
};
type ChildResult = { code: number; stdout: string; stderr: string };

const evidence: Evidence = {
    run_id: runId,
    started_at: new Date().toISOString(),
    scope: 'isolated PostgreSQL database + loopback backend/frontend + UI E2E subprocess',
    config: {
        backend_host: backendHost,
        backend_port: backendPort,
        frontend_host: frontendHost,
        frontend_port: frontendPort,
        isolated_database: isolatedDbName,
        guarded_database: guardDbName,
        whitelabel_domain: tenantDomain,
        crown_base_url: 'controlled loopback sink; expected zero requests',
    },
};
const failures: string[] = [];
let passed = 0;

function assertEqual<T>(actual: T, expected: T, label: string): void {
    if (actual !== expected) {
        failures.push(`${label}: expected=${JSON.stringify(expected)}, actual=${JSON.stringify(actual)}`);
        throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
    passed += 1;
}
function assertTrue(actual: boolean, label: string): void {
    assertEqual(actual, true, label);
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
    assertEqual(result.rowCount ?? result.rows.length, 1, `exactly one row: ${sql.slice(0, 70)}`);
    return result.rows[0] as T;
}
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
        bets: num(row.bets),
        coin_transactions: num(row.coin_transactions),
        matches: num(row.matches),
        max_bet_id: num(row.max_bet_id),
        max_transaction_id: num(row.max_transaction_id),
        max_match_id: num(row.max_match_id),
    };
}
async function getGuardSnapshot(db: Client): Promise<GuardSnapshot> {
    const counts = await getMutationCounts(db);
    const mapping = await db.query(`
        SELECT s.whitelabel_id, s.mapping_mode, s.enabled, s.version, s.updated_by
        FROM selection_mapping_settings s
        ORDER BY s.whitelabel_id
    `);
    const users = await db.query(`
        SELECT id, username, role, whitelabel_id
        FROM users
        ORDER BY id
    `);
    const accounts = await db.query(`
        SELECT id, username, credit, is_enabled, is_online
        FROM crown_accounts
        ORDER BY id
    `);
    const audit = await db.query(`
        SELECT id, whitelabel_id, from_mode, to_mode, from_enabled, to_enabled,
               from_version, to_version, operator_user_id, reason
        FROM selection_mapping_audit_logs
        ORDER BY id
    `);
    return {
        counts,
        mapping: mapping.rows,
        users: users.rows,
        accounts: accounts.rows,
        audit: audit.rows,
    };
}
function runNode(args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; logFile: string }): Promise<ChildResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, args, { cwd: options.cwd, env: options.env, windowsHide: true });
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', chunk => { stdout += String(chunk); });
        child.stderr?.on('data', chunk => { stderr += String(chunk); });
        child.on('error', reject);
        child.on('close', code => {
            fs.writeFileSync(options.logFile, `COMMAND: ${args.join(' ')}\nEXIT: ${code ?? -1}\n\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`, 'utf8');
            resolve({ code: code ?? -1, stdout, stderr });
        });
    });
}
function startProcess(args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): ChildProcess {
    return spawn(process.execPath, args, { cwd: options.cwd, env: options.env, windowsHide: true });
}
async function waitForHttp(url: string, label: string, timeoutMs = 30000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError = 'not attempted';
    while (Date.now() < deadline) {
        try {
            const response = await fetch(url);
            if (response.status === 200) return;
            lastError = `HTTP ${response.status}`;
        } catch (error: any) {
            lastError = error?.message || String(error);
        }
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error(`timed out waiting for ${label}: ${lastError}`);
}
function canBind(host: string, port: number): Promise<boolean> {
    return new Promise(resolve => {
        const server = net.createServer();
        server.once('error', () => resolve(false));
        server.listen(port, host, () => server.close(() => resolve(true)));
    });
}
async function assertPortFree(host: string, port: number, label: string): Promise<void> {
    assertTrue(await canBind(host, port), `${label} port ${host}:${port} is free before startup`);
}
async function stopProcess(child: ChildProcess | undefined, label: string): Promise<void> {
    if (!child || child.exitCode !== null) return;
    child.kill();
    try {
        await once(child, 'exit');
        return;
    } catch {
        // Windows may need a process-tree kill.
    }
    if (child.pid) {
        const killed = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
        await once(killed, 'exit');
    }
    evidence[`${label}_stopped`] = true;
}
function collectOutput(child: ChildProcess, target: { stdout: string; stderr: string }): void {
    child.stdout?.on('data', chunk => { target.stdout += String(chunk); });
    child.stderr?.on('data', chunk => { target.stderr += String(chunk); });
}
async function dropIsolatedDatabase(admin: Client): Promise<void> {
    await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [isolatedDbName]);
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(isolatedDbName)}`);
}

async function main(): Promise<void> {
    fs.mkdirSync(evidenceDir, { recursive: true });
    if (!dbPassword) throw new Error('DB_PASSWORD is required by backend/.env for isolated mapping E2E');
    if (!/^[a-z0-9_]+$/.test(isolatedDbName)) throw new Error(`Generated database name is unsafe: ${isolatedDbName}`);
    if (!Number.isInteger(backendPort) || backendPort <= 0 || backendPort > 65535) throw new Error(`Invalid MAPPING_E2E_BACKEND_PORT: ${backendPort}`);
    if (!Number.isInteger(frontendPort) || frontendPort <= 0 || frontendPort > 65535) throw new Error(`Invalid MAPPING_E2E_FRONTEND_PORT: ${frontendPort}`);

    let guardAdmin: Client | undefined;
    let admin: Client | undefined;
    let db: Client | undefined;
    let backend: ChildProcess | undefined;
    let frontend: ChildProcess | undefined;
    let upstream: http.Server | undefined;
    let child: ChildProcess | undefined;
    const backendOutput = { stdout: '', stderr: '' };
    const frontendOutput = { stdout: '', stderr: '' };
    const childOutput = { stdout: '', stderr: '' };
    let guardBefore: GuardSnapshot | undefined;
    let guardAfter: GuardSnapshot | undefined;
    let childCode: number | undefined;
    let mainError: unknown;

    try {
        await assertPortFree(backendHost, backendPort, 'backend');
        await assertPortFree(frontendHost, frontendPort, 'frontend');

        guardAdmin = await connect(guardDbName);
        guardBefore = await getGuardSnapshot(guardAdmin);
        await guardAdmin.end();
        guardAdmin = undefined;
        evidence.guard_before = guardBefore;

        admin = await connect('postgres');
        const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [isolatedDbName]);
        assertEqual(existing.rowCount ?? 0, 0, 'generated mapping E2E database does not pre-exist');
        await admin.query(`CREATE DATABASE ${quoteIdent(isolatedDbName)}`);
        evidence.isolated_database_created_at = new Date().toISOString();

        db = await connect(isolatedDbName);
        await db.query(fs.readFileSync(path.join(repoRoot, 'database', 'schema.sql'), 'utf8'));
        evidence.schema_applied = true;

        const migrationEnv: NodeJS.ProcessEnv = {
            ...process.env,
            DB_HOST: dbHost,
            DB_PORT: String(dbPort),
            DB_NAME: isolatedDbName,
            DB_USER: dbUser,
            DB_PASSWORD: dbPassword,
        };
        const migration = await runNode(['migrate.js'], {
            cwd: path.resolve(__dirname, '..'),
            env: migrationEnv,
            logFile: path.join(evidenceDir, 'migrate.log'),
        });
        assertEqual(migration.code, 0, 'isolated migration process exit code');
        const applied = await db.query('SELECT filename FROM _migrations ORDER BY filename');
        assertEqual(applied.rows.length, 15, 'isolated migration count');

        const passwordHash = await bcrypt.hash(adminPassword, 4);
        await db.query(`
            UPDATE users
            SET username = 'mapping-default-admin',
                email = 'mapping-default-admin@mapping.local',
                password_hash = $1,
                role = 'admin',
                email_verified = TRUE,
                whitelabel_id = 1,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = 1
        `, [passwordHash]);
        const tenant = await queryOne<{ id: number; domain: string; name: string }>(db, `
            INSERT INTO whitelabels (name, domain, status, is_default, owner_user_id)
            VALUES ('Mapping OEM', $1, 'active', FALSE, 1)
            RETURNING id, name, domain
        `, [tenantDomain]);
        await db.query(`
            INSERT INTO selection_mapping_settings (whitelabel_id, mapping_mode, enabled, version, updated_by)
            VALUES ($1, 'identity', FALSE, 1, 1)
        `, [tenant.id]);
        const mappingAdmin = await queryOne<{ id: number }>(db, `
            INSERT INTO users (username, email, password_hash, role, whitelabel_id, email_verified, trusted_ips)
            VALUES ($1, 'mapping-admin@mapping.local', $2, 'admin', $3, TRUE, $4::text[])
            RETURNING id
        `, [adminUsername, passwordHash, tenant.id, ['127.0.0.1', '::1', '::ffff:127.0.0.1']]);
        const group = await queryOne<{ id: number }>(db, `
            INSERT INTO groups (user_id, name, description)
            VALUES ($1, 'Mapping E2E', 'Isolated mapping fixture')
            RETURNING id
        `, [mappingAdmin.id]);
        const account = await queryOne<{ id: number; credit: string; discount: string }>(db, `
            INSERT INTO crown_accounts (
                user_id, group_id, username, password, original_username, initialized_username,
                discount, balance, credit, stop_profit_limit, is_enabled, is_online, status,
                football_prematch_limit, football_live_limit
            ) VALUES (
                $1, $2, 'mapping-crown-account', 'local-only-not-real-password',
                'mapping-crown-account', 'mapping-crown-account',
                0.80, 100, 100, 0, TRUE, TRUE, 'active', 100000, 100000
            )
            RETURNING id, credit::text AS credit, discount::text AS discount
        `, [mappingAdmin.id, group.id]);
        const match = await queryOne<{ id: number; league_name: string; home_team: string; away_team: string }>(db, `
            INSERT INTO matches (match_id, league_name, home_team, away_team, match_time, status)
            VALUES ('mapping-match-1', 'Mapping League', 'Mapping Home', 'Mapping Away', NOW() + INTERVAL '2 hours', 'scheduled')
            RETURNING id, league_name, home_team, away_team
        `);
        const fixture = await queryOne<{ id: number }>(db, `
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
                'inverse', 1, TRUE, 'cancelled', 'mapping fixture', 50
            )
            RETURNING id
        `, [mappingAdmin.id, account.id, match.id, tenant.id]);
        const initialCounts = await getMutationCounts(db);
        assertEqual(initialCounts.bets, 1, 'isolated seed bets count');
        assertEqual(initialCounts.coin_transactions, 0, 'isolated seed transactions count');
        assertEqual(initialCounts.matches, 1, 'isolated seed matches count');
        const initialAudit = await db.query('SELECT COUNT(*)::int AS count FROM selection_mapping_audit_logs');
        assertEqual(initialAudit.rows[0].count, 0, 'isolated seed audit count');
        evidence.seed = {
            tenant,
            admin: { id: mappingAdmin.id, username: adminUsername, whitelabel_id: tenant.id },
            account: { id: account.id, credit: account.credit, discount: account.discount, is_online: true },
            match: { id: match.id, names: `${match.home_team} vs ${match.away_team}` },
            fixture: { id: fixture.id, mapping_mode: 'inverse', mapping_version: 1 },
            initial_counts: initialCounts,
        };

        upstream = http.createServer((req, res) => {
            upstreamHits.push({ method: req.method || 'GET', url: req.url || '/', at: new Date().toISOString() });
            req.resume();
            req.on('end', () => {
                res.statusCode = 500;
                res.setHeader('content-type', 'text/plain; charset=utf-8');
                res.end('isolated mapping E2E expects zero upstream requests');
            });
        });
        const upstreamPort = await new Promise<number>((resolve, reject) => {
            const onError = (error: Error) => reject(error);
            upstream!.once('error', onError);
            upstream!.listen(0, backendHost, () => {
                const address = upstream!.address();
                if (address && typeof address === 'object') resolve(address.port);
                else reject(new Error('upstream sink did not return a TCP port'));
            });
        });
        (evidence.config as Record<string, unknown>).crown_base_url = `http://${backendHost}:${upstreamPort}`;

        const backendEnv: NodeJS.ProcessEnv = {
            ...process.env,
            NODE_ENV: 'test',
            HOST: backendHost,
            PORT: String(backendPort),
            DB_HOST: dbHost,
            DB_PORT: String(dbPort),
            DB_NAME: isolatedDbName,
            DB_USER: dbUser,
            DB_PASSWORD: dbPassword,
            JWT_SECRET: jwtSecret,
            CROWN_BASE_URL: `http://${backendHost}:${upstreamPort}`,
            CROWN_BASE_URL_CANDIDATES: `http://${backendHost}:${upstreamPort}`,
            CROWN_API_KEEPALIVE_ENABLED: 'false',
            CROWN_ONLINE_CHECK_INTERVAL_MS: '600000',
        };
        backend = startProcess(['dist/app.js'], { cwd: path.resolve(__dirname, '..'), env: backendEnv });
        collectOutput(backend, backendOutput);
        await waitForHttp(`${backendUrl}/api/health`, 'isolated backend');
        evidence.backend_started_at = new Date().toISOString();

        const frontendEnv: NodeJS.ProcessEnv = {
            ...process.env,
            NODE_ENV: 'development',
            BROWSER: 'none',
            CI: 'true',
            VITE_API_URL: `${backendUrl}/api`,
        };
        const viteBin = path.join(repoRoot, 'frontend', 'node_modules', 'vite', 'bin', 'vite.js');
        assertTrue(fs.existsSync(viteBin), 'frontend vite binary exists');
        frontend = startProcess([viteBin, '--host', frontendHost, '--port', String(frontendPort), '--strictPort'], {
            cwd: path.join(repoRoot, 'frontend'),
            env: frontendEnv,
        });
        collectOutput(frontend, frontendOutput);
        await waitForHttp(`${frontendUrl}/auth`, 'isolated frontend');
        evidence.frontend_started_at = new Date().toISOString();
        evidence.frontend_api_url = `${backendUrl}/api`;

        const childEnv: NodeJS.ProcessEnv = {
            ...process.env,
            NODE_ENV: 'test',
            E2E_RUN_ID: runId,
            E2E_BACKEND_URL: backendUrl,
            E2E_FRONTEND_URL: frontendUrl,
            E2E_WHITELABEL_DOMAIN: tenantDomain,
            E2E_ADMIN_USERNAME: adminUsername,
            E2E_ADMIN_PASSWORD: adminPassword,
            PLAYWRIGHT_HEADLESS: 'true',
            DB_NAME: isolatedDbName,
        };
        const tsNodeBin = path.join(repoRoot, 'backend', 'node_modules', 'ts-node', 'dist', 'bin.js');
        assertTrue(fs.existsSync(tsNodeBin), 'backend ts-node binary exists');
        child = startProcess([tsNodeBin, path.join(repoRoot, 'backend', 'scripts', 'test-selection-mapping-e2e.ts')], {
            cwd: path.resolve(__dirname, '..'),
            env: childEnv,
        });
        collectOutput(child, childOutput);
        const childExit = await new Promise<number | null>(resolve => child!.once('exit', resolve));
        childCode = childExit ?? -1;
        evidence.ui_e2e_process = {
            pid: child.pid,
            exit_code: childCode,
            evidence_file: evidenceFile,
        };
        assertEqual(childCode, 0, 'UI mapping E2E subprocess exit code');

        const finalMapping = await queryOne<{ mapping_mode: string; enabled: boolean; version: number }>(db, `
            SELECT mapping_mode, enabled, version::int AS version
            FROM selection_mapping_settings
            WHERE whitelabel_id = $1
        `, [tenant.id]);
        assertEqual(finalMapping.mapping_mode, 'identity', 'orchestrator final mapping mode');
        assertEqual(finalMapping.enabled, false, 'orchestrator final mapping enabled');
        assertEqual(finalMapping.version, 3, 'orchestrator final mapping version');
        const finalAudit = await db.query('SELECT COUNT(*)::int AS count FROM selection_mapping_audit_logs');
        assertEqual(finalAudit.rows[0].count, 2, 'orchestrator final audit count');
        const finalCounts = await getMutationCounts(db);
        assertEqual(finalCounts.bets, initialCounts.bets, 'orchestrator final bets count unchanged');
        assertEqual(finalCounts.coin_transactions, initialCounts.coin_transactions, 'orchestrator final transactions count unchanged');
        assertEqual(finalCounts.matches, initialCounts.matches, 'orchestrator final matches count unchanged');
        assertEqual(upstreamHits.length, 0, 'controlled upstream request count');
        evidence.final_isolated_state = {
            mapping: finalMapping,
            audit_count: finalAudit.rows[0].count,
            mutation_counts: finalCounts,
            upstream_hits: upstreamHits,
        };
    } catch (error) {
        mainError = error;
        failures.push(String((error as any)?.stack || error));
    } finally {
        await stopProcess(child, 'ui_e2e');
        await stopProcess(frontend, 'frontend');
        await stopProcess(backend, 'backend');
        await new Promise(resolve => upstream ? upstream.close(resolve) : resolve(undefined));
        upstream = undefined;

        fs.writeFileSync(path.join(evidenceDir, 'backend.stdout.log'), backendOutput.stdout, 'utf8');
        fs.writeFileSync(path.join(evidenceDir, 'backend.stderr.log'), backendOutput.stderr, 'utf8');
        fs.writeFileSync(path.join(evidenceDir, 'frontend.stdout.log'), frontendOutput.stdout, 'utf8');
        fs.writeFileSync(path.join(evidenceDir, 'frontend.stderr.log'), frontendOutput.stderr, 'utf8');
        fs.writeFileSync(path.join(evidenceDir, 'ui-e2e.stdout.log'), childOutput.stdout, 'utf8');
        fs.writeFileSync(path.join(evidenceDir, 'ui-e2e.stderr.log'), childOutput.stderr, 'utf8');

        let isolatedDropped = false;
        if (db) {
            try { await db.end(); } catch { }
            db = undefined;
        }
        if (admin) {
            try {
                await dropIsolatedDatabase(admin);
                isolatedDropped = true;
            } catch (error) {
                failures.push(`drop isolated database: ${String((error as any)?.stack || error)}`);
            }
            try { await admin.end(); } catch { }
            admin = undefined;
        }
        if (guardAdmin) {
            try { await guardAdmin.end(); } catch { }
            guardAdmin = undefined;
        }
        try {
            const guardClient = await connect(guardDbName);
            guardAfter = await getGuardSnapshot(guardClient);
            await guardClient.end();
            evidence.guard_after = guardAfter;
            if (guardBefore) assertEqual(JSON.stringify(guardAfter), JSON.stringify(guardBefore), 'development database guard snapshot unchanged');
        } catch (error) {
            failures.push(`development guard after: ${String((error as any)?.stack || error)}`);
        }
        try {
            assertTrue(await canBind(backendHost, backendPort), 'backend port is free after cleanup');
            assertTrue(await canBind(frontendHost, frontendPort), 'frontend port is free after cleanup');
        } catch (error) {
            failures.push(`port cleanup: ${String((error as any)?.stack || error)}`);
        }
        assertEqual(isolatedDropped, true, 'isolated database dropped');

        evidence.cleanup = {
            backend_stopped: !backend || backend.exitCode !== null || backend.signalCode !== null,
            frontend_stopped: !frontend || frontend.exitCode !== null || frontend.signalCode !== null,
            upstream_stopped: true,
            isolated_database_dropped: isolatedDropped,
            backend_port_free: await canBind(backendHost, backendPort),
            frontend_port_free: await canBind(frontendHost, frontendPort),
        };
        evidence.finished_at = new Date().toISOString();
        evidence.assertions = { passed, failed: failures.length, failures };
        evidence.success = failures.length === 0;

        try {
            const childEvidence = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'));
            const childAssertions = childEvidence.assertions || { passed: 0, failed: 0 };
            childEvidence.isolation = evidence;
            childEvidence.assertions = {
                passed: num(childAssertions.passed) + passed,
                failed: num(childAssertions.failed) + failures.length,
                failures: [...(childAssertions.failures || []), ...failures],
            };
            childEvidence.success = childEvidence.success === true && evidence.success === true;
            fs.writeFileSync(evidenceFile, JSON.stringify(childEvidence, null, 2), 'utf8');
            fs.writeFileSync(path.join(path.dirname(evidenceDir), 'latest-run-id.txt'), runId, 'utf8');
            fs.writeFileSync(path.join(path.dirname(evidenceDir), 'latest.json'), JSON.stringify(childEvidence, null, 2), 'utf8');
        } catch (error) {
            failures.push(`merge UI evidence: ${String((error as any)?.stack || error)}`);
            fs.writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2), 'utf8');
        }
    }

    if (mainError || failures.length > 0) {
        throw mainError || new Error(failures.join('\n'));
    }
}

main().catch(error => {
    console.error(String((error as any)?.stack || error));
    process.exit(1);
}).then(() => {
    const combined = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'));
    console.log(JSON.stringify({
        success: true,
        run_id: runId,
        evidence: path.relative(repoRoot, evidenceFile),
        assertions: combined.assertions,
    }, null, 2));
});
