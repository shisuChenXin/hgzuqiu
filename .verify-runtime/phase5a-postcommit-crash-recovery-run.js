'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const { createRequire } = require('module');

const deployRoot = path.resolve(__dirname, '..');
const mainRepo = path.resolve(deployRoot, '..', 'hgzuqiu');
const backendDir = path.join(deployRoot, 'backend');
const backendEnvFile = fs.existsSync(path.join(deployRoot, 'backend', '.env'))
  ? path.join(deployRoot, 'backend', '.env')
  : path.join(mainRepo, 'backend', '.env');
const backendRequire = createRequire(path.join(backendDir, 'package.json'));
const { Client } = backendRequire('pg');
const bcrypt = backendRequire('bcrypt');

const matrixStartedAt = new Date();
const matrixRunId = `${formatBeijingTimestamp(matrixStartedAt)}-${process.pid}`;
const evidenceRoot = path.join(deployRoot, '证据', 'phase5a-postcommit-crash-recovery', matrixRunId);
const reportDir = path.join(deployRoot, '报告');
const targetPorts = [3301, 3202, 3203];
const urls = {
  mock: 'http://127.0.0.1:3301',
  backendA: 'http://127.0.0.1:3202',
  backendB: 'http://127.0.0.1:3203',
};
const holdMs = 5000;
const restartObservationMs = 5000;
const matchTime = new Date(Date.now() + 2 * 60 * 60 * 1000);
const fixtures = {
  crashed: { id: 950001, gid: '950001', league: 'Phase5A Crash League', home: 'Phase5A Crash Home', away: 'Phase5A Crash Away' },
  control: { id: 950002, gid: '950002', league: 'Phase5A Control League', home: 'Phase5A Control Home', away: 'Phase5A Control Away' },
};
const markets = {
  cornerFull: {
    handicapLines: [{ hdp: '1', line: '1', home: '1.90', away: '1.90', __meta: { gid: 'fixture', hgid: 'fixture', isMaster: 'Y', mode: 'CN' } }],
  },
};
const matrixResult = {
  phase: 'phase5a-postcommit-crash-recovery',
  matrix_run_id: matrixRunId,
  matrix_started_at_utc: matrixStartedAt.toISOString(),
  matrix_started_at_beijing: beijingTime(matrixStartedAt),
  checked_at_utc: null,
  checked_at_beijing: null,
  git_commit: gitRevision(),
  expected_cycles: 5,
  completed_cycles: 0,
  databases: [],
  evidence_dir: path.relative(deployRoot, evidenceRoot),
  assertions: [],
  fatal_errors: [],
  summary: {},
  report_file: null,
  success: false,
  runner_success_criterion: 'All five fresh local databases conclusively reproduce the characterized post-commit crash state; this is not a product-recovery pass criterion.',
};
const fatal = [];

function formatBeijingTimestamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(date);
  const get = type => parts.find(part => part.type === type).value;
  return `${get('year')}${get('month')}${get('day')}T${get('hour')}${get('minute')}${get('second')}`;
}
function beijingTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(date);
  const get = type => parts.find(part => part.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')} +08:00`;
}
function gitRevision() {
  return spawnSync('git', ['rev-parse', 'HEAD'], { cwd: deployRoot, encoding: 'utf8', windowsHide: true }).stdout.trim();
}
function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function writeJson(file, value) { ensureDir(path.dirname(file)); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
function evidencePath(ctx, name) { return path.join(ctx.evidenceDir, name); }
function parseEnvFile(file) {
  const map = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (match) map[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
  }
  return map;
}
function requiredEnv(map, key) { const value = map[key]; if (!value) throw new Error(`missing ${key}`); return value; }
function dbConfig(database) {
  const map = parseEnvFile(backendEnvFile);
  return { host: requiredEnv(map, 'DB_HOST'), port: Number(requiredEnv(map, 'DB_PORT')), user: requiredEnv(map, 'DB_USER'), password: requiredEnv(map, 'DB_PASSWORD'), database, ssl: false };
}
async function connectDb(database) { const client = new Client(dbConfig(database)); await client.connect(); return client; }
function probePort(host, port, timeout = 400) {
  return new Promise(resolve => {
    const socket = net.connect({ host, port });
    socket.setTimeout(timeout);
    const finish = result => { socket.destroy(); resolve(result); };
    socket.once('connect', () => finish(true)); socket.once('timeout', () => finish(false)); socket.once('error', () => finish(false));
  });
}
async function targetPortsOpen() { const output = []; for (const port of targetPorts) if (await probePort('127.0.0.1', port)) output.push(port); return output; }
async function waitHttpOk(url, timeout = 40000) {
  const deadline = Date.now() + timeout; let lastError;
  while (Date.now() < deadline) {
    try { const response = await fetch(url, { cache: 'no-store' }); if (response.ok) return { status: response.status }; lastError = new Error(`HTTP ${response.status}`); }
    catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw lastError || new Error(`timeout waiting for ${url}`);
}
async function waitFor(condition, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs; let lastValue;
  while (Date.now() < deadline) { lastValue = await condition(); if (lastValue === true) return true; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`timeout waiting for ${label}; lastValue=${JSON.stringify(lastValue)}`);
}
function sha256File(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function watchedHashMap() {
  const files = ['backend/src/app.ts','backend/src/models/database.ts','backend/src/routes/auth.ts','backend/src/routes/bets.ts','backend/src/services/account-selection.ts','database/schema.sql','database/migrations/20261017_add_bet_idempotency_requests.sql','.verify-runtime/phase5a-postcommit-crash-recovery-run.js'];
  return Object.fromEntries(files.map(file => [file, sha256File(path.join(deployRoot, file))]));
}
function canonical(value) { if (Array.isArray(value)) return value.map(canonical); if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])); return value; }
function same(left, right) { return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right)); }
const SENSITIVE_JSON_KEYS = /^(?:token|password|authorization|access_token|refresh_token|secret)$/i;
function redactSensitive(value, key = '') { if (SENSITIVE_JSON_KEYS.test(key)) return '<redacted>'; if (Array.isArray(value)) return value.map(item => redactSensitive(item)); if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redactSensitive(entryValue, entryKey)])); return value; }
function evidenceFiles(rootDir, extensions = /\.(?:json|jsonl|txt|md)$/i) { const output = []; function walk(dir) { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) walk(full); else if (extensions.test(entry.name)) output.push(full); } } walk(rootDir); return output.sort(); }
function scanEvidenceSecrets(rootDir, knownSecrets) {
  const jwtPattern = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g; const findings = [];
  for (const file of evidenceFiles(rootDir)) {
    const text = fs.readFileSync(file, 'utf8'); const jwtMatches = text.match(jwtPattern) || [];
    if (jwtMatches.length) findings.push({ file: path.relative(rootDir, file), kind: 'jwt-like', count: jwtMatches.length });
    const bearerMatches = text.match(/Bearer\s+[A-Za-z0-9._~+/=-]{20,}/gi) || [];
    if (bearerMatches.length) findings.push({ file: path.relative(rootDir, file), kind: 'bearer-like', count: bearerMatches.length });
    for (const [kind, secret] of Object.entries(knownSecrets)) if (secret && secret.length >= 8 && text.includes(secret)) findings.push({ file: path.relative(rootDir, file), kind, count: 1 });
  }
  return findings;
}
function scanNonLoopbackUrls(rootDir) {
  const pattern = /\b(?:https?|wss?):\/\/[^\s"'<>)]+/g; const findings = [];
  for (const file of evidenceFiles(rootDir)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const raw of text.match(pattern) || []) { try { const host = new URL(raw).hostname; if (!['127.0.0.1','localhost','::1'].includes(host)) findings.push({ file: path.relative(rootDir, file), url: raw.slice(0, 180), host }); } catch { findings.push({ file: path.relative(rootDir, file), url: raw.slice(0, 180), host: null }); } }
  }
  return findings;
}

