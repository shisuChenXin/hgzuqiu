'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createRequire } = require('module');

const deployRoot = path.resolve(__dirname, '..');
const mainRepo = path.resolve(deployRoot, '..', 'hgzuqiu');
const backendEnvFile = fs.existsSync(path.join(deployRoot, 'backend', '.env')) ? path.join(deployRoot, 'backend', '.env') : path.join(mainRepo, 'backend', '.env');
const backendRequire = createRequire(path.join(__dirname, '..', 'backend', 'package.json'));
const { Client } = backendRequire('pg');
const evidenceRoot = path.join(deployRoot, '证据', 'phase3f02-idempotency-fix');
const reportRoot = path.join(deployRoot, '报告');
const startedAt = new Date();
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
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function same(left, right) { return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right)); }
function readText(file) { return fs.readFileSync(file, 'utf8'); }
function parseJson(file) { return JSON.parse(readText(file)); }
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

const latestFile = path.join(evidenceRoot, 'latest-run-id.txt');
const latestLines = fs.existsSync(latestFile) ? readText(latestFile).split(/\r?\n/).map(v => v.trim()).filter(Boolean) : [];
const runId = latestLines[0] || null;
const evidenceDir = runId ? path.join(evidenceRoot, runId) : null;
const finalPath = evidenceDir ? path.join(evidenceDir, 'final-assertions.json') : null;
const final = finalPath && fs.existsSync(finalPath) ? parseJson(finalPath) : null;
const mainReportRel = final?.report_file || null;
const mainReportFile = mainReportRel ? path.join(deployRoot, mainReportRel) : null;
const mainReport = mainReportFile && fs.existsSync(mainReportFile) ? readText(mainReportFile) : '';
const result = {
  postcheck: 'phase3f02-independent-postcheck',
  run_id: runId,
  started_at_utc: startedAt.toISOString(),
  started_at_beijing: beijingTime(startedAt),
  main_report: mainReportRel,
  evidence_dir: evidenceDir ? path.relative(deployRoot, evidenceDir) : null,
  checks: [],
  summary: {},
  success: false,
};

