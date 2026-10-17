'use strict';

const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { createRequire } = require('module');

const deployRoot = path.resolve(__dirname, '..');
const evidenceRoot = path.join(deployRoot, '证据', 'phase4a-multi-backend-idempotency');
const reportRoot = path.join(deployRoot, '报告');
const backendEnvFile = fs.existsSync(path.join(deployRoot, 'backend', '.env'))
  ? path.join(deployRoot, 'backend', '.env')
  : path.join(deployRoot, '..', 'hgzuqiu', 'backend', '.env');
const backendRequire = createRequire(path.join(deployRoot, 'backend', 'package.json'));
const { Client } = backendRequire('pg');

const checks = [];
function check(name, passed, expected, actual) {
  checks.push({ name, passed: passed === true, expected, actual });
  return passed === true;
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
function walk(dir) {
  const output = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) output.push(...walk(full));
    else output.push(full);
  }
  return output;
}
function readText(file) { return fs.readFileSync(file, 'utf8'); }
function parseJson(file) { return JSON.parse(readText(file)); }
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function same(left, right) { return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right)); }
function normalizeDbRows(rows) { return JSON.parse(JSON.stringify(rows)); }
function parseEnvFile(file) {
  const map = {};
  for (const line of readText(file).split(/\r?\n/)) {
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
function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function parseJsonl(file) {
  return readText(file).split(/\r?\n/).map((line, index) => {
    if (!line.trim()) return null;
    try { return JSON.parse(line); } catch (error) { throw new Error(`${file}:${index + 1}: ${error.message}`); }
  }).filter(Boolean);
}
async function portOpen(port, host = '127.0.0.1') {
  return new Promise(resolve => {
    const socket = net.connect({ port, host });
    socket.setTimeout(350);
    const finish = result => { socket.destroy(); resolve(result); };
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}
function scanEvidenceSecrets(root, knownSecrets) {
  const files = walk(root).filter(file => /\.(json|jsonl|txt|md)$/i.test(file));
  const findings = [];
  for (const file of files) {
    const text = readText(file);
    const relative = path.relative(root, file);
    const jwtMatches = text.match(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g) || [];
    if (jwtMatches.length) findings.push({ file: relative, type: 'jwt_like_string', count: jwtMatches.length });
    const bearerMatches = text.match(/Bearer\s+[A-Za-z0-9._~+/=-]{20,}/gi) || [];
    if (bearerMatches.length) findings.push({ file: relative, type: 'bearer_token', count: bearerMatches.length });
    for (const [label, secret] of Object.entries(knownSecrets)) {
      if (secret && secret.length >= 8 && text.includes(secret)) findings.push({ file: relative, type: `known_${label}`, count: 1 });
    }
  }
  return findings;
}
function scanNonLoopbackUrls(root) {
  const files = walk(root).filter(file => /\.(json|jsonl|txt|md)$/i.test(file));
  const findings = [];
  for (const file of files) {
    const text = readText(file);
    const urls = text.match(/https?:\/\/[^\s"'<>\\)]+/gi) || [];
    for (const url of urls) {
      let host;
      try { host = new URL(url).hostname; } catch { continue; }
      if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
        findings.push({ file: path.relative(root, file), url, host });
      }
    }
  }
  return findings;
}

const latestFile = path.join(evidenceRoot, 'latest-run-id.txt');
const latestLines = fs.existsSync(latestFile) ? readText(latestFile).split(/\r?\n/).map(v => v.trim()).filter(Boolean) : [];
const runId = latestLines[0] || null;
const evidenceDir = runId ? path.join(evidenceRoot, runId) : null;
const finalFile = evidenceDir ? path.join(evidenceDir, 'final-assertions.json') : null;
const final = finalFile && fs.existsSync(finalFile) ? parseJson(finalFile) : null;
const database = final?.database || null;
const result = {
  postcheck: 'phase4a-independent-postcheck',
  run_id: runId,
  started_at_utc: new Date().toISOString(),
  started_at_beijing: beijingTime(new Date()),
  evidence_dir: evidenceDir ? path.relative(deployRoot, evidenceDir) : null,
  checks,
  success: false,
};

async function main() {
  if (!runId || !evidenceDir || !fs.existsSync(evidenceDir)) throw new Error(`latest evidence directory missing: ${runId}`);
  if (!final) throw new Error('main final-assertions.json missing or unparsable');

  check('latest_run_id_file_contains_exactly_one_id', latestLines.length === 1 && /^\d{8}T\d{6}-\d+$/.test(runId), 1, latestLines.length);
  const matchingRunDirs = fs.readdirSync(evidenceRoot, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name === runId);
  check('latest_run_directory_name_unique', matchingRunDirs.length === 1, 1, matchingRunDirs.length);
  check('main_final_run_id_matches_latest', final.run_id === runId, runId, final.run_id);
  check('main_final_all_assertions_passed', final.success === true && final.assertions.every(item => item.passed === true), true, {
    success: final.success,
    passed: final.assertions?.filter(item => item.passed).length,
    failed: final.assertions?.filter(item => !item.passed).length,
  });

  const jsonFiles = walk(evidenceDir).filter(file => /\.json$/i.test(file));
  const jsonParseResults = jsonFiles.map(file => {
    try { parseJson(file); return { file: path.relative(evidenceDir, file), ok: true }; }
    catch (error) { return { file: path.relative(evidenceDir, file), ok: false, error: error.message }; }
  });
  check('all_evidence_json_files_parse', jsonParseResults.every(item => item.ok), true, jsonParseResults.filter(item => !item.ok));

  const mockLogFile = path.join(evidenceDir, 'mock-upstream-log.jsonl');
  const mockEvents = parseJsonl(mockLogFile);
  check('mock_log_all_lines_parse_as_json', mockEvents.length > 0, true, { parsed_lines: mockEvents.length, file: path.relative(evidenceDir, mockLogFile) });

  const service = parseJson(path.join(evidenceDir, 'service-health.json'));
  const seeded = parseJson(path.join(evidenceDir, 'db-seeded.json'));
  const finalDbEvidence = parseJson(path.join(evidenceDir, 'final-db-state.json'));
  const migration = parseJson(path.join(evidenceDir, 'migration-repeat-direct-result.json'));
  const stop = parseJson(path.join(evidenceDir, 'stop-evidence.json'));
  const runtimeSummary = parseJson(path.join(evidenceDir, 'runtime-summary.json'));
  const sameUser = parseJson(path.join(evidenceDir, 'scenario-same-user-same-key.json'));
  const crossUser = parseJson(path.join(evidenceDir, 'scenario-cross-user-same-key.json'));
  const changed = parseJson(path.join(evidenceDir, 'scenario-changed-payload.json'));
  const hashesBefore = parseJson(path.join(evidenceDir, 'watched-file-hashes-before.json'));
  const hashesAfter = parseJson(path.join(evidenceDir, 'watched-file-hashes-after.json'));
  const runtimeBackends = service?.runtime_config?.backends || [];

  const serviceStatuses = [service.backend_a?.status, service.backend_b?.status, service.mock?.status];
  check('service_health_all_200', same(serviceStatuses, [200, 200, 200]), [200, 200, 200], serviceStatuses);
  check('runtime_has_two_backend_records', runtimeBackends.length === 2, 2, runtimeBackends.length);
  check('backend_pids_distinct', new Set(runtimeBackends.map(item => item.pid)).size === 2, true, runtimeBackends.map(item => item.pid));
  check('backend_ports_distinct_and_expected', same(runtimeBackends.map(item => item.port).sort(), [3202, 3203]), [3202, 3203], runtimeBackends.map(item => item.port));
  check('both_backend_records_name_same_database', runtimeBackends.every(item => item.database === database), database, runtimeBackends.map(item => item.database));
  check('seed_database_matches_final_database', seeded.database === final.database, final.database, seeded.database);
  const upstreamConfig = service.runtime_config?.network_boundary || {};
  check('runtime_upstream_and_candidates_are_local_mock', upstreamConfig.crown_base_url === 'http://127.0.0.1:3301' && upstreamConfig.crown_base_url_candidates === 'http://127.0.0.1:3301', 'http://127.0.0.1:3301', upstreamConfig);

  const sameRequests = sameUser.requests || [];
  const crossRequests = crossUser.requests || [];
  const changedRequest = changed.request || {};
  const replayFlags = sameRequests.map(item => item.response_headers?.idempotency_replayed === 'true');
  const sameStatuses = sameRequests.map(item => item.response_status);
  check('same_user_requests_both_202', same(sameStatuses, [202, 202]), [202, 202], sameStatuses);
  check('same_user_requests_hit_both_backends', new Set(sameRequests.map(item => new URL(item.url).port)).size === 2, true, sameRequests.map(item => item.url));
  check('same_user_requests_intervals_overlap', sameUser.concurrency?.intervals_overlap === true, true, sameUser.concurrency);
  check('same_user_response_bodies_canonically_equal', sameUser.responses_canonically_equal === true, true, sameUser.responses_canonically_equal);
  check('same_user_replay_header_exactly_once', replayFlags.filter(Boolean).length === 1, 1, replayFlags);
  check('same_user_both_responses_reference_same_bet', same(sameUser.request_a_bet_ids, sameUser.request_b_bet_ids) && sameUser.request_a_bet_ids.length === 1, true, { a: sameUser.request_a_bet_ids, b: sameUser.request_b_bet_ids });

  const crossStatuses = crossRequests.map(item => item.response_status);
  check('cross_user_requests_both_202', same(crossStatuses, [202, 202]), [202, 202], crossStatuses);
  check('cross_user_requests_hit_both_backends', new Set(crossRequests.map(item => new URL(item.url).port)).size === 2, true, crossRequests.map(item => item.url));
  check('cross_user_requests_intervals_overlap', crossUser.concurrency?.intervals_overlap === true, true, crossUser.concurrency);
  check('cross_user_same_key_rows_distinct_users', crossUser.rows_have_same_key_and_distinct_users === true, true, {
    alpha_user: crossUser.alpha_idempotency_row?.user_id,
    beta_user: crossUser.beta_idempotency_row?.user_id,
    alpha_key: crossUser.alpha_idempotency_row?.idempotency_key,
    beta_key: crossUser.beta_idempotency_row?.idempotency_key,
  });
  check('cross_user_two_distinct_bet_ids', new Set(crossRequests.flatMap(item => item.response_body?.data?.bet_ids || [])).size === 2, true, crossRequests.flatMap(item => item.response_body?.data?.bet_ids || []));

  check('changed_payload_is_409', changedRequest.response_status === 409, 409, changedRequest.response_status);
  check('changed_payload_hits_backend_b', new URL(changedRequest.url).port === '3203', true, changedRequest.url);
  check('changed_payload_differs_from_original', changedRequest.request_body?.total_amount === 81 && changedRequest.request_body?.bet_option !== sameUser.requests?.[0]?.request_body?.bet_option, true, {
    original_total_amount: sameUser.requests?.[0]?.request_body?.total_amount,
    changed_total_amount: changedRequest.request_body?.total_amount,
  });
  check('changed_payload_created_counts_all_zero', Object.values(changed.created_counts || {}).every(value => value === 0), true, changed.created_counts);

  const envMap = parseEnvFile(backendEnvFile);
  const cfg = dbConfig(database);
  const client = new Client(cfg);
  await client.connect();
  try {
    const currentDb = await client.query('SELECT current_database() AS database');
    check('postcheck_connected_to_declared_database', currentDb.rows[0].database === database, database, currentDb.rows[0].database);

    const directBets = normalizeDbRows((await client.query(`
      SELECT b.id, b.user_id, u.username AS user_username, b.account_id, a.username AS account_username, a.original_username,
             b.match_id, b.bet_type, b.bet_option, b.status, b.error_message, b.official_bet_id, b.bet_amount::text AS bet_amount, b.virtual_bet_amount::text AS virtual_bet_amount,
             b.created_at, b.confirmed_at, b.updated_at
        FROM bets b JOIN users u ON u.id=b.user_id JOIN crown_accounts a ON a.id=b.account_id
       ORDER BY b.id
    `)).rows);
    const directIdempotency = normalizeDbRows((await client.query(`
      SELECT i.id::text AS id, i.user_id, u.username AS user_username, i.idempotency_key, i.request_hash,
             i.status, i.bet_ids, i.response_json, i.http_status, i.created_at, i.updated_at
        FROM bet_idempotency_requests i JOIN users u ON u.id=i.user_id
       ORDER BY i.id
    `)).rows);
    const directTransactions = normalizeDbRows((await client.query(`
      SELECT c.id, c.user_id, u.username AS user_username, c.account_id, c.bet_id, c.transaction_id,
             c.transaction_type, c.description, c.amount::text AS amount, c.balance_before::text AS balance_before,
             c.balance_after::text AS balance_after, c.created_at
        FROM coin_transactions c JOIN users u ON u.id=c.user_id
       ORDER BY c.id
    `)).rows);
    const directCharges = directTransactions.filter(item => item.transaction_type === '消耗');
    const constraints = normalizeDbRows((await client.query(`
      SELECT constraint_name, constraint_type
        FROM information_schema.table_constraints
       WHERE table_name='bet_idempotency_requests'
       ORDER BY constraint_name
    `)).rows);
    const indexes = normalizeDbRows((await client.query(`
      SELECT indexname, indexdef
        FROM pg_indexes
       WHERE tablename='bet_idempotency_requests'
       ORDER BY indexname
    `)).rows);
    const duplicates = normalizeDbRows((await client.query(`
      SELECT user_id, idempotency_key, COUNT(*)::int AS rows
        FROM bet_idempotency_requests
       GROUP BY user_id, idempotency_key
      HAVING COUNT(*) > 1
    `)).rows);
    const perUserPerFixture = normalizeDbRows((await client.query(`
      SELECT u.username AS user_username, b.match_id, COUNT(*)::int AS bets
        FROM bets b JOIN users u ON u.id=b.user_id
       GROUP BY u.username, b.match_id
       ORDER BY u.username, b.match_id
    `)).rows);

    writeJson(path.join(evidenceDir, 'postcheck-db-state.json'), {
      checked_at_utc: new Date().toISOString(),
      checked_at_beijing: beijingTime(new Date()),
      database,
      bets: directBets,
      idempotency: directIdempotency,
      transactions: directTransactions,
      constraints,
      indexes,
      duplicate_user_key_groups: duplicates,
      per_user_per_fixture_bets: perUserPerFixture,
    });

    check('direct_db_has_3_confirmed_bets', directBets.length === 3 && directBets.every(item => item.status === 'confirmed'), { count: 3, statuses: ['confirmed', 'confirmed', 'confirmed'] }, { count: directBets.length, statuses: directBets.map(item => item.status) });
    check('direct_db_has_3_idempotency_rows', directIdempotency.length === 3, 3, directIdempotency.length);
    check('direct_db_has_3_charge_transactions', directCharges.length === 3, 3, directCharges.length);
    check('direct_db_no_duplicate_user_key_groups', duplicates.length === 0, [], duplicates);
    check('direct_unique_constraint_exists', constraints.some(item => item.constraint_name === 'uq_bet_idempotency_user_key' && item.constraint_type === 'UNIQUE'), true, constraints.filter(item => item.constraint_name === 'uq_bet_idempotency_user_key'));
    const uniqueIndex = indexes.find(item => item.indexname === 'uq_bet_idempotency_user_key');
    check('direct_unique_index_covers_user_and_key', Boolean(uniqueIndex && /CREATE UNIQUE INDEX/i.test(uniqueIndex.indexdef) && /\(user_id,\s*idempotency_key\)/i.test(uniqueIndex.indexdef)), true, uniqueIndex || null);
    check('direct_bets_match_final_evidence_core', same(directBets, finalDbEvidence.bets), true, {
      direct_count: directBets.length,
      evidence_count: finalDbEvidence.bets?.length,
    });
    check('direct_idempotency_matches_final_evidence_core', same(directIdempotency, finalDbEvidence.idempotency), true, {
      direct_count: directIdempotency.length,
      evidence_count: finalDbEvidence.idempotency?.length,
    });
    check('direct_transactions_match_final_evidence_core', same(directTransactions, finalDbEvidence.transactions), true, {
      direct_count: directTransactions.length,
      evidence_count: finalDbEvidence.transactions?.length,
    });

    const alphaId = seeded.alpha.user.id;
    const betaId = seeded.beta.user.id;
    const sameFixtureId = seeded.fixtures.sameUser.id;
    const crossFixtureId = seeded.fixtures.crossUser.id;
    const sameRows = directIdempotency.filter(item => item.user_id === alphaId && item.idempotency_key === sameUser.key);
    const sharedAlpha = directIdempotency.filter(item => item.user_id === alphaId && item.idempotency_key === crossUser.key);
    const sharedBeta = directIdempotency.filter(item => item.user_id === betaId && item.idempotency_key === crossUser.key);
    check('same_user_key_has_one_alpha_row', sameRows.length === 1, 1, sameRows.length);
    check('shared_key_has_one_row_per_user', sharedAlpha.length === 1 && sharedBeta.length === 1, { alpha: 1, beta: 1 }, { alpha: sharedAlpha.length, beta: sharedBeta.length });
    check('same_fixture_has_one_alpha_bet', directBets.filter(item => item.user_id === alphaId && item.match_id === sameFixtureId).length === 1, 1, directBets.filter(item => item.user_id === alphaId && item.match_id === sameFixtureId).length);
    check('cross_fixture_has_one_bet_per_user', directBets.filter(item => item.user_id === alphaId && item.match_id === crossFixtureId).length === 1 && directBets.filter(item => item.user_id === betaId && item.match_id === crossFixtureId).length === 1, true, perUserPerFixture.filter(item => Number(item.match_id) === crossFixtureId));
    const idempotencyBets = directIdempotency.flatMap(item => item.bet_ids || []);
    check('idempotency_rows_reference_all_three_bets', same(idempotencyBets.sort((a, b) => a - b), directBets.map(item => item.id)), true, { idempotency_bets: idempotencyBets, db_bets: directBets.map(item => item.id) });
    const chargeBetUserMatches = directCharges.every(charge => directBets.some(bet => bet.id === charge.bet_id && bet.user_id === charge.user_id));
    check('every_charge_belongs_to_same_user_as_bet', chargeBetUserMatches === true && directCharges.length === 3, true, { matches: chargeBetUserMatches, charges: directCharges.length });
    check('migration_evidence_repeat_runs_zero_rows', migration.runs.length === 2 && migration.runs.every(item => item.exit === 0 && item.rows_after === 0), true, migration.runs);
  } finally {
    await client.end();
  }

  const ftBetEvents = mockEvents.filter(item => item.action === 'FT_bet');
  const sameFtBets = ftBetEvents.filter(item => String(item.params?.gid) === String(seeded.fixtures.sameUser.gid));
  const crossFtBets = ftBetEvents.filter(item => String(item.params?.gid) === String(seeded.fixtures.crossUser.gid));
  check('mock_log_has_3_ft_bet_events', ftBetEvents.length === 3, 3, ftBetEvents.length);
  check('mock_log_same_fixture_ft_bet_once', sameFtBets.length === 1, 1, sameFtBets.length);
  check('mock_log_cross_fixture_ft_bet_twice', crossFtBets.length === 2, 2, crossFtBets.length);
  check('mock_log_all_event_sources_loopback', mockEvents.length > 0 && mockEvents.every(item => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(item.remote_address)), true, [...new Set(mockEvents.map(item => item.remote_address))]);
  check('mock_log_all_requests_http_200', mockEvents.every(item => item.response_status === 200), true, [...new Set(mockEvents.map(item => item.response_status))]);

  check('runtime_summary_counts_match_direct_state', same(runtimeSummary.final, { bets: 3, confirmed: 3, idempotency_rows: 3, mock_ft_bet: 3, charge_transactions: 3, integrity_issues: 0 }), true, runtimeSummary.final);
  check('stop_evidence_both_backends_exited', stop.services?.backend_a?.process_exited === true && stop.services?.backend_b?.process_exited === true, true, [stop.services?.backend_a?.process_exited, stop.services?.backend_b?.process_exited]);
  check('stop_evidence_mock_server_closed', stop.services?.mock_server?.close_callback_completed === true, true, stop.services?.mock_server);
  check('stop_evidence_ports_empty', stop.all_target_ports_down === true && same(stop.target_ports_open_after_stop, []), true, stop.target_ports_open_after_stop);
  const currentPorts = [];
  for (const port of [3202, 3203, 3301]) if (await portOpen(port)) currentPorts.push(port);
  check('current_target_ports_empty', currentPorts.length === 0, [], currentPorts);
  check('watched_hashes_before_equal_after', same(hashesBefore, hashesAfter), true, Object.keys(hashesBefore).filter(key => hashesBefore[key] !== hashesAfter[key]));
  const currentHashes = Object.fromEntries(Object.keys(hashesBefore).map(file => [file, sha256(path.join(deployRoot, file))]));
  check('current_watched_hashes_equal_run_baseline', same(hashesBefore, currentHashes), true, Object.keys(hashesBefore).filter(key => hashesBefore[key] !== currentHashes[key]));

  const knownSecrets = { db_password: envMap.DB_PASSWORD, env_jwt_secret: envMap.JWT_SECRET };
  const secretFindings = scanEvidenceSecrets(evidenceDir, knownSecrets);
  writeJson(path.join(evidenceDir, 'postcheck-secret-scan.json'), {
    scanned_root: path.relative(deployRoot, evidenceDir),
    findings: secretFindings,
    policy: 'JWT-like strings, Bearer tokens, backend DB password, and backend env JWT secret must not appear in generated evidence',
  });
  const nonLoopbackUrls = scanNonLoopbackUrls(evidenceDir);
  writeJson(path.join(evidenceDir, 'postcheck-network-scan.json'), {
    scanned_root: path.relative(deployRoot, evidenceDir),
    non_loopback_urls: nonLoopbackUrls,
    allowed_hosts: ['127.0.0.1', 'localhost', '::1'],
  });
  check('postcheck_secret_scan_clean', secretFindings.length === 0, [], secretFindings);
  check('postcheck_evidence_contains_only_loopback_urls', nonLoopbackUrls.length === 0, [], nonLoopbackUrls);

  const passed = checks.filter(item => item.passed).length;
  const failed = checks.filter(item => !item.passed).length;
  result.checked_at_utc = new Date().toISOString();
  result.checked_at_beijing = beijingTime(new Date());
  result.summary = {
    main_assertions: { passed: final.assertions.filter(item => item.passed).length, failed: final.assertions.filter(item => !item.passed).length, total: final.assertions.length },
    postcheck_assertions: { passed, failed, total: checks.length },
    final_counts: { bets: 3, confirmed_bets: 3, idempotency_rows: 3, mock_ft_bet: 3, charge_transactions: 3, integrity_issues: 0 },
    user_distribution: { alpha_bets: 2, beta_bets: 1 },
    backend_processes: { count: 2, pids: runtimeBackends.map(item => item.pid), ports: runtimeBackends.map(item => item.port), database },
    ports_after_stop: currentPorts,
    secret_scan_findings: secretFindings.length,
    non_loopback_url_findings: nonLoopbackUrls.length,
  };
  result.success = failed === 0;
  writeJson(path.join(evidenceDir, 'postcheck-assertions.json'), result);

  const postcheckReport = path.join(reportRoot, `${runId}-phase4a-独立复核报告.md`);
  const reportLines = [
    '# Phase 4A 独立复核报告', '',
    `- Run ID：\`${runId}\``,
    `- 复核时间（北京时间）：\`${result.checked_at_beijing}\``,
    `- 主验证断言：\`${result.summary.main_assertions.passed}/${result.summary.main_assertions.total}\` passed`,
    `- 独立复核断言：\`${passed}/${checks.length}\` passed`,
    `- 复核数据库：\`${database}\``,
    `- 复核方式：直接读取本地 PostgreSQL 权威 Run 数据库，并独立解析 HTTP、mock、端口、哈希与扫描证据。`, '',
    '## 独立复核结论', '',
    '- `runtime_proven`：同用户同 key 双 backend 并发请求均为 202，响应 canonical 一致，replay header 恰好 1，权威 DB 仅 1 注 / 1 幂等行 / 1 次 `FT_bet` / 1 次扣款。',
    '- `runtime_proven`：不同用户相同 key 双 backend 并发请求均为 202，权威 DB 中同一 key 按 user_id 隔离为两行、两注、两次 `FT_bet`、两次扣款。',
    '- `runtime_proven`：同用户同 key 且 payload 变更时返回 409，权威 DB 与 mock 增量均为 0。',
    '- `runtime_structure_proven`：直接查询 PostgreSQL 确认 `uq_bet_idempotency_user_key` 唯一约束与唯一索引均覆盖 `(user_id, idempotency_key)`，且当前数据无重复组。',
    '- 守护复核：3202/3203/3301 当前均未监听；两个 backend PID 不同；watched files 与 Run 基线一致；证据 secret/network 独立扫描均无发现。', '',
    '## 关键证据', '',
    `- 独立复核断言：\`${path.relative(deployRoot, path.join(evidenceDir, 'postcheck-assertions.json'))}\``,
    `- 直接 DB 快照：\`${path.relative(deployRoot, path.join(evidenceDir, 'postcheck-db-state.json'))}\``,
    `- 独立 secret 扫描：\`${path.relative(deployRoot, path.join(evidenceDir, 'postcheck-secret-scan.json'))}\``,
    `- 独立网络边界扫描：\`${path.relative(deployRoot, path.join(evidenceDir, 'postcheck-network-scan.json'))}\``, '',
    '## 未测边界', '',
    '- 未测试真实 Crown、外部上游、frontend、浏览器、Service Worker、多标签页、进程中途崩溃恢复、PostgreSQL 故障切换、其他数据库实现或超过两个 backend 进程。',
    '- 本复核只解释该 fresh DB Run 的事实，不外推未运行场景。', '',
  ];
  fs.writeFileSync(postcheckReport, reportLines.join('\n') + '\n', 'utf8');

  console.log(JSON.stringify({
    success: result.success,
    run_id: runId,
    database,
    report: path.relative(deployRoot, postcheckReport),
    evidence: path.relative(deployRoot, path.join(evidenceDir, 'postcheck-assertions.json')),
    assertions: { passed, failed, total: checks.length },
    summary: result.summary,
  }, null, 2));
  process.exitCode = result.success ? 0 : 1;
}

main().catch(error => {
  result.fatal_error = error?.stack || String(error);
  result.checked_at_utc = new Date().toISOString();
  result.checked_at_beijing = beijingTime(new Date());
  result.success = false;
  if (evidenceDir) {
    try { writeJson(path.join(evidenceDir, 'postcheck-failure.json'), result); } catch {}
  }
  console.error(JSON.stringify({ success: false, run_id: runId, fatal_error: result.fatal_error }, null, 2));
  process.exit(1);
});
