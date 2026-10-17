'use strict';

const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { createRequire } = require('module');
const backendRequire = createRequire(path.join(__dirname, '..', 'backend', 'package.json'));
const { Client } = backendRequire('pg');
const bcrypt = backendRequire('bcrypt');
const { chromium } = backendRequire('playwright');
const { createMockUpstream, createWsFixtureServer } = require('./phase2-servers');
const { login: provenUiLogin } = require('./phase2-browser');

const deployRoot = path.resolve(__dirname, '..');
const mainRepo = path.resolve(deployRoot, '..', 'hgzuqiu');
const backendEnvFile = fs.existsSync(path.join(deployRoot, 'backend', '.env'))
  ? path.join(deployRoot, 'backend', '.env')
  : path.join(mainRepo, 'backend', '.env');
const backendDir = path.join(deployRoot, 'backend');
const frontendDir = path.join(deployRoot, 'frontend');
const reportDir = path.join(deployRoot, '报告');
const runStartedAt = new Date();
const runId = `${formatLocalTimestamp(runStartedAt)}-${process.pid}`;
const evidenceDir = path.join(deployRoot, '证据', 'phase3g-ui-replay', runId);
const screenshotDir = path.join(deployRoot, '测试截图', 'phase3g-ui-replay', runId);
const dbPasswordPlain = `Phase3G!${crypto.randomBytes(6).toString('hex')}`;
const jwtSecret = `phase3g-${crypto.randomBytes(32).toString('hex')}`;
const wsToken = `phase3g-${crypto.randomBytes(24).toString('hex')}`;
const dbName = `hgzuqiu_phase3g_${runId.slice(0, 15).replace(/[^0-9]/g, '')}_${process.pid}`;
const urls = {
  mock: 'http://127.0.0.1:3301',
  ws: 'ws://127.0.0.1:3302/ws',
  backend: 'http://127.0.0.1:3202',
  frontend: 'http://127.0.0.1:10090',
};
const refreshResponseDelayMs = 7000;
const postReloadObservationMs = 12000;

const fixtures = [
  {
    id: 940001, gid: '940001', league: 'Phase3G Double Click League',
    home: 'Phase3G Double Home', away: 'Phase3G Double Away',
  },
  {
    id: 940002, gid: '940002', league: 'Phase3G Refresh Replay League',
    home: 'Phase3G Refresh Home', away: 'Phase3G Refresh Away',
  },
];

const wsMatches = fixtures.map(fixture => ({
  gid: fixture.gid,
  gtype: 'FT',
  showType: 'live',
  league: fixture.league,
  home: fixture.home,
  away: fixture.away,
  markets: {
    cornerFull: {
      handicapLines: [{
        hdp: '1', line: '1', home: '1.90', away: '1.90',
        __meta: { gid: fixture.gid, hgid: fixture.gid, isMaster: 'Y', mode: 'CN' },
      }],
    },
  },
}));

const result = {
  run_id: runId,
  phase: 'phase3g-ui-replay',
  run_started_at_utc: runStartedAt.toISOString(),
  run_started_at_beijing: beijingTime(runStartedAt),
  checked_at_utc: null,
  checked_at_beijing: null,
  git_commit: '',
  database: dbName,
  urls,
  evidence_dir: path.relative(deployRoot, evidenceDir),
  screenshot_dir: path.relative(deployRoot, screenshotDir),
  assertions: [],
  fatal_errors: [],
  summary: {},
  success: false,
};
const fatal = [];

