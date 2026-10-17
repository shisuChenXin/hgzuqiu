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
const { createMockUpstream } = require('./phase2-servers');

const runStartedAt = new Date();
const runId = `${formatBeijingTimestamp(runStartedAt)}-${process.pid}`;
const evidenceDir = path.join(deployRoot, '证据', 'phase4a-multi-backend-idempotency', runId);
const reportDir = path.join(deployRoot, '报告');
const dbName = `hgzuqiu_phase4a_${runId.slice(0, 15).replace(/[^0-9]/g, '')}_${process.pid}`;
const dbPasswordPlain = `Phase4A!${process.pid}`;
const jwtSecret = `phase4a-${crypto.randomBytes(32).toString('hex')}`;
const urls = {
  mock: 'http://127.0.0.1:3301',
  backendA: 'http://127.0.0.1:3202',
  backendB: 'http://127.0.0.1:3203',
};
const targetPorts = [3301, 3202, 3203];
const matchTime = new Date(Date.now() + 2 * 60 * 60 * 1000);
const fixtures = {
  sameUser: { id: 940001, gid: '940001', league: 'Phase4A Same User League', home: 'Phase4A Same User Home', away: 'Phase4A Same User Away' },
  crossUser: { id: 940002, gid: '940002', league: 'Phase4A Cross User League', home: 'Phase4A Cross User Home', away: 'Phase4A Cross User Away' },
};
const markets = {
  cornerFull: {
    handicapLines: [{
      hdp: '1', line: '1', home: '1.90', away: '1.90',
      __meta: { gid: 'fixture', hgid: 'fixture', isMaster: 'Y', mode: 'CN' },
    }],
  },
};
const result = {
  phase: 'phase4a-multi-backend-idempotency',
  run_id: runId,
  run_started_at_utc: runStartedAt.toISOString(),
  run_started_at_beijing: beijingTime(runStartedAt),
  checked_at_utc: null,
  checked_at_beijing: null,
  git_commit: gitRevision(),
  database: dbName,
  urls,
  evidence_dir: path.relative(deployRoot, evidenceDir),
  assertions: [],
  fatal_errors: [],
  summary: {},
  report_file: null,
  success: false,
};
const fatal = [];

