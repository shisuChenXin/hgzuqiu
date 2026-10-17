'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const { createRequire } = require('module');
const backendRequire = createRequire(path.join(__dirname, '..', 'backend', 'package.json'));
const { Client } = backendRequire('pg');
const bcrypt = backendRequire('bcrypt');
const { createMockUpstream } = require('./phase2-servers');

const deployRoot = path.resolve(__dirname, '..');
const mainRepo = path.resolve(deployRoot, '..', 'hgzuqiu');
const backendEnvFile = fs.existsSync(path.join(deployRoot, 'backend', '.env')) ? path.join(deployRoot, 'backend', '.env') : path.join(mainRepo, 'backend', '.env');
const backendDir = path.join(deployRoot, 'backend');
const runStartedAt = new Date();
const runId = `${formatLocalTimestamp(runStartedAt)}-${process.pid}`;
const evidenceDir = path.join(deployRoot, '证据', 'phase3f02-idempotency-fix', runId);
const reportDir = path.join(deployRoot, '报告');
const dbPasswordPlain = `Phase3F02!${process.pid}`;
const jwtSecret = `phase3f02-${crypto.randomBytes(32).toString('hex')}`;
const dbName = `hgzuqiu_phase3f02_${runId.slice(0, 15).replace(/[^0-9]/g, '')}_${process.pid}`;
const urls = { backend: 'http://127.0.0.1:3202', mock: 'http://127.0.0.1:3301' };
const ftBetDelayMs = 500;
const concurrentFtBetDelayMs = 500;
const concurrentTrials = 10;

const matchFixtures = [
  { id: 920001, gid: '920001', league: 'Phase3F02 ABC League', home: 'Phase3F02 Home ABC', away: 'Phase3F02 Away ABC' },
  ...Array.from({ length: concurrentTrials }, (_, index) => ({
    id: 921000 + index,
    gid: String(921000 + index),
    league: `Phase3F02 Concurrent League ${index + 1}`,
    home: `Phase3F02 Concurrent Home ${index + 1}`,
    away: `Phase3F02 Concurrent Away ${index + 1}`,
  })),
];

const markets = {
  cornerFull: {
    handicapLines: [{
      hdp: '1', line: '1', home: '1.90', away: '1.90',
      __meta: { gid: 'fixture', hgid: 'fixture', isMaster: 'Y', mode: 'CN' },
    }],
  },
};

const result = {
  run_id: runId,
  run_started_at_utc: runStartedAt.toISOString(),
  run_started_at_beijing: beijingTime(runStartedAt),
  checked_at_utc: null,
  checked_at_beijing: null,
  git_commit: execSync('git', ['rev-parse', 'HEAD']),
  database: dbName,
  urls,
  evidence_dir: path.relative(deployRoot, evidenceDir),
  assertions: [],
  fatal_errors: [],
  summary: {},
  success: false,
};
const fatal = [];
const memoryTokens = [];

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
function execSync(command, args) {
  return spawnSync(command, args, { cwd: deployRoot, encoding: 'utf8', windowsHide: true }).stdout.trim();
}
function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function evidencePath(name) { return path.join(evidenceDir, name); }
function writeJson(file, value) { ensureDir(path.dirname(file)); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
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
async function connectDb(database) { const client = new Client(dbConfig(database)); await client.connect(); return client; }
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
  for (const port of [3301, 3202, 3302, 10090]) if (await probePort('127.0.0.1', port)) open.push(port);
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
    await new Promise(resolve => setTimeout(resolve, 250));
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
function startLogChild(file, command, args, options) {
  ensureDir(path.dirname(file));
  const child = spawn(command, args, { ...options, windowsHide: true });
  const stream = fs.openSync(file, 'a');
  child.stdout.on('data', chunk => fs.writeSync(stream, chunk));
  child.stderr.on('data', chunk => fs.writeSync(stream, chunk));
  child.once('exit', () => fs.closeSync(stream, () => undefined));
  return child;
}
function sha256File(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function watchedHashMap() {
  const files = [
    'backend/src/app.ts',
    'backend/src/routes/bets.ts',
    'backend/src/routes/auth.ts',
    'backend/src/services/account-selection.ts',
    'backend/src/services/crown-automation.ts',
    'database/schema.sql',
    'frontend/src/components/Betting/BetFormModal.tsx',
    'frontend/src/pages/MatchesPage.tsx',
    '.verify-runtime/phase2-servers.js',
    '.verify-runtime/phase3f02-run.js',
  ];
  return Object.fromEntries(files.map(file => [file, sha256File(path.join(deployRoot, file))]));
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function same(left, right) { return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right)); }
function findJwtLikeMatches(rootDir) {
  const pattern = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
  const matches = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(?:json|jsonl|txt|md)$/i.test(entry.name)) {
        const found = fs.readFileSync(full, 'utf8').match(pattern) || [];
        for (const value of found) matches.push({ file: path.relative(rootDir, full), length: value.length, sha256: crypto.createHash('sha256').update(value).digest('hex') });
      }
    }
  }
  walk(rootDir);
  return matches;
}
function findNonLoopbackUrls(rootDir) {
  const pattern = /\b(?:https?|wss?):\/\/[^\s"'<>)]+/g;
  const matches = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(?:json|jsonl|txt|md)$/i.test(entry.name)) {
        const text = fs.readFileSync(full, 'utf8');
        for (const raw of text.match(pattern) || []) {
          try {
            const host = new URL(raw).hostname;
            if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') matches.push({ file: path.relative(rootDir, full), url: raw.slice(0, 180) });
          } catch { matches.push({ file: path.relative(rootDir, full), url: raw.slice(0, 180) }); }
        }
      }
    }
  }
  walk(rootDir);
  return matches;
}