async function main() {
  if (!runId || !evidenceDir || !fs.existsSync(evidenceDir)) throw new Error(`latest evidence directory missing: ${runId}`);
  if (!final) throw new Error('final assertions missing or unparsable');
  const load = name => parseJson(path.join(evidenceDir, name));

  check('latest_run_id_file_contains_exactly_one_id', latestLines.length === 1 && /^[0-9T-]+-\d+$/.test(runId), 1, latestLines.length);
  const runDirectories = fs.readdirSync(evidenceRoot, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name === runId);
  check('latest_run_directory_name_unique', runDirectories.length === 1, 1, runDirectories.length);
  const jsonFiles = walk(evidenceDir).filter(file => /\.json$/i.test(file));
  const parseResults = jsonFiles.map(file => {
    try { parseJson(file); return { file: path.relative(evidenceDir, file), ok: true }; }
    catch (error) { return { file: path.relative(evidenceDir, file), ok: false, error: error.message }; }
  });
  check('all_evidence_json_files_parse_before_postcheck', parseResults.every(item => item.ok), parseResults.length,
    { total: parseResults.length, failed: parseResults.filter(item => !item.ok) });
  check('final_assertions_run_id_matches_latest', final.run_id === runId, runId, final.run_id);
  const passedCount = final.assertions.filter(item => item.passed === true).length;
  const failedCount = final.assertions.filter(item => item.passed !== true).length;
  check('main_final_assertions_37_of_37_passed', final.success === true && final.fatal_errors.length === 0 &&
    passedCount === 37 && failedCount === 0 && final.assertions.length === 37,
    { success: true, passed: 37, failed: 0, total: 37 },
    { success: final.success, fatal_errors: final.fatal_errors, passed: passedCount, failed: failedCount, total: final.assertions.length });

  const legacy = load('scenario-legacy-no-key.json');
  const concurrentSummaryFile = load('scenario-concurrent-summary.json');
  const concurrentTrials = Array.from({ length: 10 }, (_, index) => load(`scenario-concurrent-${String(index + 1).padStart(2, '0')}.json`));
  const sequential = load('scenario-sequential-replay-confirmed.json');
  const differentKey = load('scenario-different-key.json');
  const differentPayload = load('scenario-same-key-different-payload.json');
  const preCancelled = load('scenario-pre-cancelled-replay.json');
  const dryRun = load('scenario-dry-run.json');
  const headerBody = load('scenario-header-body-key.json');
  const earlyFailure = load('scenario-early-failure-replay.json');
  const responseSnapshots = load('response-snapshot-checks.json');

  check('legacy_scenario_evidence_consistent', legacy.request.response_status === 202 &&
    same(legacy.created_counts, { bets: 1, ft_bet: 1, transactions: 1, idempotency: 0 }),
    { status: 202, counts: { bets: 1, ft_bet: 1, transactions: 1, idempotency: 0 } },
    { status: legacy.request.response_status, counts: legacy.created_counts });
  check('concurrent_scenario_files_and_summary_consistent',
    concurrentTrials.length === 10 &&
    concurrentTrials.every((trial, index) => trial.trial_index === index + 1 && trial.request_timing.client_observed_overlap === true &&
      JSON.stringify(trial.request_statuses) === JSON.stringify([202, 202]) && trial.response_bodies_canonically_equal === true &&
      trial.created_counts.bets === 1 && trial.created_counts.ft_bet === 1 && trial.created_counts.transactions === 1 && trial.created_counts.idempotency === 1),
    { trials: 10, overlap: 10, statuses: [202, 202], counts: [1, 1, 1, 1] },
    concurrentTrials.map(trial => ({ index: trial.trial_index, overlap: trial.request_timing.client_observed_overlap, statuses: trial.request_statuses,
      equal: trial.response_bodies_canonically_equal, counts: trial.created_counts })));
  check('sequential_replay_scenario_evidence_consistent', sequential.request.response_status === 202 &&
    String(sequential.request.response_headers.idempotency_replayed).toLowerCase() === 'true' &&
    same(sequential.original_bet_ids, sequential.replay_bet_ids) && Object.values(sequential.created_counts).every(v => v === 0),
    { status: 202, replay: true, side_effects: 0 },
    { status: sequential.request.response_status, header: sequential.request.response_headers.idempotency_replayed,
      original: sequential.original_bet_ids, replay: sequential.replay_bet_ids, counts: sequential.created_counts });
  check('different_key_and_payload_scenarios_consistent',
    differentKey.first.response_status === 202 && differentKey.second.response_status === 202 &&
    differentKey.first_bet_ids[0] !== differentKey.second_bet_ids[0] &&
    differentPayload.first.response_status === 202 && differentPayload.second.response_status === 409 &&
    Object.values(differentPayload.second_created_counts).every(v => v === 0),
    { different_key: [202, 202], same_key_changed_payload: [202, 409] },
    { different_key: [differentKey.first.response_status, differentKey.second.response_status],
      same_key_changed_payload: [differentPayload.first.response_status, differentPayload.second.response_status],
      second_created_counts: differentPayload.second_created_counts });
  check('pre_cancelled_dry_run_header_body_early_failure_evidence_consistent',
    preCancelled.first.response_status === 202 && preCancelled.after.bets[0].status === 'cancelled' &&
    dryRun.request.response_status === 200 && dryRun.idempotency_row === null &&
    headerBody.mismatch.response_status === 400 && headerBody.invalid.response_status === 400 &&
    headerBody.header_only.response_status === 202 && headerBody.body_only_replay.response_status === 202 &&
    earlyFailure.first.response_status === 400 && earlyFailure.replay.response_status === 400 &&
    earlyFailure.changed.response_status === 409 && earlyFailure.first_replay_responses_canonically_equal === true,
    { pre_cancelled: 202, dry_run: 200, mismatch: 400, invalid: 400, header_replay: [202, 202], early: [400, 400, 409] },
    { pre_cancelled: preCancelled.first.response_status, db_status: preCancelled.after.bets[0].status, dry_run: dryRun.request.response_status,
      mismatch: headerBody.mismatch.response_status, invalid: headerBody.invalid.response_status,
      header_replay: [headerBody.header_only.response_status, headerBody.body_only_replay.response_status],
      early: [earlyFailure.first.response_status, earlyFailure.replay.response_status, earlyFailure.changed.response_status],
      early_equal: earlyFailure.first_replay_responses_canonically_equal });

  const client = new Client(dbConfig(final.database));
  await client.connect();
  let dbBets;
  let dbIdempotency;
  let dbTransactions;
  let dbIntegrity;
  let constraints;
  let indexes;
  try {
    dbBets = (await client.query(`
      SELECT b.id, b.user_id, b.account_id, b.match_id, b.status, b.error_message, b.official_bet_id, b.created_at
      FROM bets b ORDER BY b.match_id, b.id
    `)).rows;
    dbIdempotency = (await client.query(`
      SELECT id::text AS id, user_id, idempotency_key, request_hash, status, bet_ids, response_json, http_status, created_at, updated_at
      FROM bet_idempotency_requests ORDER BY id
    `)).rows;
    dbTransactions = (await client.query(`
      SELECT id, user_id, account_id, bet_id, transaction_id, transaction_type, amount::text AS amount, created_at
      FROM coin_transactions ORDER BY id
    `)).rows;
    dbIntegrity = (await client.query(`
      SELECT 'missing_transaction_for_active_bet' AS issue, b.id AS bet_id
        FROM bets b
       WHERE b.status <> 'cancelled'
         AND NOT EXISTS (SELECT 1 FROM coin_transactions t WHERE t.bet_id=b.id AND t.transaction_type='消耗')
      UNION ALL
      SELECT 'charge_transaction_without_active_bet' AS issue, t.bet_id
        FROM coin_transactions t LEFT JOIN bets b ON b.id=t.bet_id
       WHERE t.transaction_type='消耗' AND (b.id IS NULL OR b.status='cancelled')
      ORDER BY issue, bet_id
    `)).rows;
    constraints = (await client.query(`
      SELECT constraint_name, constraint_type FROM information_schema.table_constraints
       WHERE table_name='bet_idempotency_requests' ORDER BY constraint_name
    `)).rows;
    indexes = (await client.query(`
      SELECT indexname, indexdef FROM pg_indexes WHERE tablename='bet_idempotency_requests' ORDER BY indexname
    `)).rows;
  } finally { await client.end(); }

  const statusCounts = dbBets.reduce((accumulator, row) => { accumulator[row.status] = (accumulator[row.status] || 0) + 1; return accumulator; }, {});
  check('direct_db_bet_counts_and_statuses', dbBets.length === 16 && statusCounts.confirmed === 15 && statusCounts.cancelled === 1,
    { total: 16, confirmed: 15, cancelled: 1 }, { total: dbBets.length, ...statusCounts });
  const matchCounts = {};
  for (const bet of dbBets) matchCounts[bet.match_id] = (matchCounts[bet.match_id] || 0) + 1;
  const expectedMatchCounts = { 930001: 1, 930002: 2, 930003: 1, 930004: 1, 930006: 1,
    ...Object.fromEntries(Array.from({ length: 10 }, (_, index) => [931000 + index, 1])) };
  check('direct_db_bets_grouped_by_fixture', same(matchCounts, expectedMatchCounts), expectedMatchCounts, matchCounts);
  const idempotencyStatusCounts = dbIdempotency.reduce((accumulator, row) => { accumulator[row.status] = (accumulator[row.status] || 0) + 1; return accumulator; }, {});
  check('direct_db_idempotency_counts', dbIdempotency.length === 16 && idempotencyStatusCounts.created === 15 && idempotencyStatusCounts.failed === 1,
    { total: 16, created: 15, failed: 1 }, { total: dbIdempotency.length, ...idempotencyStatusCounts });
  check('direct_db_user_key_pairs_unique', new Set(dbIdempotency.map(row => `${row.user_id}:${row.idempotency_key}`)).size === dbIdempotency.length,
    dbIdempotency.length, new Set(dbIdempotency.map(row => `${row.user_id}:${row.idempotency_key}`)).size);
  const chargeTransactions = dbTransactions.filter(row => row.transaction_type === '消耗');
  check('direct_db_transaction_counts_and_integrity', chargeTransactions.length === 15 && dbIntegrity.length === 0 &&
    new Set(chargeTransactions.map(row => row.transaction_id)).size === chargeTransactions.length,
    { charges: 15, integrity_issues: 0, unique_transaction_ids: 15 },
    { charges: chargeTransactions.length, integrity_issues: dbIntegrity, unique_transaction_ids: new Set(chargeTransactions.map(row => row.transaction_id)).size });

  const idempotencyByKey = new Map(dbIdempotency.map(row => [row.idempotency_key, row]));
  const createdCases = [
    ...concurrentTrials.map(item => ({
      key: item.payload.idempotency_key,
      request: item.requests[0],
      ids: item.unique_request_bet_ids,
    })),
    {
      key: differentKey.first_payload.idempotency_key,
      request: differentKey.first,
      ids: differentKey.first_bet_ids,
    },
    {
      key: differentKey.second_payload.idempotency_key,
      request: differentKey.second,
      ids: differentKey.second_bet_ids,
    },
    {
      key: differentPayload.first_payload.idempotency_key,
      request: differentPayload.first,
      ids: differentPayload.first_bet_ids,
    },
    {
      key: preCancelled.payload.idempotency_key,
      request: preCancelled.first,
      ids: preCancelled.first_bet_ids,
    },
    {
      key: headerBody.key,
      request: headerBody.header_only,
      ids: headerBody.header_only_bet_ids,
    },
  ];
  const parseStoredJson = value => (typeof value === 'string' ? JSON.parse(value) : value);
  const directSnapshotResults = createdCases.map(item => {
    const row = idempotencyByKey.get(item.key);
    const responseJson = row ? parseStoredJson(row.response_json) : null;
    return {
      key: item.key,
      row_found: Boolean(row),
      status: row?.status || null,
      http_status: row?.http_status === undefined || row?.http_status === null ? null : Number(row.http_status),
      response_json_canonically_equal: Boolean(row && same(responseJson, item.request.response_body)),
      bet_ids_equal: Boolean(row && Array.isArray(row.bet_ids) && same(row.bet_ids, item.ids)),
      expected_ids: item.ids,
      actual_ids: row?.bet_ids || null,
    };
  });
  check('independent_direct_db_created_response_snapshots',
    createdCases.length === 15 && directSnapshotResults.length === 15 &&
      directSnapshotResults.every(item => item.row_found && item.status === 'created' && item.http_status === 202 &&
        item.response_json_canonically_equal && item.bet_ids_equal),
    { cases: 15, status: 'created', http_status: 202, canonical_equal: true, bet_ids_equal: true },
    directSnapshotResults);

  const failedRows = dbIdempotency.filter(row => row.idempotency_key === 'phase3f02-early-failure');
  const failedSnapshot = failedRows.map(row => ({
    status: row.status,
    http_status: row.http_status === undefined || row.http_status === null ? null : Number(row.http_status),
    bet_ids: row.bet_ids,
    equals_first: same(parseStoredJson(row.response_json), earlyFailure.first.response_body),
    equals_replay: same(parseStoredJson(row.response_json), earlyFailure.replay.response_body),
  }));
  check('independent_direct_db_early_failure_snapshot',
    failedRows.length === 1 && failedSnapshot[0]?.status === 'failed' && failedSnapshot[0]?.http_status === 400 &&
      failedSnapshot[0]?.bet_ids === null && failedSnapshot[0]?.equals_first === true && failedSnapshot[0]?.equals_replay === true,
    { rows: 1, status: 'failed', http_status: 400, bet_ids: null, equals_first: true, equals_replay: true },
    failedSnapshot);

  const betsById = new Map(dbBets.map(row => [Number(row.id), row]));
  const createdIdempotencyRows = dbIdempotency.filter(row => row.status === 'created');
  const createdRowBetDetails = createdIdempotencyRows.map(row => {
    const ids = Array.isArray(row.bet_ids) ? row.bet_ids.map(Number) : [];
    const missing = ids.filter(id => !betsById.has(id));
    const cancelled = ids.map(id => betsById.get(id)).filter(bet => bet && bet.status === 'cancelled').map(bet => bet.id);
    return { key: row.idempotency_key, ids, missing, cancelled };
  });
  const expectedPreCancelledRows = createdRowBetDetails.filter(item => item.key === 'phase3f02-pre-cancelled' && same(item.cancelled, [15]));
  const unexpectedCreatedRowBetIssues = createdRowBetDetails.filter(item =>
    item.ids.length !== 1 || item.missing.length > 0 ||
    (item.key !== 'phase3f02-pre-cancelled' && item.cancelled.length > 0));
  check('independent_direct_db_created_rows_reference_expected_bets',
    createdIdempotencyRows.length === 15 && expectedPreCancelledRows.length === 1 && unexpectedCreatedRowBetIssues.length === 0,
    { created_rows: 15, bet_ids_per_row: 1, missing: 0, expected_pre_cancelled: 1, unexpected_cancelled: 0 },
    { created_rows: createdIdempotencyRows.length, expected_pre_cancelled: expectedPreCancelledRows.length,
      issues: unexpectedCreatedRowBetIssues, pre_cancelled: createdRowBetDetails.find(item => item.key === 'phase3f02-pre-cancelled') || null });

  const mockEvidence = load('mock-events.json');
  const ftBetEvents = mockEvidence.ft_bet_events || [];
  const confirmedOfficialIds = dbBets.filter(row => row.status === 'confirmed' && row.official_bet_id).map(row => row.official_bet_id);
  const loopbackAddresses = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
  const mockTicketIds = ftBetEvents.map(event => event.ticket_id);
  const mockAddressIssues = ftBetEvents.filter(event => !loopbackAddresses.has(event.remote_address)).map(event => ({ ticket_id: event.ticket_id, remote_address: event.remote_address }));
  check('independent_mock_ft_bet_matches_confirmed_db_bets',
    ftBetEvents.length === 15 && new Set(mockTicketIds).size === 15 &&
      same(new Set(mockTicketIds), new Set(confirmedOfficialIds)) && mockAddressIssues.length === 0,
    { events: 15, unique_tickets: 15, equals_confirmed_official_ids: true, non_loopback_addresses: 0 },
    { events: ftBetEvents.length, unique_tickets: new Set(mockTicketIds).size,
      db_confirmed_official_ids: confirmedOfficialIds.length, ticket_set_equal: same(new Set(mockTicketIds), new Set(confirmedOfficialIds)),
      non_loopback_addresses: mockAddressIssues });

  const constraintNames = constraints.map(row => row.constraint_name);
  const indexNames = indexes.map(row => row.indexname);
  check('independent_direct_db_constraints_and_indexes',
    constraintNames.includes('uq_bet_idempotency_user_key') && constraintNames.includes('bet_idempotency_status_check') &&
      indexNames.includes('idx_bet_idempotency_user_created') && indexNames.includes('idx_bet_idempotency_status'),
    { constraints: ['uq_bet_idempotency_user_key', 'bet_idempotency_status_check'], indexes: ['idx_bet_idempotency_user_created', 'idx_bet_idempotency_status'] },
    { constraints: constraintNames, indexes: indexNames });

  const backendSource = readText(path.join(deployRoot, 'backend', 'src', 'routes', 'bets.ts'));
  const backendMarkers = {
    reserve_call: backendSource.indexOf('idempotencyReservation = await reserveBetIdempotency'),
    balance_check: backendSource.indexOf('检查金币余额是否足够'),
    transaction_begin: backendSource.indexOf("await insertClient.query('BEGIN')"),
    created_update: backendSource.search(/UPDATE\s+bet_idempotency_requests[\s\S]{0,200}?SET\s+status\s*=\s*'created'/),
    transaction_commit: backendSource.indexOf("await insertClient.query('COMMIT')"),
    process_job: backendSource.indexOf('processBetJob(jobParams)'),
  };
  const backendMarkerValues = Object.values(backendMarkers);
  check('independent_backend_source_order_and_conflict_clause',
    backendMarkerValues.every(index => index >= 0) &&
      backendMarkers.reserve_call < backendMarkers.balance_check &&
      backendMarkers.balance_check < backendMarkers.transaction_begin &&
      backendMarkers.transaction_begin < backendMarkers.created_update &&
      backendMarkers.created_update < backendMarkers.transaction_commit &&
      backendMarkers.transaction_commit < backendMarkers.process_job &&
      backendSource.includes('ON CONFLICT (user_id, idempotency_key) DO NOTHING'),
    {
      order: ['reserveBetIdempotency', 'balance_check', 'BEGIN', "UPDATE status='created'", 'COMMIT', 'processBetJob(jobParams)'],
      conflict_clause: true,
    },
    { markers: backendMarkers, conflict_clause: backendSource.includes('ON CONFLICT (user_id, idempotency_key) DO NOTHING') });

  const frontendSource = readText(path.join(deployRoot, 'frontend', 'src', 'components', 'Betting', 'BetFormModal.tsx'));
  check('independent_frontend_source_generates_key_per_submit',
    frontendSource.includes('const generateBetIdempotencyKey = (): string =>') &&
      frontendSource.includes('randomUUID') && frontendSource.includes('getRandomValues') &&
      frontendSource.includes('idempotency_key: generateBetIdempotencyKey(),'),
    ['generateBetIdempotencyKey', 'randomUUID', 'getRandomValues', 'idempotency_key: generateBetIdempotencyKey()'],
    {
      generate_function: frontendSource.includes('const generateBetIdempotencyKey = (): string =>'),
      randomUUID: frontendSource.includes('randomUUID'),
      getRandomValues: frontendSource.includes('getRandomValues'),
      submit_field: frontendSource.includes('idempotency_key: generateBetIdempotencyKey(),'),
    });

  const guardBefore = load('guard-db-before.json');
  const guardAfter = load('guard-db-after.json');
  check('independent_guard_db_evidence_unchanged',
    guardBefore.database === guardAfter.database && guardBefore.sha256 === guardAfter.sha256,
    { same_database: true, same_sha256: true },
    { before_database: guardBefore.database, after_database: guardAfter.database, before_sha256: guardBefore.sha256, after_sha256: guardAfter.sha256 });

  const watchedBefore = load('watched-file-hashes-before.json');
  const watchedAfter = load('watched-file-hashes-after.json');
  const currentWatchedHashes = Object.fromEntries(Object.keys(watchedBefore).map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(deployRoot, file))).digest('hex')]));
  check('independent_watched_file_hashes_before_after_current',
    same(watchedBefore, watchedAfter) && same(watchedBefore, currentWatchedHashes),
    { before_after_equal: true, before_current_equal: true, files: Object.keys(watchedBefore).length },
    { before_after_equal: same(watchedBefore, watchedAfter), before_current_equal: same(watchedBefore, currentWatchedHashes), files: Object.keys(watchedBefore).length,
      current_mismatches: Object.keys(watchedBefore).filter(file => watchedBefore[file] !== currentWatchedHashes[file]) });

  const jwtEvidence = load('jwt-scan.json');
  const jwtPattern = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
  const independentJwtMatches = [];
  for (const file of [...jsonFiles, mainReportFile]) {
    const text = readText(file);
    const found = text.match(jwtPattern) || [];
    for (const value of found) independentJwtMatches.push({ file: path.relative(evidenceDir, file), length: value.length });
  }
  check('independent_jwt_scan_evidence_and_main_report',
    jwtEvidence.matches.length === 0 && independentJwtMatches.length === 0,
    { runner_matches: 0, independent_matches: 0 },
    { runner_matches: jwtEvidence.matches, independent_matches: independentJwtMatches });

  const networkEvidence = load('network-boundary-scan.json');
  const allowedUrls = new Set(['https://dotenvx.com', 'https://dotenvx.com/radar', 'https://dotenvx.com/precommit', 'https://rollupjs.org/configuration-options/#output-manualchunks']);
  const networkAllowed = networkEvidence.allowed_static_banner_urls.every(item => allowedUrls.has(item.url));
  check('independent_network_boundary_evidence',
    networkEvidence.unallowed_non_loopback_urls.length === 0 && networkAllowed &&
      networkEvidence.non_loopback_urls.length === networkEvidence.allowed_static_banner_urls.length,
    { unallowed: [], allowed_only_static_banner: true },
    { unallowed: networkEvidence.unallowed_non_loopback_urls, allowed_only_static_banner: networkAllowed,
      non_loopback_count: networkEvidence.non_loopback_urls.length, allowed_count: networkEvidence.allowed_static_banner_urls.length });

  const serviceHealth = load('service-health.json');
  const serviceHosts = serviceHealth.network_boundary.all_service_hosts || [];
  check('independent_service_health_loopback_only',
    serviceHealth.backend.status === 200 && serviceHealth.mock.status === 200 &&
      serviceHosts.every(host => host === '127.0.0.1' || host === 'localhost' || host === '::1'),
    { backend: 200, mock: 200, hosts: ['127.0.0.1'] },
    { backend: serviceHealth.backend.status, mock: serviceHealth.mock.status, hosts: serviceHosts });

  const stopEvidence = load('stop-evidence.json');
  const targetPortsAfter = load('target-port-guard-after.json');
  check('independent_stop_and_port_guard_evidence',
    stopEvidence.all_target_ports_down === true && same(stopEvidence.target_ports_open_after_stop, []) &&
      same(targetPortsAfter.target_ports_open_after, []),
    { stop_ports: [], guard_after_ports: [] },
    { stop_ports: stopEvidence.target_ports_open_after_stop, guard_after_ports: targetPortsAfter.target_ports_open_after });

  const requiredReportFragments = [
    `Run ID：\`${runId}\``,
    `${passedCount}/${final.assertions.length}`,
    'bets=16',
    'FT_bet=15',
    '消耗流水=15',
    '幂等=16',
    'created=15',
    'failed=1',
    'PHASE3F02-CONTROLLED-DIFFERENT-KEY-FIXTURE',
    '直接 SQL',
    '不是产品自然路径',
  ];
  const missingReportFragments = requiredReportFragments.filter(fragment => !mainReport.includes(fragment));
  check('independent_main_report_consistency', missingReportFragments.length === 0, requiredReportFragments,
    { missing: missingReportFragments });

  result.summary = {
    run_id: runId,
    database: final.database,
    main_assertions: `${passedCount}/${final.assertions.length}`,
    direct_db: {
      bets: dbBets.length,
      bet_statuses: statusCounts,
      idempotency_rows: dbIdempotency.length,
      idempotency_statuses: idempotencyStatusCounts,
      charge_transactions: chargeTransactions.length,
      integrity_issues: dbIntegrity.length,
    },
    independent_snapshot_cases: directSnapshotResults.length,
    mock_ft_bet_events: ftBetEvents.length,
    source_proven: {
      backend_order_and_conflict_clause: checks.find(item => item.name === 'independent_backend_source_order_and_conflict_clause')?.passed === true,
      frontend_key_generation: checks.find(item => item.name === 'independent_frontend_source_generates_key_per_submit')?.passed === true,
    },
    guard: {
      db_sha256_unchanged: guardBefore.sha256 === guardAfter.sha256,
      watched_hashes_before_after_current_equal: same(watchedBefore, watchedAfter) && same(watchedBefore, currentWatchedHashes),
      jwt_matches: independentJwtMatches.length,
      unallowed_non_loopback_urls: networkEvidence.unallowed_non_loopback_urls.length,
      target_ports_down_after_stop: stopEvidence.all_target_ports_down === true,
    },
    not_tested: [
      'UI 双击',
      '浏览器刷新后的 UI 请求重试',
      '多进程 backend',
      '数据库主备延迟',
      '真实 Crown 上游网络分区',
      '长时间后台重试',
      '幂等键过期清理',
      '跨用户同 key',
    ],
  };

  finish();
}