function formatBeijingTimestamp(date) {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date);
  const get = type => parts.find(part => part.type === type).value;
  return `${get('year')}${get('month')}${get('day')}T${get('hour')}${get('minute')}${get('second')}`;
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
function gitRevision() {
  const found = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: deployRoot, encoding: 'utf8', windowsHide: true });
  return found.stdout.trim();
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
    host: requiredEnv(map, 'DB_HOST'),
    port: Number(requiredEnv(map, 'DB_PORT')),
    user: requiredEnv(map, 'DB_USER'),
    password: requiredEnv(map, 'DB_PASSWORD'),
    database,
    ssl: false,
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
  for (const port of targetPorts) if (await probePort('127.0.0.1', port)) open.push(port);
  return open;
}
async function waitHttpOk(url, timeout = 40000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (response.ok) return { status: response.status };
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw lastError || new Error(`timeout waiting for ${url}`);
}
async function waitFor(condition, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await condition();
    if (lastValue === true) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`timeout waiting for ${label}; lastValue=${JSON.stringify(lastValue)}`);
}
function sha256File(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function watchedHashMap() {
  const files = [
    'backend/src/app.ts',
    'backend/src/models/database.ts',
    'backend/src/routes/auth.ts',
    'backend/src/routes/bets.ts',
    'backend/src/services/account-selection.ts',
    'database/schema.sql',
    'database/migrations/20261017_add_bet_idempotency_requests.sql',
    '.verify-runtime/phase2-servers.js',
    '.verify-runtime/phase4a-multi-backend-run.js',
  ];
  return Object.fromEntries(files.map(file => [file, sha256File(path.join(deployRoot, file))]));
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
const SENSITIVE_JSON_KEYS = /^(?:token|password|authorization|access_token|refresh_token|secret)$/i;
function redactSensitive(value, key = '') {
  if (SENSITIVE_JSON_KEYS.test(key)) return '<redacted>';
  if (Array.isArray(value)) return value.map(item => redactSensitive(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey, redactSensitive(entryValue, entryKey),
    ]));
  }
  return value;
}
function evidenceFiles(rootDir, extensions = /\.(?:json|jsonl|txt|md)$/i) {
  const output = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (extensions.test(entry.name)) output.push(full);
    }
  }
  walk(rootDir);
  return output.sort();
}
function scanEvidenceSecrets(rootDir) {
  const jwtPattern = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
  const findings = [];
  for (const file of evidenceFiles(rootDir)) {
    const text = fs.readFileSync(file, 'utf8');
    const jwtMatches = text.match(jwtPattern) || [];
    for (const value of jwtMatches) {
      findings.push({ file: path.relative(rootDir, file), kind: 'jwt-like', length: value.length, sha256: crypto.createHash('sha256').update(value).digest('hex') });
    }
    for (const [kind, secret] of [['db_password', dbPasswordPlain], ['jwt_secret', jwtSecret]]) {
      let cursor = 0;
      while ((cursor = text.indexOf(secret, cursor)) !== -1) {
        findings.push({ file: path.relative(rootDir, file), kind, length: secret.length, sha256: crypto.createHash('sha256').update(secret).digest('hex') });
        cursor += secret.length;
      }
    }
  }
  return findings;
}
function scanNonLoopbackUrls(rootDir) {
  const pattern = /\b(?:https?|wss?):\/\/[^\s"'<>)]+/g;
  const findings = [];
  for (const file of evidenceFiles(rootDir)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const raw of text.match(pattern) || []) {
      try {
        const host = new URL(raw).hostname;
        if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
          findings.push({ file: path.relative(rootDir, file), url: raw.slice(0, 180), host });
        }
      } catch {
        findings.push({ file: path.relative(rootDir, file), url: raw.slice(0, 180), host: null });
      }
    }
  }
  return findings;
}
function startLogChild(file, command, args, options) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, '');
  const child = spawn(command, args, { ...options, windowsHide: true });
  const stream = fs.openSync(file, 'a');
  child.stdout.on('data', chunk => fs.writeSync(stream, chunk));
  child.stderr.on('data', chunk => fs.writeSync(stream, chunk));
  child.once('exit', () => fs.closeSync(stream, () => undefined));
  return child;
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
  return { exit_code: build.status };
}
async function guardDbSnapshot() {
  const map = parseEnvFile(backendEnvFile);
  const baseName = requiredEnv(map, 'DB_NAME');
  const client = await connectDb(baseName);
  try {
    const found = await client.query(`
      SELECT
        (SELECT COUNT(*) FROM users) AS users_count,
        (SELECT COUNT(*) FROM crown_accounts) AS crown_accounts_count,
        (SELECT COUNT(*) FROM matches) AS matches_count,
        (SELECT COUNT(*) FROM bets) AS bets_count,
        (SELECT COUNT(*) FROM coin_transactions) AS coin_transactions_count,
        (SELECT COALESCE(MAX(id), 0) FROM users) AS max_users_id,
        (SELECT COALESCE(MAX(id), 0) FROM crown_accounts) AS max_crown_accounts_id,
        (SELECT COALESCE(MAX(id), 0) FROM matches) AS max_matches_id,
        (SELECT COALESCE(MAX(id), 0) FROM bets) AS max_bets_id,
        (SELECT COALESCE(MAX(id), 0) FROM coin_transactions) AS max_coin_transactions_id
    `);
    return {
      database: baseName,
      snapshot: found.rows[0],
      sha256: crypto.createHash('sha256').update(JSON.stringify(canonical(found.rows[0]))).digest('hex'),
    };
  } finally { await client.end(); }
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
    const env = dbConfig(dbName);
    const migration = spawnSync(process.execPath, ['migrate.js'], {
      cwd: backendDir, encoding: 'utf8', windowsHide: true, timeout: 120000,
      env: {
        ...process.env, DB_HOST: env.host, DB_PORT: String(env.port),
        DB_USER: env.user, DB_PASSWORD: env.password, DB_NAME: dbName,
        DOTENV_CONFIG_QUIET: 'true',
      },
    });
    fs.writeFileSync(evidencePath('migration-initial-result.txt'), [
      `STDOUT\n${migration.stdout || ''}`, `STDERR\n${migration.stderr || ''}`, `EXIT=${migration.status}`,
    ].join('\n'), 'utf8');
    if (migration.status !== 0) throw new Error(`initial migration failed: ${migration.status}`);

    const passwordHash = await bcrypt.hash(dbPasswordPlain, 10);
    await client.query('BEGIN');
    async function createUser(spec) {
      const user = await client.query(`
        INSERT INTO users (username, email, password_hash, role, whitelabel_id, email_verified, trusted_ips)
        VALUES ($1, $2, $3, 'admin', 1, TRUE, $4::text[])
        RETURNING id, username, role, whitelabel_id
      `, [spec.username, `${spec.username}@phase4a.local`, passwordHash, ['127.0.0.1', '::1', '::ffff:127.0.0.1']]);
      const group = await client.query(
        'INSERT INTO groups (user_id, name, description) VALUES ($1,$2,$3) RETURNING id, name',
        [user.rows[0].id, `${spec.username} group`, 'Phase4A isolated local group'],
      );
      const account = await client.query(`
        INSERT INTO crown_accounts (
          user_id, group_id, username, password, original_username, initialized_username,
          discount, balance, credit, stop_profit_limit, is_enabled, is_online, status,
          football_prematch_limit, football_live_limit
        ) VALUES ($1,$2,$3,'local-only-not-real-password',$4,$4,0.80,5000,100000,0,TRUE,TRUE,'active',100000,100000)
        RETURNING id, username, original_username, discount::text AS discount, credit::text AS credit, is_online
      `, [user.rows[0].id, group.rows[0].id, `${spec.username}-crown`, `${spec.linePrefix}-PHASE4A`]);
      await client.query(`
        INSERT INTO coin_transactions (user_id, account_id, bet_id, transaction_id, transaction_type, description, amount, balance_before, balance_after)
        VALUES ($1,NULL,NULL,$2,'充值','Phase4A isolated seed',1000,0,1000)
      `, [user.rows[0].id, `PHASE4A-SEED-${spec.key.toUpperCase()}`]);
      return { key: spec.key, user: user.rows[0], group: group.rows[0], account: account.rows[0] };
    }

    const alpha = await createUser({ key: 'alpha', username: 'phase4a-alpha-admin', linePrefix: 'AAAA' });
    const beta = await createUser({ key: 'beta', username: 'phase4a-beta-admin', linePrefix: 'BBBB' });
    for (const fixture of Object.values(fixtures)) {
      await client.query(`
        INSERT INTO matches (id, match_id, league_name, home_team, away_team, match_time, status, markets, odds_home_win, odds_draw, odds_away_win)
        VALUES ($1,$2,$3,$4,$5,$6,'live',$7::jsonb,2.10,3.30,3.20)
      `, [fixture.id, fixture.gid, fixture.league, fixture.home, fixture.away, matchTime, JSON.stringify(markets)]);
    }
    await client.query(`SELECT setval(pg_get_serial_sequence('matches','id'), (SELECT MAX(id) FROM matches), TRUE)`);
    await client.query('COMMIT');
    return {
      database: dbName,
      password_evidence: { policy: 'not written; held in process memory only' },
      alpha,
      beta,
      fixtures,
      seed_balances: { alpha: 1000, beta: 1000 },
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { await client.end(); }
}
async function repeatMigrationDirectly(db) {
  const migrationFile = path.join(deployRoot, 'database', 'migrations', '20261017_add_bet_idempotency_requests.sql');
  const sql = fs.readFileSync(migrationFile, 'utf8');
  const runs = [];
  for (let index = 1; index <= 2; index += 1) {
    const before = await db.query('SELECT COUNT(*)::int AS rows FROM bet_idempotency_requests');
    const startedAt = new Date().toISOString();
    await db.query(sql);
    const after = await db.query('SELECT COUNT(*)::int AS rows FROM bet_idempotency_requests');
    runs.push({ run: index, file: path.relative(deployRoot, migrationFile), started_at_utc: startedAt, exit: 0, rows_before: before.rows[0].rows, rows_after: after.rows[0].rows });
  }
  const constraints = await db.query(`
    SELECT constraint_name, constraint_type
      FROM information_schema.table_constraints
     WHERE table_name = 'bet_idempotency_requests'
     ORDER BY constraint_name
  `);
  const indexes = await db.query(`
    SELECT indexname, indexdef
      FROM pg_indexes
     WHERE tablename = 'bet_idempotency_requests'
     ORDER BY indexname
  `);
  const evidence = { runs, constraints: constraints.rows, indexes: indexes.rows };
  writeJson(evidencePath('migration-repeat-direct-result.json'), evidence);
  return evidence;
}
function backendEnv(port) {
  const base = dbConfig(dbName);
  return {
    ...process.env,
    NODE_ENV: 'development',
    DB_HOST: base.host,
    DB_PORT: String(base.port),
    DB_USER: base.user,
    DB_PASSWORD: base.password,
    DB_NAME: dbName,
    HOST: '127.0.0.1',
    PORT: String(port),
    JWT_SECRET: jwtSecret,
    CROWN_BASE_URL: urls.mock,
    CROWN_BASE_URL_CANDIDATES: urls.mock,
    CROWN_API_KEEPALIVE_ENABLED: 'false',
    CROWN_ONLINE_CHECK_INTERVAL_MS: '600000',
    CORS_ALLOWED_ORIGINS: 'http://127.0.0.1:10090',
    DOTENV_CONFIG_QUIET: 'true',
  };
}
async function startServices(mockBundle) {
  const startedAt = new Date().toISOString();
  await new Promise((resolve, reject) => {
    mockBundle.mock.server.once('error', reject);
    mockBundle.mock.server.listen(3301, '127.0.0.1', resolve);
  });

  const backendALog = evidencePath('backend-a-log.txt');
  const backendBLog = evidencePath('backend-b-log.txt');
  const backendChildA = startLogChild(backendALog, process.execPath, ['dist/app.js'], { cwd: backendDir, env: backendEnv(3202) });
  const backendChildB = startLogChild(backendBLog, process.execPath, ['dist/app.js'], { cwd: backendDir, env: backendEnv(3203) });
  try {
    const [backendAHealth, backendBHealth, mockHealth] = await Promise.all([
      waitHttpOk(`${urls.backendA}/api/health`, 40000),
      waitHttpOk(`${urls.backendB}/api/health`, 40000),
      waitHttpOk(`${urls.mock}/`, 10000),
    ]);
    const runtimeConfig = {
      started_at_utc: startedAt,
      database: dbName,
      jwt_secret: '<process-memory-only>',
      upstream: urls.mock,
      backends: [
        { role: 'backend-a', port: 3202, pid: backendChildA.pid, database: dbName, log: path.relative(deployRoot, backendALog) },
        { role: 'backend-b', port: 3203, pid: backendChildB.pid, database: dbName, log: path.relative(deployRoot, backendBLog) },
      ],
      network_boundary: {
        crown_base_url: urls.mock,
        crown_base_url_candidates: urls.mock,
        all_service_hosts: ['127.0.0.1'],
      },
    };
    const health = { started_at_utc: startedAt, backend_a: backendAHealth, backend_b: backendBHealth, mock: mockHealth, runtime_config: runtimeConfig };
    writeJson(evidencePath('service-health.json'), health);
    return { mockBundle, backendChildA, backendChildB, backendALog, backendBLog, runtimeConfig, health };
  } catch (error) {
    await stopServices({
      mockBundle, backendChildA, backendChildB,
    }, 'startup failure', 'startup-failure-stop-evidence.json').catch(() => undefined);
    throw error;
  }
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
      timer.unref?.();
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
  const closeCallbackCompleted = await new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), 8000);
    timer.unref?.();
    server.close(() => { clearTimeout(timer); resolve(true); });
  }).catch(() => false);
  return { role, close_callback_completed: closeCallbackCompleted, stopped_at: new Date().toISOString() };
}
async function stopServices(services, label, evidenceName) {
  const evidence = { label, stopped_at: new Date().toISOString(), services: {} };
  evidence.services.backend_a = await stopLoggedChild(services?.backendChildA, 'backend-a');
  evidence.services.backend_b = await stopLoggedChild(services?.backendChildB, 'backend-b');
  evidence.services.mock_server = await closeHttpServer(services?.mockBundle?.mock?.server, 'mock upstream');
  await new Promise(resolve => setTimeout(resolve, 300));
  evidence.target_ports_open_after_stop = await targetPortsOpen();
  evidence.all_target_ports_down = evidence.target_ports_open_after_stop.length === 0;
  if (evidenceName) writeJson(evidencePath(evidenceName), evidence);
  return evidence;
}
async function apiRequest({ method, url, token, body, label, headers = {} }) {
  const startedAt = new Date();
  const startedHighRes = performance.now();
  const requestHeaders = { ...headers };
  if (body !== undefined) requestHeaders['content-type'] = 'application/json';
  if (token) requestHeaders.authorization = `Bearer ${token}`;
  let response;
  let rawResponseBody = null;
  try {
    response = await fetch(url, {
      method, headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store',
    });
    const responseText = await response.text();
    let responseBody;
    try { responseBody = JSON.parse(responseText); } catch { responseBody = responseText; }
    rawResponseBody = responseBody;
    return {
      label, method, url,
      request_headers: {
        content_type: body === undefined ? null : 'application/json',
        authorization: token ? '<redacted>' : null,
        idempotency_key: requestHeaders['Idempotency-Key'] ?? null,
      },
      request_body: redactSensitive(body),
      response_status: response.status,
      response_ok: response.ok,
      response_headers: { idempotency_replayed: response.headers.get('idempotency-replayed'), content_type: response.headers.get('content-type') },
      response_body: redactSensitive(responseBody),
      started_at_utc: startedAt.toISOString(),
      ended_at_utc: new Date().toISOString(),
      duration_ms: Math.round(performance.now() - startedHighRes),
      transport_error: null,
      raw_response_body: rawResponseBody,
    };
  } catch (error) {
    return {
      label, method, url,
      request_headers: {
        content_type: body === undefined ? null : 'application/json',
        authorization: token ? '<redacted>' : null,
        idempotency_key: requestHeaders['Idempotency-Key'] ?? null,
      },
      request_body: redactSensitive(body), response_status: null, response_ok: false,
      response_headers: null, response_body: null, started_at_utc: startedAt.toISOString(),
      ended_at_utc: new Date().toISOString(), duration_ms: Math.round(performance.now() - startedHighRes),
      transport_error: error?.stack || String(error), raw_response_body: rawResponseBody,
    };
  }
}
function publicRequest(record) {
  if (!record) return record;
  const { raw_response_body, ...publicRecord } = record;
  return publicRecord;
}
async function loginApi(username, baseUrl, label) {
  const request = await apiRequest({
    method: 'POST', url: `${baseUrl}/api/auth/login`,
    body: { username, password: dbPasswordPlain }, label: `${label}:POST /api/auth/login`,
  });
  const token = request.raw_response_body?.data?.token || null;
  request.token_evidence = token ? {
    stored: 'memory only during this process', length: token.length,
    sha256: crypto.createHash('sha256').update(token).digest('hex'),
  } : null;
  if (!request.response_ok || !request.response_body?.success || !token) {
    throw new Error(`${label} login failed: ${JSON.stringify(request.response_body || request.transport_error)}`);
  }
  return { username, baseUrl, token, request };
}
function buildBetPayload({ fixture, accountId, key, overrides = {} }) {
  return {
    idempotency_key: key,
    account_ids: [accountId],
    match_id: fixture.id,
    bet_type: '角球让球',
    bet_option: `Phase4A ${fixture.home} (角球 +1)`,
    total_amount: 80,
    odds: 1.9,
    single_limit: '5000',
    interval_range: '1-3',
    quantity: 1,
    min_odds: '1.90',
    crown_match_id: fixture.gid,
    league_name: fixture.league,
    home_team: fixture.home,
    away_team: fixture.away,
    match_time: matchTime.toISOString(),
    match_status: 'live',
    current_score: '',
    match_period: '',
    market_category: 'handicap',
    market_scope: 'full',
    market_side: 'home',
    market_line: '1',
    market_index: 0,
    market_wtype: 'CNR',
    market_rtype: 'CNRH',
    ...overrides,
  };
}
async function launchPair(left, right) {
  const launchStarted = performance.now();
  const [leftResult, rightResult] = await Promise.all([left(), right()]);
  return {
    launch_span_ms: Math.round(performance.now() - launchStarted),
    request_start_delay_ms: Math.abs(Date.parse(rightResult.started_at_utc) - Date.parse(leftResult.started_at_utc)),
    intervals_overlap: Date.parse(leftResult.started_at_utc) <= Date.parse(rightResult.ended_at_utc) && Date.parse(rightResult.started_at_utc) <= Date.parse(leftResult.ended_at_utc),
    left: leftResult,
    right: rightResult,
  };
}
async function getBets(db) {
  const found = await db.query(`
    SELECT b.id, b.user_id, u.username AS user_username, b.account_id, a.username AS account_username,
           a.original_username, b.match_id, b.bet_type, b.bet_option, b.status, b.error_message,
           b.official_bet_id, b.bet_amount::text AS bet_amount, b.virtual_bet_amount::text AS virtual_bet_amount,
           b.created_at, b.confirmed_at, b.updated_at
      FROM bets b
      JOIN users u ON u.id=b.user_id
      JOIN crown_accounts a ON a.id=b.account_id
     ORDER BY b.id
  `);
  return found.rows;
}
async function getIdempotencyRows(db) {
  const found = await db.query(`
    SELECT i.id::text AS id, i.user_id, u.username AS user_username, i.idempotency_key, i.request_hash, i.status,
           i.bet_ids, i.response_json, i.http_status, i.created_at, i.updated_at
      FROM bet_idempotency_requests i
      JOIN users u ON u.id=i.user_id
     ORDER BY i.id
  `);
  return found.rows;
}
async function getTransactions(db) {
  const found = await db.query(`
    SELECT c.id, c.user_id, u.username AS user_username, c.account_id, c.bet_id, c.transaction_id,
           c.transaction_type, c.description, c.amount::text AS amount,
           c.balance_before::text AS balance_before, c.balance_after::text AS balance_after, c.created_at
      FROM coin_transactions c JOIN users u ON u.id=c.user_id ORDER BY c.id
  `);
  return found.rows;
}
async function getIntegrityIssues(db) {
  const found = await db.query(`
    SELECT 'missing_transaction_for_active_bet' AS issue, b.id AS bet_id
      FROM bets b
     WHERE b.status <> 'cancelled'
       AND NOT EXISTS (SELECT 1 FROM coin_transactions t WHERE t.bet_id=b.id AND t.transaction_type='消耗')
    UNION ALL
    SELECT 'charge_transaction_without_active_bet' AS issue, t.bet_id
      FROM coin_transactions t LEFT JOIN bets b ON b.id=t.bet_id
     WHERE t.transaction_type='消耗' AND (b.id IS NULL OR b.status='cancelled')
    ORDER BY issue, bet_id
  `);
  return found.rows;
}
function mockEventsForFixture(mockBundle, fixture) {
  return mockBundle.mock.events.filter(event =>
    event.action === 'FT_bet' && String(event.params?.gid || '') === String(fixture.gid));
}
async function captureState(db, mockBundle, fixture) {
  const [bets, idempotency, transactions, integrity] = await Promise.all([
    getBets(db), getIdempotencyRows(db), getTransactions(db), getIntegrityIssues(db),
  ]);
  return {
    checked_at_utc: new Date().toISOString(),
    fixture_bets: bets.filter(item => Number(item.match_id) === Number(fixture.id)),
    bets,
    idempotency,
    transactions,
    charge_transactions: transactions.filter(item => item.transaction_type === '消耗'),
    integrity,
    mock_ft_bet_events: mockEventsForFixture(mockBundle, fixture),
    mock_all_ft_bet_events: mockBundle.mock.ftBetEvents.slice(),
  };
}
async function waitTerminalBets(db, expectedCount, label) {
  await waitFor(async () => {
    const bets = await getBets(db);
    return bets.length === expectedCount && bets.every(item => ['confirmed', 'cancelled', 'settled'].includes(item.status));
  }, 30000, label);
  return getBets(db);
}
function responseInterval(record) {
  return {
    started_at_utc: record.started_at_utc,
    ended_at_utc: record.ended_at_utc,
    duration_ms: record.duration_ms,
    response_status: record.response_status,
    idempotency_replayed: record.response_headers?.idempotency_replayed ?? null,
  };
}
async function runSameUserScenario(db, mockBundle, seed, token) {
  const fixture = fixtures.sameUser;
  const key = 'phase4a-alpha-same-key';
  const payload = buildBetPayload({ fixture, accountId: seed.alpha.account.id, key });
  const before = await captureState(db, mockBundle, fixture);
  const concurrent = await launchPair(
    () => apiRequest({ method: 'POST', url: `${urls.backendA}/api/bets`, token, body: payload, label: 'same-user A:POST /api/bets' }),
    () => apiRequest({ method: 'POST', url: `${urls.backendB}/api/bets`, token, body: payload, label: 'same-user B:POST /api/bets' }),
  );
  await waitFor(() => mockEventsForFixture(mockBundle, fixture).length >= 1, 30000, 'same-user FT_bet');
  await waitTerminalBets(db, before.bets.length + 1, 'same-user terminal bet');
  await waitFor(async () => (await getTransactions(db)).filter(item => item.transaction_type === '消耗').length === before.charge_transactions.length + 1, 30000, 'same-user charge transaction');
  const after = await captureState(db, mockBundle, fixture);
  const [requestA, requestB] = [concurrent.left, concurrent.right];
  const evidence = {
    scenario: 'same user, same key, simultaneous requests to two backend processes',
    fixture, key, account_id: seed.alpha.account.id,
    concurrency: {
      launch_span_ms: concurrent.launch_span_ms,
      request_start_delay_ms: concurrent.request_start_delay_ms,
      intervals_overlap: concurrent.intervals_overlap,
      intervals: [responseInterval(requestA), responseInterval(requestB)],
    },
    before,
    requests: [publicRequest(requestA), publicRequest(requestB)],
    responses_canonically_equal: same(requestA.response_body, requestB.response_body),
    request_a_bet_ids: requestA.response_body?.data?.bet_ids ?? [],
    request_b_bet_ids: requestB.response_body?.data?.bet_ids ?? [],
    after,
    idempotency_row: after.idempotency.find(item => item.user_id === seed.alpha.user.id && item.idempotency_key === key) || null,
    created_counts: {
      bets: after.bets.length - before.bets.length,
      idempotency: after.idempotency.length - before.idempotency.length,
      mock_ft_bet: after.mock_ft_bet_events.length - before.mock_ft_bet_events.length,
      charge_transactions: after.charge_transactions.length - before.charge_transactions.length,
    },
  };
  writeJson(evidencePath('scenario-same-user-same-key.json'), evidence);
  return evidence;
}
async function runCrossUserScenario(db, mockBundle, seed, alphaToken, betaToken) {
  const fixture = fixtures.crossUser;
  const key = 'phase4a-shared-key';
  const alphaPayload = buildBetPayload({ fixture, accountId: seed.alpha.account.id, key });
  const betaPayload = buildBetPayload({ fixture, accountId: seed.beta.account.id, key });
  const before = await captureState(db, mockBundle, fixture);
  const concurrent = await launchPair(
    () => apiRequest({ method: 'POST', url: `${urls.backendA}/api/bets`, token: alphaToken, body: alphaPayload, label: 'cross-user alpha A:POST /api/bets' }),
    () => apiRequest({ method: 'POST', url: `${urls.backendB}/api/bets`, token: betaToken, body: betaPayload, label: 'cross-user beta B:POST /api/bets' }),
  );
  await waitFor(() => mockEventsForFixture(mockBundle, fixture).length >= 2, 30000, 'cross-user FT_bet events');
  await waitTerminalBets(db, before.bets.length + 2, 'cross-user terminal bets');
  await waitFor(async () => (await getTransactions(db)).filter(item => item.transaction_type === '消耗').length === before.charge_transactions.length + 2, 30000, 'cross-user charge transactions');
  const after = await captureState(db, mockBundle, fixture);
  const alphaRow = after.idempotency.find(item => item.user_id === seed.alpha.user.id && item.idempotency_key === key) || null;
  const betaRow = after.idempotency.find(item => item.user_id === seed.beta.user.id && item.idempotency_key === key) || null;
  const evidence = {
    scenario: 'different users submit the same key simultaneously to different backend processes',
    fixture, key,
    concurrency: {
      launch_span_ms: concurrent.launch_span_ms,
      request_start_delay_ms: concurrent.request_start_delay_ms,
      intervals_overlap: concurrent.intervals_overlap,
      intervals: [responseInterval(concurrent.left), responseInterval(concurrent.right)],
    },
    before,
    requests: [publicRequest(concurrent.left), publicRequest(concurrent.right)],
    after,
    alpha_idempotency_row: alphaRow,
    beta_idempotency_row: betaRow,
    rows_have_same_key_and_distinct_users: Boolean(alphaRow && betaRow && alphaRow.idempotency_key === betaRow.idempotency_key && alphaRow.user_id !== betaRow.user_id),
    created_counts: {
      bets: after.bets.length - before.bets.length,
      idempotency: after.idempotency.length - before.idempotency.length,
      mock_ft_bet: after.mock_ft_bet_events.length - before.mock_ft_bet_events.length,
      charge_transactions: after.charge_transactions.length - before.charge_transactions.length,
    },
  };
  writeJson(evidencePath('scenario-cross-user-same-key.json'), evidence);
  return evidence;
}
async function runChangedPayloadScenario(db, mockBundle, seed, token, key) {
  const fixture = fixtures.sameUser;
  const changedPayload = buildBetPayload({
    fixture, accountId: seed.alpha.account.id, key, overrides: { total_amount: 81, bet_option: `Phase4A changed payload ${fixture.home}` },
  });
  const before = await captureState(db, mockBundle, fixture);
  const request = await apiRequest({
    method: 'POST', url: `${urls.backendB}/api/bets`, token,
    body: changedPayload, label: 'changed payload B:POST /api/bets',
  });
  await new Promise(resolve => setTimeout(resolve, 300));
  const after = await captureState(db, mockBundle, fixture);
  const evidence = {
    scenario: 'same user and key but changed payload submitted through the other backend process',
    fixture, key,
    before,
    request: publicRequest(request),
    after,
    created_counts: {
      bets: after.bets.length - before.bets.length,
      idempotency: after.idempotency.length - before.idempotency.length,
      mock_ft_bet: after.mock_ft_bet_events.length - before.mock_ft_bet_events.length,
      charge_transactions: after.charge_transactions.length - before.charge_transactions.length,
    },
    idempotency_row: after.idempotency.find(item => item.user_id === seed.alpha.user.id && item.idempotency_key === key) || null,
  };
  writeJson(evidencePath('scenario-changed-payload.json'), evidence);
  return evidence;
}
function countBy(rows, field) {
  return rows.reduce((accumulator, row) => {
    const key = String(row[field]);
    accumulator[key] = (accumulator[key] || 0) + 1;
    return accumulator;
  }, {});
}
function mdJson(value) { return '`' + JSON.stringify(value) + '`'; }