function buildBackend() {
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const build = spawnSync(process.execPath, [npmCli, 'run', 'build'], {
    cwd: backendDir, encoding: 'utf8', windowsHide: true, timeout: 120000,
  });
  fs.writeFileSync(evidencePath('backend-build-result.txt'), [
    `STARTED_AT_UTC=${runStartedAt.toISOString()}`,
    `COMMAND=node <npm-cli.js> run build`,
    `EXIT=${build.status}`,
    `SPAWN_ERROR=${build.error ? build.error.stack : 'null'}`,
    `STDOUT\n${build.stdout || ''}`,
    `STDERR\n${build.stderr || ''}`,
  ].join('\n'), 'utf8');
  if (build.status !== 0) throw new Error(`backend build failed: ${build.status}`);
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
    const baseEnv = dbConfig(dbName);
    const migration = spawnSync(process.execPath, ['migrate.js'], {
      cwd: backendDir, encoding: 'utf8', windowsHide: true, timeout: 120000,
      env: {
        ...process.env, DB_HOST: baseEnv.host, DB_PORT: String(baseEnv.port),
        DB_USER: baseEnv.user, DB_PASSWORD: baseEnv.password, DB_NAME: dbName,
      },
    });
    fs.writeFileSync(evidencePath('migration-result.txt'), `STDOUT\n${migration.stdout || ''}\nSTDERR\n${migration.stderr || ''}\nEXIT=${migration.status}\n`, 'utf8');
    if (migration.status !== 0) throw new Error(`migration failed: ${migration.status}`);

    const passwordHash = await bcrypt.hash(dbPasswordPlain, 10);
    await client.query('BEGIN');

    async function createUser(spec) {
      const user = await client.query(`
        INSERT INTO users (username, email, password_hash, role, whitelabel_id, email_verified, trusted_ips)
        VALUES ($1, $2, $3, 'admin', 1, TRUE, $4::text[])
        RETURNING id, username, role, whitelabel_id
      `, [spec.username, `${spec.username}@phase3f01.local`, passwordHash, ['127.0.0.1', '::1', '::ffff:127.0.0.1']]);
      const group = await client.query(`
        INSERT INTO groups (user_id, name, description)
        VALUES ($1, $2, $3) RETURNING id, name
      `, [user.rows[0].id, `${spec.username} group`, 'Phase3F02 isolated local group']);
      const account = await client.query(`
        INSERT INTO crown_accounts (
          user_id, group_id, username, password, original_username, initialized_username,
          discount, balance, credit, stop_profit_limit, is_enabled, is_online, status,
          football_prematch_limit, football_live_limit
        ) VALUES ($1,$2,$3,'local-only-not-real-password',$4,$4,0.80,5000,10000,0,TRUE,TRUE,'active',100000,100000)
        RETURNING id, username, original_username, discount::text AS discount, credit::text AS credit, is_online
      `, [user.rows[0].id, group.rows[0].id, spec.accountUsername, spec.lineUsername]);
      await client.query(`
        INSERT INTO coin_transactions (user_id, account_id, bet_id, transaction_id, transaction_type, description, amount, balance_before, balance_after)
        VALUES ($1,NULL,NULL,$2,'充值','Phase3F02 isolated seed',5000,0,5000)
      `, [user.rows[0].id, `PHASE3F02-SEED-${spec.key.toUpperCase()}`]);
      return { key: spec.key, user: user.rows[0], group: group.rows[0], account: account.rows[0] };
    }

    const primary = await createUser({
      key: 'primary', username: 'phase3f02-primary-admin', accountUsername: 'phase3f02-primary-crown', lineUsername: 'AAAA-phase3f01',
    });
    const concurrent = await createUser({
      key: 'concurrent', username: 'phase3f02-concurrent-admin', accountUsername: 'phase3f02-concurrent-crown', lineUsername: 'DDDD-phase3f01',
    });

    const extraAccounts = [];
    for (const spec of [
      { key: 'b', username: 'phase3f02-primary-crown-b', lineUsername: 'BBBB-phase3f01' },
      { key: 'c', username: 'phase3f02-primary-crown-c', lineUsername: 'CCCC-phase3f01' },
    ]) {
      const account = await client.query(`
        INSERT INTO crown_accounts (
          user_id, group_id, username, password, original_username, initialized_username,
          discount, balance, credit, stop_profit_limit, is_enabled, is_online, status,
          football_prematch_limit, football_live_limit
        ) VALUES ($1,$2,$3,'local-only-not-real-password',$4,$4,0.80,5000,10000,0,TRUE,TRUE,'active',100000,100000)
        RETURNING id, username, original_username, discount::text AS discount, credit::text AS credit, is_online
      `, [primary.user.id, primary.group.id, spec.username, spec.lineUsername]);
      extraAccounts.push({ key: spec.key, ...account.rows[0] });
    }

    for (const fixture of matchFixtures) {
      await client.query(`
        INSERT INTO matches (id, match_id, league_name, home_team, away_team, match_time, status, markets, odds_home_win, odds_draw, odds_away_win)
        VALUES ($1,$2,$3,$4,$5,NOW() + INTERVAL '2 hours','live',$6::jsonb,2.10,3.30,3.20)
      `, [fixture.id, fixture.gid, fixture.league, fixture.home, fixture.away, JSON.stringify(markets)]);
    }
    await client.query(`SELECT setval(pg_get_serial_sequence('matches','id'), (SELECT MAX(id) FROM matches), TRUE)`);
    await client.query('COMMIT');

    return {
      database: dbName,
      primary,
      concurrent,
      primary_accounts: [primary.account, ...extraAccounts],
      matches: matchFixtures,
      seed_balance_each_user: 5000,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { await client.end(); }
}

async function getBetsByMatch(db, matchId) {
  const found = await db.query(`
    SELECT b.id, b.user_id, b.account_id, a.username AS account_username, a.original_username,
           UPPER(LEFT(COALESCE(a.original_username, a.username), 4)) AS line_key,
           b.match_id, b.bet_type, b.bet_option, b.status, b.error_message, b.official_bet_id,
           b.displayed_market_side, b.executed_market_side, b.displayed_market_rtype, b.executed_market_rtype,
           b.mapping_mode, b.mapping_version::int AS mapping_version, b.mapping_applied,
           b.bet_amount::text AS bet_amount, b.virtual_bet_amount::text AS virtual_bet_amount,
           b.created_at, b.confirmed_at, b.updated_at
    FROM bets b JOIN crown_accounts a ON a.id=b.account_id
    WHERE b.match_id=$1 ORDER BY b.id
  `, [matchId]);
  return found.rows;
}
async function getTransactions(db) {
  const found = await db.query(`
    SELECT c.id, c.user_id, u.username AS user_username, c.account_id, c.bet_id,
           c.transaction_id, c.transaction_type, c.description, c.amount::text AS amount,
           c.balance_before::text AS balance_before, c.balance_after::text AS balance_after, c.created_at
    FROM coin_transactions c JOIN users u ON u.id=c.user_id
    ORDER BY c.id
  `);
  return found.rows;
}
async function getFullDbSnapshot(db, seed) {
  const users = await db.query('SELECT id, username, role, whitelabel_id FROM users ORDER BY id');
  const accounts = await db.query(`
    SELECT id, user_id, group_id, username, original_username, initialized_username,
           UPPER(LEFT(COALESCE(original_username, username), 4)) AS line_key,
           discount::text AS discount, credit::text AS credit, is_enabled, is_online, status
    FROM crown_accounts ORDER BY id
  `);
  const matches = await db.query('SELECT id, match_id, league_name, home_team, away_team, status FROM matches ORDER BY id');
  const mapping = await db.query(`
    SELECT s.id, s.whitelabel_id, s.mapping_mode, s.enabled, s.version::int AS version, s.updated_at
    FROM selection_mapping_settings s ORDER BY s.id
  `);
  const bets = [];
  for (const fixture of [...matchFixtures, ...phaseFixtures]) bets.push(...await getBetsByMatch(db, fixture.id));
  return {
    checked_at_utc: new Date().toISOString(),
    users: users.rows,
    accounts: accounts.rows,
    matches: matches.rows,
    mapping: mapping.rows,
    bets,
    transactions: await getTransactions(db),
    balances: Object.fromEntries(seed ? [
      [seed.primary.user.username, await getBalance(db, seed.primary.user.id)],
      [seed.concurrent.user.username, await getBalance(db, seed.concurrent.user.id)],
      [seed.early_failure.user.username, await getBalance(db, seed.early_failure.user.id)],
    ] : []),
  };
}
async function getBalance(db, userId) {
  const found = await db.query('SELECT COALESCE(SUM(amount),0)::text AS balance, COUNT(*)::int AS transaction_count FROM coin_transactions WHERE user_id=$1', [userId]);
  return found.rows[0];
}

function createDelayedMock(ticketPrefix) {
  const logFile = evidencePath('mock-upstream-log.jsonl');
  fs.writeFileSync(logFile, '', 'utf8');
  const mock = createMockUpstream({ host: '127.0.0.1', port: 3301, ticketPrefixes: [ticketPrefix], logFile });
  const delayControl = { current_ms: ftBetDelayMs };
  const responseAttempts = [];
  const originalEmit = mock.server.emit.bind(mock.server);
  mock.server.emit = function delayedMockEmit(event, req, res) {
    if (event === 'request' && res && String(req.url || '').startsWith('/transform.php')) {
      const originalEnd = res.end.bind(res);
      res.end = function delayedFtBetEnd(...endArgs) {
        const responseBody = typeof endArgs[0] === 'string' ? endArgs[0] : '';
        if (responseBody.includes('<code>560</code>')) {
          const scheduledAt = new Date().toISOString();
          const attempt = {
            scheduled_at: scheduledAt,
            configured_delay_ms: delayControl.current_ms,
            response_class: 'FT_bet',
            response_body_prefix: responseBody.slice(0, 180),
          };
          responseAttempts.push(attempt);
          const timer = setTimeout(() => {
            attempt.original_end_started_at = new Date().toISOString();
            try { originalEnd(...endArgs); attempt.original_end_returned = true; }
            catch (error) { attempt.original_end_sync_error = error.message; }
            setTimeout(() => {
              attempt.completed_at = new Date().toISOString();
              attempt.socket_destroyed_after = req.socket?.destroyed === true;
              attempt.response_writable_ended_after = res.writableEnded === true;
            }, 50).unref?.();
          }, delayControl.current_ms);
          timer.unref?.();
          return res;
        }
        return originalEnd(...endArgs);
      };
    }
    return originalEmit(event, req, res);
  };
  return { mock, delayControl, responseAttempts, logFile };
}

async function startServices(dbName, mockBundle) {
  const startedAt = new Date().toISOString();
  const backendLog = evidencePath('backend-log.txt');
  fs.writeFileSync(backendLog, '', 'utf8');
  await new Promise((resolve, reject) => {
    mockBundle.mock.server.once('error', reject);
    mockBundle.mock.server.listen(3301, '127.0.0.1', resolve);
  });
  const baseDb = dbConfig(dbName);
  const backendChild = startLogChild(backendLog, process.execPath, ['dist/app.js'], {
    cwd: backendDir,
    env: {
      ...process.env, NODE_ENV: 'development',
      DB_HOST: baseDb.host, DB_PORT: String(baseDb.port), DB_USER: baseDb.user,
      DB_PASSWORD: baseDb.password, DB_NAME: dbName,
      HOST: '127.0.0.1', PORT: '3202', JWT_SECRET: jwtSecret,
      CROWN_BASE_URL: urls.mock, CROWN_BASE_URL_CANDIDATES: urls.mock,
      CROWN_API_KEEPALIVE_ENABLED: 'false', CROWN_ONLINE_CHECK_INTERVAL_MS: '600000',
      CORS_ALLOWED_ORIGINS: 'http://127.0.0.1:10090',
    },
  });
  try {
    const backendHealth = await waitHttpOk(`${urls.backend}/api/health`, 40000);
    const mockHealth = await waitHttpOk(`${urls.mock}/`, 10000);
    const health = {
      started_at: startedAt,
      backend: backendHealth,
      mock: mockHealth,
      network_boundary: {
        crown_base_url: urls.mock,
        crown_base_url_candidates: urls.mock,
        all_service_hosts: ['127.0.0.1'],
      },
    };
    writeJson(evidencePath('service-health.json'), health);
    return { backendChild, backendLog, health, mockBundle };
  } catch (error) {
    await stopServices({ backendChild, mockBundle }, 'startup failure', 'startup-failure-stop-evidence.json').catch(() => undefined);
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
  const closed = await new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), 8000);
    timer.unref?.();
    server.close(() => { clearTimeout(timer); resolve(true); });
  }).catch(() => false);
  return { role, close_callback_completed: closed, stopped_at: new Date().toISOString() };
}
async function stopServices(services, label, evidenceName) {
  const evidence = { label, stopped_at: new Date().toISOString(), services: {} };
  evidence.services.backend = await stopLoggedChild(services?.backendChild, 'backend');
  evidence.services.mock_server = await closeHttpServer(services?.mockBundle?.mock?.server, 'mock upstream');
  await new Promise(resolve => setTimeout(resolve, 300));
  evidence.target_ports_open_after_stop = await targetPortsOpen();
  evidence.all_target_ports_down = evidence.target_ports_open_after_stop.length === 0;
  if (evidenceName) writeJson(evidencePath(evidenceName), evidence);
  return evidence;
}

const SENSITIVE_JSON_KEYS = /^(?:token|password|authorization|access_token|refresh_token)$/i;

function redactSensitive(value, key = '') {
  if (SENSITIVE_JSON_KEYS.test(key)) return '<redacted>';
  if (Array.isArray(value)) return value.map(item => redactSensitive(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      redactSensitive(entryValue, entryKey),
    ]));
  }
  return value;
}

async function apiRequest({ method, url, token, body, label }) {
  const startedAt = new Date();
  const startedHighRes = performance.now();
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  let record;
  try {
    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
    const responseText = await response.text();
    let responseBody;
    try { responseBody = JSON.parse(responseText); } catch { responseBody = responseText; }
    const rawResponseBody = responseBody;
    record = {
      label,
      method,
      url,
      request_headers: {
        content_type: body === undefined ? null : 'application/json',
        authorization: token ? '<redacted>' : null,
      },
      request_body: redactSensitive(body),
      response_status: response.status,
      response_ok: response.ok,
      response_body: redactSensitive(responseBody),
      started_at_utc: startedAt.toISOString(),
      ended_at_utc: new Date().toISOString(),
      duration_ms: Math.round(performance.now() - startedHighRes),
      transport_error: null,
    };
    Object.defineProperty(record, 'raw_response_body', { value: rawResponseBody, enumerable: false });
  } catch (error) {
    record = {
      label,
      method,
      url,
      request_headers: {
        content_type: body === undefined ? null : 'application/json',
        authorization: token ? '<redacted>' : null,
      },
      request_body: redactSensitive(body),
      response_status: null,
      response_ok: false,
      response_body: null,
      started_at_utc: startedAt.toISOString(),
      ended_at_utc: new Date().toISOString(),
      duration_ms: Math.round(performance.now() - startedHighRes),
      transport_error: error?.stack || String(error),
    };
  }
  return record;
}

async function loginApi(username, label) {
  const password = dbPasswordPlain;
  const request = await apiRequest({
    method: 'POST',
    url: `${urls.backend}/api/auth/login`,
    body: { username, password },
    label: `${label}:POST /api/auth/login`,
  });
  const token = request.raw_response_body?.data?.token || null;
  request.token_evidence = token ? {
    stored: 'memory only during this process',
    length: token.length,
    sha256: crypto.createHash('sha256').update(token).digest('hex'),
  } : null;
  if (!request.response_ok || !request.response_body?.success || !token) {
    throw new Error(`${label} login failed: ${JSON.stringify(request.response_body || request.transport_error)}`);
  }
  return { username, token, request };
}

function buildBetPayload({ fixture, accountId }) {
  return {
    account_ids: [accountId],
    match_id: fixture.id,
    bet_type: '角球让球',
    bet_option: `Phase3F02 ${fixture.home} (角球 +1)`,
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
    match_time: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
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
  };
}

async function getBetsByMatchRange(db, fromMatchId, toMatchId) {
  const found = await db.query(`
    SELECT b.id, b.user_id, b.account_id, a.username AS account_username, a.original_username,
           UPPER(LEFT(COALESCE(a.original_username, a.username), 4)) AS line_key,
           b.match_id, b.bet_type, b.bet_option, b.status, b.error_message, b.official_bet_id,
           b.displayed_market_side, b.executed_market_side, b.displayed_market_rtype, b.executed_market_rtype,
           b.mapping_mode, b.mapping_version::int AS mapping_version, b.mapping_applied,
           b.bet_amount::text AS bet_amount, b.virtual_bet_amount::text AS virtual_bet_amount,
           b.created_at, b.confirmed_at, b.updated_at
    FROM bets b JOIN crown_accounts a ON a.id=b.account_id
    WHERE b.match_id BETWEEN $1 AND $2 ORDER BY b.id
  `, [fromMatchId, toMatchId]);
  return found.rows;
}

async function getBetById(db, betId) {
  const found = await db.query(`
    SELECT b.id, b.user_id, b.account_id, a.username AS account_username, a.original_username,
           UPPER(LEFT(COALESCE(a.original_username, a.username), 4)) AS line_key,
           b.match_id, b.bet_type, b.bet_option, b.status, b.error_message, b.official_bet_id,
           b.displayed_market_side, b.executed_market_side, b.displayed_market_rtype, b.executed_market_rtype,
           b.mapping_mode, b.mapping_version::int AS mapping_version, b.mapping_applied,
           b.bet_amount::text AS bet_amount, b.virtual_bet_amount::text AS virtual_bet_amount,
           b.created_at, b.confirmed_at, b.updated_at
    FROM bets b JOIN crown_accounts a ON a.id=b.account_id
    WHERE b.id=$1
  `, [betId]);
  return found.rows[0] || null;
}

