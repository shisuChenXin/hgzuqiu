/// <reference lib="dom" />
import { chromium, type Browser, type Page } from 'playwright';
import { Client } from 'pg';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

function requiredEnv(key: string): string {
    const value = String(process.env[key] ?? '').trim();
    if (!value) throw new Error(`Missing required ${key}; mapping E2E must run in its isolated environment`);
    return value;
}
const backendUrl = requiredEnv('E2E_BACKEND_URL').replace(/\/$/, '');
const frontendUrl = requiredEnv('E2E_FRONTEND_URL').replace(/\/$/, '');
const whitelabelDomain = requiredEnv('E2E_WHITELABEL_DOMAIN');
const adminUsername = requiredEnv('E2E_ADMIN_USERNAME');
const adminPassword = requiredEnv('E2E_ADMIN_PASSWORD');
const headless = !['0', 'false', 'no', 'off'].includes(String(process.env.PLAYWRIGHT_HEADLESS || 'true').toLowerCase());
const repoRoot = path.resolve(__dirname, '../..');
const runId = process.env.E2E_RUN_ID || `${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')}-${process.pid}`;
const screenshotDir = path.join(repoRoot, '测试截图', 'selection-mapping-e2e', runId);
const evidenceDir = path.join(repoRoot, '证据', 'selection-mapping-e2e', runId);
const evidenceFile = path.join(evidenceDir, 'result.json');
const isolatedDatabaseName = String(process.env.DB_NAME || '');
if (!/^hgzuqiu_mapping_e2e_\d+$/.test(isolatedDatabaseName)) {
    throw new Error(`Refusing non-isolated DB_NAME for mapping E2E: ${isolatedDatabaseName || '<empty>'}`);
}

type Whitelabel = { id: number; name: string; domain: string; status: string; is_default: boolean };
type UserSnapshot = { id: number; username: string; role: string; whitelabel_id: number | null };
type MappingRow = { mapping_mode: 'identity' | 'inverse'; enabled: boolean; version: number; updated_by: number | null };
type AccountRow = { id: number; username: string; credit: number; discount: number; is_enabled: boolean; is_online: boolean };
type FixtureBet = {
    id: number;
    account_id: number;
    match_id: number;
    league_name: string;
    home_team: string;
    away_team: string;
    displayed_market_side: string;
    executed_market_side: string;
    displayed_market_rtype: string;
    executed_market_rtype: string;
    displayed_market_chose_team: string;
    executed_market_chose_team: string;
    mapping_mode: 'identity' | 'inverse';
    mapping_version: number;
    mapping_applied: boolean;
};
type MutationCounts = { bets: number; coin_transactions: number; matches: number; max_bet_id: number; max_transaction_id: number; max_match_id: number };
type AuditRow = {
    whitelabel_id: number;
    from_mode: string;
    to_mode: string;
    from_enabled: boolean;
    to_enabled: boolean;
    from_version: number;
    to_version: number;
    operator_user_id: number | null;
    reason: string | null;
};
type Evidence = Record<string, unknown>;