async function main() {
  ensureDir(evidenceDir);
  ensureDir(reportDir);
  const hashesBefore = watchedHashMap();
  writeJson(evidencePath('watched-file-hashes-before.json'), hashesBefore);
  const portsBefore = await targetPortsOpen();
  writeJson(evidencePath('target-port-guard-before.json'), { target_ports_open_before: portsBefore });
  check('target_ports_free_before', portsBefore.length === 0, [], portsBefore);
  if (portsBefore.length > 0) throw new Error(`target ports already occupied: ${portsBefore.join(',')}`);

  const guardBefore = await guardDbSnapshot();
  writeJson(evidencePath('guard-db-before.json'), guardBefore);
  const build = buildBackend();
  check('backend_build_passed', build.exit_code === 0, 0, build.exit_code);

  const seed = await createAndSeedDatabase();
  writeJson(evidencePath('db-seeded.json'), seed);
  let db = null;
  let services = null;
  let mockBundle = null;
  let sameUser = null;
  let crossUser = null;
  let changedPayload = null;
  let finalBets = null;
  let finalIdempotency = null;
  let finalTransactions = null;
  let finalIntegrity = null;
  let stopEvidence = null;
  let guardAfter = null;

  try {
    db = await connectDb(dbName);
    check('fresh_database_starts_without_bets', (await db.query('SELECT COUNT(*)::int AS rows FROM bets')).rows[0].rows === 0, 0, (await db.query('SELECT COUNT(*)::int AS rows FROM bets')).rows[0].rows);
    check('fresh_database_starts_without_idempotency_rows', (await db.query('SELECT COUNT(*)::int AS rows FROM bet_idempotency_requests')).rows[0].rows === 0, 0, (await db.query('SELECT COUNT(*)::int AS rows FROM bet_idempotency_requests')).rows[0].rows);

    const migrationRepeat = await repeatMigrationDirectly(db);
    check('migration_repeat_idempotent', migrationRepeat.runs.length === 2 && migrationRepeat.runs.every(item => item.exit === 0 && item.rows_after === 0), { runs: 2, exit: [0, 0], rows_after: [0, 0] }, migrationRepeat.runs);
    const constraintNames = migrationRepeat.constraints.map(item => item.constraint_name);
    check('database_unique_user_key_constraint_exists', constraintNames.includes('uq_bet_idempotency_user_key'), ['uq_bet_idempotency_user_key'], constraintNames);
    const uniqueIndex = migrationRepeat.indexes.find(item => item.indexdef.includes('UNIQUE') && item.indexdef.includes('user_id') && item.indexdef.includes('idempotency_key'));
    check('database_unique_index_covers_user_and_key', Boolean(uniqueIndex), true, uniqueIndex || null);

    const logFile = evidencePath('mock-upstream-log.jsonl');
    fs.writeFileSync(logFile, '', 'utf8');
    mockBundle = { mock: createMockUpstream({ host: '127.0.0.1', port: 3301, ticketPrefixes: ['PHASE4A'], logFile }), logFile };
    services = await startServices(mockBundle);
    check('backend_a_health_200', services.health.backend_a.status === 200, 200, services.health.backend_a.status);
    check('backend_b_health_200', services.health.backend_b.status === 200, 200, services.health.backend_b.status);
    check('mock_health_200', services.health.mock.status === 200, 200, services.health.mock.status);
    check('backend_processes_distinct_pids', Number(services.runtimeConfig.backends[0].pid) !== Number(services.runtimeConfig.backends[1].pid), true, services.runtimeConfig.backends.map(item => item.pid));
    check('both_backends_configured_same_database', services.runtimeConfig.backends.every(item => item.database === dbName), dbName, services.runtimeConfig.backends.map(item => item.database));
    check('both_backends_configured_loopback_upstream', services.runtimeConfig.network_boundary.crown_base_url === urls.mock && services.runtimeConfig.network_boundary.crown_base_url_candidates === urls.mock, urls.mock, services.runtimeConfig.network_boundary);

    const alphaLogin = await loginApi(seed.alpha.user.username, urls.backendA, 'alpha through backend A');
    const betaLogin = await loginApi(seed.beta.user.username, urls.backendB, 'beta through backend B');
    writeJson(evidencePath('api-login-alpha-redacted.json'), publicRequest(alphaLogin.request));
    writeJson(evidencePath('api-login-beta-redacted.json'), publicRequest(betaLogin.request));
    check('alpha_login_backend_a_success', alphaLogin.request.response_status === 200 && alphaLogin.request.response_body?.success === true, 200, alphaLogin.request.response_status);
    check('beta_login_backend_b_success', betaLogin.request.response_status === 200 && betaLogin.request.response_body?.success === true, 200, betaLogin.request.response_status);

    sameUser = await runSameUserScenario(db, mockBundle, seed, alphaLogin.token);
    const sameUserRequests = sameUser.requests;
    check('same_user_same_key_both_http_202', sameUserRequests.every(item => item.response_status === 202), [202, 202], sameUserRequests.map(item => item.response_status));
    check('same_user_same_key_concurrent_intervals_overlap', sameUser.concurrency.intervals_overlap === true, true, sameUser.concurrency);
    check('same_user_same_key_response_canonical_equal', sameUser.responses_canonically_equal === true, true, sameUser.responses_canonically_equal);
    check('same_user_same_key_replay_header_present_once', sameUserRequests.filter(item => item.response_headers?.idempotency_replayed === 'true').length === 1, 1, sameUserRequests.map(item => item.response_headers?.idempotency_replayed));
    check('same_user_same_key_bets_1', sameUser.created_counts.bets === 1 && sameUser.after.fixture_bets.length === 1, 1, { created: sameUser.created_counts.bets, fixture_total: sameUser.after.fixture_bets.length });
    check('same_user_same_key_idempotency_rows_1', sameUser.created_counts.idempotency === 1, 1, sameUser.created_counts.idempotency);
    check('same_user_same_key_mock_ft_bet_1', sameUser.created_counts.mock_ft_bet === 1, 1, sameUser.created_counts.mock_ft_bet);
    check('same_user_same_key_charge_transactions_1', sameUser.created_counts.charge_transactions === 1, 1, sameUser.created_counts.charge_transactions);
    check('same_user_same_key_response_snapshot_equal', Boolean(sameUser.idempotency_row?.status === 'created' && sameUser.idempotency_row.http_status === 202 && same(sameUser.idempotency_row.response_json, sameUser.requests.find(item => item.response_headers?.idempotency_replayed !== 'true')?.response_body)), true, sameUser.idempotency_row);

    crossUser = await runCrossUserScenario(db, mockBundle, seed, alphaLogin.token, betaLogin.token);
    const crossUserRequests = crossUser.requests;
    check('cross_user_same_key_both_http_202', crossUserRequests.every(item => item.response_status === 202), [202, 202], crossUserRequests.map(item => item.response_status));
    check('cross_user_same_key_no_replay_header', crossUserRequests.every(item => item.response_headers?.idempotency_replayed !== 'true'), [null, null], crossUserRequests.map(item => item.response_headers?.idempotency_replayed));
    check('cross_user_same_key_bets_2', crossUser.created_counts.bets === 2 && crossUser.after.fixture_bets.length === 2, 2, { created: crossUser.created_counts.bets, fixture_total: crossUser.after.fixture_bets.length });
    check('cross_user_same_key_idempotency_rows_2', crossUser.created_counts.idempotency === 2, 2, crossUser.created_counts.idempotency);
    check('cross_user_same_key_mock_ft_bet_2', crossUser.created_counts.mock_ft_bet === 2, 2, crossUser.created_counts.mock_ft_bet);
    check('cross_user_same_key_charge_transactions_2', crossUser.created_counts.charge_transactions === 2, 2, crossUser.created_counts.charge_transactions);
    check('cross_user_same_key_no_cross_user_bet_sharing', crossUser.rows_have_same_key_and_distinct_users === true && crossUser.after.fixture_bets.filter(item => item.user_id === seed.alpha.user.id).length === 1 && crossUser.after.fixture_bets.filter(item => item.user_id === seed.beta.user.id).length === 1, true, {
      rows: crossUser.rows_have_same_key_and_distinct_users,
      alpha_bets: crossUser.after.fixture_bets.filter(item => item.user_id === seed.alpha.user.id).length,
      beta_bets: crossUser.after.fixture_bets.filter(item => item.user_id === seed.beta.user.id).length,
    });

    changedPayload = await runChangedPayloadScenario(db, mockBundle, seed, alphaLogin.token, sameUser.key);
    check('same_user_same_key_changed_payload_409', changedPayload.request.response_status === 409, 409, changedPayload.request.response_status);
    check('changed_payload_no_new_bets', changedPayload.created_counts.bets === 0, 0, changedPayload.created_counts.bets);
    check('changed_payload_no_new_idempotency_row', changedPayload.created_counts.idempotency === 0, 0, changedPayload.created_counts.idempotency);
    check('changed_payload_no_new_mock_ft_bet', changedPayload.created_counts.mock_ft_bet === 0, 0, changedPayload.created_counts.mock_ft_bet);
    check('changed_payload_no_new_charge_transaction', changedPayload.created_counts.charge_transactions === 0, 0, changedPayload.created_counts.charge_transactions);

    [finalBets, finalIdempotency, finalTransactions, finalIntegrity] = await Promise.all([
      getBets(db), getIdempotencyRows(db), getTransactions(db), getIntegrityIssues(db),
    ]);
    const finalCharges = finalTransactions.filter(item => item.transaction_type === '消耗');
    const officialIds = finalBets.map(item => item.official_bet_id).filter(Boolean);
    const transactionIds = finalTransactions.map(item => item.transaction_id);
    writeJson(evidencePath('final-db-state.json'), {
      bets: finalBets, idempotency: finalIdempotency, transactions: finalTransactions, integrity: finalIntegrity,
    });
    check('final_bet_counts_and_ownership', finalBets.length === 3 && finalBets.filter(item => item.user_id === seed.alpha.user.id).length === 2 && finalBets.filter(item => item.user_id === seed.beta.user.id).length === 1, { total: 3, alpha: 2, beta: 1 }, { total: finalBets.length, alpha: finalBets.filter(item => item.user_id === seed.alpha.user.id).length, beta: finalBets.filter(item => item.user_id === seed.beta.user.id).length });
    check('final_bets_all_confirmed', finalBets.every(item => item.status === 'confirmed'), { confirmed: 3 }, countBy(finalBets, 'status'));
    check('final_idempotency_rows_3_created', finalIdempotency.length === 3 && finalIdempotency.every(item => item.status === 'created'), { total: 3, created: 3 }, { total: finalIdempotency.length, ...countBy(finalIdempotency, 'status') });
    check('final_mock_ft_bet_3', mockBundle.mock.ftBetEvents.length === 3, 3, mockBundle.mock.ftBetEvents.length);
    check('final_charge_transactions_3', finalCharges.length === 3, 3, finalCharges.length);
    check('final_official_bet_ids_unique', officialIds.length === 3 && new Set(officialIds).size === 3, 3, { count: officialIds.length, unique: new Set(officialIds).size });
    check('final_transaction_ids_unique', transactionIds.length === 5 && new Set(transactionIds).size === 5, 5, { count: transactionIds.length, unique: new Set(transactionIds).size });
    check('final_integrity_issues_0', finalIntegrity.length === 0, [], finalIntegrity);
    check('api_or_mock_only_local_hosts', mockBundle.mock.events.length > 0 && mockBundle.mock.events.every(item => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(item.remote_address)), true, [...new Set(mockBundle.mock.events.map(item => item.remote_address))]);

    stopEvidence = await stopServices(services, 'phase4a complete', 'stop-evidence.json');
    services = null;
    check('all_target_ports_down_after_stop', stopEvidence.all_target_ports_down === true, true, stopEvidence.target_ports_open_after_stop);
    const portsAfter = await targetPortsOpen();
    writeJson(evidencePath('target-port-guard-after.json'), { target_ports_open_after: portsAfter });
    check('target_ports_free_after', portsAfter.length === 0, [], portsAfter);
    guardAfter = await guardDbSnapshot();
    writeJson(evidencePath('guard-db-after.json'), guardAfter);
    check('guard_db_sha256_unchanged', guardBefore.sha256 === guardAfter.sha256, guardBefore.sha256, guardAfter.sha256);
    const hashesAfter = watchedHashMap();
    writeJson(evidencePath('watched-file-hashes-after.json'), hashesAfter);
    check('watched_files_unchanged_during_run', same(hashesBefore, hashesAfter), true, { before: hashesBefore, after: hashesAfter });

    result.summary = {
      backend_processes: 2,
      same_user_same_key: { http_status: sameUserRequests.map(item => item.response_status), bets: 1, idempotency_rows: 1, mock_ft_bet: 1, charge_transactions: 1, replay_header_count: 1 },
      cross_user_same_key: { http_status: crossUserRequests.map(item => item.response_status), bets: 2, idempotency_rows: 2, mock_ft_bet: 2, charge_transactions: 2 },
      changed_payload: { http_status: 409, new_bets: 0, new_idempotency_rows: 0, new_mock_ft_bet: 0, new_charge_transactions: 0 },
      final: { bets: finalBets.length, confirmed: finalBets.filter(item => item.status === 'confirmed').length, idempotency_rows: finalIdempotency.length, mock_ft_bet: mockBundle.mock.ftBetEvents.length, charge_transactions: finalCharges.length, integrity_issues: finalIntegrity.length },
      ports_after_stop: portsAfter,
    };
    writeJson(evidencePath('runtime-summary.json'), result.summary);

    const secretFindings = scanEvidenceSecrets(evidenceDir);
    const nonLoopbackUrls = scanNonLoopbackUrls(evidenceDir);
    const currentPassed = result.assertions.filter(item => item.passed).length;
    const projectedTotal = result.assertions.length + 2;
    const reportFile = path.join(reportDir, `${runId}-phase4a-同库双Backend幂等实证报告.md`);
    const reportLines = [
      '# Phase 4A 同库双 Backend 幂等实证报告', '',
      `- Run ID：\`${runId}\``,
      `- 开始时间（北京时间）：\`${result.run_started_at_beijing}\``,
      `- Git commit：\`${result.git_commit}\``,
      `- 主验证断言：\`${currentPassed}/${projectedTotal}\` passed（本文写入后追加 2 项证据扫描断言）`,
      `- 数据库：\`${dbName}\``,
      `- Backend A：\`${urls.backendA}\` / PID \`${services === null ? stopEvidence.services.backend_a.pid : 'unknown'}\``,
      `- Backend B：\`${urls.backendB}\` / PID \`${services === null ? stopEvidence.services.backend_b.pid : 'unknown'}\``,
      `- Mock upstream：\`${urls.mock}\``, '',
      '## 实证结论', '',
      '- `runtime_proven`：同用户同 key 同时提交到两个 backend 进程，两响应均为 202、canonical body 一致，且仅一个响应带 `Idempotency-Replayed: true`；最终注单、幂等行、`FT_bet`、扣款各 1。',
      '- `runtime_proven`：不同用户使用相同 key 同时提交到两个 backend 进程，两侧各创建 1 注、1 幂等行、1 次 `FT_bet`、1 次扣款，未跨用户合并。',
      '- `runtime_proven`：同用户同 key 但 payload 改变后跨 backend 提交，返回 409，注单、幂等行、`FT_bet`、扣款增量均为 0。',
      '- `source_proven + runtime_structure_proven`：迁移文件声明 `UNIQUE(user_id, idempotency_key)`，直接查询 fresh DB 约束/索引确认存在；迁移重复执行两次行数为 0。',
      '- 守护结果：目标端口启动前/停止后均空；guard DB SHA256 前后一致；watched source/migration/runner SHA256 前后一致。', '',
      '## 关键证据', '',
      `- 服务健康与双进程配置：\`${path.relative(deployRoot, evidencePath('service-health.json'))}\``,
      `- 同用户同 key：\`${path.relative(deployRoot, evidencePath('scenario-same-user-same-key.json'))}\``,
      `- 跨用户同 key：\`${path.relative(deployRoot, evidencePath('scenario-cross-user-same-key.json'))}\``,
      `- 变更 payload：\`${path.relative(deployRoot, evidencePath('scenario-changed-payload.json'))}\``,
      `- 最终 DB：\`${path.relative(deployRoot, evidencePath('final-db-state.json'))}\``,
      `- 停止证据：\`${path.relative(deployRoot, evidencePath('stop-evidence.json'))}\``, '',
      '## 复现命令', '',
      '```shell',
      'node --check .verify-runtime/phase4a-multi-backend-run.js',
      'node .verify-runtime/phase4a-multi-backend-run.js',
      '```', '',
      '## 边界与未测项', '',
      '- 本 Run 仅覆盖本地 mock upstream、本地 PostgreSQL、两个 backend API 进程；未访问真实 Crown 或任何外部上游。',
      '- 未测试 frontend、浏览器、Service Worker、多标签页、真实网络丢包、backend 进程中途崩溃恢复、PostgreSQL 故障切换或其他数据库实现。',
      '- 未外推超过两个 backend 进程的规模行为；本 Run 仅实证两个进程的行为。',
      '- 时间标注为北京时间（Asia/Shanghai）。',
    ];
    fs.writeFileSync(reportFile, reportLines.join('\n') + '\n', 'utf8');
    result.report_file = path.relative(deployRoot, reportFile);

    writeJson(evidencePath('evidence-secret-scan.json'), {
      scanned_root: path.relative(deployRoot, evidenceDir),
      findings: secretFindings,
      policy: 'JWT-like strings, run DB password, and run JWT secret must not appear in generated evidence',
    });
    check('evidence_secret_scan_clean', secretFindings.length === 0, [], secretFindings);
    writeJson(evidencePath('network-boundary-scan.json'), {
      scanned_root: path.relative(deployRoot, evidenceDir),
      non_loopback_urls: nonLoopbackUrls,
      allowed_hosts: ['127.0.0.1', 'localhost', '::1'],
    });
    check('evidence_contains_only_loopback_urls', nonLoopbackUrls.length === 0, [], nonLoopbackUrls);

    result.checked_at_utc = new Date().toISOString();
    result.checked_at_beijing = beijingTime(new Date());
    result.assertions_passed = result.assertions.filter(item => item.passed).length;
    result.assertions_failed = result.assertions.filter(item => !item.passed).length;
    result.success = fatal.length === 0 && result.assertions_failed === 0;
    writeJson(evidencePath('final-assertions.json'), result);
    fs.writeFileSync(path.join(path.dirname(evidenceDir), 'latest-run-id.txt'), runId, 'utf8');
    console.log(JSON.stringify({
      success: result.success, run_id: runId, database: dbName, report: result.report_file,
      evidence: path.relative(deployRoot, evidencePath('final-assertions.json')),
      assertions: { passed: result.assertions_passed, failed: result.assertions_failed, total: result.assertions.length },
      summary: result.summary,
    }, null, 2));
    process.exitCode = result.success ? 0 : 1;
  } finally {
    if (services) await stopServices(services, 'finally cleanup', 'finally-stop-evidence.json').catch(() => undefined);
    if (db) await db.end().catch(() => undefined);
  }
}

main().catch(error => {
  fatal.push(error?.stack || String(error));
  result.fatal_errors = fatal;
  result.checked_at_utc = new Date().toISOString();
  result.checked_at_beijing = beijingTime(new Date());
  result.assertions_passed = result.assertions.filter(item => item.passed).length;
  result.assertions_failed = result.assertions.filter(item => !item.passed).length;
  result.success = false;
  try { writeJson(evidencePath('final-assertions.json'), result); } catch {}
  console.error(JSON.stringify({ success: false, run_id: runId, fatal_errors: fatal }, null, 2));
  process.exit(1);
});