async function waitBetTerminal(db, betId, timeoutMs = 20000) {
  await waitFor(async () => {
    const bet = await getBetById(db, betId);
    return Boolean(bet && ['confirmed', 'cancelled', 'settled'].includes(bet.status));
  }, timeoutMs, `bet ${betId} terminal state`);
  return getBetById(db, betId);
}

function extractBetIds(apiRecord) {
  const ids = apiRecord?.response_body?.data?.bet_ids;
  return Array.isArray(ids) ? ids.map(Number) : [];
}

function mockEventsForGid(mockBundle, gid) {
  return mockBundle.mock.events.filter(event =>
    event.action === 'FT_bet' && String(event.params?.gid || '') === String(gid));
}

function transactionsForBet(transactions, betId) {
  return transactions.filter(item => Number(item.bet_id) === Number(betId));
}

async function guardDbSnapshot() {
  const map = parseEnvFile(backendEnvFile);
  const baseName = requiredEnv(map, 'DB_NAME');
  const client = await connectDb(baseName);
  try {
    const result = await client.query(`
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
      snapshot: result.rows[0],
      sha256: crypto.createHash('sha256').update(JSON.stringify(canonical(result.rows[0]))).digest('hex'),
    };
  } finally {
    await client.end();
  }
}

function groupEvidence({
  group, fixture, baseline, requests, betIds, before, after, mockBefore, mockAfter,
}) {
  const mockAfterFtBetEvents = mockAfter.ftBetEvents || mockAfter.mock?.ftBetEvents || [];
  const beforeBets = before?.bets || [];
  const afterBets = after?.bets || [];
  const beforeTransactions = before?.transactions || [];
  const afterTransactions = after?.transactions || [];
  return {
    group,
    match_id: fixture.id,
    account: {
      id: baseline.account.id,
      username: baseline.account.username,
      original_username: baseline.account.original_username,
      line_key: baseline.line_key,
    },
    counts: {
      bets_before_request: baseline.bets.length,
      bets_after_request: afterBets.length,
      bets_created: afterBets.length - beforeBets.length,
      transactions_before_request: baseline.transactions.length,
      transactions_after_request: afterTransactions.length,
      transactions_created: afterTransactions.length - beforeTransactions.length,
      ft_bet_before_request: baseline.ftBetEvents.length,
      ft_bet_after_request: mockAfterFtBetEvents.length,
      ft_bet_created: mockAfterFtBetEvents.length - baseline.ftBetEvents.length,
    },
    request_bet_ids: betIds,
    before_bets: beforeBets,
    after_bets: afterBets,
    before_transactions: beforeTransactions,
    after_transactions: afterTransactions,
    mock_ft_bet_events: mockAfterFtBetEvents.filter(event => String(event.params?.gid || '') === String(fixture.id)),
    mock_response_attempts: mockAfter.responseAttempts,
    requests: (requests || []).map(requestOutcome),
  };
}


const phaseFixtures = [
  { name: 'legacy-no-key', id: 930001, gid: '930001', league: 'Phase3F02 Legacy League', home: 'Phase3F02 Legacy Home', away: 'Phase3F02 Legacy Away' },
  { name: 'different-key', id: 930002, gid: '930002', league: 'Phase3F02 Key League', home: 'Phase3F02 Key Home', away: 'Phase3F02 Key Away' },
  { name: 'different-payload', id: 930003, gid: '930003', league: 'Phase3F02 Payload League', home: 'Phase3F02 Payload Home', away: 'Phase3F02 Payload Away' },
  { name: 'pre-cancelled', id: 930004, gid: '930004', league: 'Phase3F02 Cancelled League', home: 'Phase3F02 Cancelled Home', away: 'Phase3F02 Cancelled Away' },
  { name: 'dry-run', id: 930005, gid: '930005', league: 'Phase3F02 Dry League', home: 'Phase3F02 Dry Home', away: 'Phase3F02 Dry Away' },
  { name: 'header-body', id: 930006, gid: '930006', league: 'Phase3F02 Header League', home: 'Phase3F02 Header Home', away: 'Phase3F02 Header Away' },
  { name: 'early-failure', id: 930007, gid: '930007', league: 'Phase3F02 Failure League', home: 'Phase3F02 Failure Home', away: 'Phase3F02 Failure Away' },
  ...Array.from({ length: concurrentTrials }, (_, index) => ({
    name: `concurrent-${index + 1}`,
    id: 931000 + index,
    gid: String(931000 + index),
    league: `Phase3F02 Concurrent League ${index + 1}`,
    home: `Phase3F02 Concurrent Home ${index + 1}`,
    away: `Phase3F02 Concurrent Away ${index + 1}`,
  })),
];
phaseFixtures.match_time = new Date(Date.now() + 2 * 60 * 60 * 1000);

function buildFrontend() {
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const build = spawnSync(process.execPath, [npmCli, 'run', 'build'], {
    cwd: path.join(deployRoot, 'frontend'), encoding: 'utf8', windowsHide: true, timeout: 180000,
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

async function createAndSeedPhase3F02Database() {
  const admin = await connectDb('postgres');
  try {
    const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (existing.rowCount !== 0) throw new Error(`database already exists: ${dbName}`);
    await admin.query(`CREATE DATABASE "${dbName}"`);
  } finally { await admin.end(); }

  const client = await connectDb(dbName);
  try {
    await client.query(fs.readFileSync(path.join(deployRoot, 'database', 'schema.sql'), 'utf8'));
    const baseEnv = dbConfig(dbName);
    const migration = spawnSync(process.execPath, ['migrate.js'], {
      cwd: backendDir, encoding: 'utf8', windowsHide: true, timeout: 120000,
      env: {
        ...process.env, DB_HOST: baseEnv.host, DB_PORT: String(baseEnv.port),
        DB_USER: baseEnv.user, DB_PASSWORD: baseEnv.password, DB_NAME: dbName,
      },
    });
    fs.writeFileSync(evidencePath('migration-result.txt'), `STDOUT\n${migration.stdout || ''}\nSTDERR\n${migration.stderr || ''}\nEXIT=${migration.status}\n`, 'utf8');
    if (migration.status !== 0) throw new Error(`migration failed: ${migration.status}`);

    const passwordHash = await bcrypt.hash(dbPasswordPlain, 10);
    await client.query('BEGIN');
    async function createUser(spec) {
      const user = await client.query(`
        INSERT INTO users (username, email, password_hash, role, whitelabel_id, email_verified, trusted_ips)
        VALUES ($1, $2, $3, 'admin', 1, TRUE, $4::text[])
        RETURNING id, username, role, whitelabel_id
      `, [spec.username, `${spec.username}@phase3f02.local`, passwordHash, ['127.0.0.1', '::1', '::ffff:127.0.0.1']]);
      const group = await client.query(
        'INSERT INTO groups (user_id, name, description) VALUES ($1,$2,$3) RETURNING id, name',
        [user.rows[0].id, `${spec.username} group`, 'Phase3F02 isolated local group'],
      );
      const accountSpecs = spec.accounts.map((account, index) => ({ ...account, suffix: index + 1 }));
      const accounts = [];
      for (const accountSpec of accountSpecs) {
        const account = await client.query(`
          INSERT INTO crown_accounts (
            user_id, group_id, username, password, original_username, initialized_username,
            discount, balance, credit, stop_profit_limit, is_enabled, is_online, status,
            football_prematch_limit, football_live_limit
          ) VALUES ($1,$2,$3,'local-only-not-real-password',$4,$4,0.80,5000,$5,0,TRUE,TRUE,'active',100000,100000)
          RETURNING id, username, original_username, discount::text AS discount, credit::text AS credit, is_online
        `, [user.rows[0].id, group.rows[0].id, `${spec.username}-crown-${accountSpec.suffix}`, `${accountSpec.linePrefix}-${spec.key}`.toUpperCase(), accountSpec.credit ?? 100000]);
        accounts.push(account.rows[0]);
      }
      if (spec.seedBalance > 0) {
        await client.query(`
          INSERT INTO coin_transactions (user_id, account_id, bet_id, transaction_id, transaction_type, description, amount, balance_before, balance_after)
          VALUES ($1,NULL,NULL,$2,'充值','Phase3F02 isolated seed',$3,0,$3)
        `, [user.rows[0].id, `PHASE3F02-SEED-${spec.key.toUpperCase()}`, spec.seedBalance]);
      }
      return { key: spec.key, user: user.rows[0], group: group.rows[0], accounts };
    }

    const primary = await createUser({
      key: 'primary', username: 'phase3f02-primary-admin', seedBalance: 20000,
      accounts: [
        { key: 'legacy', linePrefix: 'AAAA' },
        { key: 'distinct', linePrefix: 'BBBB' },
        { key: 'payload', linePrefix: 'CCCC' },
        { key: 'cancelled', linePrefix: 'EEEE', credit: 50 },
        { key: 'dry-header', linePrefix: 'FFFF' },
      ],
    });
    const concurrent = await createUser({
      key: 'concurrent', username: 'phase3f02-concurrent-admin', seedBalance: 10000,
      accounts: [{ key: 'only', linePrefix: 'GGGG' }],
    });
    const earlyFailure = await createUser({
      key: 'earlyfailure', username: 'phase3f02-earlyfail-admin', seedBalance: 0,
      accounts: [{ key: 'only', linePrefix: 'HHHH' }],
    });

    for (const fixture of phaseFixtures) {
      await client.query(`
        INSERT INTO matches (id, match_id, league_name, home_team, away_team, match_time, status, markets, odds_home_win, odds_draw, odds_away_win)
        VALUES ($1,$2,$3,$4,$5,$6,'live',$7::jsonb,2.10,3.30,3.20)
      `, [fixture.id, fixture.gid, fixture.league, fixture.home, fixture.away, phaseFixtures.match_time, JSON.stringify(markets)]);
    }
    await client.query('SELECT setval(pg_get_serial_sequence(\'matches\',\'id\'), (SELECT MAX(id) FROM matches), TRUE)');
    await client.query('COMMIT');
    return {
      database: dbName,
      primary,
      concurrent,
      early_failure: earlyFailure,
      fixtures: phaseFixtures,
      seed_balances: { primary: 20000, concurrent: 10000, early_failure: 0 },
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
    runs.push({
      run: index, file: path.relative(deployRoot, migrationFile), started_at_utc: startedAt,
      exit: 0, rows_before: before.rows[0].rows, rows_after: after.rows[0].rows,
    });
  }
  const objects = await db.query(`
    SELECT table_name, constraint_name, constraint_type
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
  const evidence = { runs, constraints: objects.rows, indexes: indexes.rows };
  writeJson(evidencePath('migration-repeat-direct-result.json'), evidence);
  return evidence;
}

async function rawApiRequest({ method, url, token, body, headers = {}, label }) {
  const startedAt = new Date();
  const startedHighRes = performance.now();
  const requestHeaders = { ...headers };
  if (body !== undefined) requestHeaders['content-type'] = 'application/json';
  if (token) requestHeaders.authorization = `Bearer ${token}`;
  let response;
  try {
    response = await fetch(url, {
      method, headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store',
    });
    const responseText = await response.text();
    let responseBody;
    try { responseBody = JSON.parse(responseText); } catch { responseBody = responseText; }
    const record = {
      label, method, url,
      request_headers: {
        content_type: body === undefined ? null : 'application/json',
        authorization: token ? '<redacted>' : null,
        idempotency_key: requestHeaders['Idempotency-Key'] ?? null,
      },
      request_body: redactSensitive(body),
      response_status: response.status,
      response_ok: response.ok,
      response_headers: {
        idempotency_replayed: response.headers.get('idempotency-replayed'),
        content_type: response.headers.get('content-type'),
      },
      response_body: redactSensitive(responseBody),
      started_at_utc: startedAt.toISOString(),
      ended_at_utc: new Date().toISOString(),
      duration_ms: Math.round(performance.now() - startedHighRes),
      transport_error: null,
    };
    Object.defineProperty(record, 'raw_response_body', { value: responseBody, enumerable: false });
    return record;
  } catch (error) {
    return {
      label, method, url,
      request_headers: {
        content_type: body === undefined ? null : 'application/json',
        authorization: token ? '<redacted>' : null,
        idempotency_key: requestHeaders['Idempotency-Key'] ?? null,
      },
      request_body: redactSensitive(body), response_status: null, response_ok: false,
      response_headers: null, response_body: null,
      started_at_utc: startedAt.toISOString(), ended_at_utc: new Date().toISOString(),
      duration_ms: Math.round(performance.now() - startedHighRes),
      transport_error: error?.stack || String(error),
    };
  }
}

function buildPhasePayload({ fixture, accountId, key, overrides = {} }) {
  return {
    idempotency_key: key,
    account_ids: [accountId],
    match_id: fixture.id,
    bet_type: '角球让球',
    bet_option: `Phase3F02 ${fixture.home} (角球 +1)`,
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
    match_time: phaseFixtures.match_time.toISOString(),
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

function idsFromResponse(record) {
  const value = record?.response_body?.data?.bet_ids;
  return Array.isArray(value) ? value.map(Number) : [];
}

async function betsForFixture(db, fixture) { return (await getBetsByMatch(db, fixture.id)); }
async function transactionRows(db) { return getTransactions(db); }
async function idempotencyRows(db, userId) {
  const found = await db.query(`
    SELECT id, user_id, idempotency_key, request_hash, status, bet_ids, response_json, http_status,
           created_at, updated_at
      FROM bet_idempotency_requests
     WHERE user_id = $1
     ORDER BY id
  `, [userId]);
  return found.rows;
}
async function countIdempotency(db) {
  const found = await db.query('SELECT COUNT(*)::int AS rows FROM bet_idempotency_requests');
  return found.rows[0].rows;
}
async function captureFixtureState(db, mockBundle, fixture) {
  return {
    checked_at_utc: new Date().toISOString(),
    match_id: fixture.id,
    bets: await betsForFixture(db, fixture),
    transactions: await transactionRows(db),
    mock_ft_bet_events: mockBundle.mock.ftBetEvents.slice(),
    idempotency_rows: await (async () => {
      const found = await db.query('SELECT * FROM bet_idempotency_requests ORDER BY id');
      return found.rows;
    })(),
  };
}
async function runLegacyNoKey(db, mockBundle, seed, token) {
  const fixture = phaseFixtures.find(item => item.name === 'legacy-no-key');
  const account = seed.primary.accounts[0];
  const before = await captureFixtureState(db, mockBundle, fixture);
  const payload = buildPhasePayload({ fixture, accountId: account.id });
  delete payload.idempotency_key;
  const request = await rawApiRequest({
    method: 'POST', url: `${urls.backend}/api/bets`, token, body: payload,
    label: 'legacy-no-key: POST /api/bets without idempotency_key',
  });
  const betIds = idsFromResponse(request);
  await waitFor(() => mockBundle.mock.ftBetEvents.length > before.mock_ft_bet_events.length, 15000, 'legacy FT_bet');
  const terminal = [];
  for (const id of betIds) terminal.push(await waitBetTerminal(db, id, 25000));
  await new Promise(resolve => setTimeout(resolve, 200));
  const after = await captureFixtureState(db, mockBundle, fixture);
  const evidence = {
    scenario: 'legacy request without idempotency_key keeps old behavior',
    fixture, account_id: account.id, payload, before, request, bet_ids: betIds,
    terminal_bets: terminal, after,
    created_counts: {
      bets: after.bets.length - before.bets.length,
      ft_bet: after.mock_ft_bet_events.length - before.mock_ft_bet_events.length,
      transactions: after.transactions.length - before.transactions.length,
      idempotency: after.idempotency_rows.length - before.idempotency_rows.length,
    },
  };
  writeJson(evidencePath('scenario-legacy-no-key.json'), evidence);
  return evidence;
}

async function runConcurrentIdempotencyTrials(db, mockBundle, seed, token) {
  mockBundle.delayControl.current_ms = concurrentFtBetDelayMs;
  const trials = [];
  for (let index = 0; index < concurrentTrials; index += 1) {
    const fixture = phaseFixtures.find(item => item.name === `concurrent-${index + 1}`);
    const account = seed.concurrent.accounts[0];
    const before = await captureFixtureState(db, mockBundle, fixture);
    const payload = buildPhasePayload({
      fixture, accountId: account.id, key: `phase3f02-concurrent-${index + 1}`,
    });
    const requests = await Promise.all([
      rawApiRequest({ method: 'POST', url: `${urls.backend}/api/bets`, token, body: payload, label: `concurrent ${index + 1} A` }),
      rawApiRequest({ method: 'POST', url: `${urls.backend}/api/bets`, token, body: payload, label: `concurrent ${index + 1} B` }),
    ]);
    const requestBetIds = requests.flatMap(idsFromResponse);
    const uniqueIds = [...new Set(requestBetIds)];
    const terminal = [];
    for (const id of uniqueIds) terminal.push(await waitBetTerminal(db, id, 25000));
    await new Promise(resolve => setTimeout(resolve, 200));
    const after = await captureFixtureState(db, mockBundle, fixture);
    const timing = overlapFromApiRequests(requests[0], requests[1]);
    const trial = {
      scenario: 'same idempotency_key submitted concurrently twice',
      trial_index: index + 1, fixture, account_id: account.id, payload,
      before, requests, request_timing: timing, request_statuses: requests.map(item => item.response_status),
      response_bodies_canonically_equal: JSON.stringify(canonical(requests[0].response_body)) === JSON.stringify(canonical(requests[1].response_body)),
      replay_header_counts: {
        first: requests[0].response_headers?.idempotency_replayed ?? null,
        second: requests[1].response_headers?.idempotency_replayed ?? null,
      },
      request_bet_ids: requestBetIds, unique_request_bet_ids: uniqueIds, terminal_bets: terminal,
      database_bets_after_http: await betsForFixture(db, fixture), after,
      created_counts: {
        bets: after.bets.length - before.bets.length,
        ft_bet: after.mock_ft_bet_events.length - before.mock_ft_bet_events.length,
        transactions: after.transactions.length - before.transactions.length,
        idempotency: after.idempotency_rows.length - before.idempotency_rows.length,
      },
      idempotency_rows_for_match_user: await idempotencyRows(db, seed.concurrent.user.id),
    };
    trials.push(trial);
    writeJson(evidencePath(`scenario-concurrent-${String(index + 1).padStart(2, '0')}.json`), trial);
  }
  const summary = {
    trial_count: trials.length,
    overlap_count: trials.filter(item => item.request_timing.client_observed_overlap).length,
    statuses: trials.map(item => item.request_statuses),
    created_bets: trials.map(item => item.created_counts.bets),
    created_ft_bet: trials.map(item => item.created_counts.ft_bet),
    created_transactions: trials.map(item => item.created_counts.transactions),
    replay_header_count_per_trial: trials.map(item => [item.replay_header_counts.first, item.replay_header_counts.second].filter(value => String(value).toLowerCase() === 'true').length),
  };
  writeJson(evidencePath('scenario-concurrent-summary.json'), { summary });
  return { trials, summary };
}

async function runSequentialReplayAfterConfirmed(db, mockBundle, seed, token, concurrentResult) {
  const trial = concurrentResult.trials[0];
  const fixture = trial.fixture;
  const payload = trial.payload;
  const before = await captureFixtureState(db, mockBundle, fixture);
  const request = await rawApiRequest({
    method: 'POST', url: `${urls.backend}/api/bets`, token, body: payload,
    label: 'sequential replay after terminal confirmed',
  });
  await new Promise(resolve => setTimeout(resolve, 200));
  const after = await captureFixtureState(db, mockBundle, fixture);
  const evidence = {
    scenario: 'same key sequential replay after original bet confirmed',
    fixture, payload, before, request, original_bet_ids: trial.unique_request_bet_ids,
    replay_bet_ids: idsFromResponse(request), after,
    created_counts: {
      bets: after.bets.length - before.bets.length,
      ft_bet: after.mock_ft_bet_events.length - before.mock_ft_bet_events.length,
      transactions: after.transactions.length - before.transactions.length,
      idempotency: after.idempotency_rows.length - before.idempotency_rows.length,
    },
  };
  writeJson(evidencePath('scenario-sequential-replay-confirmed.json'), evidence);
  return evidence;
}

async function runDifferentKeySamePayload(db, mockBundle, seed, token) {
  const fixture = phaseFixtures.find(item => item.name === 'different-key');
  const account = seed.primary.accounts[1];
  const firstPayload = buildPhasePayload({ fixture, accountId: account.id, key: 'phase3f02-distinct-one' });
  const before = await captureFixtureState(db, mockBundle, fixture);
  const first = await rawApiRequest({ method: 'POST', url: `${urls.backend}/api/bets`, token, body: firstPayload, label: 'different key request one' });
  const firstIds = idsFromResponse(first);
  await waitFor(() => mockBundle.mock.ftBetEvents.length > before.mock_ft_bet_events.length, 15000, 'different-key first FT_bet');
  const firstTerminal = [];
  for (const id of firstIds) firstTerminal.push(await waitBetTerminal(db, id, 25000));

  // Controlled fixture: make the first non-cancelled row leave the line-usage query so exact payload can be retried.
  const controlledUpdate = await db.query(`
    UPDATE bets SET error_message='PHASE3F02-CONTROLLED-DIFFERENT-KEY-FIXTURE'
     WHERE id=$1 AND status='confirmed' AND error_message IS NULL
     RETURNING id,status,error_message
  `, [firstIds[0]]);
  const secondPayload = { ...firstPayload, idempotency_key: 'phase3f02-distinct-two' };
  const beforeSecond = await captureFixtureState(db, mockBundle, fixture);
  const second = await rawApiRequest({ method: 'POST', url: `${urls.backend}/api/bets`, token, body: secondPayload, label: 'different key request two' });
  const secondIds = idsFromResponse(second);
  await waitFor(() => mockBundle.mock.ftBetEvents.length > beforeSecond.mock_ft_bet_events.length, 15000, 'different-key second FT_bet');
  const secondTerminal = [];
  for (const id of secondIds) secondTerminal.push(await waitBetTerminal(db, id, 25000));
  await new Promise(resolve => setTimeout(resolve, 200));
  const after = await captureFixtureState(db, mockBundle, fixture);
  const evidence = {
    scenario: 'different idempotency_key does not merge the same payload',
    fixture, account_id: account.id, before, first_payload: firstPayload, second_payload: secondPayload,
    first, second, first_bet_ids: firstIds, second_bet_ids: secondIds,
    first_terminal_bets: firstTerminal, controlled_update: controlledUpdate.rows, second_terminal_bets: secondTerminal,
    after, created_counts: {
      bets: after.bets.length - before.bets.length,
      ft_bet: after.mock_ft_bet_events.length - before.mock_ft_bet_events.length,
      transactions: after.transactions.length - before.transactions.length,
      idempotency: after.idempotency_rows.length - before.idempotency_rows.length,
    },
  };
  writeJson(evidencePath('scenario-different-key.json'), evidence);
  return evidence;
}

function overlapFromApiRequests(left, right) {
  const leftStart = Date.parse(left.started_at_utc);
  const leftEnd = Date.parse(left.ended_at_utc);
  const rightStart = Date.parse(right.started_at_utc);
  const rightEnd = Date.parse(right.ended_at_utc);
  return {
    left_window: { start_utc: left.started_at_utc, end_utc: left.ended_at_utc, duration_ms: left.duration_ms },
    right_window: { start_utc: right.started_at_utc, end_utc: right.ended_at_utc, duration_ms: right.duration_ms },
    start_delta_ms: Math.round(Math.abs(leftStart - rightStart)),
    client_observed_overlap: leftStart < rightEnd && rightStart < leftEnd,
    overlap_ms: Math.max(0, Math.round(Math.min(leftEnd, rightEnd) - Math.max(leftStart, rightStart))),
  };
}

async function idempotencyRowForKey(db, key) {
  const found = await db.query(`
    SELECT id, user_id, idempotency_key, request_hash, status, bet_ids, response_json, http_status,
           created_at, updated_at
      FROM bet_idempotency_requests
     WHERE idempotency_key = $1
     ORDER BY id
  `, [key]);
  return found.rows[0] || null;
}

function mockEventsForFixture(mockBundle, fixture) {
  return mockBundle.mock.ftBetEvents.filter(event => String(event.params?.gid || '') === String(fixture.gid));
}

async function runDifferentPayloadSameKey(db, mockBundle, seed, token) {
  const fixture = phaseFixtures.find(item => item.name === 'different-payload');
  const account = seed.primary.accounts[2];
  const key = 'phase3f02-payload-one';
  const firstPayload = buildPhasePayload({ fixture, accountId: account.id, key });
  const before = await captureFixtureState(db, mockBundle, fixture);
  const first = await rawApiRequest({ method: 'POST', url: `${urls.backend}/api/bets`, token, body: firstPayload, label: 'same key different payload: first payload' });
  const firstIds = idsFromResponse(first);
  await waitFor(() => mockEventsForFixture(mockBundle, fixture).length > mockEventsForFixture({ mock: { ftBetEvents: before.mock_ft_bet_events } }, fixture).length, 15000, 'different-payload first FT_bet');
  const terminal = [];
  for (const id of firstIds) terminal.push(await waitBetTerminal(db, id, 25000));
  const beforeSecond = await captureFixtureState(db, mockBundle, fixture);
  const secondPayload = buildPhasePayload({ fixture, accountId: account.id, key, overrides: { total_amount: 81 } });
  const second = await rawApiRequest({ method: 'POST', url: `${urls.backend}/api/bets`, token, body: secondPayload, label: 'same key different payload: changed payload' });
  await new Promise(resolve => setTimeout(resolve, 200));
  const after = await captureFixtureState(db, mockBundle, fixture);
  const evidence = {
    scenario: 'same idempotency_key with changed payload is rejected',
    fixture, account_id: account.id, key, before, first_payload: firstPayload, second_payload: secondPayload,
    first, second, first_bet_ids: firstIds, second_bet_ids: idsFromResponse(second),
    terminal_bets: terminal, before_second: beforeSecond, after,
    second_created_counts: {
      bets: after.bets.length - beforeSecond.bets.length,
      ft_bet: after.mock_ft_bet_events.length - beforeSecond.mock_ft_bet_events.length,
      transactions: after.transactions.length - beforeSecond.transactions.length,
      idempotency: after.idempotency_rows.length - beforeSecond.idempotency_rows.length,
    },
    created_counts: {
      bets: after.bets.length - before.bets.length,
      ft_bet: after.mock_ft_bet_events.length - before.mock_ft_bet_events.length,
      transactions: after.transactions.length - before.transactions.length,
      idempotency: after.idempotency_rows.length - before.idempotency_rows.length,
    },
    idempotency_row: await idempotencyRowForKey(db, key),
  };
  writeJson(evidencePath('scenario-same-key-different-payload.json'), evidence);
  return evidence;
}

async function runPreCancelledReplay(db, mockBundle, seed, token) {
  const fixture = phaseFixtures.find(item => item.name === 'pre-cancelled');
  const account = seed.primary.accounts[3];
  const key = 'phase3f02-pre-cancelled';
  const payload = buildPhasePayload({ fixture, accountId: account.id, key });
  const before = await captureFixtureState(db, mockBundle, fixture);
  const first = await rawApiRequest({ method: 'POST', url: `${urls.backend}/api/bets`, token, body: payload, label: 'pre-cancelled: credit below amount' });
  const firstIds = idsFromResponse(first);
  await new Promise(resolve => setTimeout(resolve, 200));
  const afterFirst = await captureFixtureState(db, mockBundle, fixture);
  const beforeReplay = await captureFixtureState(db, mockBundle, fixture);
  const replay = await rawApiRequest({ method: 'POST', url: `${urls.backend}/api/bets`, token, body: payload, label: 'pre-cancelled: same key replay' });
  await new Promise(resolve => setTimeout(resolve, 200));
  const after = await captureFixtureState(db, mockBundle, fixture);
  const evidence = {
    scenario: 'pre-cancelled response is stored and replayed without new side effects',
    fixture, account_id: account.id, payload, before, first, replay,
    first_bet_ids: firstIds, replay_bet_ids: idsFromResponse(replay),
    after_first: afterFirst, before_replay: beforeReplay, after,
    first_created_counts: {
      bets: afterFirst.bets.length - before.bets.length,
      ft_bet: afterFirst.mock_ft_bet_events.length - before.mock_ft_bet_events.length,
      transactions: afterFirst.transactions.length - before.transactions.length,
      idempotency: afterFirst.idempotency_rows.length - before.idempotency_rows.length,
    },
    replay_created_counts: {
      bets: after.bets.length - beforeReplay.bets.length,
      ft_bet: after.mock_ft_bet_events.length - beforeReplay.mock_ft_bet_events.length,
      transactions: after.transactions.length - beforeReplay.transactions.length,
      idempotency: after.idempotency_rows.length - beforeReplay.idempotency_rows.length,
    },
    idempotency_row: await idempotencyRowForKey(db, key),
  };
  writeJson(evidencePath('scenario-pre-cancelled-replay.json'), evidence);
  return evidence;
}

async function runDryRun(db, mockBundle, seed, token) {
  const fixture = phaseFixtures.find(item => item.name === 'dry-run');
  const account = seed.primary.accounts[4];
  const key = 'phase3f02-dry-run';
  const payload = buildPhasePayload({ fixture, accountId: account.id, key, overrides: { dry_run: true } });
  const before = await captureFixtureState(db, mockBundle, fixture);
  const request = await rawApiRequest({ method: 'POST', url: `${urls.backend}/api/bets`, token, body: payload, label: 'dry-run with idempotency_key' });
  await new Promise(resolve => setTimeout(resolve, 200));
  const after = await captureFixtureState(db, mockBundle, fixture);
  const evidence = {
    scenario: 'dry_run does not persist an idempotency reservation or bet side effects',
    fixture, account_id: account.id, payload, before, request, after,
    created_counts: {
      bets: after.bets.length - before.bets.length,
      ft_bet: after.mock_ft_bet_events.length - before.mock_ft_bet_events.length,
      transactions: after.transactions.length - before.transactions.length,
      idempotency: after.idempotency_rows.length - before.idempotency_rows.length,
    },
    idempotency_row: await idempotencyRowForKey(db, key),
  };
  writeJson(evidencePath('scenario-dry-run.json'), evidence);
  return evidence;
}

async function runHeaderAndBodyKey(db, mockBundle, seed, token) {
  const fixture = phaseFixtures.find(item => item.name === 'header-body');
  const account = seed.primary.accounts[4];
  const key = 'phase3f02-header-only';
  const before = await captureFixtureState(db, mockBundle, fixture);

  const mismatchBody = buildPhasePayload({ fixture, accountId: account.id, key });
  const mismatch = await rawApiRequest({
    method: 'POST', url: `${urls.backend}/api/bets`, token, body: mismatchBody,
    headers: { 'Idempotency-Key': 'phase3f02-other-key' }, label: 'header/body key mismatch',
  });
  const afterMismatch = await captureFixtureState(db, mockBundle, fixture);

  const invalidBody = buildPhasePayload({ fixture, accountId: account.id, key: 'bad key!' });
  const invalid = await rawApiRequest({
    method: 'POST', url: `${urls.backend}/api/bets`, token, body: invalidBody, label: 'invalid body key',
  });
  const afterInvalid = await captureFixtureState(db, mockBundle, fixture);

  const headerOnlyPayload = buildPhasePayload({ fixture, accountId: account.id, key });
  delete headerOnlyPayload.idempotency_key;
  const beforeHeaderOnly = await captureFixtureState(db, mockBundle, fixture);
  const headerOnly = await rawApiRequest({
    method: 'POST', url: `${urls.backend}/api/bets`, token, body: headerOnlyPayload,
    headers: { 'Idempotency-Key': key }, label: 'valid Header-only key first request',
  });
  const betIds = idsFromResponse(headerOnly);
  await waitFor(() => mockEventsForFixture(mockBundle, fixture).length > mockEventsForFixture({ mock: { ftBetEvents: beforeHeaderOnly.mock_ft_bet_events } }, fixture).length, 15000, 'header-only FT_bet');
  const terminal = [];
  for (const id of betIds) terminal.push(await waitBetTerminal(db, id, 25000));

  const bodyOnlyPayload = buildPhasePayload({ fixture, accountId: account.id, key });
  const beforeReplay = await captureFixtureState(db, mockBundle, fixture);
  const bodyOnlyReplay = await rawApiRequest({
    method: 'POST', url: `${urls.backend}/api/bets`, token, body: bodyOnlyPayload,
    label: 'same key body-only replay',
  });
  await new Promise(resolve => setTimeout(resolve, 200));
  const after = await captureFixtureState(db, mockBundle, fixture);
  const evidence = {
    scenario: 'idempotency key is accepted from Header or body and remains one reservation',
    fixture, account_id: account.id, key, before,
    mismatch, mismatch_body: mismatchBody, after_mismatch: afterMismatch,
    invalid, invalid_body: invalidBody, after_invalid: afterInvalid,
    header_only_payload: headerOnlyPayload, header_only: headerOnly, header_only_bet_ids: betIds,
    terminal_bets: terminal, body_only_payload: bodyOnlyPayload, body_only_replay: bodyOnlyReplay,
    before_header_only: beforeHeaderOnly, before_replay: beforeReplay, after,
    mismatch_created_counts: {
      bets: afterMismatch.bets.length - before.bets.length,
      ft_bet: afterMismatch.mock_ft_bet_events.length - before.mock_ft_bet_events.length,
      transactions: afterMismatch.transactions.length - before.transactions.length,
      idempotency: afterMismatch.idempotency_rows.length - before.idempotency_rows.length,
    },
    invalid_created_counts: {
      bets: afterInvalid.bets.length - afterMismatch.bets.length,
      ft_bet: afterInvalid.mock_ft_bet_events.length - afterMismatch.mock_ft_bet_events.length,
      transactions: afterInvalid.transactions.length - afterMismatch.transactions.length,
      idempotency: afterInvalid.idempotency_rows.length - afterMismatch.idempotency_rows.length,
    },
    replay_created_counts: {
      bets: after.bets.length - beforeReplay.bets.length,
      ft_bet: after.mock_ft_bet_events.length - beforeReplay.mock_ft_bet_events.length,
      transactions: after.transactions.length - beforeReplay.transactions.length,
      idempotency: after.idempotency_rows.length - beforeReplay.idempotency_rows.length,
    },
    created_counts: {
      bets: after.bets.length - before.bets.length,
      ft_bet: after.mock_ft_bet_events.length - before.mock_ft_bet_events.length,
      transactions: after.transactions.length - before.transactions.length,
      idempotency: after.idempotency_rows.length - before.idempotency_rows.length,
    },
    idempotency_row: await idempotencyRowForKey(db, key),
  };
  writeJson(evidencePath('scenario-header-body-key.json'), evidence);
  return evidence;
}

async function runEarlyFailureReplay(db, mockBundle, seed, token) {
  const fixture = phaseFixtures.find(item => item.name === 'early-failure');
  const account = seed.early_failure.accounts[0];
  const key = 'phase3f02-early-failure';
  const payload = buildPhasePayload({ fixture, accountId: account.id, key });
  const before = await captureFixtureState(db, mockBundle, fixture);
  const first = await rawApiRequest({ method: 'POST', url: `${urls.backend}/api/bets`, token, body: payload, label: 'early failure: zero platform balance' });
  await new Promise(resolve => setTimeout(resolve, 200));
  const afterFirst = await captureFixtureState(db, mockBundle, fixture);
  const beforeReplay = await captureFixtureState(db, mockBundle, fixture);
  const replay = await rawApiRequest({ method: 'POST', url: `${urls.backend}/api/bets`, token, body: payload, label: 'early failure: same key same payload replay' });
  const changedPayload = buildPhasePayload({ fixture, accountId: account.id, key, overrides: { total_amount: 81 } });
  const changed = await rawApiRequest({ method: 'POST', url: `${urls.backend}/api/bets`, token, body: changedPayload, label: 'early failure: same key changed payload' });
  await new Promise(resolve => setTimeout(resolve, 200));
  const after = await captureFixtureState(db, mockBundle, fixture);
  const evidence = {
    scenario: 'early validation failure is stored once and replayed',
    fixture, account_id: account.id, payload, changed_payload: changedPayload,
    before, first, replay, changed, after_first: afterFirst,
    first_replay_responses_canonically_equal: JSON.stringify(canonical(first.response_body)) === JSON.stringify(canonical(replay.response_body)),
    replay_created_counts: {
      bets: after.bets.length - beforeReplay.bets.length,
      ft_bet: after.mock_ft_bet_events.length - beforeReplay.mock_ft_bet_events.length,
      transactions: after.transactions.length - beforeReplay.transactions.length,
      idempotency: after.idempotency_rows.length - beforeReplay.idempotency_rows.length,
    },
    after,
    idempotency_row: await idempotencyRowForKey(db, key),
    idempotency_rows_for_user: await idempotencyRows(db, seed.early_failure.user.id),
  };
  writeJson(evidencePath('scenario-early-failure-replay.json'), evidence);
  return evidence;
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
  const backendBuild = buildBackend();
  check('backend_build_passed', backendBuild.exit_code === 0, 0, backendBuild.exit_code);
  const frontendBuild = buildFrontend();
  check('frontend_build_passed', frontendBuild.exit_code === 0, 0, frontendBuild.exit_code);

  const seed = await createAndSeedPhase3F02Database();
  writeJson(evidencePath('db-seeded.json'), seed);
  let db = null;
  let services = null;
  let mockBundle = null;
  let migrationRepeat = null;
  let legacy = null;
  let concurrent = null;
  let sequential = null;
  let differentKey = null;
  let differentPayload = null;
  let preCancelled = null;
  let dryRun = null;
  let headerBody = null;
  let earlyFailure = null;
  let finalSnapshot = null;
  let finalIdempotency = null;
  let finalIntegrity = null;
  let stopEvidence = null;
  let guardAfter = null;

  try {
    db = await connectDb(dbName);
    const seedState = await getFullDbSnapshot(db, seed);
    writeJson(evidencePath('db-seed-state.json'), seedState);
    check('fresh_database_starts_without_bets', seedState.bets.length === 0, 0, seedState.bets.length);
    check('fresh_database_starts_without_idempotency_rows', await countIdempotency(db) === 0, 0, await countIdempotency(db));

    migrationRepeat = await repeatMigrationDirectly(db);
    check('migration_repeat_twice_success', migrationRepeat.runs.length === 2 && migrationRepeat.runs.every(item => item.exit === 0 && item.rows_after === 0),
      { runs: 2, exit: [0, 0], rows_after: [0, 0] }, migrationRepeat.runs);
    const constraintNames = migrationRepeat.constraints.map(item => item.constraint_name);
    check('migration_unique_and_status_constraints_exist',
      constraintNames.includes('uq_bet_idempotency_user_key') && constraintNames.includes('bet_idempotency_status_check'),
      ['uq_bet_idempotency_user_key', 'bet_idempotency_status_check'], constraintNames);

    mockBundle = createDelayedMock('PHASE3F02');
    services = await startServices(dbName, mockBundle);
    const loginPrimary = await loginApi(seed.primary.user.username, 'primary admin');
    const loginConcurrent = await loginApi(seed.concurrent.user.username, 'concurrent admin');
    const loginEarlyFailure = await loginApi(seed.early_failure.user.username, 'early failure admin');
    writeJson(evidencePath('api-login-primary-redacted.json'), loginPrimary.request);
    writeJson(evidencePath('api-login-concurrent-redacted.json'), loginConcurrent.request);
    writeJson(evidencePath('api-login-early-failure-redacted.json'), loginEarlyFailure.request);
    check('primary_api_login_success', loginPrimary.request.response_status === 200, 200, loginPrimary.request.response_status);
    check('concurrent_api_login_success', loginConcurrent.request.response_status === 200, 200, loginConcurrent.request.response_status);
    check('early_failure_api_login_success', loginEarlyFailure.request.response_status === 200, 200, loginEarlyFailure.request.response_status);

    legacy = await runLegacyNoKey(db, mockBundle, seed, loginPrimary.token);
    check('legacy_no_key_compatible',
      legacy.request.response_status === 202 && legacy.created_counts.bets === 1 &&
      legacy.created_counts.ft_bet === 1 && legacy.created_counts.transactions === 1 &&
      legacy.created_counts.idempotency === 0,
      { status: 202, bets: 1, ft_bet: 1, transactions: 1, idempotency: 0 },
      { status: legacy.request.response_status, counts: legacy.created_counts });

    concurrent = await runConcurrentIdempotencyTrials(db, mockBundle, seed, loginConcurrent.token);
    check('concurrent_10_trials_overlap_observed', concurrent.summary.overlap_count === concurrentTrials, concurrentTrials, concurrent.summary.overlap_count);
    check('concurrent_all_statuses_202_202', concurrent.trials.every(item => JSON.stringify(item.request_statuses) === JSON.stringify([202, 202])),
      [[202, 202]], concurrent.summary.statuses);
    check('concurrent_all_response_bodies_canonically_equal', concurrent.trials.every(item => item.response_bodies_canonically_equal === true), true,
      concurrent.trials.map(item => ({ trial: item.trial_index, equal: item.response_bodies_canonically_equal })));
    check('concurrent_each_trial_has_replay_header', concurrent.summary.replay_header_count_per_trial.every(count => count >= 1), '>=1 per trial',
      concurrent.summary.replay_header_count_per_trial);
    check('concurrent_each_trial_creates_one_bet_ft_bet_transaction_idempotency',
      concurrent.trials.every(item => item.created_counts.bets === 1 && item.created_counts.ft_bet === 1 &&
        item.created_counts.transactions === 1 && item.created_counts.idempotency === 1),
      { bets: 1, ft_bet: 1, transactions: 1, idempotency: 1 },
      concurrent.trials.map(item => ({ trial: item.trial_index, counts: item.created_counts })));
    check('concurrent_all_created_bets_terminal_confirmed', concurrent.trials.every(item => item.terminal_bets.length === 1 && item.terminal_bets[0].status === 'confirmed'),
      'confirmed', concurrent.trials.map(item => item.terminal_bets.map(bet => bet.status)));

    sequential = await runSequentialReplayAfterConfirmed(db, mockBundle, seed, loginConcurrent.token, concurrent);
    check('sequential_replay_confirmed_returns_same_ids_without_side_effects',
      sequential.request.response_status === 202 &&
      JSON.stringify(sequential.replay_bet_ids) === JSON.stringify(sequential.original_bet_ids) &&
      String(sequential.request.response_headers?.idempotency_replayed).toLowerCase() === 'true' &&
      Object.values(sequential.created_counts).every(value => value === 0),
      { status: 202, same_ids: true, replay_header: true, side_effects: 0 },
      { status: sequential.request.response_status, replay_ids: sequential.replay_bet_ids, original_ids: sequential.original_bet_ids,
        header: sequential.request.response_headers?.idempotency_replayed, counts: sequential.created_counts });

    differentKey = await runDifferentKeySamePayload(db, mockBundle, seed, loginPrimary.token);
    const differentKeyDisjoint = differentKey.first_bet_ids.length === 1 && differentKey.second_bet_ids.length === 1 &&
      differentKey.first_bet_ids[0] !== differentKey.second_bet_ids[0];
    check('different_key_same_payload_creates_two_requests',
      differentKey.first.response_status === 202 && differentKey.second.response_status === 202 &&
      differentKeyDisjoint && differentKey.created_counts.bets === 2 && differentKey.created_counts.ft_bet === 2 &&
      differentKey.created_counts.transactions === 2 && differentKey.created_counts.idempotency === 2,
      { statuses: [202, 202], distinct_ids: true, bets: 2, ft_bet: 2, transactions: 2, idempotency: 2 },
      { statuses: [differentKey.first.response_status, differentKey.second.response_status], distinct_ids: differentKeyDisjoint, counts: differentKey.created_counts });

    differentPayload = await runDifferentPayloadSameKey(db, mockBundle, seed, loginPrimary.token);
    check('same_key_different_payload_rejected_409',
      differentPayload.first.response_status === 202 && differentPayload.second.response_status === 409 &&
      differentPayload.created_counts.bets === 1 && differentPayload.created_counts.ft_bet === 1 &&
      differentPayload.created_counts.transactions === 1 && differentPayload.created_counts.idempotency === 1 &&
      Object.values(differentPayload.second_created_counts).every(value => value === 0),
      { first: 202, second: 409, first_side_effects: [1, 1, 1, 1], second_side_effects: 0 },
      { first: differentPayload.first.response_status, second: differentPayload.second.response_status,
        first_counts: differentPayload.created_counts, second_counts: differentPayload.second_created_counts });

    preCancelled = await runPreCancelledReplay(db, mockBundle, seed, loginPrimary.token);
    check('pre_cancelled_replay',
      preCancelled.first.response_status === 202 &&
      preCancelled.first.response_body?.data?.processing === 0 &&
      preCancelled.first.response_body?.data?.cancelled === 1 &&
      preCancelled.after.bets.length === 1 && preCancelled.after.bets[0].status === 'cancelled' &&
      preCancelled.first_created_counts.bets === 1 && preCancelled.first_created_counts.ft_bet === 0 &&
      preCancelled.first_created_counts.transactions === 0 && preCancelled.first_created_counts.idempotency === 1 &&
      JSON.stringify(preCancelled.replay_bet_ids) === JSON.stringify(preCancelled.first_bet_ids) &&
      String(preCancelled.replay.response_headers?.idempotency_replayed).toLowerCase() === 'true' &&
      Object.values(preCancelled.replay_created_counts).every(value => value === 0),
      { status: 202, processing: 0, cancelled_response: 1, db_status: 'cancelled', ft_bet: 0, transaction: 0, replay_same_ids: true },
      { status: preCancelled.first.response_status, response: preCancelled.first.response_body?.data,
        db_status: preCancelled.after.bets[0]?.status, first_counts: preCancelled.first_created_counts,
        replay_ids: preCancelled.replay_bet_ids, header: preCancelled.replay.response_headers?.idempotency_replayed,
        replay_counts: preCancelled.replay_created_counts });

    dryRun = await runDryRun(db, mockBundle, seed, loginPrimary.token);
    check('dry_run_no_idempotency_row_or_side_effects',
      dryRun.request.response_status === 200 && Object.values(dryRun.created_counts).every(value => value === 0) && dryRun.idempotency_row === null,
      { status: 200, side_effects: 0, idempotency_row: null },
      { status: dryRun.request.response_status, counts: dryRun.created_counts, idempotency_row: dryRun.idempotency_row });

    headerBody = await runHeaderAndBodyKey(db, mockBundle, seed, loginPrimary.token);
    check('header_body_mismatch_400_no_row',
      headerBody.mismatch.response_status === 400 && Object.values(headerBody.mismatch_created_counts).every(value => value === 0),
      { status: 400, side_effects: 0 }, { status: headerBody.mismatch.response_status, counts: headerBody.mismatch_created_counts });
    check('invalid_key_400_no_row',
      headerBody.invalid.response_status === 400 && Object.values(headerBody.invalid_created_counts).every(value => value === 0),
      { status: 400, side_effects: 0 }, { status: headerBody.invalid.response_status, counts: headerBody.invalid_created_counts });
    check('header_only_and_body_only_same_key_replay',
      headerBody.header_only.response_status === 202 && headerBody.body_only_replay.response_status === 202 &&
      JSON.stringify(idsFromResponse(headerBody.body_only_replay)) === JSON.stringify(headerBody.header_only_bet_ids) &&
      String(headerBody.body_only_replay.response_headers?.idempotency_replayed).toLowerCase() === 'true' &&
      headerBody.created_counts.bets === 1 && headerBody.created_counts.ft_bet === 1 &&
      headerBody.created_counts.transactions === 1 && headerBody.created_counts.idempotency === 1 &&
      Object.values(headerBody.replay_created_counts).every(value => value === 0),
      { statuses: [202, 202], same_ids: true, replay_header: true, counts: [1, 1, 1, 1] },
      { statuses: [headerBody.header_only.response_status, headerBody.body_only_replay.response_status],
        replay_ids: idsFromResponse(headerBody.body_only_replay), header: headerBody.body_only_replay.response_headers?.idempotency_replayed,
        counts: headerBody.created_counts, replay_counts: headerBody.replay_created_counts });

    earlyFailure = await runEarlyFailureReplay(db, mockBundle, seed, loginEarlyFailure.token);
    check('early_failure_replay',
      earlyFailure.first.response_status === 400 && earlyFailure.replay.response_status === 400 &&
      earlyFailure.changed.response_status === 409 && earlyFailure.first_replay_responses_canonically_equal === true &&
      earlyFailure.after.bets.length === 0 && mockEventsForFixture(mockBundle, earlyFailure.fixture).length === 0 &&
      earlyFailure.after.transactions.filter(item => item.user_username === seed.early_failure.user.username && item.transaction_type === '消耗').length === 0 &&
      earlyFailure.idempotency_rows_for_user.length === 1 && earlyFailure.idempotency_row?.status === 'failed' &&
      Number(earlyFailure.idempotency_row?.http_status) === 400 &&
      Object.values(earlyFailure.replay_created_counts).every(value => value === 0),
      { first: 400, replay: 400, changed: 409, equal: true, bets: 0, ft_bet: 0, transactions: 0, idempotency: '1 failed' },
      { first: earlyFailure.first.response_status, replay: earlyFailure.replay.response_status, changed: earlyFailure.changed.response_status,
        equal: earlyFailure.first_replay_responses_canonically_equal, bets: earlyFailure.after.bets.length,
        idempotency: earlyFailure.idempotency_row, replay_counts: earlyFailure.replay_created_counts });

    finalSnapshot = await getFullDbSnapshot(db, seed);
    writeJson(evidencePath('db-after.json'), finalSnapshot);
    writeJson(evidencePath('db-final.json'), finalSnapshot);
    finalIdempotency = await db.query(`
      SELECT id, user_id, idempotency_key, request_hash, status, bet_ids, response_json, http_status,
             created_at, updated_at
        FROM bet_idempotency_requests ORDER BY id
    `);
    finalIntegrity = await db.query(`
      SELECT 'missing_transaction_for_active_bet' AS issue, b.id AS bet_id
        FROM bets b
       WHERE b.status <> 'cancelled'
         AND NOT EXISTS (
           SELECT 1 FROM coin_transactions t
            WHERE t.bet_id = b.id AND t.transaction_type = '消耗'
         )
      UNION ALL
      SELECT 'charge_transaction_without_active_bet' AS issue, t.bet_id
        FROM coin_transactions t
        LEFT JOIN bets b ON b.id = t.bet_id
       WHERE t.transaction_type = '消耗'
         AND (b.id IS NULL OR b.status = 'cancelled')
      ORDER BY issue, bet_id
    `);
    writeJson(evidencePath('final-idempotency.json'), { rows: finalIdempotency.rows });
    writeJson(evidencePath('final-db-integrity.json'), { rows: finalIntegrity.rows });
    writeJson(evidencePath('mock-events.json'), {
      events: mockBundle.mock.events,
      ft_bet_events: mockBundle.mock.ftBetEvents,
      unrecognized_action_events: mockBundle.mock.events.filter(event =>
        !['chk_login', 'FT_order_view', 'FT_bet', 'get_today_wagers'].includes(event.action)),
    });
    writeJson(evidencePath('mock-response-attempts.json'), {
      attempts: mockBundle.responseAttempts,
      scheduled_count: mockBundle.responseAttempts.length,
      completed_count: mockBundle.responseAttempts.filter(item => item.completed_at).length,
    });
    writeJson(evidencePath('transaction-evidence.json'), {
      transactions: finalSnapshot.transactions,
      transaction_id_unique_count: new Set(finalSnapshot.transactions.map(item => item.transaction_id)).size,
      transaction_id_total_count: finalSnapshot.transactions.length,
      charge_transaction_count: finalSnapshot.transactions.filter(item => item.transaction_type === '消耗').length,
      balances: finalSnapshot.balances,
    });

    const rowsByKey = new Map(finalIdempotency.rows.map(row => [row.idempotency_key, row]));
    const createdResponseCases = [
      ...concurrent.trials.map(item => ({ key: item.payload.idempotency_key, request: item.requests[0], ids: item.unique_request_bet_ids })),
      { key: differentKey.first_payload.idempotency_key, request: differentKey.first, ids: differentKey.first_bet_ids },
      { key: differentKey.second_payload.idempotency_key, request: differentKey.second, ids: differentKey.second_bet_ids },
      { key: differentPayload.first_payload.idempotency_key, request: differentPayload.first, ids: differentPayload.first_bet_ids },
      { key: preCancelled.payload.idempotency_key, request: preCancelled.first, ids: preCancelled.first_bet_ids },
      { key: headerBody.key, request: headerBody.header_only, ids: headerBody.header_only_bet_ids },
    ];
    const responseChecks = createdResponseCases.map(item => {
      const row = rowsByKey.get(item.key) || null;
      return {
        key: item.key,
        row_found: row !== null,
        status: row?.status ?? null,
        http_status: row?.http_status ?? null,
        response_json_canonically_equal: row ? JSON.stringify(canonical(row.response_json)) === JSON.stringify(canonical(item.request.response_body)) : false,
        bet_ids_equal: row ? JSON.stringify(row.bet_ids || []) === JSON.stringify(item.ids) : false,
      };
    });
    writeJson(evidencePath('response-snapshot-checks.json'), {
      expected_created_cases: createdResponseCases.length, checks: responseChecks,
    });
    check('response_snapshot_canonical_equal_for_created_cases',
      responseChecks.length === 15 && responseChecks.every(item => item.row_found && item.status === 'created' &&
        Number(item.http_status) === 202 && item.response_json_canonically_equal && item.bet_ids_equal),
      { cases: 15, row_found: true, status: 'created', http_status: 202, response_equal: true, bet_ids_equal: true },
      responseChecks);

    const statusCounts = finalIdempotency.rows.reduce((accumulator, row) => {
      accumulator[row.status] = (accumulator[row.status] || 0) + 1;
      return accumulator;
    }, {});
    check('final_idempotency_row_counts',
      finalIdempotency.rows.length === 16 && statusCounts.created === 15 && statusCounts.failed === 1,
      { total: 16, created: 15, failed: 1 }, { total: finalIdempotency.rows.length, ...statusCounts });
    check('final_bet_ft_transaction_counts',
      finalSnapshot.bets.length === 16 && mockBundle.mock.ftBetEvents.length === 15 &&
      finalSnapshot.transactions.filter(item => item.transaction_type === '消耗').length === 15,
      { bets: 16, ft_bet: 15, charge_transactions: 15 },
      { bets: finalSnapshot.bets.length, ft_bet: mockBundle.mock.ftBetEvents.length,
        charge_transactions: finalSnapshot.transactions.filter(item => item.transaction_type === '消耗').length });
    check('final_active_bet_transaction_integrity', finalIntegrity.rows.length === 0, [], finalIntegrity.rows);
    check('final_bet_status_counts',
      finalSnapshot.bets.filter(item => item.status === 'confirmed').length === 15 &&
      finalSnapshot.bets.filter(item => item.status === 'cancelled').length === 1,
      { confirmed: 15, cancelled: 1 },
      finalSnapshot.bets.reduce((accumulator, row) => { accumulator[row.status] = (accumulator[row.status] || 0) + 1; return accumulator; }, {}));

    stopEvidence = await stopServices(services, 'phase3f02 complete', 'stop-evidence.json');
    services = null;
    check('all_target_ports_down_after_stop', stopEvidence.all_target_ports_down, true, stopEvidence.target_ports_open_after_stop);
    const portsAfter = await targetPortsOpen();
    writeJson(evidencePath('target-port-guard-after.json'), { target_ports_open_after: portsAfter });
    check('target_ports_free_after', portsAfter.length === 0, [], portsAfter);
    guardAfter = await guardDbSnapshot();
    writeJson(evidencePath('guard-db-after.json'), guardAfter);
    check('guard_db_sha256_unchanged', guardBefore.sha256 === guardAfter.sha256, guardBefore.sha256, guardAfter.sha256);
    const hashesAfter = watchedHashMap();
    writeJson(evidencePath('watched-file-hashes-after.json'), hashesAfter);
    check('watched_files_unchanged_during_run',
      JSON.stringify(canonical(hashesBefore)) === JSON.stringify(canonical(hashesAfter)), hashesBefore, hashesAfter);

    result.summary = {
      backend_build: backendBuild,
      frontend_build: frontendBuild,
      migration_repeat: migrationRepeat.runs,
      legacy_no_key: { status: legacy.request.response_status, counts: legacy.created_counts },
      concurrent: concurrent.summary,
      sequential_replay: {
        status: sequential.request.response_status,
        replay_header: sequential.request.response_headers?.idempotency_replayed,
        original_bet_ids: sequential.original_bet_ids,
        replay_bet_ids: sequential.replay_bet_ids,
        created_counts: sequential.created_counts,
      },
      different_key: {
        statuses: [differentKey.first.response_status, differentKey.second.response_status],
        first_bet_ids: differentKey.first_bet_ids,
        second_bet_ids: differentKey.second_bet_ids,
        created_counts: differentKey.created_counts,
        controlled_fixture_update_rows: differentKey.controlled_update,
      },
      same_key_different_payload: {
        statuses: [differentPayload.first.response_status, differentPayload.second.response_status],
        created_counts: differentPayload.created_counts,
        second_created_counts: differentPayload.second_created_counts,
      },
      pre_cancelled: {
        status: preCancelled.first.response_status,
        processing: preCancelled.first.response_body?.data?.processing,
        cancelled: preCancelled.first.response_body?.data?.cancelled,
        db_status: preCancelled.after.bets[0]?.status,
        first_created_counts: preCancelled.first_created_counts,
        replay_created_counts: preCancelled.replay_created_counts,
      },
      dry_run: { status: dryRun.request.response_status, created_counts: dryRun.created_counts, idempotency_row: dryRun.idempotency_row },
      header_body: {
        mismatch_status: headerBody.mismatch.response_status,
        invalid_status: headerBody.invalid.response_status,
        header_only_status: headerBody.header_only.response_status,
        body_replay_status: headerBody.body_only_replay.response_status,
        replay_header: headerBody.body_only_replay.response_headers?.idempotency_replayed,
        created_counts: headerBody.created_counts,
      },
      early_failure: {
        statuses: [earlyFailure.first.response_status, earlyFailure.replay.response_status, earlyFailure.changed.response_status],
        first_replay_responses_canonically_equal: earlyFailure.first_replay_responses_canonically_equal,
        idempotency_row_status: earlyFailure.idempotency_row?.status,
      },
      final_counts: {
        bets: finalSnapshot.bets.length,
        ft_bet_events: mockBundle.mock.ftBetEvents.length,
        charge_transactions: finalSnapshot.transactions.filter(item => item.transaction_type === '消耗').length,
        idempotency_rows: finalIdempotency.rows.length,
        idempotency_status_counts: statusCounts,
        integrity_issues: finalIntegrity.rows,
      },
    };

    const reportFile = path.join(reportDir, `${runId}-phase3f02-幂等修复实证报告.md`);
    const reportLines = [
      '# Phase 3F-02 下注跨客户端幂等修复实证报告', '',
      `- Run ID：\`${runId}\``,
      `- 数据库：\`${dbName}\``,
      `- 开始时间：${result.run_started_at_beijing}（${result.run_started_at_utc}）`,
      `- 证据目录：\`${path.relative(deployRoot, evidenceDir)}\``,
      '- 服务边界：本地 backend `127.0.0.1:3202` + 本地 mock upstream `127.0.0.1:3301`；本 Run 未访问真实 Crown / 外部上游。', '',
      '## runtime_proven', '',
      '| 场景 | 请求结果 | DB 注单 | mock FT_bet | 扣款流水 | 幂等记录 | 结论 |',
      '|---|---:|---:|---:|---:|---:|---|',
      `| 无 key 旧兼容 | ${legacy.request.response_status} | ${legacy.created_counts.bets} | ${legacy.created_counts.ft_bet} | ${legacy.created_counts.transactions} | ${legacy.created_counts.idempotency} | 保持旧行为 |`,
      `| 同 key 并发 10 组 | 全部 [202,202] | 每组 1 | 每组 1 | 每组 1 | 每组 1 | 响应 canonical 相等且至少一端重放标记 |`,
      `| 已 confirmed 后同 key 重放 | ${sequential.request.response_status} | ${sequential.created_counts.bets} | ${sequential.created_counts.ft_bet} | ${sequential.created_counts.transactions} | ${sequential.created_counts.idempotency} | 返回原 bet_ids，无新增副作用 |`,
      `| 不同 key 同 payload | [${differentKey.first.response_status},${differentKey.second.response_status}] | ${differentKey.created_counts.bets} | ${differentKey.created_counts.ft_bet} | ${differentKey.created_counts.transactions} | ${differentKey.created_counts.idempotency} | 不同 key 不合并 |`,
      `| 同 key 变更 payload | [${differentPayload.first.response_status},${differentPayload.second.response_status}] | ${differentPayload.created_counts.bets} | ${differentPayload.created_counts.ft_bet} | ${differentPayload.created_counts.transactions} | ${differentPayload.created_counts.idempotency} | 第二次 409，第二次无新增副作用 |`,
      `| 预取消（信用不足） | ${preCancelled.first.response_status} | ${preCancelled.first_created_counts.bets} | ${preCancelled.first_created_counts.ft_bet} | ${preCancelled.first_created_counts.transactions} | ${preCancelled.first_created_counts.idempotency} | DB 为 cancelled；重放同 bet_ids 且无新增副作用 |`,
      `| dry_run + key | ${dryRun.request.response_status} | ${dryRun.created_counts.bets} | ${dryRun.created_counts.ft_bet} | ${dryRun.created_counts.transactions} | ${dryRun.created_counts.idempotency} | 不落幂等表 |`,
      `| Header/Body key | mismatch=${headerBody.mismatch.response_status}, invalid=${headerBody.invalid.response_status}, success/replay=[${headerBody.header_only.response_status},${headerBody.body_only_replay.response_status}] | ${headerBody.created_counts.bets} | ${headerBody.created_counts.ft_bet} | ${headerBody.created_counts.transactions} | ${headerBody.created_counts.idempotency} | 同 key Header 首次与 Body 重放共用一条记录 |`,
      `| 早期失败重放 | first/replay/changed=[${earlyFailure.first.response_status},${earlyFailure.replay.response_status},${earlyFailure.changed.response_status}] | ${earlyFailure.after.bets.length} | ${mockEventsForFixture(mockBundle, earlyFailure.fixture).length} | 0 | 1 failed | 失败响应可重放，变更 payload 409 |`, '',
      `- 并发窗口：客户端观测重叠 ${concurrent.summary.overlap_count}/${concurrentTrials}。该结论仅覆盖本 Run 请求窗口，不外推为数学上不存在其他竞态。`,
      `- created 幂等快照复核：${responseChecks.length} 条，全部与首次 HTTP 响应 canonical 相等、bet_ids 相等、status=created、HTTP 202。`,
      `- 最终计数：bets=${finalSnapshot.bets.length}，FT_bet=${mockBundle.mock.ftBetEvents.length}，消耗流水=${finalSnapshot.transactions.filter(item => item.transaction_type === '消耗').length}，幂等=${finalIdempotency.rows.length}（created=15，failed=1）。`, '',
      '## source_proven', '',
      '- `backend/src/routes/bets.ts`：reservation 在余额检查前创建；created 注单与幂等 response snapshot 在同一事务内更新；`COMMIT` 后才调用 `processBetJob`。',
      '- `database/schema.sql` 与迁移：`UNIQUE(user_id, idempotency_key)` 和 status CHECK 由结构查询复核。',
      '- `frontend/src/components/Betting/BetFormModal.tsx`：每次提交生成新的 `bet-*` 幂等键并写入 `requestData.idempotency_key`。', '',
      '## 测试内受控 fixture', '',
      '- `different-key` 场景在第一注 terminal confirmed 后，用直接 SQL 写入 `PHASE3F02-CONTROLLED-DIFFERENT-KEY-FIXTURE`，仅用于让旧注单退出线路占用查询；该行为不是产品自然路径，证据中保留 update 返回行。', '',
      '## not_tested', '',
      '- 未测试 UI 双击、浏览器刷新后的 UI 请求重试、多进程 backend、数据库主备延迟、真实 Crown 上游网络分区、长时间后台重试、幂等键过期清理和跨用户同 key。', '',
      '## 守护检查', '',
      `- 停止后目标端口：${mdJson(stopEvidence.target_ports_open_after_stop)}。`,
      `- guard DB SHA256 前后一致：${guardBefore.sha256 === guardAfter.sha256}。`,
      `- watched 文件 SHA256 前后一致：${JSON.stringify(canonical(hashesBefore)) === JSON.stringify(canonical(hashesAfter))}。`, '',
      '## 复现', '',
      '```powershell',
      'node --check .verify-runtime/phase3f02-run.js',
      'node .verify-runtime/phase3f02-run.js',
      '```', '',
      '时间标注为北京时间（Asia/Shanghai）。',
    ];
    fs.writeFileSync(reportFile, reportLines.join('\n') + '\n', 'utf8');
    result.report_file = path.relative(deployRoot, reportFile);
    const preliminaryJwtMatches = findJwtLikeMatches(evidenceDir);
    const preliminaryNonLoopbackUrls = findNonLoopbackUrls(evidenceDir);
    const preliminaryAllowedStaticBannerUrls = preliminaryNonLoopbackUrls.filter(item => item.url.startsWith('https://dotenvx.com') || item.url === 'https://rollupjs.org/configuration-options/#output-manualchunks');
    const preliminaryUnallowedNonLoopbackUrls = preliminaryNonLoopbackUrls.filter(item => !(item.url.startsWith('https://dotenvx.com') || item.url === 'https://rollupjs.org/configuration-options/#output-manualchunks'));
    const projectedPassed = result.assertions.filter(item => item.passed === true).length +
      (preliminaryJwtMatches.length === 0 ? 1 : 0) +
      (preliminaryUnallowedNonLoopbackUrls.length === 0 ? 1 : 0);
    const projectedTotal = result.assertions.length + 2;
    const assertionLine = '- \u4E3B\u9A8C\u8BC1\u65AD\u8A00\uFF1A' + `\`${projectedPassed}/${projectedTotal}\` passed`;
    reportLines.splice(4, 0, assertionLine);
    fs.writeFileSync(reportFile, reportLines.join('\n') + '\n', 'utf8');

    const jwtMatches = findJwtLikeMatches(evidenceDir);
    if (!same(jwtMatches, preliminaryJwtMatches)) throw new Error('JWT scan changed after report summary insertion');
    writeJson(evidencePath('jwt-scan.json'), {
      scanned_root: path.relative(deployRoot, evidenceDir),
      matches: jwtMatches,
      policy: 'three-segment JWT-like strings must not appear in generated evidence',
    });
    check('jwt_not_written_to_evidence', jwtMatches.length === 0, [], jwtMatches);
    const nonLoopbackUrls = findNonLoopbackUrls(evidenceDir);
    if (!same(nonLoopbackUrls, preliminaryNonLoopbackUrls)) throw new Error('network scan changed after report summary insertion');
    const allowedStaticBannerUrls = nonLoopbackUrls.filter(item => item.url.startsWith('https://dotenvx.com') || item.url === 'https://rollupjs.org/configuration-options/#output-manualchunks');
    const unallowedNonLoopbackUrls = nonLoopbackUrls.filter(item => !(item.url.startsWith('https://dotenvx.com') || item.url === 'https://rollupjs.org/configuration-options/#output-manualchunks'));
    writeJson(evidencePath('network-boundary-scan.json'), {
      scanned_root: path.relative(deployRoot, evidenceDir),
      non_loopback_urls: nonLoopbackUrls,
      allowed_static_banner_urls: allowedStaticBannerUrls,
      unallowed_non_loopback_urls: unallowedNonLoopbackUrls,
      allowed_hosts: ['127.0.0.1', 'localhost', '::1'],
      classification_note: 'dotenvx URLs and the Rollup manualChunks documentation URL are static build/tooling stdout text, not outbound requests in this run. Raw logs are not rewritten.',
    });
    check('network_only_loopback_except_static_build_tooling_banners', unallowedNonLoopbackUrls.length === 0, [], unallowedNonLoopbackUrls);

    result.checked_at_utc = new Date().toISOString();
    result.checked_at_beijing = beijingTime(new Date());
    result.assertions_passed = result.assertions.filter(item => item.passed).length;
    result.assertions_failed = result.assertions.filter(item => !item.passed).length;
    result.fatal_errors = fatal;
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