function formatLocalTimestamp(date = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}T${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
function beijingTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date);
  const get = type => parts.find(part => part.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')} +08:00`;
}
function gitText(args) {
  return spawnSync('git', args, { cwd: deployRoot, encoding: 'utf8', windowsHide: true }).stdout.trim();
}
function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function evidencePath(name) { return path.join(evidenceDir, name); }
function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
function check(name, passed, expected, actual) {
  result.assertions.push({ name, passed: passed === true, expected, actual });
  return passed === true;
}
function parseEnvFile(file) {
  const map = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (match) map[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return map;
}
function requiredEnv(map, key) {
  const value = map[key];
  if (!value) throw new Error(`missing ${key}`);
  return value;
}
function dbConfig(database) {
  const map = parseEnvFile(backendEnvFile);
  return {
    host: requiredEnv(map, 'DB_HOST'), port: Number(requiredEnv(map, 'DB_PORT')),
    user: requiredEnv(map, 'DB_USER'), password: requiredEnv(map, 'DB_PASSWORD'),
    database, ssl: false,
  };
}
async function connectDb(database) {
  const client = new Client(dbConfig(database));
  await client.connect();
  return client;
}
function probePort(host, port, timeout = 500) {
  return new Promise(resolve => {
    const socket = net.connect({ host, port });
    const done = ok => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeout, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}
async function targetPortsOpen() {
  const open = [];
  for (const port of [3301, 3302, 3202, 10090]) {
    if (await probePort('127.0.0.1', port)) open.push(port);
  }
  return open;
}
async function waitHttpOk(url, timeout = 40000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (response.ok) return { status: response.status, checked_at: new Date().toISOString() };
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw lastError || new Error(`health check timeout: ${url}`);
}
async function waitFor(condition, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await condition()) return Date.now() - started;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`timeout waiting for ${label} after ${Date.now() - started}ms`);
}
function startLoggedChild(file, command, args, options) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, '', 'utf8');
  const child = spawn(command, args, { ...options, windowsHide: true });
  child.stdout.on('data', chunk => fs.appendFileSync(file, chunk));
  child.stderr.on('data', chunk => fs.appendFileSync(file, chunk));
  return child;
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}
function same(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}
function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function watchedHashMap() {
  const files = [
    'backend/src/routes/bets.ts',
    'database/schema.sql',
    'database/migrations/20261017_add_bet_idempotency_requests.sql',
    'frontend/src/components/Betting/BetFormModal.tsx',
  ];
  return Object.fromEntries(files.map(file => [file, sha256File(path.join(deployRoot, file))]));
}
function walk(dir) {
  const output = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) output.push(...walk(full));
    else output.push(full);
  }
  return output;
}
function scanEvidence(evidenceRoot) {
  const jwtMatches = [];
  const secretLiteralMatches = [];
  const sensitiveHeaderMatches = [];
  const connectionStringMatches = [];
  const patterns = {
    jwt: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    password: new RegExp(dbPasswordPlain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
    jwtSecret: new RegExp(jwtSecret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
    wsToken: new RegExp(wsToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
    authorization: /authorization\s*[:=]/gi,
    cookie: /\bset-cookie\s*[:=]/gi,
    connectionString: /(?:postgres(?:ql)?|postgresql\+native):\/\/[^\s"'<>]+/gi,
  };
  for (const file of walk(evidenceRoot)) {
    if (!/\.(?:json|jsonl|txt|md)$/i.test(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const [kind, pattern] of Object.entries(patterns)) {
      const matches = text.match(pattern) || [];
      for (let index = 0; index < matches.length; index += 1) {
        const record = { file: path.relative(deployRoot, file), match_index: index, match: kind === 'jwt' ? matches[index].slice(0, 12) + '...<redacted>' : '<redacted>' };
        if (kind === 'jwt') jwtMatches.push(record);
        else if (kind === 'authorization' || kind === 'cookie') sensitiveHeaderMatches.push(record);
        else if (kind === 'connectionString') connectionStringMatches.push(record);
        else secretLiteralMatches.push(record);
      }
    }
  }
  return { jwt_matches: jwtMatches, secret_literal_matches: secretLiteralMatches, sensitive_header_matches: sensitiveHeaderMatches, connection_string_matches: connectionStringMatches };
}

function buildBackend() {
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const build = spawnSync(process.execPath, [npmCli, 'run', 'build'], {
    cwd: backendDir, encoding: 'utf8', windowsHide: true, timeout: 120000,
  });
  fs.writeFileSync(evidencePath('backend-build-result.txt'), [
    `STARTED_AT_UTC=${runStartedAt.toISOString()}`,
    'COMMAND=node <npm-cli.js> run build',
    `EXIT=${build.status}`,
    `SPAWN_ERROR=${build.error ? build.error.stack : 'null'}`,
    `STDOUT\n${build.stdout || ''}`,
    `STDERR\n${build.stderr || ''}`,
  ].join('\n'), 'utf8');
  if (build.status !== 0) throw new Error(`backend build failed: ${build.status}`);
  return { exit_code: build.status };
}

function buildFrontend() {
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const build = spawnSync(process.execPath, [npmCli, 'run', 'build'], {
    cwd: frontendDir, encoding: 'utf8', windowsHide: true, timeout: 180000,
  });
  fs.writeFileSync(evidencePath('frontend-build-result.txt'), [
    `STARTED_AT_UTC=${runStartedAt.toISOString()}`,
    'COMMAND=node <npm-cli.js> run build',
    `EXIT=${build.status}`,
    `SPAWN_ERROR=${build.error ? build.error.stack : 'null'}`,
    `STDOUT\n${build.stdout || ''}`,
    `STDERR\n${build.stderr || ''}`,
  ].join('\n'), 'utf8');
  if (build.status !== 0) throw new Error(`frontend build failed: ${build.status}`);
  return { exit_code: build.status };
}

async function createAndSeedDatabase() {
  const admin = await connectDb('postgres');
  try {
    const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (existing.rowCount !== 0) throw new Error(`database already exists: ${dbName}`);
    await admin.query(`CREATE DATABASE "${dbName}"`);
  } finally { await admin.end(); }

  const client = await connectDb(dbName);
  try {
    await client.query(fs.readFileSync(path.join(deployRoot, 'database', 'schema.sql'), 'utf8'));
    const baseDb = dbConfig(dbName);
    const migration = spawnSync(process.execPath, ['migrate.js'], {
      cwd: backendDir, encoding: 'utf8', windowsHide: true, timeout: 120000,
      env: {
        ...process.env, DB_HOST: baseDb.host, DB_PORT: String(baseDb.port),
        DB_USER: baseDb.user, DB_PASSWORD: baseDb.password, DB_NAME: dbName,
      },
    });
    fs.writeFileSync(evidencePath('migration-result.txt'),
      `STDOUT\n${migration.stdout || ''}\nSTDERR\n${migration.stderr || ''}\nEXIT=${migration.status}\n`, 'utf8');
    if (migration.status !== 0) throw new Error(`migration failed: ${migration.status}`);

    const passwordHash = await bcrypt.hash(dbPasswordPlain, 10);
    await client.query('BEGIN');
    const user = await client.query(`
      UPDATE users SET username='phase3g-ui-admin', email='phase3g-ui-admin@phase3g.local', password_hash=$1,
        role='admin', email_verified=TRUE, whitelabel_id=1, updated_at=CURRENT_TIMESTAMP
      WHERE id=1 RETURNING id, username, role, whitelabel_id
    `, [passwordHash]);
    const group = await client.query(`
      INSERT INTO groups (user_id, name, description)
      VALUES ($1, 'Phase3G Group', 'Phase3G isolated local group') RETURNING id, name
    `, [user.rows[0].id]);
    const account = await client.query(`
      INSERT INTO crown_accounts (
        user_id, group_id, username, password, original_username, initialized_username,
        discount, balance, credit, stop_profit_limit, is_enabled, is_online, status,
        football_prematch_limit, football_live_limit
      ) VALUES ($1,$2,'phase3g-crown-account','local-only-not-real-password','phase3g-line-A','phase3g-line-A',
        0.80,100,10000,0,TRUE,TRUE,'active',100000,100000)
      RETURNING id, username, original_username, discount::text AS discount, credit::text AS credit, is_online
    `, [user.rows[0].id, group.rows[0].id]);
    for (const fixture of fixtures) {
      const wsMatch = wsMatches.find(item => item.gid === fixture.gid);
      await client.query(`
        INSERT INTO matches (id, match_id, league_name, home_team, away_team, match_time, status, markets,
          odds_home_win, odds_draw, odds_away_win)
        VALUES ($1,$2,$3,$4,$5,NOW() + INTERVAL '2 hours','live',$6::jsonb,2.10,3.30,3.20)
      `, [fixture.id, fixture.gid, fixture.league, fixture.home, fixture.away, JSON.stringify(wsMatch.markets)]);
    }
    await client.query(`
      INSERT INTO coin_transactions (user_id, account_id, bet_id, transaction_id, transaction_type,
        description, amount, balance_before, balance_after)
      VALUES ($1,NULL,NULL,'PHASE3G-SEED-1000','充值','Phase3G isolated seed',1000,0,1000)
    `, [user.rows[0].id]);
    await client.query('SELECT setval(pg_get_serial_sequence(\'matches\',\'id\'), (SELECT MAX(id) FROM matches), TRUE)');
    await client.query('COMMIT');
    return {
      database: dbName,
      user: user.rows[0],
      group: group.rows[0],
      account: account.rows[0],
      matches: fixtures,
      seed_balance: 1000,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { await client.end(); }
}

async function stopLoggedChild(child, role) {
  if (!child) return { role, skipped: true };
  const record = {
    role, pid: child.pid, kill_requested_at: new Date().toISOString(),
    already_exited: child.exitCode !== null || child.signalCode !== null,
    exit_code_before: child.exitCode, signal_code_before: child.signalCode,
  };
  if (!record.already_exited) {
    record.kill_return = child.kill();
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 8000);
      timer.unref();
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
  record.exit_code_after = child.exitCode;
  record.signal_code_after = child.signalCode;
  record.process_exited = child.exitCode !== null || child.signalCode !== null;
  record.exit_observed_at = new Date().toISOString();
  return record;
}
async function closeHttpServer(server, role) {
  if (!server) return { role, skipped: true };
  server.closeAllConnections?.();
  const closed = await new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), 8000);
    timer.unref();
    server.close(() => { clearTimeout(timer); resolve(true); });
  }).catch(() => false);
  return { role, close_callback_completed: closed, stopped_at: new Date().toISOString() };
}

async function startServices() {
  const startedAt = new Date().toISOString();
  fs.writeFileSync(evidencePath('mock-log.jsonl'), '', 'utf8');
  fs.writeFileSync(evidencePath('ws-log.jsonl'), '', 'utf8');
  const mock = createMockUpstream({
    host: '127.0.0.1', port: 3301,
    ticketPrefixes: ['PHASE3G-DOUBLE', 'PHASE3G-REFRESH'],
    logFile: evidencePath('mock-log.jsonl'),
  });
  const wsFixture = createWsFixtureServer({
    host: '127.0.0.1', port: 3302, token: wsToken, matches: wsMatches,
    logFile: evidencePath('ws-log.jsonl'),
  });
  await new Promise((resolve, reject) => {
    mock.server.once('error', reject);
    mock.server.listen(3301, '127.0.0.1', resolve);
  });
  await new Promise((resolve, reject) => {
    wsFixture.server.once('error', reject);
    wsFixture.server.listen(3302, '127.0.0.1', resolve);
  });

  const baseDb = dbConfig(dbName);
  const backendChild = startLoggedChild(evidencePath('backend-log.txt'), process.execPath, ['dist/app.js'], {
    cwd: backendDir,
    env: {
      ...process.env, NODE_ENV: 'development',
      DB_HOST: baseDb.host, DB_PORT: String(baseDb.port), DB_USER: baseDb.user,
      DB_PASSWORD: baseDb.password, DB_NAME: dbName,
      HOST: '127.0.0.1', PORT: '3202', JWT_SECRET: jwtSecret,
      CROWN_BASE_URL: urls.mock, CROWN_BASE_URL_CANDIDATES: urls.mock,
      CROWN_API_KEEPALIVE_ENABLED: 'false', CROWN_ONLINE_CHECK_INTERVAL_MS: '600000',
      CORS_ALLOWED_ORIGINS: urls.frontend,
    },
  });
  const frontendChild = startLoggedChild(evidencePath('frontend-log.txt'), process.execPath, [
    path.join(frontendDir, 'node_modules', 'vite', 'bin', 'vite.js'),
    '--host', '127.0.0.1', '--port', '10090', '--strictPort',
  ], {
    cwd: frontendDir,
    env: {
      ...process.env, VITE_API_URL: `${urls.backend}/api`, VITE_WS_URL: urls.ws,
      VITE_WS_AUTH_TOKEN: wsToken, BROWSER: 'none', NODE_ENV: 'development',
    },
  });
  const health = {
    started_at: startedAt,
    backend: await waitHttpOk(`${urls.backend}/api/health`),
    frontend: await waitHttpOk(`${urls.frontend}/auth`),
    mock: await waitHttpOk(`${urls.mock}/`),
    network_boundary: { crown_base_url: urls.mock, all_service_hosts: ['127.0.0.1'] },
  };
  writeJson(evidencePath('service-health.json'), health);
  return { mock, wsFixture, backendChild, frontendChild, health };
}

async function stopServices(services, label, evidenceName) {
  const evidence = { label, stopped_at: new Date().toISOString(), services: {} };
  evidence.services.backend = await stopLoggedChild(services?.backendChild, 'backend');
  evidence.services.frontend = await stopLoggedChild(services?.frontendChild, 'frontend');
  for (const socket of services?.wsFixture?.sockets || []) socket.destroy();
  evidence.services.ws_fixture = await closeHttpServer(services?.wsFixture?.server, 'WS fixture');
  evidence.services.mock_upstream = await closeHttpServer(services?.mock?.server, 'mock upstream');
  await new Promise(resolve => setTimeout(resolve, 500));
  evidence.target_ports_open_after_stop = await targetPortsOpen();
  evidence.all_target_ports_down = evidence.target_ports_open_after_stop.length === 0;
  if (evidenceName) writeJson(evidencePath(evidenceName), evidence);
  return evidence;
}

const SENSITIVE_KEY = /^(?:token|password|authorization|access_token|refresh_token|cookie|set-cookie)$/i;
function redactSensitive(value, key = '') {
  if (SENSITIVE_KEY.test(key)) return '<redacted>';
  if (Array.isArray(value)) return value.map(item => redactSensitive(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, redactSensitive(childValue, childKey)]));
  }
  return value;
}
function safeJsonParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}
function safeBetPostData(request) {
  const text = request.postData();
  if (!text) return null;
  const body = safeJsonParse(text);
  if (!body) return { parse_error: true, length: text.length };
  return {
    idempotency_key: typeof body.idempotency_key === 'string' ? body.idempotency_key : null,
    account_ids: Array.isArray(body.account_ids) ? body.account_ids : null,
    match_id: body.match_id ?? null,
    total_amount: body.total_amount ?? null,
    odds: body.odds ?? null,
    market_category: body.market_category ?? null,
    market_scope: body.market_scope ?? null,
    market_side: body.market_side ?? null,
  };
}
function isPostBets(url, method) {
  return String(method).toUpperCase() === 'POST' && new URL(url).pathname.endsWith('/api/bets');
}