const evidence: Evidence = {
    run_id: runId,
    started_at: new Date().toISOString(),
    config: {
        backend_url: backendUrl,
        frontend_url: frontendUrl,
        whitelabel_domain: whitelabelDomain,
        isolated_database: isolatedDatabaseName,
        admin_username: adminUsername,
        playwright_headless: headless,
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
    if (!Number.isFinite(parsed)) {
        throw new Error(`Expected finite number, got ${String(value)}`);
    }
    return parsed;
}

async function requestHealth(): Promise<void> {
    const health = await fetch(`${backendUrl}/api/health`);
    assertEqual(health.status, 200, 'backend health HTTP status');
    const authPage = await fetch(`${frontendUrl}/auth`);
    assertEqual(authPage.status, 200, 'frontend auth page HTTP status');
}

async function queryOne<T>(db: Client, sql: string, params: unknown[] = []): Promise<T> {
    const result = await db.query(sql, params);
    if (result.rowCount !== 1) {
        throw new Error(`Expected exactly one row for ${sql}, got ${result.rowCount}`);
    }
    return result.rows[0] as T;
}

async function getMutationCounts(db: Client): Promise<MutationCounts> {
    const row = await queryOne<{ bets: string; coin_transactions: string; matches: string; max_bet_id: string | null; max_transaction_id: string | null; max_match_id: string | null }>(db, `
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

async function readSwitch(page: Page): Promise<boolean> {
    return page.$eval('[role="switch"]', node => node.classList.contains('ant-switch-checked'));
}

async function selectMappingMode(page: Page, mode: 'identity' | 'inverse'): Promise<void> {
    await page.locator('#mode').click({ force: true });
    const label = mode === 'inverse' ? 'inverse：主客/大小互换' : 'identity：展示=执行';
    await page.locator(`.ant-select-item-option[title="${label}"]`).click();
    await page.waitForTimeout(100);
}

async function main(): Promise<void> {
    fs.mkdirSync(screenshotDir, { recursive: true });
    fs.mkdirSync(evidenceDir, { recursive: true });

    await requestHealth();

    const requiredDatabaseEnv = ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'];
    for (const key of requiredDatabaseEnv) {
        if (!process.env[key]) {
            throw new Error(`Missing ${key} in backend/.env`);
        }
    }

    const db = new Client({
        host: process.env.DB_HOST,
        port: num(process.env.DB_PORT),
        database: process.env.DB_NAME,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
    });
    await db.connect();
    evidence.db_connected_at = new Date().toISOString();

    try {
        const whitelabel = await queryOne<Whitelabel>(db, `
            SELECT id, name, domain, status, is_default
            FROM whitelabels
            WHERE domain = $1
        `, [whitelabelDomain]);
        assertEqual(whitelabel.status, 'active', 'target whitelabel status');
        assertTrue(!whitelabel.is_default, 'target whitelabel is non-default');

        const originalAdmin = await queryOne<UserSnapshot>(db, `
            SELECT id, username, role, whitelabel_id
            FROM users
            WHERE username = $1
        `, [adminUsername]);
        assertEqual(originalAdmin.role, 'admin', 'E2E admin role');
        evidence.initial_state = {
            whitelabel,
            admin: originalAdmin,
            mutation_counts: await getMutationCounts(db),
        };

        const initialCounts = await getMutationCounts(db);
        await db.query(`
            UPDATE users
            SET whitelabel_id = $2, updated_at = CURRENT_TIMESTAMP
            WHERE id = $1
        `, [originalAdmin.id, whitelabel.id]);

        const account = await queryOne<AccountRow>(db, `
            SELECT ca.id, ca.username, ca.credit::float8 AS credit, ca.discount::float8 AS discount, ca.is_enabled, ca.is_online
            FROM crown_accounts ca
            JOIN users u ON u.id = ca.user_id
            WHERE u.whitelabel_id = $1
              AND ca.is_enabled = TRUE
              AND ca.credit > 0
            ORDER BY ca.id
            LIMIT 1
        `, [whitelabel.id]);
        assertTrue(account.credit >= 50, 'selected account has enough credit for the local minimum split');

        const fixture = await queryOne<FixtureBet>(db, `
            SELECT
                b.id, b.account_id, b.match_id,
                m.league_name, m.home_team, m.away_team,
                b.displayed_market_side, b.executed_market_side,
                b.displayed_market_rtype, b.executed_market_rtype,
                b.displayed_market_chose_team, b.executed_market_chose_team,
                b.mapping_mode, b.mapping_version::int AS mapping_version, b.mapping_applied
            FROM bets b
            JOIN matches m ON m.id = b.match_id
            WHERE b.whitelabel_id = $1
              AND b.mapping_applied = TRUE
              AND b.displayed_market_side IS NOT NULL
              AND b.executed_market_side IS NOT NULL
              AND b.displayed_market_rtype IS NOT NULL
              AND b.executed_market_rtype IS NOT NULL
              AND b.displayed_market_chose_team IS NOT NULL
              AND b.executed_market_chose_team IS NOT NULL
            ORDER BY b.created_at DESC, b.id DESC
            LIMIT 1
        `, [whitelabel.id]);
        assertEqual(fixture.mapping_mode, 'inverse', 'fixture bet historical mapping mode');

        const initialMapping = await queryOne<MappingRow>(db, `
            UPDATE selection_mapping_settings
            SET mapping_mode = 'identity',
                enabled = FALSE,
                updated_by = $2,
                updated_at = CURRENT_TIMESTAMP
            WHERE whitelabel_id = $1
            RETURNING mapping_mode, enabled, version::int AS version, updated_by
        `, [whitelabel.id, originalAdmin.id]);
        evidence.test_setup = {
            account: { ...account, password: undefined },
            fixture_bet: fixture,
            forced_initial_mapping: initialMapping,
        };

        let browser: Browser | undefined;
        try {
            browser = await chromium.launch({ headless });
            const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
            page.setDefaultTimeout(20000);

            await page.goto(`${frontendUrl}/auth`, { waitUntil: 'domcontentloaded' });
            await page.getByPlaceholder('请输入用户名').fill(adminUsername);
            await page.getByPlaceholder('请输入密码').fill(adminPassword);
            await page.getByPlaceholder('白标域名（默认站点可留空）').fill(whitelabel.domain);
            await page.getByRole('button', { name: '登 录' }).click();
            await page.waitForURL(/dashboard/);
            const storedDomain = await page.evaluate(() => window.localStorage.getItem('whitelabelDomain'));
            assertEqual(storedDomain, whitelabel.domain, 'browser localStorage tenant domain');

            await page.goto(`${frontendUrl}/whitelabels`, { waitUntil: 'domcontentloaded' });
            await page.getByText(whitelabel.name).first().click();
            await page.getByText(`选择映射配置：${whitelabel.name} / ${whitelabel.domain}`).waitFor();
            assertEqual(await readSwitch(page), false, 'initial mapping switch is off');

            await selectMappingMode(page, 'inverse');
            if (!(await readSwitch(page))) {
                await page.getByRole('switch').click({ force: true });
            }
            await page.waitForFunction(() => {
                const node = document.querySelector('[role="switch"]');
                return !!node && node.classList.contains('ant-switch-checked');
            });
            const inverseReason = `selection mapping e2e enable ${runId}`;
            await page.getByLabel('变更原因（写入审计）').fill(inverseReason);
            const inverseResponsePromise = page.waitForResponse(response =>
                response.url().includes(`/api/whitelabels/${whitelabel.id}/mapping`) &&
                response.request().method() === 'PUT'
            );
            await page.getByRole('button', { name: /保存并生成新版本/ }).click();
            const inverseHttp = await inverseResponsePromise;
            const inverseJson = await inverseHttp.json();
            const expectedInverseVersion = initialMapping.version + 1;
            assertEqual(inverseHttp.status(), 200, 'enable mapping HTTP status');
            assertEqual(inverseJson.success, true, 'enable mapping API success');
            assertEqual(inverseJson.data.mapping_mode, 'inverse', 'enable mapping mode');
            assertEqual(inverseJson.data.enabled, true, 'enable mapping switch');
            assertEqual(num(inverseJson.data.version), expectedInverseVersion, 'enable mapping version increment');
            await page.getByText(`当前版本 v${expectedInverseVersion}`).waitFor();
            const inverseScreenshot = path.join(screenshotDir, '01-inverse-enabled.png');
            await page.screenshot({ path: inverseScreenshot, fullPage: true });

            const inverseAudit = await queryOne<AuditRow>(db, `
                SELECT whitelabel_id, from_mode, to_mode, from_enabled, to_enabled,
                       from_version::int AS from_version, to_version::int AS to_version, operator_user_id, reason
                FROM selection_mapping_audit_logs
                WHERE whitelabel_id = $1
                ORDER BY created_at DESC, id DESC
                LIMIT 1
            `, [whitelabel.id]);
            assertEqual(inverseAudit.from_mode, 'identity', 'enable audit from mode');
            assertEqual(inverseAudit.to_mode, 'inverse', 'enable audit to mode');
            assertEqual(inverseAudit.from_enabled, false, 'enable audit from enabled');
            assertEqual(inverseAudit.to_enabled, true, 'enable audit to enabled');
            assertEqual(inverseAudit.from_version, initialMapping.version, 'enable audit from version');
            assertEqual(inverseAudit.to_version, expectedInverseVersion, 'enable audit to version');
            assertEqual(inverseAudit.operator_user_id, originalAdmin.id, 'enable audit operator');
            assertEqual(inverseAudit.reason, inverseReason, 'enable audit reason');

            await db.query('UPDATE crown_accounts SET is_online = TRUE WHERE id = $1', [account.id]);
            const dryRunTargetVirtual = Math.min(account.credit, Math.max(50, account.credit * 0.8));
            const safeDryRunAmount = Math.max(1, Math.floor(dryRunTargetVirtual * account.discount));
            const dryRunPayload = {
                account_ids: [account.id],
                match_id: fixture.match_id,
                league_name: fixture.league_name,
                home_team: fixture.home_team,
                away_team: fixture.away_team,
                match_time: new Date().toISOString(),
                match_status: 'scheduled',
                bet_type: '让球',
                bet_option: '主队',
                odds: 1.9,
                total_amount: safeDryRunAmount,
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
            const dryRunResult = await page.evaluate(async (args: { api: string; payload: unknown }) => {
                const browserGlobal = globalThis as unknown as {
                    localStorage: { getItem(key: string): string | null };
                    fetch(input: string, init: Record<string, unknown>): Promise<{ status: number; json(): Promise<unknown> }>;
                };
                const token = browserGlobal.localStorage.getItem('token');
                const tenant = browserGlobal.localStorage.getItem('whitelabelDomain');
                const response = await browserGlobal.fetch(`${args.api}/api/bets`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${token}`,
                        'x-whitelabel-domain': String(tenant),
                    },
                    body: JSON.stringify(args.payload),
                });
                return { status: response.status, body: await response.json() };
            }, { api: backendUrl, payload: dryRunPayload });

            evidence.dry_run = { payload: dryRunPayload, result: dryRunResult };
            const dryRunData = (dryRunResult.body as any).data;
            assertEqual(dryRunResult.status, 200, 'dry-run HTTP status');
            assertEqual((dryRunResult.body as any).success, true, 'dry-run API success');
            assertEqual(dryRunData.dry_run, true, 'dry-run flag');
            assertEqual(dryRunData.queued, 0, 'dry-run queued count');
            assertEqual(dryRunData.processing, 0, 'dry-run processing count');
            assertEqual(dryRunData.cancelled, 0, 'dry-run cancelled count');
            assertEqual(Array.isArray(dryRunData.bet_ids) && dryRunData.bet_ids.length, 0, 'dry-run created bet count');
            assertTrue(Array.isArray(dryRunData.planned_splits) && dryRunData.planned_splits.length > 0, 'dry-run planned splits present');
            assertEqual(dryRunData.selection_mapping.whitelabel_id, whitelabel.id, 'dry-run mapping tenant');
            assertEqual(dryRunData.selection_mapping.mapping_mode, 'inverse', 'dry-run mapping mode');
            assertEqual(dryRunData.selection_mapping.mapping_enabled, true, 'dry-run mapping enabled');
            assertEqual(dryRunData.selection_mapping.mapping_applied, true, 'dry-run mapping applied');
            assertEqual(num(dryRunData.selection_mapping.mapping_version), expectedInverseVersion, 'dry-run mapping version');
            assertEqual(dryRunData.selection_mapping.displayed_market_side, fixture.displayed_market_side, 'dry-run displayed side');
            assertEqual(dryRunData.selection_mapping.executed_market_side, fixture.executed_market_side, 'dry-run executed side');
            assertEqual(dryRunData.selection_mapping.displayed_market_rtype, fixture.displayed_market_rtype, 'dry-run displayed rtype');
            assertEqual(dryRunData.selection_mapping.executed_market_rtype, fixture.executed_market_rtype, 'dry-run executed rtype');
            assertEqual(dryRunData.selection_mapping.displayed_market_chose_team, fixture.displayed_market_chose_team, 'dry-run displayed team');
            assertEqual(dryRunData.selection_mapping.executed_market_chose_team, fixture.executed_market_chose_team, 'dry-run executed team');

            const afterDryRunCounts = await getMutationCounts(db);
            assertEqual(afterDryRunCounts.bets, initialCounts.bets, 'dry-run did not change bets count');
            assertEqual(afterDryRunCounts.coin_transactions, initialCounts.coin_transactions, 'dry-run did not change coin transactions count');
            assertEqual(afterDryRunCounts.matches, initialCounts.matches, 'dry-run did not change matches count');
            assertEqual(afterDryRunCounts.max_bet_id, initialCounts.max_bet_id, 'dry-run did not change max bet id');
            assertEqual(afterDryRunCounts.max_transaction_id, initialCounts.max_transaction_id, 'dry-run did not change max transaction id');
            assertEqual(afterDryRunCounts.max_match_id, initialCounts.max_match_id, 'dry-run did not change max match id');

            const betsResponsePromise = page.waitForResponse(response =>
                response.url().includes('/api/bets?') &&
                response.request().method() === 'GET'
            );
            await page.goto(`${frontendUrl}/betting`, { waitUntil: 'domcontentloaded' });
            const betsHttp = await betsResponsePromise;
            const betsJson = await betsHttp.json();
            assertEqual(betsHttp.status(), 200, 'betting page bets API HTTP status');
            assertEqual(betsJson.success, true, 'betting page bets API success');
            const targetBet = (betsJson.data.bets as any[]).find(item => num(item.id) === fixture.id);
            assertTrue(Boolean(targetBet), `fixture bet ${fixture.id} returned to BettingPage`);
            assertEqual(targetBet.displayed_market_side, fixture.displayed_market_side, 'betting API displayed side');
            assertEqual(targetBet.executed_market_side, fixture.executed_market_side, 'betting API executed side');
            assertEqual(targetBet.displayed_market_rtype, fixture.displayed_market_rtype, 'betting API displayed rtype');
            assertEqual(targetBet.executed_market_rtype, fixture.executed_market_rtype, 'betting API executed rtype');
            assertEqual(targetBet.displayed_market_chose_team, fixture.displayed_market_chose_team, 'betting API displayed team');
            assertEqual(targetBet.executed_market_chose_team, fixture.executed_market_chose_team, 'betting API executed team');
            assertEqual(targetBet.mapping_mode, fixture.mapping_mode, 'betting API historical mapping mode');
            assertEqual(num(targetBet.mapping_version), fixture.mapping_version, 'betting API historical mapping version');
            assertEqual(targetBet.mapping_applied, fixture.mapping_applied, 'betting API historical mapping applied');

            await page.getByText(fixture.league_name).first().waitFor();
            await page.getByRole('button', { name: /展开/ }).first().click();
            const mappingTag = page.getByText(`${fixture.displayed_market_side} -> ${fixture.executed_market_side}`).first();
            await mappingTag.waitFor();
            await mappingTag.scrollIntoViewIfNeeded();
            await mappingTag.hover();
            await page.getByText(`rtype: ${fixture.displayed_market_rtype} -> ${fixture.executed_market_rtype}`).waitFor();
            await page.getByText(`chose_team: ${fixture.displayed_market_chose_team} -> ${fixture.executed_market_chose_team}`).waitFor();
            await page.getByText(`tenant: #${whitelabel.id}`).waitFor();
            await page.getByText(`mode: ${fixture.mapping_mode}`).waitFor();
            await page.getByText(`version: v${fixture.mapping_version}`).waitFor();
            const bettingScreenshot = path.join(screenshotDir, '02-betting-display-executed.png');
            await page.screenshot({ path: bettingScreenshot, fullPage: true });

            evidence.enable_mapping = {
                http_status: inverseHttp.status(),
                response: inverseJson,
                audit: inverseAudit,
                screenshot: path.relative(repoRoot, inverseScreenshot),
            };
            evidence.dry_run = {
                payload: dryRunPayload,
                result: dryRunResult,
                mutation_counts_before: initialCounts,
                mutation_counts_after: afterDryRunCounts,
            };
            evidence.betting_page = {
                fixture_bet_id: fixture.id,
                api_bet: targetBet,
                tooltip_assertions: [
                    `${fixture.displayed_market_side} -> ${fixture.executed_market_side}`,
                    `rtype: ${fixture.displayed_market_rtype} -> ${fixture.executed_market_rtype}`,
                    `chose_team: ${fixture.displayed_market_chose_team} -> ${fixture.executed_market_chose_team}`,
                    `tenant: #${whitelabel.id}`,
                    `mode: ${fixture.mapping_mode}`,
                    `version: v${fixture.mapping_version}`,
                ],
                screenshot: path.relative(repoRoot, bettingScreenshot),
            };

            await page.goto(`${frontendUrl}/whitelabels`, { waitUntil: 'domcontentloaded' });
            await page.getByText(whitelabel.name).first().click();
            await page.getByText(`选择映射配置：${whitelabel.name} / ${whitelabel.domain}`).waitFor();
            await selectMappingMode(page, 'identity');
            if (await readSwitch(page)) {
                await page.getByRole('switch').click({ force: true });
            }
            await page.waitForFunction(() => {
                const node = document.querySelector('[role="switch"]');
                return !!node && !node.classList.contains('ant-switch-checked');
            });
            const restoreReason = `selection mapping e2e restore ${runId}`;
            await page.getByLabel('变更原因（写入审计）').fill(restoreReason);
            const restoreResponsePromise = page.waitForResponse(response =>
                response.url().includes(`/api/whitelabels/${whitelabel.id}/mapping`) &&
                response.request().method() === 'PUT'
            );
            await page.getByRole('button', { name: /保存并生成新版本/ }).click();
            const restoreHttp = await restoreResponsePromise;
            const restoreJson = await restoreHttp.json();
            const expectedRestoredVersion = expectedInverseVersion + 1;
            assertEqual(restoreHttp.status(), 200, 'restore mapping HTTP status');
            assertEqual(restoreJson.success, true, 'restore mapping API success');
            assertEqual(restoreJson.data.mapping_mode, 'identity', 'restore mapping mode');
            assertEqual(restoreJson.data.enabled, false, 'restore mapping switch');
            assertEqual(num(restoreJson.data.version), expectedRestoredVersion, 'restore mapping version increment');
            await page.getByText(`当前版本 v${expectedRestoredVersion}`).waitFor();
            const restoreScreenshot = path.join(screenshotDir, '03-identity-restored.png');
            await page.screenshot({ path: restoreScreenshot, fullPage: true });

            const restoreAudit = await queryOne<AuditRow>(db, `
                SELECT whitelabel_id, from_mode, to_mode, from_enabled, to_enabled,
                       from_version::int AS from_version, to_version::int AS to_version, operator_user_id, reason
                FROM selection_mapping_audit_logs
                WHERE whitelabel_id = $1
                ORDER BY created_at DESC, id DESC
                LIMIT 1
            `, [whitelabel.id]);
            assertEqual(restoreAudit.from_mode, 'inverse', 'restore audit from mode');
            assertEqual(restoreAudit.to_mode, 'identity', 'restore audit to mode');
            assertEqual(restoreAudit.from_enabled, true, 'restore audit from enabled');
            assertEqual(restoreAudit.to_enabled, false, 'restore audit to enabled');
            assertEqual(restoreAudit.from_version, expectedInverseVersion, 'restore audit from version');
            assertEqual(restoreAudit.to_version, expectedRestoredVersion, 'restore audit to version');
            assertEqual(restoreAudit.operator_user_id, originalAdmin.id, 'restore audit operator');
            assertEqual(restoreAudit.reason, restoreReason, 'restore audit reason');
            evidence.restore_mapping = {
                http_status: restoreHttp.status(),
                response: restoreJson,
                audit: restoreAudit,
                screenshot: path.relative(repoRoot, restoreScreenshot),
            };
            evidence.expected_final_version = expectedRestoredVersion;
        } finally {
            if (browser) {
                await browser.close().catch(error => {
                    failures.push(`browser close: ${String(error)}`);
                });
            }
        }
    } finally {
        const initialEvidence = evidence.initial_state as { admin?: UserSnapshot; mutation_counts?: MutationCounts } | undefined;
        const setupEvidence = evidence.test_setup as { account?: AccountRow } | undefined;
        const originalAdmin = initialEvidence?.admin;
        const originalAccount = setupEvidence?.account;
        const baselineCounts = initialEvidence?.mutation_counts;

        await db.query(`
            UPDATE selection_mapping_settings s
            SET mapping_mode = 'identity',
                enabled = FALSE,
                updated_by = users.id,
                updated_at = CURRENT_TIMESTAMP
            FROM whitelabels w
            LEFT JOIN users ON users.username = $2 AND users.role = 'admin'
            WHERE s.whitelabel_id = w.id
              AND w.domain = $1
        `, [whitelabelDomain, adminUsername]);

        if (originalAdmin) {
            await db.query(`
                UPDATE users
                SET whitelabel_id = $2, updated_at = CURRENT_TIMESTAMP
                WHERE id = $1 AND whitelabel_id IS DISTINCT FROM $2
            `, [originalAdmin.id, originalAdmin.whitelabel_id]);
        }
        if (originalAccount) {
            await db.query(`
                UPDATE crown_accounts
                SET is_online = $2
                WHERE id = $1 AND is_online IS DISTINCT FROM $2
            `, [originalAccount.id, originalAccount.is_online]);
        }

        const finalMapping = await queryOne<MappingRow>(db, `
            SELECT s.mapping_mode, s.enabled, s.version::int AS version, s.updated_by
            FROM selection_mapping_settings s
            JOIN whitelabels w ON w.id = s.whitelabel_id
            WHERE w.domain = $1
        `, [whitelabelDomain]);
        const finalAdmin = await queryOne<UserSnapshot>(db, `
            SELECT id, username, role, whitelabel_id
            FROM users
            WHERE username = $1
        `, [adminUsername]);
        const finalCounts = await getMutationCounts(db);
        assertEqual(finalMapping.mapping_mode, 'identity', 'final mapping mode');
        assertEqual(finalMapping.enabled, false, 'final mapping enabled');
        if (evidence.expected_final_version !== undefined) {
            assertEqual(finalMapping.version, num(evidence.expected_final_version), 'final mapping version');
        }
        if (originalAdmin) {
            assertEqual(finalAdmin.whitelabel_id, originalAdmin.whitelabel_id, 'final admin tenant');
        }
        if (baselineCounts) {
            assertEqual(finalCounts.bets, baselineCounts.bets, 'final bets count unchanged');
            assertEqual(finalCounts.coin_transactions, baselineCounts.coin_transactions, 'final transaction count unchanged');
            assertEqual(finalCounts.matches, baselineCounts.matches, 'final matches count unchanged');
        }
        let finalAccount: AccountRow | undefined;
        if (originalAccount) {
            finalAccount = await queryOne<AccountRow>(db, `
                SELECT id, username, credit, discount, is_enabled, is_online
                FROM crown_accounts
                WHERE id = $1
            `, [originalAccount.id]);
            assertEqual(finalAccount.is_online, originalAccount.is_online, 'final account online state');
        }
        evidence.final_state = {
            mapping: finalMapping,
            admin: finalAdmin,
            account: finalAccount,
            mutation_counts: finalCounts,
        };
        evidence.finished_at = new Date().toISOString();
        evidence.assertions = { passed, failed: failures.length, failures };
        evidence.success = failures.length === 0;
        fs.writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2), 'utf8');
        fs.writeFileSync(path.join(path.dirname(evidenceDir), 'latest-run-id.txt'), runId, 'utf8');
        fs.writeFileSync(path.join(path.dirname(evidenceDir), 'latest.json'), JSON.stringify(evidence, null, 2), 'utf8');
        await db.end();
    }

}

main().catch(error => {
    failures.push(String(error?.stack || error));
    console.error(JSON.stringify({
        success: false,
        run_id: runId,
        evidence: evidenceFile,
        assertions: { passed, failed: failures.length, failures },
    }, null, 2));
    process.exit(1);
}).then(() => {
    if (failures.length > 0) {
        process.exit(1);
    }
    console.log(JSON.stringify({
        success: true,
        run_id: runId,
        evidence: path.relative(repoRoot, evidenceFile),
        screenshots: path.relative(repoRoot, screenshotDir),
        assertions: { passed, failed: 0 },
    }, null, 2));
});