const SENSITIVE_PARAM_KEYS = /^(?:pass(word)?|passcode|pwd|token|secret)$/i;
function sanitizeParams(params) {
  const out = {};
  for (const [key, value] of Object.entries(params || {})) out[key] = SENSITIVE_PARAM_KEYS.test(key) ? '<redacted>' : value;
  return out;
}
function parseParams(req, body) {
  const parsed = new URLSearchParams(body || '');
  const url = new URL(req.url, 'http://127.0.0.1');
  for (const [key, value] of url.searchParams.entries()) if (!parsed.has(key)) parsed.append(key, value);
  return Object.fromEntries(parsed.entries());
}
function appendJsonl(file, value) { fs.appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8'); }
function createHoldingMockUpstream({ logFile, ticketPrefix, delayMs }) {
  const events = [];
  let ticketIndex = 0;
  const server = require('http').createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const params = parseParams(req, body);
      const action = String(params.p || '');
      const requestId = `mock-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
      const baseEvent = {
        event: 'request_received', at: new Date().toISOString(), request_id: requestId,
        remote_address: req.socket.remoteAddress || '', method: req.method, url: req.url, action,
        content_type: req.headers['content-type'] || '', params: sanitizeParams(params),
      };
      let status = 200, contentType = 'application/xml; charset=utf-8', responseBody = '';
      if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
        contentType = 'text/html; charset=utf-8'; responseBody = `<html><script>top.ver='phase5a-local-holding-mock'</script></html>`;
      } else if (action === 'chk_login') {
        responseBody = '<serverresponse><msg>100</msg><uid>phase5a-mock-uid</uid></serverresponse>';
      } else if (action === 'FT_order_view') {
        responseBody = '<serverresponse><code>501</code><ioratio>1.90</ioratio><ratio>1900</ratio><con>1</con><spread>1</spread></serverresponse>';
      } else if (action === 'FT_bet') {
        ticketIndex += 1;
        const ticketId = `${ticketPrefix}-${String(ticketIndex).padStart(3, '0')}`;
        baseEvent.ticket_id = ticketId;
        baseEvent.hold_first_ft_bet = ticketIndex === 1;
        responseBody = `<serverresponse><code>560</code><ticket_id>${ticketId}</ticket_id><ioratio>1.90</ioratio><gold>80</gold></serverresponse>`;
        events.push(baseEvent); appendJsonl(logFile, baseEvent);
        const respond = () => {
          const attempt = {
            event: 'FT_bet_response_attempt', at: new Date().toISOString(), request_id: requestId,
            ticket_id: ticketId, action, delay_ms: ticketIndex === 1 ? delayMs : 0, remote_address: baseEvent.remote_address,
            socket_destroyed_before_response_attempt: Boolean(req.socket.destroyed),
            planned_response_status: status, planned_response_body: responseBody,
          };
          if (!req.socket.destroyed) {
            try { res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' }); res.end(responseBody); attempt.response_end_called = true; }
            catch (error) { attempt.response_end_error = error?.message || String(error); }
          } else attempt.response_end_called = false;
          events.push(attempt); appendJsonl(logFile, attempt);
        };
        if (ticketIndex === 1) setTimeout(respond, delayMs); else respond();
        return;
      } else if (action === 'get_today_wagers') {
        contentType = 'application/json; charset=utf-8'; responseBody = JSON.stringify({ wagers: [] });
      } else {
        status = 500; contentType = 'text/plain; charset=utf-8'; responseBody = `unrecognized phase5a mock action: ${action || '<empty>'}`;
      }
      baseEvent.response_status = status; events.push(baseEvent); appendJsonl(logFile, baseEvent);
      res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' }); res.end(responseBody);
    });
    req.on('error', error => { try { res.writeHead(500, { 'content-type': 'text/plain' }); res.end(`mock request error: ${error.message}`); } catch {} });
  });
  return {
    server, events,
    get ftBetRequests() { return events.filter(item => item.event === 'request_received' && item.action === 'FT_bet'); },
    get ftBetResponseAttempts() { return events.filter(item => item.event === 'FT_bet_response_attempt'); },
  };
}
function startLogChild(file, command, args, options) {
  ensureDir(path.dirname(file)); fs.writeFileSync(file, ''); const child = spawn(command, args, { ...options, windowsHide: true }); const stream = fs.openSync(file, 'a');
  child.stdout.on('data', chunk => fs.writeSync(stream, chunk)); child.stderr.on('data', chunk => fs.writeSync(stream, chunk)); child.once('exit', () => fs.closeSync(stream, () => undefined)); return child;
}
function buildBackend(ctx) {
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const build = spawnSync(process.execPath, [npmCli, 'run', 'build'], { cwd: backendDir, encoding: 'utf8', windowsHide: true, timeout: 120000 });
  fs.writeFileSync(evidencePath(ctx, 'backend-build-result.txt'), [`CYCLE=${ctx.cycleIndex}`, `STARTED_AT_UTC=${ctx.startedAt.toISOString()}`, 'COMMAND=node <npm-cli.js> run build', `EXIT=${build.status}`, `SPAWN_ERROR=${build.error ? build.error.stack : 'null'}`, `STDOUT\n${build.stdout || ''}`, `STDERR\n${build.stderr || ''}`].join('\n'), 'utf8');
  return { exit_code: build.status };
}
async function guardDbSnapshot() {
  const map = parseEnvFile(backendEnvFile); const baseName = requiredEnv(map, 'DB_NAME'); const client = await connectDb(baseName);
  try {
    const found = await client.query(`SELECT (SELECT COUNT(*) FROM users)::int AS users_count,(SELECT COUNT(*) FROM crown_accounts)::int AS crown_accounts_count,(SELECT COUNT(*) FROM matches)::int AS matches_count,(SELECT COUNT(*) FROM bets)::int AS bets_count,(SELECT COUNT(*) FROM coin_transactions)::int AS coin_transactions_count,(SELECT COALESCE(MAX(id),0) FROM users)::int AS max_users_id,(SELECT COALESCE(MAX(id),0) FROM crown_accounts)::int AS max_crown_accounts_id,(SELECT COALESCE(MAX(id),0) FROM matches)::int AS max_matches_id,(SELECT COALESCE(MAX(id),0) FROM bets)::int AS max_bets_id,(SELECT COALESCE(MAX(id),0) FROM coin_transactions)::int AS max_coin_transactions_id`);
    return { database: baseName, snapshot: found.rows[0], sha256: crypto.createHash('sha256').update(JSON.stringify(canonical(found.rows[0]))).digest('hex') };
  } finally { await client.end(); }
}
async function createAndSeedDatabase(ctx) {
  const admin = await connectDb('postgres');
  try { const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [ctx.database]); if (existing.rowCount !== 0) throw new Error(`database already exists: ${ctx.database}`); await admin.query(`CREATE DATABASE "${ctx.database}"`); } finally { await admin.end(); }
  const client = await connectDb(ctx.database);
  try {
    await client.query(fs.readFileSync(path.join(deployRoot, 'database', 'schema.sql'), 'utf8')); const env = dbConfig(ctx.database);
    const migration = spawnSync(process.execPath, ['migrate.js'], { cwd: backendDir, encoding: 'utf8', windowsHide: true, timeout: 120000, env: { ...process.env, DB_HOST: env.host, DB_PORT: String(env.port), DB_USER: env.user, DB_PASSWORD: env.password, DB_NAME: ctx.database, DOTENV_CONFIG_QUIET: 'true' } });
    fs.writeFileSync(evidencePath(ctx, 'migration-initial-result.txt'), [`STDOUT\n${migration.stdout || ''}`, `STDERR\n${migration.stderr || ''}`, `EXIT=${migration.status}`].join('\n'), 'utf8');
    if (migration.status !== 0) throw new Error(`initial migration failed: ${migration.status}`);
    const passwordHash = await bcrypt.hash(ctx.dbPasswordPlain, 10); await client.query('BEGIN');
    const user = await client.query(`INSERT INTO users (username,email,password_hash,role,whitelabel_id,email_verified,trusted_ips) VALUES ($1,$2,$3,'admin',1,TRUE,$4::text[]) RETURNING id,username,role,whitelabel_id`, [`phase5a-alpha-admin-c${ctx.cycleIndex}`, `phase5a-alpha-c${ctx.cycleIndex}@phase5a.local`, passwordHash, ['127.0.0.1','::1','::ffff:127.0.0.1']]);
    const group = await client.query('INSERT INTO groups (user_id,name,description) VALUES ($1,$2,$3) RETURNING id,name', [user.rows[0].id, `phase5a-alpha-c${ctx.cycleIndex} group`, 'Phase5A isolated local group']);
    const account = await client.query(`INSERT INTO crown_accounts (user_id,group_id,username,password,original_username,initialized_username,discount,balance,credit,stop_profit_limit,is_enabled,is_online,status,football_prematch_limit,football_live_limit) VALUES ($1,$2,$3,'local-only-not-real-password',$4,$4,0.80,5000,100000,0,TRUE,TRUE,'active',100000,100000) RETURNING id,username,original_username,discount::text AS discount,credit::text AS credit,is_online`, [user.rows[0].id, group.rows[0].id, `phase5a-alpha-c${ctx.cycleIndex}-crown`, `PHASE5A-C${ctx.cycleIndex}`]);
    await client.query(`INSERT INTO coin_transactions (user_id,account_id,bet_id,transaction_id,transaction_type,description,amount,balance_before,balance_after) VALUES ($1,NULL,NULL,$2,'充值','Phase5A isolated seed',1000,0,1000)`, [user.rows[0].id, `PHASE5A-C${ctx.cycleIndex}-SEED`]);
    for (const fixture of Object.values(fixtures)) await client.query(`INSERT INTO matches (id,match_id,league_name,home_team,away_team,match_time,status,markets,odds_home_win,odds_draw,odds_away_win) VALUES ($1,$2,$3,$4,$5,$6,'live',$7::jsonb,2.10,3.30,3.20)`, [fixture.id, fixture.gid, fixture.league, fixture.home, fixture.away, matchTime, JSON.stringify(markets)]);
    await client.query(`SELECT setval(pg_get_serial_sequence('matches','id'), (SELECT MAX(id) FROM matches), TRUE)`); await client.query('COMMIT');
    return { database: ctx.database, cycle_index: ctx.cycleIndex, password_evidence: { policy: 'not written; held in process memory only' }, alpha: { user: user.rows[0], group: group.rows[0], account: account.rows[0] }, fixtures, seed_balance: { alpha: 1000 } };
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { await client.end(); }
}
function backendEnv(ctx, port) { const base = dbConfig(ctx.database); return { ...process.env, NODE_ENV: 'development', DB_HOST: base.host, DB_PORT: String(base.port), DB_USER: base.user, DB_PASSWORD: base.password, DB_NAME: ctx.database, HOST: '127.0.0.1', PORT: String(port), JWT_SECRET: ctx.jwtSecret, CROWN_BASE_URL: urls.mock, CROWN_BASE_URL_CANDIDATES: urls.mock, CROWN_API_KEEPALIVE_ENABLED: 'false', CROWN_ONLINE_CHECK_INTERVAL_MS: '600000', CORS_ALLOWED_ORIGINS: 'http://127.0.0.1:10090', DOTENV_CONFIG_QUIET: 'true' }; }
function startBackend(ctx, port, logFile, role) { return startLogChild(logFile, process.execPath, ['dist/app.js'], { cwd: backendDir, env: backendEnv(ctx, port) }); }
async function startInitialServices(ctx, mockBundle) {
  const startedAt = new Date().toISOString();
  await new Promise((resolve, reject) => { mockBundle.mock.server.once('error', reject); mockBundle.mock.server.listen(3301, '127.0.0.1', resolve); });
  const backendALog = evidencePath(ctx, 'backend-a-generation1-log.txt'); const backendBLog = evidencePath(ctx, 'backend-b-log.txt');
  const backendChildA1 = startBackend(ctx, 3202, backendALog, 'backend-a-generation1'); const backendChildB = startBackend(ctx, 3203, backendBLog, 'backend-b');
  try {
    const [backendAHealth, backendBHealth, mockHealth] = await Promise.all([waitHttpOk(`${urls.backendA}/api/health`, 40000), waitHttpOk(`${urls.backendB}/api/health`, 40000), waitHttpOk(`${urls.mock}/`, 10000)]);
    const runtimeConfig = { started_at_utc: startedAt, cycle_index: ctx.cycleIndex, database: ctx.database, jwt_secret: '<process-memory-only>', upstream: urls.mock, backends: [{ role: 'backend-a-generation1', port: 3202, pid: backendChildA1.pid, database: ctx.database, log: path.relative(deployRoot, backendALog) }, { role: 'backend-b', port: 3203, pid: backendChildB.pid, database: ctx.database, log: path.relative(deployRoot, backendBLog) }], network_boundary: { crown_base_url: urls.mock, crown_base_url_candidates: urls.mock, all_service_hosts: ['127.0.0.1'] } };
    const health = { started_at_utc: startedAt, backend_a_generation1: backendAHealth, backend_b: backendBHealth, mock: mockHealth, runtime_config: runtimeConfig }; writeJson(evidencePath(ctx, 'initial-service-health.json'), health); return { mockBundle, backendChildA1, backendChildB, backendALog, backendBLog, runtimeConfig, health };
  } catch (error) { await stopServices(ctx, { mockBundle, backendChildA1, backendChildB }, 'startup failure', 'startup-failure-stop-evidence.json').catch(() => undefined); throw error; }
}
async function restartBackendA(ctx) {
  const startedAt = new Date().toISOString(); const logFile = evidencePath(ctx, 'backend-a-generation2-log.txt'); const backendChildA2 = startBackend(ctx, 3202, logFile, 'backend-a-generation2');
  try { const health = await waitHttpOk(`${urls.backendA}/api/health`, 40000); const evidence = { started_at_utc: startedAt, backend_a_generation2: health, pid: backendChildA2.pid, log: path.relative(deployRoot, logFile), database: ctx.database, upstream: urls.mock }; writeJson(evidencePath(ctx, 'backend-a-generation2-health.json'), evidence); return { backendChildA2, evidence }; }
  catch (error) { await stopLoggedChild(backendChildA2, 'backend-a-generation2').catch(() => null); throw error; }
}

async function stopLoggedChild(child, role) { if (!child) return { role, skipped: true }; const record = { role, pid: child.pid, kill_requested_at: new Date().toISOString(), already_exited: child.exitCode !== null || child.signalCode !== null, exit_code_before: child.exitCode, signal_code_before: child.signalCode }; if (!record.already_exited) { record.kill_method = 'Node child.kill() default termination signal on Windows'; record.kill_return = child.kill(); await new Promise(resolve => { const timer = setTimeout(resolve, 8000); timer.unref?.(); child.once('exit', () => { clearTimeout(timer); resolve(); }); }); } record.exit_code_after = child.exitCode; record.signal_code_after = child.signalCode; record.process_exited = child.exitCode !== null || child.signalCode !== null; record.exit_observed_at = new Date().toISOString(); return record; }
async function closeHttpServer(server, role) { if (!server) return { role, skipped: true }; server.closeAllConnections?.(); const closeCallbackCompleted = await new Promise(resolve => { const timer = setTimeout(() => resolve(false), 8000); timer.unref?.(); server.close(() => { clearTimeout(timer); resolve(true); }); }).catch(() => false); return { role, close_callback_completed: closeCallbackCompleted, stopped_at: new Date().toISOString() }; }
async function stopServices(ctx, services, label, evidenceName) { const evidence = { cycle_index: ctx.cycleIndex, label, stopped_at: new Date().toISOString(), services: {} }; evidence.services.backend_a_generation1 = await stopLoggedChild(services?.backendChildA1, 'backend-a-generation1'); evidence.services.backend_a_generation2 = await stopLoggedChild(services?.backendChildA2, 'backend-a-generation2'); evidence.services.backend_b = await stopLoggedChild(services?.backendChildB, 'backend-b'); evidence.services.mock_server = await closeHttpServer(services?.mockBundle?.mock?.server, 'mock upstream'); await new Promise(resolve => setTimeout(resolve, 300)); evidence.target_ports_open_after_stop = await targetPortsOpen(); evidence.all_target_ports_down = evidence.target_ports_open_after_stop.length === 0; if (evidenceName) writeJson(evidencePath(ctx, evidenceName), evidence); return evidence; }
async function apiRequest({ method, url, token, body, label, headers = {} }) {
  const startedAt = new Date(); const startedHighRes = performance.now(); const requestHeaders = { ...headers }; if (body !== undefined) requestHeaders['content-type'] = 'application/json'; if (token) requestHeaders.authorization = `Bearer ${token}`;
  let response; let rawResponseBody = null;
  try { response = await fetch(url, { method, headers: requestHeaders, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' }); const responseText = await response.text(); let responseBody; try { responseBody = JSON.parse(responseText); } catch { responseBody = responseText; } rawResponseBody = responseBody;
    return { label, method, url, request_headers: { content_type: body === undefined ? null : 'application/json', authorization: token ? '<redacted>' : null, idempotency_key: requestHeaders['Idempotency-Key'] ?? null }, request_body: redactSensitive(body), response_status: response.status, response_ok: response.ok, response_headers: { idempotency_replayed: response.headers.get('idempotency-replayed'), content_type: response.headers.get('content-type') }, response_body: redactSensitive(responseBody), started_at_utc: startedAt.toISOString(), ended_at_utc: new Date().toISOString(), duration_ms: Math.round(performance.now() - startedHighRes), transport_error: null, raw_response_body: rawResponseBody }; }
  catch (error) { return { label, method, url, request_headers: { content_type: body === undefined ? null : 'application/json', authorization: token ? '<redacted>' : null, idempotency_key: requestHeaders['Idempotency-Key'] ?? null }, request_body: redactSensitive(body), response_status: null, response_ok: false, response_headers: null, response_body: null, started_at_utc: startedAt.toISOString(), ended_at_utc: new Date().toISOString(), duration_ms: Math.round(performance.now() - startedHighRes), transport_error: error?.stack || String(error), raw_response_body: rawResponseBody }; }
}
function publicRequest(record) { if (!record) return record; const { raw_response_body, ...publicRecord } = record; return publicRecord; }
async function loginApi(username, password, baseUrl, label) { const request = await apiRequest({ method: 'POST', url: `${baseUrl}/api/auth/login`, body: { username, password }, label: `${label}:POST /api/auth/login` }); const token = request.raw_response_body?.data?.token || null; request.token_evidence = token ? { stored: 'memory only during this process', length: token.length, sha256: crypto.createHash('sha256').update(token).digest('hex') } : null; if (!request.response_ok || !request.response_body?.success || !token) throw new Error(`${label} login failed: ${JSON.stringify(request.response_body || request.transport_error)}`); return { username, baseUrl, token, request }; }
function buildBetPayload({ fixture, accountId, key }) { return { idempotency_key: key, account_ids: [accountId], match_id: fixture.id, bet_type: '角球让球', bet_option: `Phase5A ${fixture.home} (角球 +1)`, total_amount: 80, odds: 1.9, single_limit: '5000', interval_range: '1-3', quantity: 1, min_odds: '1.90', crown_match_id: fixture.gid, league_name: fixture.league, home_team: fixture.home, away_team: fixture.away, match_time: matchTime.toISOString(), match_status: 'live', current_score: '', match_period: '', market_category: 'handicap', market_scope: 'full', market_side: 'home', market_line: '1', market_index: 0, market_wtype: 'CNR', market_rtype: 'CNRH' }; }
async function getBets(db) { return (await db.query(`SELECT b.id,b.user_id,u.username AS user_username,b.account_id,a.username AS account_username,b.match_id,b.bet_type,b.bet_option,b.status,b.error_message,b.official_bet_id,b.bet_amount::text AS bet_amount,b.virtual_bet_amount::text AS virtual_bet_amount,b.created_at,b.confirmed_at,b.updated_at FROM bets b JOIN users u ON u.id=b.user_id JOIN crown_accounts a ON a.id=b.account_id ORDER BY b.id`)).rows; }
async function getIdempotencyRows(db) { return (await db.query(`SELECT i.id::text AS id,i.user_id,u.username AS user_username,i.idempotency_key,i.request_hash,i.status,i.bet_ids,i.response_json,i.http_status,i.created_at,i.updated_at FROM bet_idempotency_requests i JOIN users u ON u.id=i.user_id ORDER BY i.id`)).rows; }
async function getTransactions(db) { return (await db.query(`SELECT c.id,c.user_id,u.username AS user_username,c.account_id,c.bet_id,c.transaction_id,c.transaction_type,c.description,c.amount::text AS amount,c.balance_before::text AS balance_before,c.balance_after::text AS balance_after,c.created_at FROM coin_transactions c JOIN users u ON u.id=c.user_id ORDER BY c.id`)).rows; }
async function getIntegrityIssues(db) { return (await db.query(`SELECT 'missing_transaction_for_active_bet' AS issue,b.id AS bet_id FROM bets b WHERE b.status <> 'cancelled' AND NOT EXISTS (SELECT 1 FROM coin_transactions t WHERE t.bet_id=b.id AND t.transaction_type='消耗') UNION ALL SELECT 'charge_transaction_without_active_bet' AS issue,t.bet_id FROM coin_transactions t LEFT JOIN bets b ON b.id=t.bet_id WHERE t.transaction_type='消耗' AND (b.id IS NULL OR b.status='cancelled') ORDER BY issue,bet_id`)).rows; }
function mockEventsForFixture(mockBundle, fixture) { return mockBundle.mock.ftBetRequests.filter(item => String(item.params?.gid || '') === String(fixture.gid)); }
async function captureState(db, mockBundle) { const [bets, idempotency, transactions, integrity] = await Promise.all([getBets(db), getIdempotencyRows(db), getTransactions(db), getIntegrityIssues(db)]); return { checked_at_utc: new Date().toISOString(), bets, idempotency, transactions, charge_transactions: transactions.filter(item => item.transaction_type === '消耗'), integrity, mock_ft_bet_events: mockBundle.mock.ftBetRequests.slice(), mock_ft_bet_response_attempts: mockBundle.mock.ftBetResponseAttempts.slice() }; }
function countBy(items, key) { return items.reduce((map, item) => ({ ...map, [item[key]]: (map[item[key]] || 0) + 1 }), {}); }
function createdCounts(before, after) { return { bets: after.bets.length - before.bets.length, idempotency: after.idempotency.length - before.idempotency.length, mock_ft_bet: after.mock_ft_bet_events.length - before.mock_ft_bet_events.length, charge_transactions: after.charge_transactions.length - before.charge_transactions.length }; }
function cycleDeltaSummary(before, after) { return { ...createdCounts(before, after), integrity_issues: after.integrity.length - before.integrity.length }; }
async function waitFixtureTerminalBets(db, fixture, expectedCount, label) { await waitFor(async () => { const bets = await getBets(db); const scoped = bets.filter(item => Number(item.match_id) === Number(fixture.id)); return scoped.length === expectedCount && scoped.every(item => ['confirmed','cancelled','settled'].includes(item.status)); }, 30000, label); return getBets(db); }

async function runCycle(cycleIndex) {
  const cycleLabel = `run-${String(cycleIndex).padStart(2, '0')}`; const startedAt = new Date(); const database = `hgzuqiu_phase5a_${matrixRunId.slice(0, 15).replace(/[^0-9]/g, '')}_${process.pid}_${cycleIndex}`; const dbPasswordPlain = `Phase5A!${process.pid}-${cycleIndex}`; const jwtSecret = `phase5a-${cycleIndex}-${crypto.randomBytes(32).toString('hex')}`;
  const ctx = { cycleIndex, cycleLabel, startedAt, database, dbPasswordPlain, jwtSecret, evidenceDir: path.join(evidenceRoot, cycleLabel), assertions: [], success: false };
  let db = null, services = null, restart = null, initialRequest = null, replayA = null, replayB = null, controlRequest = null, stopEvidence = null, guardBefore = null, guardAfter = null, portsAfter = null, finalState = null, summary = null;
  const cycleResult = { phase: 'phase5a-cycle', matrix_run_id: matrixRunId, cycle_index: cycleIndex, cycle_label: cycleLabel, cycle_started_at_utc: startedAt.toISOString(), cycle_started_at_beijing: beijingTime(startedAt), database, evidence_dir: path.relative(deployRoot, ctx.evidenceDir), assertions: ctx.assertions, fatal_errors: [], product_recovery_invariant_passed: null, summary: {}, success: false };
  function check(name, passed, expected, actual) { ctx.assertions.push({ name, passed: passed === true, expected, actual }); return passed === true; }
  function saveCycleFailure(error) { cycleResult.fatal_errors.push(error?.stack || String(error)); cycleResult.checked_at_utc = new Date().toISOString(); cycleResult.checked_at_beijing = beijingTime(new Date()); cycleResult.assertions_passed = ctx.assertions.filter(item => item.passed).length; cycleResult.assertions_failed = ctx.assertions.filter(item => !item.passed).length; cycleResult.success = false; writeJson(evidencePath(ctx, 'cycle-final-assertions.json'), cycleResult); }
  try {
    ensureDir(ctx.evidenceDir); const portsBefore = await targetPortsOpen(); writeJson(evidencePath(ctx, 'target-port-guard-before.json'), { target_ports_open_before: portsBefore }); check('target_ports_free_before', portsBefore.length === 0, [], portsBefore);
    const build = buildBackend(ctx); check('backend_build_passed', build.exit_code === 0, 0, build.exit_code);
    guardBefore = await guardDbSnapshot(); writeJson(evidencePath(ctx, 'guard-db-before.json'), guardBefore);
    const hashesBefore = watchedHashMap(); writeJson(evidencePath(ctx, 'watched-file-hashes-before.json'), hashesBefore);
    const seed = await createAndSeedDatabase(ctx); db = await connectDb(ctx.database);
    const fresh = await captureState(db, { mock: { ftBetRequests: [], ftBetResponseAttempts: [] } }); writeJson(evidencePath(ctx, 'db-seeded.json'), fresh); check('fresh_database_has_no_bets', fresh.bets.length === 0, 0, fresh.bets.length); check('fresh_database_has_no_idempotency_rows', fresh.idempotency.length === 0, 0, fresh.idempotency.length);
    const mockLogFile = evidencePath(ctx, 'mock-upstream-log.jsonl'); const mockBundle = { mock: createHoldingMockUpstream({ logFile: mockLogFile, ticketPrefix: `PHASE5A-C${cycleIndex}`, delayMs: holdMs }) };
    services = await startInitialServices(ctx, mockBundle);
    check('initial_backend_processes_distinct', services.backendChildA1.pid !== services.backendChildB.pid, true, [services.backendChildA1.pid, services.backendChildB.pid]); check('both_backends_configured_same_database', services.runtimeConfig.backends.every(item => item.database === ctx.database), ctx.database, services.runtimeConfig.backends.map(item => item.database)); check('both_backends_configured_loopback_upstream', services.runtimeConfig.network_boundary.crown_base_url === urls.mock && services.runtimeConfig.network_boundary.crown_base_url_candidates === urls.mock, urls.mock, services.runtimeConfig.network_boundary);
    const alphaLoginA = await loginApi(seed.alpha.user.username, ctx.dbPasswordPlain, urls.backendA, 'alpha through backend A generation1'); const alphaLoginB = await loginApi(seed.alpha.user.username, ctx.dbPasswordPlain, urls.backendB, 'alpha through backend B'); writeJson(evidencePath(ctx, 'api-login-alpha-a-redacted.json'), publicRequest(alphaLoginA.request)); writeJson(evidencePath(ctx, 'api-login-alpha-b-redacted.json'), publicRequest(alphaLoginB.request)); check('alpha_login_backend_a_generation1_success', alphaLoginA.request.response_status === 200 && alphaLoginA.request.response_body?.success === true, 200, alphaLoginA.request.response_status); check('alpha_login_backend_b_success', alphaLoginB.request.response_status === 200 && alphaLoginB.request.response_body?.success === true, 200, alphaLoginB.request.response_status);

    const crashKey = `phase5a-crash-c${cycleIndex}`; const crashPayload = buildBetPayload({ fixture: fixtures.crashed, accountId: seed.alpha.account.id, key: crashKey });
    const beforeCrash = await captureState(db, mockBundle); initialRequest = await apiRequest({ method: 'POST', url: `${urls.backendA}/api/bets`, token: alphaLoginA.token, body: crashPayload, label: 'crash request: backend A generation1 POST /api/bets' }); writeJson(evidencePath(ctx, 'scenario-crash-request.json'), { scenario: 'backend is killed after response-commit but while first FT_bet response is held by local mock', key: crashKey, fixture: fixtures.crashed, account_id: seed.alpha.account.id, request_payload_sha256: crypto.createHash('sha256').update(JSON.stringify(canonical(crashPayload))).digest('hex'), before: beforeCrash, request: publicRequest(initialRequest), hold_ms: holdMs });
    check('crash_request_http_202', initialRequest.response_status === 202, 202, initialRequest.response_status); check('crash_request_success_true', initialRequest.response_body?.success === true, true, initialRequest.response_body?.success);
    await waitFor(() => mockEventsForFixture(mockBundle, fixtures.crashed).length >= 1, 30000, 'crash fixture FT_bet request received by mock');
    const beforeKill = await captureState(db, mockBundle); writeJson(evidencePath(ctx, 'db-before-kill.json'), beforeKill); check('before_kill_one_pending_crash_bet', beforeKill.bets.length === 1 && beforeKill.bets[0].status === 'pending', { total: 1, status: 'pending' }, { total: beforeKill.bets.length, statuses: beforeKill.bets.map(item => item.status) }); check('before_kill_idempotency_created_202', beforeKill.idempotency.length === 1 && beforeKill.idempotency[0].status === 'created' && beforeKill.idempotency[0].http_status === 202, { status: 'created', http_status: 202 }, { status: beforeKill.idempotency[0]?.status, http_status: beforeKill.idempotency[0]?.http_status }); check('before_kill_response_snapshot_canonical_equal', same(beforeKill.idempotency[0]?.response_json, initialRequest.response_body), true, same(beforeKill.idempotency[0]?.response_json, initialRequest.response_body)); check('before_kill_no_charge_transaction', beforeKill.charge_transactions.length === 0, 0, beforeKill.charge_transactions.length); check('before_kill_mock_received_one_crash_ft_bet', mockEventsForFixture(mockBundle, fixtures.crashed).length === 1, 1, mockEventsForFixture(mockBundle, fixtures.crashed).length);
    const killEvidence = await stopLoggedChild(services.backendChildA1, 'backend-a-generation1 after FT_bet receive'); services.backendChildA1 = null; writeJson(evidencePath(ctx, 'backend-a-kill-evidence.json'), killEvidence); check('backend_a_generation1_exited', killEvidence.process_exited === true, true, killEvidence);
    const heldRequest = mockEventsForFixture(mockBundle, fixtures.crashed)[0]; await waitFor(() => mockBundle.mock.ftBetResponseAttempts.some(item => item.request_id === heldRequest.request_id), holdMs + 4000, 'held FT_bet response attempt after backend kill'); const heldResponseAttempt = mockBundle.mock.ftBetResponseAttempts.find(item => item.request_id === heldRequest.request_id); writeJson(evidencePath(ctx, 'held-ft-bet-response-attempt.json'), { request: heldRequest, response_attempt: heldResponseAttempt, backend_kill: killEvidence });
    check('ft_bet_received_before_kill_request', Date.parse(heldRequest.at) <= Date.parse(killEvidence.kill_requested_at), true, { ft_bet_received_at: heldRequest.at, kill_requested_at: killEvidence.kill_requested_at }); check('backend_exit_before_held_response_attempt', Date.parse(killEvidence.exit_observed_at) <= Date.parse(heldResponseAttempt.at), true, { exit_observed_at: killEvidence.exit_observed_at, response_attempt_at: heldResponseAttempt.at }); check('held_response_socket_destroyed', heldResponseAttempt.socket_destroyed_before_response_attempt === true, true, heldResponseAttempt.socket_destroyed_before_response_attempt);
    const afterDelayedResponse = await captureState(db, mockBundle); writeJson(evidencePath(ctx, 'db-after-delayed-response.json'), afterDelayedResponse); check('after_delayed_response_crash_bet_still_pending', afterDelayedResponse.bets.length === 1 && afterDelayedResponse.bets[0].status === 'pending', 'pending', afterDelayedResponse.bets[0]?.status); check('after_delayed_response_no_charge', afterDelayedResponse.charge_transactions.length === 0, 0, afterDelayedResponse.charge_transactions.length); check('after_delayed_response_no_extra_ft_bet', mockEventsForFixture(mockBundle, fixtures.crashed).length === 1, 1, mockEventsForFixture(mockBundle, fixtures.crashed).length);
    const portAOpenBeforeRestart = await probePort('127.0.0.1', 3202); writeJson(evidencePath(ctx, 'backend-a-port-before-restart.json'), { port: 3202, open: portAOpenBeforeRestart }); check('backend_a_port_free_before_restart', portAOpenBeforeRestart === false, false, portAOpenBeforeRestart);
    restart = await restartBackendA(ctx); services.backendChildA2 = restart.backendChildA2; check('backend_a_generation2_started', restart.evidence.backend_a_generation2.status === 200, 200, restart.evidence.backend_a_generation2.status); check('backend_a_generation_pid_changed', restart.backendChildA2.pid !== killEvidence.pid, true, { generation1: killEvidence.pid, generation2: restart.backendChildA2.pid });
    const restartStartedState = await captureState(db, mockBundle); const observationStartedAt = new Date().toISOString(); await new Promise(resolve => setTimeout(resolve, restartObservationMs)); const afterObservation = await captureState(db, mockBundle); writeJson(evidencePath(ctx, 'restart-observation.json'), { observation_ms: restartObservationMs, observation_started_at_utc: observationStartedAt, observation_ended_at_utc: new Date().toISOString(), backend_a_generation2_pid: restart.backendChildA2.pid, restart_started_state: restartStartedState, after_observation_state: afterObservation, delta: cycleDeltaSummary(restartStartedState, afterObservation) });
    check('no_automatic_retry_during_restart_observation', afterObservation.mock_ft_bet_events.length === restartStartedState.mock_ft_bet_events.length, 0, afterObservation.mock_ft_bet_events.length - restartStartedState.mock_ft_bet_events.length); check('crash_bet_pending_after_restart_observation', afterObservation.bets.length === 1 && afterObservation.bets[0].status === 'pending', 'pending', afterObservation.bets[0]?.status); check('no_charge_after_restart_observation', afterObservation.charge_transactions.length === 0, 0, afterObservation.charge_transactions.length); check('integrity_issue_present_after_crash', afterObservation.integrity.length === 1 && afterObservation.integrity[0].issue === 'missing_transaction_for_active_bet', [{ issue: 'missing_transaction_for_active_bet', bet_id: afterObservation.bets[0]?.id }], afterObservation.integrity);
    const beforeReplayA = await captureState(db, mockBundle); replayA = await apiRequest({ method: 'POST', url: `${urls.backendA}/api/bets`, token: alphaLoginA.token, body: crashPayload, label: 'exact replay through restarted backend A' }); const afterReplayA = await captureState(db, mockBundle); const replayADelta = cycleDeltaSummary(beforeReplayA, afterReplayA); writeJson(evidencePath(ctx, 'scenario-exact-replay-restarted-backend-a.json'), { request: publicRequest(replayA), before: beforeReplayA, after: afterReplayA, delta: replayADelta, response_canonically_equal_to_initial: same(replayA.response_body, initialRequest.response_body) });
    check('restarted_backend_a_replay_202', replayA.response_status === 202, 202, replayA.response_status); check('restarted_backend_a_replay_header_true', replayA.response_headers?.idempotency_replayed === 'true', 'true', replayA.response_headers?.idempotency_replayed); check('restarted_backend_a_replay_response_canonical_equal', same(replayA.response_body, initialRequest.response_body), true, same(replayA.response_body, initialRequest.response_body)); check('restarted_backend_a_replay_zero_side_effects', replayADelta.bets === 0 && replayADelta.idempotency === 0 && replayADelta.mock_ft_bet === 0 && replayADelta.charge_transactions === 0, { bets: 0, idempotency: 0, mock_ft_bet: 0, charge_transactions: 0 }, replayADelta);
    const beforeReplayB = await captureState(db, mockBundle); replayB = await apiRequest({ method: 'POST', url: `${urls.backendB}/api/bets`, token: alphaLoginB.token, body: crashPayload, label: 'exact replay through continuously running backend B' }); const afterReplayB = await captureState(db, mockBundle); const replayBDelta = cycleDeltaSummary(beforeReplayB, afterReplayB); writeJson(evidencePath(ctx, 'scenario-exact-replay-backend-b.json'), { request: publicRequest(replayB), before: beforeReplayB, after: afterReplayB, delta: replayBDelta, response_canonically_equal_to_initial: same(replayB.response_body, initialRequest.response_body) });
    check('backend_b_replay_202', replayB.response_status === 202, 202, replayB.response_status); check('backend_b_replay_header_true', replayB.response_headers?.idempotency_replayed === 'true', 'true', replayB.response_headers?.idempotency_replayed); check('backend_b_replay_response_canonical_equal', same(replayB.response_body, initialRequest.response_body), true, same(replayB.response_body, initialRequest.response_body)); check('backend_b_replay_zero_side_effects', replayBDelta.bets === 0 && replayBDelta.idempotency === 0 && replayBDelta.mock_ft_bet === 0 && replayBDelta.charge_transactions === 0, { bets: 0, idempotency: 0, mock_ft_bet: 0, charge_transactions: 0 }, replayBDelta); check('after_both_replays_crash_bet_still_pending', afterReplayB.bets.length === 1 && afterReplayB.bets[0].status === 'pending', 'pending', afterReplayB.bets[0]?.status);
    const controlKey = `phase5a-control-c${cycleIndex}`; const controlPayload = buildBetPayload({ fixture: fixtures.control, accountId: seed.alpha.account.id, key: controlKey }); const beforeControl = await captureState(db, mockBundle); controlRequest = await apiRequest({ method: 'POST', url: `${urls.backendA}/api/bets`, token: alphaLoginA.token, body: controlPayload, label: 'control request through restarted backend A' }); await waitFor(() => mockEventsForFixture(mockBundle, fixtures.control).length >= 1, 30000, 'control fixture FT_bet'); await waitFixtureTerminalBets(db, fixtures.control, 1, 'control fixture terminal bet'); const afterControl = await captureState(db, mockBundle); const controlDelta = cycleDeltaSummary(beforeControl, afterControl); writeJson(evidencePath(ctx, 'scenario-control-new-request.json'), { scenario: 'new idempotency key after restart proves backend generation2 and local mock remain usable', key: controlKey, fixture: fixtures.control, request: publicRequest(controlRequest), before: beforeControl, after: afterControl, delta: controlDelta });
    check('control_request_http_202', controlRequest.response_status === 202, 202, controlRequest.response_status); check('control_bet_confirmed', afterControl.bets.filter(item => Number(item.match_id) === Number(fixtures.control.id)).length === 1 && afterControl.bets.find(item => Number(item.match_id) === Number(fixtures.control.id))?.status === 'confirmed', 'confirmed', afterControl.bets.find(item => Number(item.match_id) === Number(fixtures.control.id))?.status); check('control_mock_ft_bet_once', mockEventsForFixture(mockBundle, fixtures.control).length === 1, 1, mockEventsForFixture(mockBundle, fixtures.control).length); check('control_charge_once', afterControl.charge_transactions.length === 1, 1, afterControl.charge_transactions.length);
    finalState = await captureState(db, mockBundle); writeJson(evidencePath(ctx, 'final-db-state.json'), finalState); const finalBets = finalState.bets, finalIdempotency = finalState.idempotency, finalCharges = finalState.charge_transactions, finalIntegrity = finalState.integrity; check('final_two_bets_one_pending_one_confirmed', finalBets.length === 2 && finalBets.filter(item => item.status === 'pending').length === 1 && finalBets.filter(item => item.status === 'confirmed').length === 1, { pending: 1, confirmed: 1 }, countBy(finalBets, 'status')); check('final_two_created_idempotency_rows', finalIdempotency.length === 2 && finalIdempotency.every(item => item.status === 'created'), { total: 2, created: 2 }, { total: finalIdempotency.length, ...countBy(finalIdempotency, 'status') }); check('final_two_mock_ft_bet_requests', mockBundle.mock.ftBetRequests.length === 2, 2, mockBundle.mock.ftBetRequests.length); check('final_one_charge_transaction', finalCharges.length === 1, 1, finalCharges.length); check('final_integrity_one_orphaned_active_bet', finalIntegrity.length === 1 && finalIntegrity[0].issue === 'missing_transaction_for_active_bet', 1, finalIntegrity); check('final_official_ticket_only_on_control', finalBets.filter(item => item.official_bet_id).length === 1 && finalBets.find(item => Number(item.match_id) === Number(fixtures.control.id))?.official_bet_id === mockEventsForFixture(mockBundle, fixtures.control)[0].ticket_id, true, finalBets.map(item => ({ id: item.id, match_id: item.match_id, status: item.status, official_bet_id: item.official_bet_id }))); check('mock_only_local_remote_addresses', mockBundle.mock.events.length > 0 && mockBundle.mock.events.every(item => ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(item.remote_address)), true, [...new Set(mockBundle.mock.events.map(item => item.remote_address))]);
    stopEvidence = await stopServices(ctx, services, `phase5a cycle ${cycleIndex} complete`, 'stop-evidence.json'); services = null; check('all_target_ports_down_after_stop', stopEvidence.all_target_ports_down === true, true, stopEvidence.target_ports_open_after_stop); portsAfter = await targetPortsOpen(); writeJson(evidencePath(ctx, 'target-port-guard-after.json'), { target_ports_open_after: portsAfter }); check('target_ports_free_after', portsAfter.length === 0, [], portsAfter); guardAfter = await guardDbSnapshot(); writeJson(evidencePath(ctx, 'guard-db-after.json'), guardAfter); check('guard_db_sha256_unchanged', guardBefore.sha256 === guardAfter.sha256, guardBefore.sha256, guardAfter.sha256); const hashesAfter = watchedHashMap(); writeJson(evidencePath(ctx, 'watched-file-hashes-after.json'), hashesAfter); check('watched_files_unchanged_during_cycle', same(hashesBefore, hashesAfter), true, { before: hashesBefore, after: hashesAfter });
    summary = { cycle_index: cycleIndex, database, backend_generation1_pid: killEvidence.pid, backend_generation2_pid: restart.backendChildA2.pid, backend_b_pid: services?.backendChildB?.pid ?? stopEvidence.services.backend_b.pid, crash: { initial_http_status: initialRequest.response_status, ft_bet_received_at: heldRequest.at, kill_requested_at: killEvidence.kill_requested_at, backend_exit_observed_at: killEvidence.exit_observed_at, held_response_attempt_at: heldResponseAttempt.at, socket_destroyed_before_response_attempt: heldResponseAttempt.socket_destroyed_before_response_attempt, automatic_retry_during_observation: afterObservation.mock_ft_bet_events.length - restartStartedState.mock_ft_bet_events.length }, replay: { restarted_backend_a: { http_status: replayA.response_status, header: replayA.response_headers?.idempotency_replayed, canonical_equal: same(replayA.response_body, initialRequest.response_body), ...replayADelta }, backend_b: { http_status: replayB.response_status, header: replayB.response_headers?.idempotency_replayed, canonical_equal: same(replayB.response_body, initialRequest.response_body), ...replayBDelta } }, control: { http_status: controlRequest.response_status, ...controlDelta }, final: { bets: finalBets.length, statuses: countBy(finalBets, 'status'), idempotency_rows: finalIdempotency.length, mock_ft_bet: mockBundle.mock.ftBetRequests.length, charge_transactions: finalCharges.length, integrity_issues: finalIntegrity.length }, product_recovery_invariant_passed: false };
    const cycleSecretFindings = scanEvidenceSecrets(ctx.evidenceDir, { db_password: ctx.dbPasswordPlain, jwt_secret: ctx.jwtSecret }); const cycleNonLoopbackUrls = scanNonLoopbackUrls(ctx.evidenceDir); writeJson(evidencePath(ctx, 'evidence-secret-scan.json'), { scanned_root: path.relative(deployRoot, ctx.evidenceDir), findings: cycleSecretFindings, policy: 'JWT-like strings, run DB password, and run JWT secret must not appear in generated evidence' }); writeJson(evidencePath(ctx, 'network-boundary-scan.json'), { scanned_root: path.relative(deployRoot, ctx.evidenceDir), non_loopback_urls: cycleNonLoopbackUrls, allowed_hosts: ['127.0.0.1','localhost','::1'] }); check('cycle_evidence_secret_scan_clean', cycleSecretFindings.length === 0, [], cycleSecretFindings); check('cycle_evidence_contains_only_loopback_urls', cycleNonLoopbackUrls.length === 0, [], cycleNonLoopbackUrls);
    cycleResult.product_recovery_invariant_passed = false; cycleResult.summary = summary; cycleResult.checked_at_utc = new Date().toISOString(); cycleResult.checked_at_beijing = beijingTime(new Date()); cycleResult.assertions_passed = ctx.assertions.filter(item => item.passed).length; cycleResult.assertions_failed = ctx.assertions.filter(item => !item.passed).length; cycleResult.success = cycleResult.assertions_failed === 0 && cycleResult.fatal_errors.length === 0 && summary.final.integrity_issues === 1 && summary.crash.automatic_retry_during_observation === 0; writeJson(evidencePath(ctx, 'cycle-final-assertions.json'), cycleResult); matrixResult.completed_cycles += 1; return cycleResult;
  } catch (error) { saveCycleFailure(error); throw error; } finally { if (services) await stopServices(ctx, services, 'finally cleanup', 'finally-stop-evidence.json').catch(() => undefined); if (db) await db.end().catch(() => undefined); }
}

async function main() {
  ensureDir(evidenceRoot); ensureDir(reportDir); const cycleResults = [];
  for (let cycleIndex = 1; cycleIndex <= 5; cycleIndex += 1) cycleResults.push(await runCycle(cycleIndex));
  const allDatabases = cycleResults.map(item => item.database);
  matrixResult.databases = allDatabases; matrixResult.assertions = cycleResults.flatMap(item => item.assertions);
  const allReproduced = cycleResults.every(item => item.success === true && item.product_recovery_invariant_passed === false && item.summary?.final?.integrity_issues === 1 && item.summary?.crash?.automatic_retry_during_observation === 0);
  matrixResult.summary = { runner_outcome: allReproduced ? 'characterization_matrix_completed' : 'characterization_incomplete', product_recovery_invariant: { passed_cycles: cycleResults.filter(item => item.product_recovery_invariant_passed === true).length, failed_cycles: cycleResults.filter(item => item.product_recovery_invariant_passed === false).length, total_cycles: cycleResults.length }, cycles: cycleResults.map(item => item.summary), databases: allDatabases, distinct_databases: new Set(allDatabases).size === 5, all_characterization_cycles_complete: cycleResults.every(item => item.success === true), completed_cycles: cycleResults.length, target_ports_after_all_cycles: await targetPortsOpen() };
  writeJson(path.join(evidenceRoot, 'matrix-runtime-summary.json'), matrixResult.summary);
  const knownSecrets = {}; for (const item of cycleResults) { knownSecrets[`cycle_${item.cycle_index}_db_password`] = `Phase5A!${process.pid}-${item.cycle_index}`; }
  const secretFindings = scanEvidenceSecrets(evidenceRoot, knownSecrets); const nonLoopbackUrls = scanNonLoopbackUrls(evidenceRoot);
  writeJson(path.join(evidenceRoot, 'matrix-evidence-secret-scan.json'), { scanned_root: path.relative(deployRoot, evidenceRoot), findings: secretFindings, policy: 'JWT-like strings, each cycle DB password, and each cycle JWT secret must not appear in generated evidence' }); writeJson(path.join(evidenceRoot, 'matrix-network-boundary-scan.json'), { scanned_root: path.relative(deployRoot, evidenceRoot), non_loopback_urls: nonLoopbackUrls, allowed_hosts: ['127.0.0.1','localhost','::1'] });
  matrixResult.assertions.push({ name: 'matrix_evidence_secret_scan_clean', passed: secretFindings.length === 0, expected: [], actual: secretFindings }); matrixResult.assertions.push({ name: 'matrix_evidence_contains_only_loopback_urls', passed: nonLoopbackUrls.length === 0, expected: [], actual: nonLoopbackUrls }); matrixResult.assertions.push({ name: 'five_distinct_fresh_databases', passed: new Set(allDatabases).size === 5 && allDatabases.length === 5, expected: 5, actual: { count: allDatabases.length, distinct: new Set(allDatabases).size } }); matrixResult.assertions.push({ name: 'all_five_cycles_reproduced_postcommit_orphan', passed: allReproduced, expected: 5, actual: cycleResults.filter(item => item.success === true && item.product_recovery_invariant_passed === false && item.summary?.final?.integrity_issues === 1).length }); matrixResult.assertions.push({ name: 'all_target_ports_down_after_matrix', passed: matrixResult.summary.target_ports_after_all_cycles.length === 0, expected: [], actual: matrixResult.summary.target_ports_after_all_cycles });
  matrixResult.checked_at_utc = new Date().toISOString(); matrixResult.checked_at_beijing = beijingTime(new Date()); matrixResult.assertions_passed = matrixResult.assertions.filter(item => item.passed).length; matrixResult.assertions_failed = matrixResult.assertions.filter(item => !item.passed).length; matrixResult.success = fatal.length === 0 && matrixResult.assertions_failed === 0 && matrixResult.completed_cycles === 5 && allReproduced;
  const reportFile = path.join(reportDir, `${matrixRunId}-phase5a-提交后崩溃恢复实证报告.md`); matrixResult.report_file = path.relative(deployRoot, reportFile);
  const failedCycles = cycleResults.filter(item => item.product_recovery_invariant_passed === false).length; fs.writeFileSync(reportFile, [
    '# Phase 5A 提交后崩溃恢复实证报告', '',
    `- 实证结论：**runtime_proven：当前实现存在提交后崩溃孤儿注单缺陷**。产品恢复目标 **${failedCycles}/5 未满足**；矩阵复现断言 **${matrixResult.assertions_passed}/${matrixResult.assertions.length}** 通过，fatal **${fatal.length}**。`,
    `- Run ID：\`${matrixRunId}\``,
    `- Git commit：\`${matrixResult.git_commit}\``,
    `- 开始时间：${matrixResult.matrix_started_at_beijing}（${matrixResult.matrix_started_at_utc}）`,
    `- 结束时间：${matrixResult.checked_at_beijing}（${matrixResult.checked_at_utc}）`,
    `- 测试对象：本地 backend、本地 PostgreSQL fresh DB、本地 holding mock upstream；未访问真实 Crown 或任何外部上游。`, '',
    '## 触发边界', '',
    '1. 首个下注请求已在同一数据库事务内写入 `pending` bet 与 `created` 幂等记录，并向客户端返回 HTTP 202。',
    '2. 本地 mock 已收到该注单的第一个 `FT_bet` 请求，但将响应延迟 5000ms。',
    '3. 在响应前强制终止 backend Generation 1，等待 mock 延迟响应尝试落盘。',
    '4. 同库重启 Generation 2，观察 5000ms，再用原 key 精确重放到 Generation 2 与持续运行的 Backend B。',
    '5. 最后用新 key 在 Generation 2 提交控制注单，排除“重启后服务整体不可用”的解释。', '',
    '## 5 轮共同结果', '',
    '- 崩溃后旧注单始终为 `pending`，无 `official_bet_id`，无扣款流水。',
    '- 幂等记录始终为 `created` / HTTP 202，并保留原始成功响应快照。',
    '- Generation 2 重启观察期内没有旧注单自动 `FT_bet` 重试。',
    '- 原 key 在重启后的 backend A 和持续运行的 backend B 上均返回 HTTP 202、`Idempotency-Replayed: true`、响应 canonical 一致。',
    '- 两次精确重放的 bets / idempotency / mock `FT_bet` / charges 增量均为 0，因此不会恢复旧任务。',
    '- 控制注单可由 Generation 2 正常确认并扣款，证明旧注单未恢复不是本地 mock 或 backend 整体不可用造成。',
    '- 最终每轮均出现 1 条 `missing_transaction_for_active_bet` integrity issue。', '',
    '## 结论分级', '',
    '- `runtime_proven`：提交后崩溃会让 HTTP 202 + `created` 幂等快照与 `pending` 注单长期不一致。',
    '- `runtime_proven`：原 key 精确重放只回放 202 快照，不触发旧 pending 任务恢复。',
    '- `runtime_proven`：重启后新 key 控制流正常，排除服务整体失效。',
    '- `not_tested`：进程内其他崩溃时机、PostgreSQL 故障切换、真实上游语义、Service Worker、多标签页、长时间生产运行。', '',
    '## 数据库', '',
    ...allDatabases.map(name => `- \`${name}\``), '',
    '## 证据', '',
    `- 矩阵断言：\`${path.relative(deployRoot, path.join(evidenceRoot, 'matrix-final-assertions.json'))}\``,
    `- 矩阵摘要：\`${path.relative(deployRoot, path.join(evidenceRoot, 'matrix-runtime-summary.json'))}\``,
    `- 秘密扫描：\`${path.relative(deployRoot, path.join(evidenceRoot, 'matrix-evidence-secret-scan.json'))}\``,
    `- 网络边界扫描：\`${path.relative(deployRoot, path.join(evidenceRoot, 'matrix-network-boundary-scan.json'))}\``, '',
    '> 本报告的“矩阵通过”表示缺陷复现链路完整、证据链完整；不表示产品恢复能力通过。', '',
  ].join('\n'), 'utf8');
  writeJson(path.join(evidenceRoot, 'matrix-final-assertions.json'), matrixResult); fs.writeFileSync(path.join(path.dirname(evidenceRoot), 'latest-matrix-run-id.txt'), matrixRunId, 'utf8');
  console.log(JSON.stringify({ success: matrixResult.success, matrix_run_id: matrixRunId, runner_outcome: matrixResult.summary.runner_outcome, product_recovery_invariant: matrixResult.summary.product_recovery_invariant, databases: allDatabases, report: matrixResult.report_file, evidence: path.relative(deployRoot, path.join(evidenceRoot, 'matrix-final-assertions.json')), assertions: { passed: matrixResult.assertions_passed, failed: matrixResult.assertions_failed, total: matrixResult.assertions.length }, summary: matrixResult.summary }, null, 2)); process.exitCode = matrixResult.success ? 0 : 1;
}
main().catch(error => { fatal.push(error?.stack || String(error)); matrixResult.fatal_errors = fatal; matrixResult.checked_at_utc = new Date().toISOString(); matrixResult.checked_at_beijing = beijingTime(new Date()); matrixResult.assertions_passed = matrixResult.assertions.filter(item => item.passed).length; matrixResult.assertions_failed = matrixResult.assertions.filter(item => !item.passed).length; matrixResult.success = false; try { writeJson(path.join(evidenceRoot, 'matrix-final-assertions.json'), matrixResult); } catch {} console.error(JSON.stringify({ success: false, matrix_run_id: matrixRunId, fatal_errors: fatal }, null, 2)); process.exit(1); });