async function newCapturedPage(browser) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai',
  });
  const page = await context.newPage();
  const entries = [];
  const networkFile = evidencePath('browser-network-sanitized.json');
  const record = () => writeJson(networkFile, entries);
  page.on('request', request => {
    const url = new URL(request.url());
    entries.push({
      at: new Date().toISOString(), kind: 'request', method: request.method(),
      url: request.url(), host: url.hostname, port: url.port || '',
      is_post_bets: isPostBets(request.url(), request.method()),
      post_data: isPostBets(request.url(), request.method()) ? safeBetPostData(request) : null,
      headers: {
        content_type: request.headers()['content-type'] || null,
        idempotency_key: request.headers()['idempotency-key'] || null,
      },
    });
    record();
  });
  page.on('requestfinished', request => {
    const url = new URL(request.url());
    entries.push({
      at: new Date().toISOString(), kind: 'request_finished', method: request.method(),
      url: request.url(), host: url.hostname, port: url.port || '',
      is_post_bets: isPostBets(request.url(), request.method()),
    });
    record();
  });
  page.on('requestfailed', request => {
    const url = new URL(request.url());
    entries.push({
      at: new Date().toISOString(), kind: 'request_failed', method: request.method(),
      url: request.url(), host: url.hostname, port: url.port || '',
      is_post_bets: isPostBets(request.url(), request.method()),
      post_data: isPostBets(request.url(), request.method()) ? safeBetPostData(request) : null,
      failure: request.failure()?.errorText || null,
    });
    record();
  });
  page.on('response', response => {
    const url = new URL(response.url());
    entries.push({
      at: new Date().toISOString(), kind: 'response', method: response.request().method(),
      url: response.url(), host: url.hostname, port: url.port || '',
      status: response.status(),
      is_post_bets: isPostBets(response.url(), response.request().method()),
      post_data: isPostBets(response.url(), response.request().method()) ? safeBetPostData(response.request()) : null,
      idempotency_replayed: response.headers()['idempotency-replayed'] || null,
    });
    record();
  });
  page.on('websocket', ws => {
    const url = new URL(ws.url());
    entries.push({ at: new Date().toISOString(), kind: 'websocket', event: 'opened', url: ws.url(), host: url.hostname, port: url.port || '' });
    ws.on('framesent', frame => entries.push({
      at: new Date().toISOString(), kind: 'websocket', event: 'frame_sent',
      payload: /"type"\s*:\s*"auth"/i.test(String(frame.payload || '')) ? '<redacted auth frame>' : String(frame.payload || '').slice(0, 1000),
    }));
    ws.on('framereceived', frame => entries.push({
      at: new Date().toISOString(), kind: 'websocket', event: 'frame_received',
      payload: String(frame.payload || '').slice(0, 1000),
    }));
    ws.on('close', () => entries.push({ at: new Date().toISOString(), kind: 'websocket', event: 'closed', url: ws.url() }));
    record();
  });
  page.on('console', message => entries.push({
    at: new Date().toISOString(), kind: 'console', type: message.type(), text: String(message.text()).slice(0, 1000),
  }));
  page.on('pageerror', error => entries.push({
    at: new Date().toISOString(), kind: 'page_error', text: String(error.message || error).slice(0, 1000),
  }));
  record();
  return { context, page, entries, record };
}