function finish() {
  const completedAt = new Date();
  result.completed_at_utc = completedAt.toISOString();
  result.completed_at_beijing = beijingTime(completedAt);
  result.checks = checks;
  result.checks_passed = checks.filter(item => item.passed).length;
  result.checks_failed = checks.filter(item => !item.passed).length;
  result.checks_total = checks.length;
  result.success = checks.every(item => item.passed);

  const postcheckFile = path.join(evidenceDir, 'independent-postcheck.json');
  const reportFile = path.join(reportRoot, `${runId}-phase3f02-独立复核报告.md`);
  const relativePostcheck = path.relative(deployRoot, postcheckFile);
  const relativeReport = path.relative(deployRoot, reportFile);
  fs.writeFileSync(postcheckFile, JSON.stringify(result, null, 2) + '\n', 'utf8');

  const failedChecks = checks.filter(item => !item.passed);
  const reportLines = [
    '# Phase 3F-02 下注幂等修复独立复核报告', '',
    `Run ID：\`${runId}\``,
    `- 复核时间：${result.completed_at_beijing}（${result.completed_at_utc}）`,
    `- 主验证断言：${result.summary.main_assertions}`,
    `- 独立复核断言：${result.checks_passed}/${result.checks_total}`,
    `- 复核结果：${result.success ? '通过' : '未通过'}`,
    `- 证据：\`${relativePostcheck}\``, '',
    '## runtime direct DB 复核', '',
    `- bets：${result.summary.direct_db.bets}；状态：${JSON.stringify(result.summary.direct_db.bet_statuses)}`,
    `- 幂等记录：${result.summary.direct_db.idempotency_rows}；状态：${JSON.stringify(result.summary.direct_db.idempotency_statuses)}`,
    `- 消耗流水：${result.summary.direct_db.charge_transactions}；完整性问题：${result.summary.direct_db.integrity_issues}`,
    `- created 响应快照独立复核：${result.summary.independent_snapshot_cases} 例`,
    `- mock FT_bet：${result.summary.mock_ft_bet_events} 例，ticket 与 DB confirmed official_bet_id 集合相等`, '',
    '## source_proven', '',
    `- backend 顺序：reservation → 余额检查 → BEGIN → created 更新 → COMMIT → processBetJob；含 UNIQUE 冲突子句：${result.summary.source_proven.backend_order_and_conflict_clause}`,
    `- frontend：每次提交生成新 bet-* key，并写入 idempotency_key：${result.summary.source_proven.frontend_key_generation}`, '',
    '## guard 复核', '',
    `- guard DB SHA256 前后一致：${result.summary.guard.db_sha256_unchanged}`,
    `- watched 文件 before/after/current 一致：${result.summary.guard.watched_hashes_before_after_current_equal}`,
    `- JWT-like 独立扫描命中：${result.summary.guard.jwt_matches}`,
    `- 未允许非 loopback URL：${result.summary.guard.unallowed_non_loopback_urls}`,
    `- 停止后目标端口全 DOWN：${result.summary.guard.target_ports_down_after_stop}`, '',
    '## not_tested', '',
    ...result.summary.not_tested.map(item => `- ${item}`), '',
    '## 复现', '',
    '```powershell',
    'node --check .verify-runtime/phase3f02-postcheck.js',
    'node .verify-runtime/phase3f02-postcheck.js',
    '```', '',
    '时间标注为北京时间（Asia/Shanghai）。', '',
  ];
  if (failedChecks.length > 0) {
    reportLines.push('## 未通过断言', '');
    for (const item of failedChecks) reportLines.push(`- \`${item.name}\`：expected=${JSON.stringify(item.expected)}；actual=${JSON.stringify(item.actual)}`);
    reportLines.push('');
  }
  fs.writeFileSync(reportFile, reportLines.join('\n') + '\n', 'utf8');
  result.report_file = relativeReport;
  fs.writeFileSync(postcheckFile, JSON.stringify(result, null, 2) + '\n', 'utf8');

  console.log(JSON.stringify({
    postcheck: result.postcheck,
    run_id: runId,
    success: result.success,
    checks_passed: result.checks_passed,
    checks_total: result.checks_total,
    evidence: relativePostcheck,
    report: relativeReport,
  }, null, 2));
  process.exitCode = result.success ? 0 : 1;
}

main().catch(error => {
  const completedAt = new Date();
  result.completed_at_utc = completedAt.toISOString();
  result.completed_at_beijing = beijingTime(completedAt);
  result.checks = checks;
  result.checks_passed = checks.filter(item => item.passed).length;
  result.checks_failed = checks.filter(item => !item.passed).length + 1;
  result.checks_total = checks.length + 1;
  result.success = false;
  result.fatal_error = { message: error?.message || String(error) };
  if (evidenceDir) {
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.writeFileSync(path.join(evidenceDir, 'independent-postcheck.json'), JSON.stringify(result, null, 2) + '\n', 'utf8');
  }
  console.error(JSON.stringify(result.fatal_error));
  process.exit(1);
});