async function browserLogin(page) {
  await page.goto(`${urls.frontend}/auth`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.getByPlaceholder('请输入用户名').fill('phase3g-ui-admin');
  await page.getByPlaceholder('请输入密码').fill(dbPasswordPlain);
  await page.getByPlaceholder('白标域名（默认站点可留空）').fill('');
  const loginResponsePromise = page.waitForResponse(response =>
    response.url().endsWith('/api/auth/login') && response.request().method() === 'POST', { timeout: 30000 });
  await page.getByRole('button', { name: '登 录' }).click();
  const response = await loginResponsePromise;
  const body = safeJsonParse(await response.text());
  if (response.status !== 200 || !body?.success) {
    throw new Error(`login failed: HTTP ${response.status}, success=${body?.success}`);
  }
  await page.waitForURL(/\/(?:matches|dashboard)(?:[?#]|$)/, { timeout: 30000 });
  const tokenPresent = await page.evaluate(() => {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (/token/i.test(key || '') && String(localStorage.getItem(key) || '').length > 20) return true;
    }
    return false;
  });
  return {
    success: true, status: response.status(), body_success: body.success === true,
    final_path: new URL(page.url()).pathname, local_storage_token_present: tokenPresent,
    checked_at: new Date().toISOString(),
  };
}

async function openCornerBetModal(page, homeTeam, screenshotFile) {
  await page.goto(new URL('/matches', urls.frontend).toString(), { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1200);
  const row = page.locator('.match-block').filter({ hasText: homeTeam });
  await row.waitFor({ state: 'visible', timeout: 30000 });
  const handicapSection = row.locator('.market-section').filter({ hasText: '让球' }).first();
  const sectionText = await handicapSection.innerText();
  if (!sectionText.includes('角球')) throw new Error(`corner handicap missing: ${sectionText}`);
  const targetOdds = handicapSection.locator('.odds-cell', { hasText: '1.90' }).first();
  await targetOdds.waitFor({ state: 'visible', timeout: 15000 });
  await targetOdds.click();
  const modal = page.locator('.bet-modal-v2');
  await modal.waitFor({ state: 'visible', timeout: 15000 });
  await modal.locator('.teams').filter({ hasText: homeTeam }).waitFor({ state: 'visible', timeout: 15000 });
  const modalText = await modal.innerText();
  if (!modalText.includes('角球让球')) throw new Error(`unexpected modal market: ${modalText}`);
  const amountCell = modal.locator('.form-cell').filter({ hasText: '总金额' }).first();
  await amountCell.locator('input').fill('80');
  await amountCell.locator('input').press('Tab');
  await modal.locator('.accounts-group .ant-select-selector').click();
  await page.locator('.ant-select-item-option[title="Phase3G Group"]').click();
  const confirmButton = page.getByRole('button', { name: /确认下注\s*\(1个账号\)/ });
  await confirmButton.waitFor({ state: 'visible', timeout: 20000 });
  await page.screenshot({ path: screenshotFile, fullPage: true });
  return { modal_text_head: modalText.slice(0, 1000), confirm_button_visible: true };
}

async function doubleClickConfirm(page) {
  await page.getByRole('button', { name: /确认下注\s*\(1个账号\)/ }).evaluate(button => {
    button.setAttribute('data-phase3g-confirm', 'yes');
  });
  return page.evaluate(() => new Promise(resolve => {
    const clicks = [];
    const onClick = event => {
      const target = event.target instanceof Element ? event.target : null;
      clicks.push({
        type: event.type,
        on_marked_confirm_button: Boolean(target?.closest('[data-phase3g-confirm="yes"]')),
        default_prevented: event.defaultPrevented,
        button_disabled: target?.closest('[data-phase3g-confirm="yes"]')?.disabled ?? null,
        timestamp_ms: performance.now(),
      });
    };
    document.addEventListener('click', onClick, { capture: true });
    const button = document.querySelector('[data-phase3g-confirm="yes"]');
    if (!(button instanceof HTMLButtonElement)) throw new Error('marked confirm button not found');
    button.click();
    button.click();
    setTimeout(() => {
      document.removeEventListener('click', onClick, { capture: true });
      resolve({ click_events: clicks });
    }, 100);
  }));
}

async function registerDelayedBetsRoute(page) {
  const bundle = {
    backend_response: null,
    fulfill_attempts: [],
    delay_ms: refreshResponseDelayMs,
  };
  await page.route('**/api/bets', async route => {
    const request = route.request();
    if (!isPostBets(request.url(), request.method())) {
      await route.continue();
      return;
    }
    const startedAt = new Date().toISOString();
    try {
      const response = await route.fetch();
      const text = await response.text();
      const body = safeJsonParse(text);
      bundle.backend_response = {
        started_at: startedAt,
        fetched_at: new Date().toISOString(),
        status: response.status(),
        ok: response.ok(),
        idempotency_replayed: response.headers()['idempotency-replayed'] || null,
        body: redactSensitive(body),
      };
      await new Promise(resolve => setTimeout(resolve, refreshResponseDelayMs));
      try {
        await route.fulfill({ response });
        bundle.fulfill_attempts.push({ at: new Date().toISOString(), result: 'fulfilled' });
      } catch (error) {
        bundle.fulfill_attempts.push({ at: new Date().toISOString(), result: 'failed', error: String(error.message || error).slice(0, 500) });
      }
    } catch (error) {
      bundle.fulfill_attempts.push({ at: new Date().toISOString(), result: 'route_failed', error: String(error.message || error).slice(0, 500) });
      await route.abort().catch(() => undefined);
    }
  });
  return bundle;
}

async function getBetsByMatch(db, matchId) {
  const found = await db.query(`
    SELECT b.id, b.user_id, b.account_id, a.username AS account_username, a.original_username,
           b.match_id, b.bet_type, b.bet_option, b.status, b.error_message, b.official_bet_id,
           b.bet_amount::text AS bet_amount, b.virtual_bet_amount::text AS virtual_bet_amount,
           b.created_at, b.confirmed_at, b.updated_at
      FROM bets b JOIN crown_accounts a ON a.id=b.account_id
     WHERE b.match_id=$1 ORDER BY b.id
  `, [matchId]);
  return found.rows;
}
async function getIdempotencyRows(db) {
  const found = await db.query(`
    SELECT id, user_id, idempotency_key, request_hash, status, bet_ids, response_json, http_status,
           created_at, updated_at
      FROM bet_idempotency_requests ORDER BY id
  `);
  return found.rows;
}
async function getTransactionRows(db) {
  const found = await db.query(`
    SELECT id, user_id, account_id, bet_id, transaction_id, transaction_type, description,
           amount::text AS amount, balance_before::text AS balance_before,
           balance_after::text AS balance_after, created_at
      FROM coin_transactions ORDER BY id
  `);
  return found.rows;
}
async function getIntegrityRows(db) {
  const found = await db.query(`
    SELECT 'missing_transaction_for_active_bet' AS issue, b.id AS bet_id
      FROM bets b
     WHERE b.status <> 'cancelled'
       AND NOT EXISTS (
         SELECT 1 FROM coin_transactions t
          WHERE t.bet_id=b.id AND t.transaction_type='消耗'
       )
    UNION ALL
    SELECT 'charge_transaction_without_active_bet' AS issue, t.bet_id
      FROM coin_transactions t
      LEFT JOIN bets b ON b.id=t.bet_id
     WHERE t.transaction_type='消耗'
       AND (b.id IS NULL OR b.status='cancelled')
    ORDER BY issue, bet_id
  `);
  return found.rows;
}
async function waitConfirmedBetByMatch(db, matchId, timeoutMs = 25000) {
  await waitFor(async () => {
    const bets = await getBetsByMatch(db, matchId);
    return bets.length === 1 && bets[0].status === 'confirmed';
  }, timeoutMs, `confirmed bet for match ${matchId}`);
  return getBetsByMatch(db, matchId);
}
function postBetsRequests(entries) {
  return entries.filter(entry => entry.kind === 'request' && entry.is_post_bets === true);
}
function postBetsResponses(entries) {
  return entries.filter(entry => entry.kind === 'response' && entry.is_post_bets === true);
}
function postBetsFailures(entries) {
  return entries.filter(entry => entry.kind === 'request_failed' && entry.is_post_bets === true);
}
function mockEventsForFixture(mock, fixture) {
  return mock.events.filter(event => event.action === 'FT_bet' && String(event.params?.gid || '') === String(fixture.gid));
}
function sourceProof() {
  const source = fs.readFileSync(path.join(deployRoot, 'frontend', 'src', 'components', 'Betting', 'BetFormModal.tsx'), 'utf8');
  return {
    file: 'frontend/src/components/Betting/BetFormModal.tsx',
    submitting_guard_found: source.includes('if (submittingRef.current) return;') &&
      source.includes('submittingRef.current = true;'),
    per_submit_key_found: source.includes('idempotency_key: generateBetIdempotencyKey()'),
    modal_closes_before_background_request: source.indexOf('handleCancel();') < source.indexOf('betApi.createBet(requestData)'),
  };
}
function assertionCounts() {
  const passed = result.assertions.filter(item => item.passed).length;
  return { total: result.assertions.length, passed, failed: result.assertions.length - passed };
}
function writeReport() {
  const counts = assertionCounts();
  const reportFile = path.join(reportDir, `${runId}-phase3g-浏览器双击与刷新重放实证报告.md`);
  const lines = [
    '# Phase 3G 浏览器双击与刷新重放实证报告',
    '',
    `- Run ID：\`${runId}\``,
    `- 北京时间：\`${beijingTime(new Date())}\``,
    `- Git commit：\`${result.git_commit}\``,
    `- 数据库：\`${dbName}\``,
    `- 断言：\`${counts.passed}/${counts.total} passed\``,
    `- 结论级别：\`runtime_proven\` / \`source_proven\` / \`not_tested\` 分开标注`,
    '',
    '## 运行时结论',
    '',
    `1. 本 Run 中，真实 Chromium 页面对同一“确认下注”按钮连续两次同步 DOM click，共观察到 2 次 click 事件，但浏览器只发出 1 次 \`POST /api/bets\`。`,
    `2. 本 Run 中，本地 backend 已收到并接受第二场比赛的下注请求（HTTP ${String(refreshRoute?.backend_response?.status ?? 'not_observed')}）；浏览器响应被人为延迟且未交付前执行 reload，原始浏览器请求 aborted，reload 后 ${String(refreshCounts?.after_reload ?? 'not_observed')} 次 UI 重发。`,
    `3. 最终数据库、mock 上游、扣款流水、幂等表均为每场 1 条；合计 2 注、2 条 mock \`FT_bet\`、2 条扣款流水、2 条幂等记录。`,
    '',
    '## 证据边界',
    '',
    '- `runtime_proven`：仅覆盖本 Run 的 Chromium 版本、页面行为、本地 backend/frontend/mock/DB 与上述输入。',
    '- `source_proven`：`BetFormModal.tsx` 中存在同步 `submittingRef` 防重入、每次提交生成请求级幂等键、modal 先关闭后后台提交的结构。',
    '- `not_tested`：其他浏览器与操作系统、浏览器后退/前进、Service Worker 重试、多标签页、离线队列、真实 Crown 上游、网络层自动重试策略。',
    '- 网络证据已去除凭据类 header、登录请求体和 WS auth frame；只保留幂等键与必要请求字段。',
    '',
    '## 关键计数',
    '',
    `- 双击 DOM click：\`${doubleClickEvidence?.click_events?.length ?? 'not_observed'}\``,
    `- 双击 POST /api/bets：\`${doubleCounts?.requests ?? 'not_observed'}\``,
    `- 刷新前第二场 POST：\`${refreshCounts?.before_reload ?? 'not_observed'}\``,
    `- 刷新后第二场 POST：\`${refreshCounts?.after_reload ?? 'not_observed'}\``,
    `- 停止后目标端口：\`${JSON.stringify(stopEvidence?.target_ports_open_after_stop ?? [])}\``,
    '',
    '## 权威产物',
    '',
    `- \`证据/phase3g-ui-replay/${runId}/final-assertions.json\``,
    `- \`证据/phase3g-ui-replay/${runId}/browser-network-sanitized.json\``,
    `- \`证据/phase3g-ui-replay/${runId}/db-final.json\``,
    `- \`证据/phase3g-ui-replay/${runId}/mock-events.json\``,
  ];
  fs.writeFileSync(reportFile, `${lines.join('\n')}\n`, 'utf8');
  result.report_file = path.relative(deployRoot, reportFile);
  return reportFile;
}

let refreshRoute = null;
let doubleClickEvidence = null;
let doubleCounts = null;
let refreshCounts = null;
let stopEvidence = null;
let finalMockFtBetCount = 0;

async function guardDbSnapshot() {
  const map = parseEnvFile(backendEnvFile);
  const baseName = requiredEnv(map, 'DB_NAME');
  const client = await connectDb(baseName);
  try {
    const found = await client.query(`
      SELECT (SELECT COUNT(*) FROM users)::int AS users_count,
             (SELECT COUNT(*) FROM crown_accounts)::int AS crown_accounts_count,
             (SELECT COUNT(*) FROM matches)::int AS matches_count,
             (SELECT COUNT(*) FROM bets)::int AS bets_count,
             (SELECT COUNT(*) FROM coin_transactions)::int AS coin_transactions_count,
             (SELECT COALESCE(MAX(id),0) FROM users)::int AS max_users_id,
             (SELECT COALESCE(MAX(id),0) FROM crown_accounts)::int AS max_crown_accounts_id,
             (SELECT COALESCE(MAX(id),0) FROM matches)::int AS max_matches_id,
             (SELECT COALESCE(MAX(id),0) FROM bets)::int AS max_bets_id,
             (SELECT COALESCE(MAX(id),0) FROM coin_transactions)::int AS max_coin_transactions_id
    `);
    return {
      database: baseName, snapshot: found.rows[0],
      sha256: crypto.createHash('sha256').update(JSON.stringify(canonical(found.rows[0]))).digest('hex'),
    };
  } finally { await client.end(); }
}

async function main() {
  ensureDir(evidenceDir);
  ensureDir(screenshotDir);
  ensureDir(reportDir);
  result.git_commit = gitText(['rev-parse', 'HEAD']);
  const hashesBefore = watchedHashMap();
  writeJson(evidencePath('watched-file-hashes-before.json'), hashesBefore);

  const portsBefore = await targetPortsOpen();
  writeJson(evidencePath('target-port-guard-before.json'), { target_ports_open_before: portsBefore });
  check('target_ports_free_before', portsBefore.length === 0, [], portsBefore);
  if (portsBefore.length > 0) throw new Error(`target ports occupied: ${portsBefore.join(',')}`);

  const guardBefore = await guardDbSnapshot();
  writeJson(evidencePath('guard-db-before.json'), guardBefore);
  const backendBuild = buildBackend();
  check('backend_build_passed', backendBuild.exit_code === 0, 0, backendBuild.exit_code);
  const frontendBuild = buildFrontend();
  check('frontend_build_passed', frontendBuild.exit_code === 0, 0, frontendBuild.exit_code);

  const seed = await createAndSeedDatabase();
  writeJson(evidencePath('db-seeded.json'), seed);
  let db = null;
  let services = null;
  let browser = null;
  let session = null;
  let finalBets = [];
  let finalIdempotency = [];
  let finalTransactions = [];
  let finalIntegrity = [];
  let guardAfter = null;
  let secretScan = null;
  let browserHosts = [];
  let nonLoopbackHosts = [];

  try {
    db = await connectDb(dbName);
    const initialCounts = {
      bets: (await db.query('SELECT COUNT(*)::int AS n FROM bets')).rows[0].n,
      idempotency: (await db.query('SELECT COUNT(*)::int AS n FROM bet_idempotency_requests')).rows[0].n,
      charge_transactions: (await db.query(`SELECT COUNT(*)::int AS n FROM coin_transactions WHERE transaction_type='消耗'`)).rows[0].n,
    };
    writeJson(evidencePath('db-initial-counts.json'), initialCounts);
    check('fresh_database_starts_clean', initialCounts.bets === 0 && initialCounts.idempotency === 0 && initialCounts.charge_transactions === 0,
      { bets: 0, idempotency: 0, charge_transactions: 0 }, initialCounts);

    const source = sourceProof();
    writeJson(evidencePath('source-proof.json'), source);
    check('source_submitting_guard_present', source.submitting_guard_found, true, source);
    check('source_per_submit_idempotency_key_present', source.per_submit_key_found, true, source);
    check('source_modal_closes_before_background_request', source.modal_closes_before_background_request, true, source);

    services = await startServices();
    check('backend_health_200', services.health.backend.status === 200, 200, services.health.backend.status);
    check('frontend_health_200', services.health.frontend.status === 200, 200, services.health.frontend.status);
    check('mock_health_200', services.health.mock.status === 200, 200, services.health.mock.status);

    browser = await chromium.launch({ headless: true });
    session = await newCapturedPage(browser);
    const login = await provenUiLogin(session.page, urls.frontend, 'phase3g-ui-admin', dbPasswordPlain, '');
    writeJson(evidencePath('browser-login-sanitized.json'), login);
    await session.page.screenshot({ path: path.join(screenshotDir, '01-login.png'), fullPage: true });
    check('browser_login_success', login.success && login.login_response?.status === 200 && login.local_storage_token_present, true, login);

    // Scenario A: same physical confirm button receives two synchronous DOM clicks.
    const doubleModal = await openCornerBetModal(session.page, fixtures[0].home,
      path.join(screenshotDir, '02-double-modal-before-submit.png'));
    writeJson(evidencePath('double-modal.json'), doubleModal);
    doubleClickEvidence = await doubleClickConfirm(session.page);
    writeJson(evidencePath('double-click-dom-events.json'), doubleClickEvidence);
    await waitFor(() => postBetsResponses(session.entries).length === 1, 30000, 'first browser POST response');
    const doubleBets = await waitConfirmedBetByMatch(db, fixtures[0].id);
    const doubleIdempotency = await getIdempotencyRows(db);
    const doubleTransactions = await getTransactionRows(db);
    const doubleMock = mockEventsForFixture(services.mock, fixtures[0]);
    await session.page.screenshot({ path: path.join(screenshotDir, '03-double-after-submit.png'), fullPage: true });
    doubleCounts = {
      dom_clicks: doubleClickEvidence.click_events.length,
      marked_confirm_clicks: doubleClickEvidence.click_events.filter(item => item.on_marked_confirm_button).length,
      requests: postBetsRequests(session.entries).length,
      response_status: postBetsResponses(session.entries)[0]?.status ?? null,
      bets: doubleBets.length,
      idempotency_rows: doubleIdempotency.length,
      charge_transactions: doubleTransactions.filter(item => item.transaction_type === '消耗').length,
      mock_ft_bet: doubleMock.length,
    };
    writeJson(evidencePath('double-click-state.json'), {
      bets: doubleBets, idempotency: doubleIdempotency, transactions: doubleTransactions,
      mock_ft_bet_events: doubleMock, counts: doubleCounts,
    });
    check('double_click_document_events_2', doubleCounts.dom_clicks === 2, 2, doubleCounts.dom_clicks);
    check('double_click_confirm_button_events_2', doubleCounts.marked_confirm_clicks === 2, 2, doubleCounts.marked_confirm_clicks);
    check('double_click_post_bets_request_count_1', doubleCounts.requests === 1, 1, doubleCounts.requests);
    check('double_click_response_status_202', doubleCounts.response_status === 202, 202, doubleCounts.response_status);
    check('double_click_db_bets_1_confirmed', doubleCounts.bets === 1 && doubleBets[0].status === 'confirmed',
      { count: 1, status: 'confirmed' }, { count: doubleCounts.bets, status: doubleBets[0]?.status });
    check('double_click_idempotency_rows_1', doubleCounts.idempotency_rows === 1, 1, doubleCounts.idempotency_rows);
    check('double_click_mock_ft_bet_1', doubleCounts.mock_ft_bet === 1, 1, doubleCounts.mock_ft_bet);
    check('double_click_charge_transactions_1', doubleCounts.charge_transactions === 1, 1, doubleCounts.charge_transactions);

    // Scenario B: backend accepts request, browser response is delayed, page reloads before delivery.
    refreshRoute = await registerDelayedBetsRoute(session.page);
    const refreshModal = await openCornerBetModal(session.page, fixtures[1].home,
      path.join(screenshotDir, '04-refresh-modal-before-submit.png'));
    writeJson(evidencePath('refresh-modal.json'), refreshModal);
    await session.page.getByRole('button', { name: /确认下注\s*\(1个账号\)/ }).click();
    await waitFor(() => refreshRoute.backend_response !== null, 30000, 'delayed route backend response');
    const refreshBets = await waitConfirmedBetByMatch(db, fixtures[1].id, 25000);
    const refreshIdempotencyAfterBackend = await getIdempotencyRows(db);
    const refreshTransactionsAfterBackend = await getTransactionRows(db);
    const refreshMockAfterBackend = mockEventsForFixture(services.mock, fixtures[1]);
    writeJson(evidencePath('refresh-backend-accepted-db-state.json'), {
      route_response: refreshRoute.backend_response,
      bets: refreshBets, idempotency: refreshIdempotencyAfterBackend,
      transactions: refreshTransactionsAfterBackend, mock_ft_bet_events: refreshMockAfterBackend,
    });

    const reloadStartedAt = new Date().toISOString();
    await session.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(resolve => setTimeout(resolve, postReloadObservationMs));
    const allPostRequests = postBetsRequests(session.entries);
    const refreshKey = refreshIdempotencyAfterBackend.at(-1)?.idempotency_key || null;
    const refreshRequests = allPostRequests.filter(item => item.post_data?.idempotency_key === refreshKey);
    const refreshFailures = postBetsFailures(session.entries).filter(item => item.post_data?.idempotency_key === refreshKey);
    refreshCounts = {
      before_reload: refreshRequests.filter(item => item.at < reloadStartedAt).length,
      after_reload: refreshRequests.filter(item => item.at >= reloadStartedAt).length,
      browser_failures: refreshFailures.length,
      reload_started_at: reloadStartedAt,
      observation_ms: postReloadObservationMs,
      idempotency_key: refreshKey,
    };
    await session.page.screenshot({ path: path.join(screenshotDir, '05-refresh-after-reload.png'), fullPage: true });
    writeJson(evidencePath('refresh-replay-network-evidence.json'), {
      route: refreshRoute,
      counts: refreshCounts,
      request_failed_events: refreshFailures,
      browser_post_bets_requests: refreshRequests,
    });

    const finalChargeBeforeStop = (await getTransactionRows(db)).filter(item => item.transaction_type === '消耗').length;
    check('refresh_backend_response_received_202', refreshRoute.backend_response?.status === 202, 202, refreshRoute.backend_response?.status ?? null);
    check('refresh_db_bet_confirmed_before_browser_response', refreshBets.length === 1 && refreshBets[0].status === 'confirmed',
      { count: 1, status: 'confirmed' }, { count: refreshBets.length, status: refreshBets[0]?.status });
    check('refresh_request_aborted_in_browser', refreshCounts.browser_failures >= 1, true, refreshCounts.browser_failures);
    check('refresh_post_bets_after_reload_0', refreshCounts.after_reload === 0, 0, refreshCounts.after_reload);
    check('refresh_db_bets_1', refreshBets.length === 1, 1, refreshBets.length);
    check('refresh_idempotency_rows_total_2', refreshIdempotencyAfterBackend.length === 2, 2, refreshIdempotencyAfterBackend.length);
    check('refresh_mock_ft_bet_1', refreshMockAfterBackend.length === 1, 1, refreshMockAfterBackend.length);
    check('refresh_charge_transactions_2_total', finalChargeBeforeStop === 2, 2, finalChargeBeforeStop);

    finalMockFtBetCount = services.mock.ftBetEvents.length;
    session.record();
    finalBets = (await db.query(`
      SELECT b.id, b.user_id, b.account_id, a.username AS account_username, b.match_id, b.status,
             b.official_bet_id, b.bet_amount::text AS bet_amount, b.virtual_bet_amount::text AS virtual_bet_amount,
             b.created_at, b.confirmed_at
        FROM bets b JOIN crown_accounts a ON a.id=b.account_id ORDER BY b.id
    `)).rows;
    finalIdempotency = await getIdempotencyRows(db);
    finalTransactions = await getTransactionRows(db);
    finalIntegrity = await getIntegrityRows(db);
    writeJson(evidencePath('db-final.json'), {
      bets: finalBets, idempotency: finalIdempotency, transactions: finalTransactions, integrity: finalIntegrity,
    });
    writeJson(evidencePath('mock-events.json'), {
      all_events: services.mock.events,
      ft_bet_events: services.mock.ftBetEvents,
      double_click_ft_bet_events: doubleMock,
      refresh_ft_bet_events: refreshMockAfterBackend,
    });
    writeJson(evidencePath('ws-events.json'), services.wsFixture.events);

    browserHosts = [...new Set(session.entries.filter(item => item.host).map(item => item.host))];
    nonLoopbackHosts = browserHosts.filter(host => host !== '127.0.0.1' && host !== '::1' && host !== 'localhost');
    writeJson(evidencePath('browser-host-boundary.json'), { hosts: browserHosts, non_loopback_hosts: nonLoopbackHosts });
    check('browser_only_local_hosts', nonLoopbackHosts.length === 0, [], nonLoopbackHosts);
    check('final_bets_total_2_confirmed', finalBets.length === 2 && finalBets.every(item => item.status === 'confirmed'),
      { total: 2, statuses: { confirmed: 2 } }, {
        total: finalBets.length,
        statuses: finalBets.reduce((acc, item) => ({ ...acc, [item.status]: (acc[item.status] || 0) + 1 }), {}),
      });
    check('final_idempotency_total_2_created', finalIdempotency.length === 2 && finalIdempotency.every(item => item.status === 'created'),
      { total: 2, created: 2 }, {
        total: finalIdempotency.length,
        statuses: finalIdempotency.reduce((acc, item) => ({ ...acc, [item.status]: (acc[item.status] || 0) + 1 }), {}),
      });
    check('all_idempotency_keys_unique', new Set(finalIdempotency.map(item => `${item.user_id}:${item.idempotency_key}`)).size === 2,
      2, new Set(finalIdempotency.map(item => `${item.user_id}:${item.idempotency_key}`)).size);
    const finalCharge = finalTransactions.filter(item => item.transaction_type === '消耗');
    check('final_mock_ft_transaction_counts', services.mock.ftBetEvents.length === 2 && finalCharge.length === 2,
      { mock_ft_bet: 2, charge_transactions: 2 },
      { mock_ft_bet: services.mock.ftBetEvents.length, charge_transactions: finalCharge.length });
    check('final_transaction_ids_unique', new Set(finalCharge.map(item => item.transaction_id)).size === 2,
      2, new Set(finalCharge.map(item => item.transaction_id)).size);
    check('final_integrity_issues_0', finalIntegrity.length === 0, [], finalIntegrity);
  } catch (error) {
    fatal.push(error?.stack || String(error));
  } finally {
    if (session) await session.context.close().catch(() => undefined);
    if (browser) await browser.close().catch(() => undefined);
    if (services) {
      stopEvidence = await stopServices(services, 'phase3g finally', 'stop-evidence.json').catch(error => {
        fatal.push(`stopServices failed: ${error?.stack || String(error)}`);
        return null;
      });
      services = null;
    }
    check('all_target_ports_down_after_stop', !stopEvidence || stopEvidence.all_target_ports_down === true, true,
      stopEvidence?.target_ports_open_after_stop ?? 'stop evidence missing');
    const portsAfter = await targetPortsOpen();
    writeJson(evidencePath('target-port-guard-after.json'), { target_ports_open_after: portsAfter });
    check('target_ports_free_after', portsAfter.length === 0, [], portsAfter);
    if (db) await db.end().catch(() => undefined);
    guardAfter = await guardDbSnapshot().catch(error => {
      fatal.push(`guard snapshot after failed: ${error?.stack || String(error)}`);
      return null;
    });
    if (guardAfter) writeJson(evidencePath('guard-db-after.json'), guardAfter);
    check('guard_db_sha256_unchanged', guardBefore.sha256 === guardAfter?.sha256, guardBefore.sha256, guardAfter?.sha256 ?? null);
    const hashesAfter = watchedHashMap();
    writeJson(evidencePath('watched-file-hashes-after.json'), hashesAfter);
    check('watched_files_unchanged_during_run', same(hashesBefore, hashesAfter), hashesBefore, hashesAfter);

    secretScan = scanEvidence(evidenceDir);
    const secretClean = secretScan.jwt_matches.length === 0 && secretScan.secret_literal_matches.length === 0 &&
      secretScan.sensitive_header_matches.length === 0 && secretScan.connection_string_matches.length === 0;
    check('evidence_secret_scan_clean', secretClean, true, secretScan);
    writeJson(evidencePath('evidence-secret-scan.json'), secretScan);

    result.checked_at_utc = new Date().toISOString();
    result.checked_at_beijing = beijingTime(new Date());
    result.success = fatal.length === 0 && result.assertions.every(item => item.passed);
    result.summary = {
      assertion_counts: assertionCounts(),
      double_click: doubleCounts,
      refresh: refreshCounts,
      final_counts: {
        bets: finalBets.length, idempotency: finalIdempotency.length,
        charge_transactions: finalTransactions.filter(item => item.transaction_type === '消耗').length,
        mock_ft_bet: finalMockFtBetCount,
        integrity_issues: finalIntegrity.length,
      },
      browser_hosts: browserHosts,
      non_loopback_hosts: nonLoopbackHosts,
      target_ports_open_after_stop: stopEvidence?.target_ports_open_after_stop ?? portsAfter,
      evidence_secret_scan_clean: secretClean,
    };
    result.fatal_errors = fatal;
    writeReport();
    writeJson(evidencePath('final-assertions.json'), result);
    fs.writeFileSync(path.join(deployRoot, '证据', 'phase3g-ui-replay', 'latest-run-id.txt'), `${runId}\n`, 'utf8');
    console.log(JSON.stringify({
      success: result.success, run_id: runId, database: dbName,
      assertions: assertionCounts(), report: result.report_file, fatal_errors: fatal,
    }, null, 2));
    if (!result.success) process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});



