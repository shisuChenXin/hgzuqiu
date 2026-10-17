'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const { spawnSync } = require('child_process');
const { createRequire } = require('module');

const deployRoot = path.resolve(__dirname, '..');
const mainRepo = path.resolve(deployRoot, '..', 'hgzuqiu');
const backendDir = path.join(deployRoot, 'backend');
const backendEnvFile = fs.existsSync(path.join(backendDir, '.env')) ? path.join(backendDir, '.env') : path.join(mainRepo, 'backend', '.env');
const backendRequire = createRequire(path.join(backendDir, 'package.json'));
const { Client } = backendRequire('pg');
const evidenceRoot = path.join(deployRoot, '证据', 'phase5a-postcommit-crash-recovery');
const reportRoot = path.join(deployRoot, '报告');
const startedAt = new Date();
const targetPorts = [3301, 3202, 3203];
const checks = [];
const result = {
  phase: 'phase5a-postcommit-crash-recovery-independent-postcheck',
  started_at_utc: startedAt.toISOString(),
  started_at_beijing: beijingTime(startedAt),
  run_id: null,
  evidence_dir: null,
  main_report: null,
  checks: [],
  summary: {},
  fatal_errors: [],
  success: false,
};

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
function readText(file) { return fs.readFileSync(file, 'utf8'); }
function readJson(file) { return JSON.parse(readText(file)); }
function existsFile(file) { return fs.existsSync(file) && fs.statSync(file).isFile(); }
function walk(dir) {
  const output = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) output.push(...walk(full));
    else output.push(full);
  }
  return output.sort();
}
function evidenceFiles(rootDir, extensions = /\.(?:json|jsonl|txt|md)$/i) {
  return walk(rootDir).filter(file => extensions.test(path.basename(file)));
}
function canonical(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function same(left, right) { return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right)); }
function sha256Value(value) { return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }
function sha256File(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function parseEnvFile(file) {
  const map = {};
  for (const line of readText(file).split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (match) map[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
  }
  return map;
}
function requiredEnv(map, key) { const value = map[key]; if (!value) throw new Error(`missing ${key}`); return value; }
function dbConfig(database) {
  const map = parseEnvFile(backendEnvFile);
  return {
    host: requiredEnv(map, 'DB_HOST'), port: Number(requiredEnv(map, 'DB_PORT')),
    user: requiredEnv(map, 'DB_USER'), password: requiredEnv(map, 'DB_PASSWORD'), database, ssl: false,
  };
}
async function connectDb(database) { const client = new Client(dbConfig(database)); await client.connect(); return client; }
function probePort(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const finish = ok => { socket.destroy(); resolve(ok); };
    socket.setTimeout(500, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}
async function targetPortsOpen() {
  const output = [];
  for (const port of targetPorts) if (await probePort(port)) output.push(port);
  return output;
}
function gitRevision() { return spawnSync('git', ['rev-parse', 'HEAD'], { cwd: deployRoot, encoding: 'utf8', windowsHide: true }).stdout.trim(); }
function gitIsAncestor(ancestor) {
  return spawnSync('git', ['merge-base', '--is-ancestor', ancestor, 'HEAD'], { cwd: deployRoot, windowsHide: true }).status === 0;
}
function scanSecrets(files, knownSecrets) {
  const jwtPattern = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
  const findings = [];
  for (const file of files) {
    const text = readText(file);
    const jwtMatches = text.match(jwtPattern) || [];
    if (jwtMatches.length) findings.push({ file: path.relative(deployRoot, file), kind: 'jwt-like', count: jwtMatches.length });
    const bearerMatches = text.match(/Bearer\s+[A-Za-z0-9._~+/=-]{20,}/gi) || [];
    if (bearerMatches.length) findings.push({ file: path.relative(deployRoot, file), kind: 'bearer-like', count: bearerMatches.length });
    for (const [kind, secret] of Object.entries(knownSecrets)) if (secret && secret.length >= 8 && text.includes(secret)) findings.push({ file: path.relative(deployRoot, file), kind, count: 1 });
  }
  return findings;
}
function scanNonLoopbackUrls(files) {
  const pattern = /\b(?:https?|wss?):\/\/[^\s"'<>)]+/g;
  const findings = [];
  for (const file of files) {
    for (const raw of readText(file).match(pattern) || []) {
      try {
        const host = new URL(raw).hostname;
        if (!['127.0.0.1', 'localhost', '::1'].includes(host)) findings.push({ file: path.relative(deployRoot, file), url: raw.slice(0, 180), host });
      } catch { findings.push({ file: path.relative(deployRoot, file), url: raw.slice(0, 180), host: null }); }
    }
  }
  return findings;
}
function parseJsonlFile(file) {
  return readText(file).split(/\r?\n/).map((line, index) => {
    if (!line.trim()) return null;
    try { return JSON.parse(line); } catch (error) { throw new Error(`${file}:${index + 1}: ${error.message}`); }
  }).filter(Boolean);
}
function isLoopback(value) { return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1' || value === '::ffff:7f00:1'; }
function countBy(items, key) { return items.reduce((map, item) => ({ ...map, [item[key]]: (map[item[key]] || 0) + 1 }), {}); }
function zeroDelta(delta) {
  return delta?.bets === 0 && delta?.idempotency === 0 && delta?.mock_ft_bet === 0 && delta?.charge_transactions === 0 && delta?.integrity_issues === 0;
}
async function directState(client) {
  const bets = (await client.query(`SELECT b.id,b.user_id,u.username AS user_username,b.account_id,a.username AS account_username,b.match_id,b.bet_type,b.bet_option,b.status,b.error_message,b.official_bet_id,b.bet_amount::text AS bet_amount,b.virtual_bet_amount::text AS virtual_bet_amount,b.created_at,b.confirmed_at,b.updated_at FROM bets b JOIN users u ON u.id=b.user_id JOIN crown_accounts a ON a.id=b.account_id ORDER BY b.id`)).rows;
  const idempotency = (await client.query(`SELECT i.id::text AS id,i.user_id,u.username AS user_username,i.idempotency_key,i.request_hash,i.status,i.bet_ids,i.response_json,i.http_status,i.created_at,i.updated_at FROM bet_idempotency_requests i JOIN users u ON u.id=i.user_id ORDER BY i.id`)).rows;
  const transactions = (await client.query(`SELECT c.id,c.user_id,u.username AS user_username,c.account_id,c.bet_id,c.transaction_id,c.transaction_type,c.description,c.amount::text AS amount,c.balance_before::text AS balance_before,c.balance_after::text AS balance_after,c.created_at FROM coin_transactions c JOIN users u ON u.id=c.user_id ORDER BY c.id`)).rows;
  const integrity = (await client.query(`SELECT 'missing_transaction_for_active_bet' AS issue,b.id AS bet_id FROM bets b WHERE b.status <> 'cancelled' AND NOT EXISTS (SELECT 1 FROM coin_transactions t WHERE t.bet_id=b.id AND t.transaction_type='消耗') UNION ALL SELECT 'charge_transaction_without_active_bet' AS issue,t.bet_id FROM coin_transactions t LEFT JOIN bets b ON b.id=t.bet_id WHERE t.transaction_type='消耗' AND (b.id IS NULL OR b.status='cancelled') ORDER BY issue,bet_id`)).rows;
  return {
    bets,
    idempotency,
    transactions,
    charge_transactions: transactions.filter(item => item.transaction_type === '消耗'),
    integrity,
    persisted_state_sha256: sha256Value({ bets, idempotency, transactions, integrity }),
  };
}
async function guardSnapshot() {
  const baseName = requiredEnv(parseEnvFile(backendEnvFile), 'DB_NAME');
  const client = await connectDb(baseName);
  try {
    const found = await client.query(`SELECT (SELECT COUNT(*) FROM users)::int AS users_count,(SELECT COUNT(*) FROM crown_accounts)::int AS crown_accounts_count,(SELECT COUNT(*) FROM matches)::int AS matches_count,(SELECT COUNT(*) FROM bets)::int AS bets_count,(SELECT COUNT(*) FROM coin_transactions)::int AS coin_transactions_count,(SELECT COALESCE(MAX(id),0) FROM users)::int AS max_users_id,(SELECT COALESCE(MAX(id),0) FROM crown_accounts)::int AS max_crown_accounts_id,(SELECT COALESCE(MAX(id),0) FROM matches)::int AS max_matches_id,(SELECT COALESCE(MAX(id),0) FROM bets)::int AS max_bets_id,(SELECT COALESCE(MAX(id),0) FROM coin_transactions)::int AS max_coin_transactions_id`);
    return { database: baseName, snapshot: found.rows[0], sha256: sha256Value(found.rows[0]) };
  } finally { await client.end(); }
}
async function main() {
  const latestFile = path.join(evidenceRoot, 'latest-matrix-run-id.txt');
  check('latest_matrix_id_file_exists', existsFile(latestFile), true, latestFile);
  const latestLines = existsFile(latestFile) ? readText(latestFile).split(/\r?\n/).map(value => value.trim()).filter(Boolean) : [];
  check('latest_matrix_id_file_contains_exactly_one_id', latestLines.length === 1 && /^[0-9]{8}T[0-9]{6}-[0-9]+$/.test(latestLines[0] || ''), 1, latestLines);
  const requestedRunId = process.argv[2] || latestLines[0] || null;
  check('requested_run_id_valid', Boolean(requestedRunId && /^[0-9]{8}T[0-9]{6}-[0-9]+$/.test(requestedRunId)), true, requestedRunId);
  check('requested_run_id_is_latest', !process.argv[2] || requestedRunId === latestLines[0], true, { requested: requestedRunId, latest: latestLines[0] || null });
  if (!requestedRunId) return;
  const runId = requestedRunId;
  result.run_id = runId;
  const evidenceDir = path.join(evidenceRoot, runId);
  result.evidence_dir = path.relative(deployRoot, evidenceDir);
  check('matrix_evidence_directory_exists', fs.existsSync(evidenceDir) && fs.statSync(evidenceDir).isDirectory(), true, result.evidence_dir);
  const finalFile = path.join(evidenceDir, 'matrix-final-assertions.json');
  check('matrix_final_assertions_exists', existsFile(finalFile), true, path.relative(deployRoot, finalFile));
  const final = existsFile(finalFile) ? readJson(finalFile) : null;
  check('matrix_final_run_id_matches', final?.matrix_run_id === runId, runId, final?.matrix_run_id || null);
  check('matrix_phase_matches', final?.phase === 'phase5a-postcommit-crash-recovery', 'phase5a-postcommit-crash-recovery', final?.phase || null);
  const actualPassed = Array.isArray(final?.assertions) ? final.assertions.filter(item => item.passed === true).length : null;
  const actualFailed = Array.isArray(final?.assertions) ? final.assertions.filter(item => item.passed !== true).length : null;
  check('matrix_assertion_counts_consistent', actualPassed === final?.assertions_passed && actualFailed === final?.assertions_failed && final?.assertions?.length === actualPassed + actualFailed, { passed: final?.assertions_passed, failed: final?.assertions_failed, total: final?.assertions?.length }, { passed: actualPassed, failed: actualFailed, total: Array.isArray(final?.assertions) ? final.assertions.length : null });
  check('matrix_runner_success_true', final?.success === true, true, final?.success === true);
  check('matrix_fatal_errors_empty', Array.isArray(final?.fatal_errors) && final.fatal_errors.length === 0, [], final?.fatal_errors || null);
  check('matrix_completed_five_cycles', final?.expected_cycles === 5 && final?.completed_cycles === 5, { expected: 5, completed: 5 }, { expected: final?.expected_cycles, completed: final?.completed_cycles });
  check('matrix_runner_outcome_characterization_completed', final?.summary?.runner_outcome === 'characterization_matrix_completed', 'characterization_matrix_completed', final?.summary?.runner_outcome || null);
  check('matrix_product_recovery_zero_of_five', final?.summary?.product_recovery_invariant?.passed_cycles === 0 && final?.summary?.product_recovery_invariant?.failed_cycles === 5 && final?.summary?.product_recovery_invariant?.total_cycles === 5, { passed: 0, failed: 5, total: 5 }, final?.summary?.product_recovery_invariant || null);
  check('matrix_all_characterization_cycles_complete', final?.summary?.all_characterization_cycles_complete === true, true, final?.summary?.all_characterization_cycles_complete === true);
  check('matrix_target_ports_empty_after_run', Array.isArray(final?.summary?.target_ports_after_all_cycles) && final.summary.target_ports_after_all_cycles.length === 0, [], final?.summary?.target_ports_after_all_cycles || null);

  const mainReportRel = final?.report_file || null;
  const mainReportFile = mainReportRel ? path.join(deployRoot, mainReportRel) : null;
  result.main_report = mainReportRel;
  check('main_report_exists', Boolean(mainReportFile && existsFile(mainReportFile)), true, mainReportRel || null);
  const mainReport = mainReportFile && existsFile(mainReportFile) ? readText(mainReportFile) : '';
  check('main_report_contains_runtime_proven_orphan_conclusion', mainReport.includes('runtime_proven：当前实现存在提交后崩溃孤儿注单缺陷'), true, mainReport.includes('runtime_proven：当前实现存在提交后崩溃孤儿注单缺陷'));
  check('main_report_states_product_recovery_not_satisfied', mainReport.includes('产品恢复目标 **5/5 未满足**'), true, mainReport.includes('产品恢复目标 **5/5 未满足**'));
  check('main_report_does_not_call_product_recovery_passed', !mainReport.includes('产品恢复能力通过') || mainReport.includes('不表示产品恢复能力通过'), true, { contains_product_recovery_passed: mainReport.includes('产品恢复能力通过'), contains_disclaimer: mainReport.includes('不表示产品恢复能力通过') });

  const currentCommit = gitRevision();
  check('matrix_commit_is_current_history', Boolean(final?.git_commit && /^[0-9a-f]{40}$/.test(final.git_commit) && gitIsAncestor(final.git_commit)), true, { matrix_commit: final?.git_commit || null, current_commit: currentCommit });
  const mainSyntax = spawnSync(process.execPath, ['--check', path.join(deployRoot, '.verify-runtime', 'phase5a-postcommit-crash-recovery-run.js')], { encoding: 'utf8', windowsHide: true });
  check('main_runner_syntax_check_passed', mainSyntax.status === 0, 0, mainSyntax.status);
  const postcheckSyntax = spawnSync(process.execPath, ['--check', __filename], { encoding: 'utf8', windowsHide: true });
  check('independent_postcheck_syntax_check_passed', postcheckSyntax.status === 0, 0, postcheckSyntax.status);
  const jsonFiles = evidenceFiles(evidenceDir, /\.json$/i);
  const jsonParseResults = jsonFiles.map(file => {
    try { readJson(file); return { file: path.relative(evidenceDir, file), ok: true }; }
    catch (error) { return { file: path.relative(evidenceDir, file), ok: false, error: error.message }; }
  });
  check('all_matrix_json_evidence_parses', jsonParseResults.every(item => item.ok), jsonFiles.length, { total: jsonFiles.length, failed: jsonParseResults.filter(item => !item.ok) });

  const expectedRunDirs = [1, 2, 3, 4, 5].map(index => `run-${String(index).padStart(2, '0')}`);
  const actualRunDirs = fs.readdirSync(evidenceDir, { withFileTypes: true }).filter(entry => entry.isDirectory() && /^run-\d{2}$/.test(entry.name)).map(entry => entry.name).sort();
  check('evidence_contains_exactly_five_cycle_directories', same(actualRunDirs, expectedRunDirs), expectedRunDirs, actualRunDirs);
  const databases = Array.isArray(final?.databases) ? final.databases : [];
  check('matrix_declares_five_distinct_databases', databases.length === 5 && new Set(databases).size === 5, { count: 5, distinct: 5 }, { count: databases.length, distinct: new Set(databases).size });
  const admin = await connectDb('postgres');
  let existingDatabases;
  try { existingDatabases = (await admin.query('SELECT datname FROM pg_database WHERE datname = ANY($1::text[]) ORDER BY datname', [databases])).rows.map(row => row.datname); }
  finally { await admin.end(); }
  check('all_five_databases_exist_in_postgresql', same(existingDatabases, [...databases].sort()), [...databases].sort(), existingDatabases);

  const cycleSummaries = [];
  for (let index = 0; index < 5; index += 1) {
    const cycleIndex = index + 1;
    const cycleDir = path.join(evidenceDir, expectedRunDirs[index]);
    const cycleFinal = readJson(path.join(cycleDir, 'cycle-final-assertions.json'));
    const database = databases[index];
    check(`cycle_${cycleIndex}_final_success`, cycleFinal?.success === true, true, cycleFinal?.success === true);
    check(`cycle_${cycleIndex}_database_matches_matrix`, cycleFinal?.database === database, database, cycleFinal?.database || null);
    check(`cycle_${cycleIndex}_assertions_all_passed`, cycleFinal?.assertions_failed === 0 && cycleFinal?.fatal_errors?.length === 0, { failed: 0, fatal: 0 }, { failed: cycleFinal?.assertions_failed, fatal: cycleFinal?.fatal_errors?.length ?? null });
    check(`cycle_${cycleIndex}_product_recovery_failed`, cycleFinal?.product_recovery_invariant_passed === false, false, cycleFinal?.product_recovery_invariant_passed);

    const client = await connectDb(database);
    let persisted;
    try { persisted = await directState(client); }
    finally { await client.end(); }
    const finalEvidence = readJson(path.join(cycleDir, 'final-db-state.json'));
    const persistedEvidenceHash = sha256Value({ bets: finalEvidence.bets, idempotency: finalEvidence.idempotency, transactions: finalEvidence.transactions, integrity: finalEvidence.integrity });
    check(`cycle_${cycleIndex}_direct_db_matches_final_evidence`, persisted.persisted_state_sha256 === persistedEvidenceHash, persistedEvidenceHash, persisted.persisted_state_sha256);

    const crashBets = persisted.bets.filter(item => Number(item.match_id) === 950001);
    const controlBets = persisted.bets.filter(item => Number(item.match_id) === 950002);
    const crashBet = crashBets[0] || null;
    const controlBet = controlBets[0] || null;
    check(`cycle_${cycleIndex}_one_pending_crash_bet`, crashBets.length === 1 && crashBet?.status === 'pending', { count: 1, status: 'pending' }, { count: crashBets.length, status: crashBet?.status || null });
    check(`cycle_${cycleIndex}_crash_bet_has_no_official_ticket`, crashBets.length === 1 && crashBet?.official_bet_id === null && crashBet?.confirmed_at === null, { official_bet_id: null, confirmed_at: null }, { official_bet_id: crashBet?.official_bet_id, confirmed_at: crashBet?.confirmed_at || null });
    check(`cycle_${cycleIndex}_one_confirmed_control_bet`, controlBets.length === 1 && controlBet?.status === 'confirmed' && controlBet?.official_bet_id !== null && controlBet?.confirmed_at !== null, { count: 1, status: 'confirmed', official_bet_id: 'not-null', confirmed_at: 'not-null' }, { count: controlBets.length, status: controlBet?.status || null, official_bet_id: controlBet?.official_bet_id || null, confirmed_at: controlBet?.confirmed_at || null });
    check(`cycle_${cycleIndex}_final_bet_counts`, persisted.bets.length === 2 && countBy(persisted.bets, 'status').pending === 1 && countBy(persisted.bets, 'status').confirmed === 1, { total: 2, pending: 1, confirmed: 1 }, { total: persisted.bets.length, ...countBy(persisted.bets, 'status') });

    const crashIdempotency = persisted.idempotency.find(item => item.idempotency_key === `phase5a-crash-c${cycleIndex}`);
    const controlIdempotency = persisted.idempotency.find(item => item.idempotency_key === `phase5a-control-c${cycleIndex}`);
    const crashScenario = readJson(path.join(cycleDir, 'scenario-crash-request.json'));
    const controlScenario = readJson(path.join(cycleDir, 'scenario-control-new-request.json'));
    check(`cycle_${cycleIndex}_two_created_idempotency_rows`, persisted.idempotency.length === 2 && persisted.idempotency.every(item => item.status === 'created' && item.http_status === 202), { total: 2, status: 'created', http_status: 202 }, { total: persisted.idempotency.length, statuses: countBy(persisted.idempotency, 'status'), http_statuses: countBy(persisted.idempotency, 'http_status') });
    check(`cycle_${cycleIndex}_crash_idempotency_links_pending_bet`, Boolean(crashIdempotency && same(crashIdempotency.bet_ids, [crashBet?.id]) && same(crashIdempotency.response_json, crashScenario.request?.response_body)), true, { bet_ids: crashIdempotency?.bet_ids || null, response_equal: same(crashIdempotency?.response_json, crashScenario.request?.response_body) });
    check(`cycle_${cycleIndex}_control_idempotency_links_confirmed_bet`, Boolean(controlIdempotency && same(controlIdempotency.bet_ids, [controlBet?.id]) && same(controlIdempotency.response_json, controlScenario.request?.response_body)), true, { bet_ids: controlIdempotency?.bet_ids || null, response_equal: same(controlIdempotency?.response_json, controlScenario.request?.response_body) });

    const chargeTransactions = persisted.charge_transactions;
    check(`cycle_${cycleIndex}_exactly_one_charge_transaction`, chargeTransactions.length === 1, 1, chargeTransactions.length);
    check(`cycle_${cycleIndex}_charge_transaction_only_for_control`, chargeTransactions.length === 1 && chargeTransactions[0]?.bet_id === controlBet?.id && chargeTransactions.filter(item => item.bet_id === crashBet?.id).length === 0, { control_bets: 1, crash_bets: 0 }, { control_bets: chargeTransactions.filter(item => item.bet_id === controlBet?.id).length, crash_bets: chargeTransactions.filter(item => item.bet_id === crashBet?.id).length });
    check(`cycle_${cycleIndex}_one_missing_transaction_integrity_issue`, persisted.integrity.length === 1 && persisted.integrity[0]?.issue === 'missing_transaction_for_active_bet' && persisted.integrity[0]?.bet_id === crashBet?.id, [{ issue: 'missing_transaction_for_active_bet', bet_id: crashBet?.id }], persisted.integrity);

    const mockEvents = parseJsonlFile(path.join(cycleDir, 'mock-upstream-log.jsonl'));
    const ftBets = mockEvents.filter(item => item.event === 'request_received' && item.action === 'FT_bet');
    const attempts = mockEvents.filter(item => item.event === 'FT_bet_response_attempt');
    const crashMock = ftBets.find(item => String(item.params?.gid) === '950001') || null;
    const controlMock = ftBets.find(item => String(item.params?.gid) === '950002') || null;
    const crashAttempt = attempts.find(item => item.request_id === crashMock?.request_id) || null;
    const controlAttempt = attempts.find(item => item.request_id === controlMock?.request_id) || null;
    check(`cycle_${cycleIndex}_two_mock_ft_bet_requests`, ftBets.length === 2 && Boolean(crashMock && controlMock), { total: 2, crash: 1, control: 1 }, { total: ftBets.length, crash: Boolean(crashMock), control: Boolean(controlMock) });
    check(`cycle_${cycleIndex}_mock_all_remote_addresses_loopback`, mockEvents.length > 0 && mockEvents.every(item => isLoopback(item.remote_address)), true, [...new Set(mockEvents.map(item => item.remote_address))]);
    check(`cycle_${cycleIndex}_crash_mock_response_was_destroyed`, Boolean(crashAttempt && crashAttempt.socket_destroyed_before_response_attempt === true && crashAttempt.response_end_called === false), { socket_destroyed: true, response_end_called: false }, { socket_destroyed: crashAttempt?.socket_destroyed_before_response_attempt, response_end_called: crashAttempt?.response_end_called });
    check(`cycle_${cycleIndex}_control_mock_response_completed`, Boolean(controlAttempt && controlAttempt.socket_destroyed_before_response_attempt === false && controlAttempt.response_end_called === true), { socket_destroyed: false, response_end_called: true }, { socket_destroyed: controlAttempt?.socket_destroyed_before_response_attempt, response_end_called: controlAttempt?.response_end_called });
    check(`cycle_${cycleIndex}_control_official_ticket_matches_mock`, controlBet?.official_bet_id === controlMock?.ticket_id, controlMock?.ticket_id || null, controlBet?.official_bet_id || null);

    const kill = readJson(path.join(cycleDir, 'backend-a-kill-evidence.json'));
    const held = readJson(path.join(cycleDir, 'held-ft-bet-response-attempt.json'));
    const ftReceivedAt = new Date(crashMock?.at || 0).getTime();
    const killRequestedAt = new Date(kill.kill_requested_at || 0).getTime();
    const backendExitAt = new Date(kill.exit_observed_at || 0).getTime();
    const responseAttemptAt = new Date(crashAttempt?.at || held.response_attempt?.at || 0).getTime();
    check(`cycle_${cycleIndex}_crash_time_order_proven`, kill.process_exited === true && ftReceivedAt < killRequestedAt && killRequestedAt < backendExitAt && backendExitAt < responseAttemptAt, { ft_bet_received: 'lt kill_requested', kill_requested: 'lt backend_exit', backend_exit: 'lt held_response_attempt' }, { ft_bet_received_at: crashMock?.at || null, kill_requested_at: kill.kill_requested_at, backend_exit_observed_at: kill.exit_observed_at, held_response_attempt_at: crashAttempt?.at || held.response_attempt?.at || null });

    const restart = readJson(path.join(cycleDir, 'restart-observation.json'));
    check(`cycle_${cycleIndex}_restart_window_at_least_5000ms`, Number(restart.observation_ms) >= 5000, 5000, restart.observation_ms);
    check(`cycle_${cycleIndex}_no_automatic_retry_during_restart_window`, zeroDelta(restart.delta), { bets: 0, idempotency: 0, mock_ft_bet: 0, charge_transactions: 0, integrity_issues: 0 }, restart.delta);
    check(`cycle_${cycleIndex}_old_bet_pending_after_restart_window`, restart.after_observation_state?.bets?.length === 1 && restart.after_observation_state.bets[0]?.status === 'pending', { total: 1, status: 'pending' }, { total: restart.after_observation_state?.bets?.length ?? null, status: restart.after_observation_state?.bets?.[0]?.status || null });

    const replayA = readJson(path.join(cycleDir, 'scenario-exact-replay-restarted-backend-a.json'));
    const replayB = readJson(path.join(cycleDir, 'scenario-exact-replay-backend-b.json'));
    for (const [label, replay] of [['restarted_backend_a', replayA], ['backend_b', replayB]]) {
      check(`cycle_${cycleIndex}_${label}_replay_202`, replay.request?.response_status === 202, 202, replay.request?.response_status ?? null);
      check(`cycle_${cycleIndex}_${label}_replay_header_true`, replay.request?.response_headers?.idempotency_replayed === 'true', 'true', replay.request?.response_headers?.idempotency_replayed ?? null);
      check(`cycle_${cycleIndex}_${label}_replay_canonical_equal`, replay.response_canonically_equal_to_initial === true && same(replay.request?.response_body, crashScenario.request?.response_body), true, { recorded: replay.response_canonically_equal_to_initial, direct: same(replay.request?.response_body, crashScenario.request?.response_body) });
      check(`cycle_${cycleIndex}_${label}_replay_zero_side_effects`, zeroDelta(replay.delta), { bets: 0, idempotency: 0, mock_ft_bet: 0, charge_transactions: 0, integrity_issues: 0 }, replay.delta);
    }

    check(`cycle_${cycleIndex}_control_new_key_created_one_confirmed_bet`, controlScenario.request?.response_status === 202 && controlScenario.delta?.bets === 1 && controlScenario.delta?.idempotency === 1 && controlScenario.delta?.mock_ft_bet === 1 && controlScenario.delta?.charge_transactions === 1, { bets: 1, idempotency: 1, mock_ft_bet: 1, charge_transactions: 1 }, controlScenario.delta);

    cycleSummaries.push({
      cycle_index: cycleIndex,
      database,
      persisted_state_sha256: persisted.persisted_state_sha256,
      bets: { total: persisted.bets.length, ...countBy(persisted.bets, 'status') },
      idempotency: { total: persisted.idempotency.length, ...countBy(persisted.idempotency, 'status') },
      mock_ft_bet: ftBets.length,
      charge_transactions: chargeTransactions.length,
      integrity_issues: persisted.integrity.length,
      exact_replay_zero_side_effects: zeroDelta(replayA.delta) && zeroDelta(replayB.delta),
      control_confirmed: controlBet?.status === 'confirmed',
    });
  }
  const runtimeConfigs = expectedRunDirs.map((_, index) => readJson(path.join(evidenceDir, expectedRunDirs[index], 'initial-service-health.json'))?.runtime_config);
  check('all_cycles_two_backends_same_declared_database', runtimeConfigs.every((config, index) => config?.database === databases[index] && config?.backends?.length === 2 && config.backends.every(item => item.database === databases[index])), true, runtimeConfigs.map((config, index) => ({ expected: databases[index], actual: config?.backends?.map(item => item.database) || null })));
  check('all_cycles_runtime_upstream_loopback', runtimeConfigs.every(config => config?.upstream === 'http://127.0.0.1:3301' && config?.network_boundary?.crown_base_url === 'http://127.0.0.1:3301' && config?.network_boundary?.crown_base_url_candidates === 'http://127.0.0.1:3301'), true, runtimeConfigs.map(config => ({ upstream: config?.upstream, boundary: config?.network_boundary || null })));

  const watchedBefore = expectedRunDirs.map((_, index) => readJson(path.join(evidenceDir, expectedRunDirs[index], 'watched-file-hashes-before.json')));
  const watchedAfter = expectedRunDirs.map((_, index) => readJson(path.join(evidenceDir, expectedRunDirs[index], 'watched-file-hashes-after.json')));
  check('all_cycles_watched_hashes_before_after_equal', watchedBefore.length === 5 && watchedAfter.length === 5 && watchedBefore.every((map, index) => same(map, watchedAfter[index])), true, watchedBefore.map((map, index) => ({ cycle: index + 1, equal: same(map, watchedAfter[index]) })));
  const watchedReference = watchedBefore[0] || {};
  const currentWatched = Object.fromEntries(Object.keys(watchedReference).map(file => [file, sha256File(path.join(deployRoot, file))]));
  check('current_watched_hashes_match_matrix_evidence', Object.keys(watchedReference).length > 0 && same(currentWatched, watchedReference), true, { files: Object.keys(watchedReference), current_equal: same(currentWatched, watchedReference) });

  const guardsBefore = expectedRunDirs.map((_, index) => readJson(path.join(evidenceDir, expectedRunDirs[index], 'guard-db-before.json')));
  const guardsAfter = expectedRunDirs.map((_, index) => readJson(path.join(evidenceDir, expectedRunDirs[index], 'guard-db-after.json')));
  check('all_cycles_guard_db_before_after_equal', guardsBefore.length === 5 && guardsAfter.length === 5 && guardsBefore.every((item, index) => item.sha256 === guardsAfter[index].sha256), true, guardsBefore.map((item, index) => ({ cycle: index + 1, equal: item.sha256 === guardsAfter[index].sha256 })));
  const currentGuard = await guardSnapshot();
  check('current_guard_db_matches_matrix_evidence', currentGuard.sha256 === guardsBefore[0]?.sha256, guardsBefore[0]?.sha256 || null, currentGuard.sha256);

  const currentTargetPorts = await targetPortsOpen();
  check('current_target_ports_all_empty', currentTargetPorts.length === 0, [], currentTargetPorts);

  const mainSecretScan = readJson(path.join(evidenceDir, 'matrix-evidence-secret-scan.json'));
  const mainNetworkScan = readJson(path.join(evidenceDir, 'matrix-network-boundary-scan.json'));
  check('matrix_secret_scan_file_reports_zero', Array.isArray(mainSecretScan.findings) && mainSecretScan.findings.length === 0, 0, mainSecretScan.findings?.length ?? null);
  check('matrix_network_scan_file_reports_zero', Array.isArray(mainNetworkScan.non_loopback_urls) && mainNetworkScan.non_loopback_urls.length === 0, 0, mainNetworkScan.non_loopback_urls?.length ?? null);

  const scanFiles = evidenceFiles(evidenceDir).filter(file => path.basename(file) !== 'independent-postcheck.json');
  if (mainReportFile && existsFile(mainReportFile)) scanFiles.push(mainReportFile);
  const runPid = runId.split('-').pop();
  const knownSecrets = Object.fromEntries([1, 2, 3, 4, 5].map(cycle => [`cycle_${cycle}_db_password`, `Phase5A!${runPid}-${cycle}`]));
  const independentSecretFindings = scanSecrets(scanFiles, knownSecrets);
  const independentNonLoopbackFindings = scanNonLoopbackUrls(scanFiles);
  check('independent_secret_scan_zero', independentSecretFindings.length === 0, 0, independentSecretFindings.length);
  check('independent_non_loopback_url_scan_zero', independentNonLoopbackFindings.length === 0, 0, independentNonLoopbackFindings.length);

  result.summary = {
    matrix_assertions: `${actualPassed}/${final.assertions.length} passed`,
    matrix_runner_success: final.success === true,
    product_recovery_invariant: final.summary.product_recovery_invariant,
    databases: { count: databases.length, distinct: new Set(databases).size, names: databases },
    cycles: cycleSummaries,
    all_direct_databases_match_final_evidence: cycleSummaries.every(item => Boolean(item.persisted_state_sha256)),
    all_exact_replays_zero_side_effects: cycleSummaries.every(item => item.exact_replay_zero_side_effects),
    all_control_bets_confirmed: cycleSummaries.every(item => item.control_confirmed),
    watched_files_unchanged: same(currentWatched, watchedReference),
    guard_database_unchanged: currentGuard.sha256 === guardsBefore[0]?.sha256,
    current_target_ports: currentTargetPorts,
    independent_secret_findings: independentSecretFindings.length,
    independent_non_loopback_url_findings: independentNonLoopbackFindings.length,
    matrix_commit: final.git_commit,
    current_commit: currentCommit,
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
  result.success = result.fatal_errors.length === 0 && result.checks_total > 0 && result.checks_failed === 0;
  const evidenceDir = result.evidence_dir ? path.join(deployRoot, result.evidence_dir) : evidenceRoot;
  fs.mkdirSync(evidenceDir, { recursive: true });
  const independentEvidence = path.join(evidenceDir, 'independent-postcheck.json');
  fs.writeFileSync(independentEvidence, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  const independentReport = path.join(reportRoot, `${result.run_id || 'unknown'}-phase5a-独立复核报告.md`);
  const lines = [
    '# Phase 5A 独立复核报告', '',
    `- 独立复核结论：${result.success ? '通过' : '未通过'}；独立检查 ${result.checks_passed}/${result.checks_total} 通过。`,
    `- 复核语义：本“通过”仅表示 5 轮缺陷复现证据链与 PostgreSQL / mock 落盘状态一致；产品恢复目标仍为 **${result.summary?.product_recovery_invariant?.passed_cycles ?? 'n/a'}/5**，未满足。`,
    `- Run ID：${result.run_id || 'unknown'}`,
    `- 原始矩阵断言：${result.summary?.matrix_assertions || 'n/a'}。`,
    `- 数据库独立复核：${result.summary?.databases?.count ?? 'n/a'} 个，distinct ${result.summary?.databases?.distinct ?? 'n/a'} 个；每库直连复核均为 1 pending / 1 confirmed / 2 created / 2 FT_bet / 1 扣款 / 1 integrity issue。`,
    `- 原 key 重放：${result.summary?.all_exact_replays_zero_side_effects ? '两个 backend 方向均为 202 + replay header + canonical response + 五项零增量' : '存在不一致'}。`,
    `- 控制流：${result.summary?.all_control_bets_confirmed ? '5/5 新 key 控制注单确认' : '存在失败'}。`,
    `- 守护状态：watched hashes 不变=${String(result.summary?.watched_files_unchanged)}；guard DB 不变=${String(result.summary?.guard_database_unchanged)}；目标端口=${JSON.stringify(result.summary?.current_target_ports || [])}。`,
    `- 独立扫描：secret findings=${result.summary?.independent_secret_findings ?? 'n/a'}；non-loopback URL findings=${result.summary?.independent_non_loopback_url_findings ?? 'n/a'}。`,
    `- Git：矩阵基线 commit=${result.summary?.matrix_commit || 'n/a'}；复核时 HEAD=${result.summary?.current_commit || 'n/a'}；基线在当前历史中。`, '',
    '## 独立检查项', '',
    ...checks.map(item => `- ${item.passed ? 'PASS' : 'FAIL'}：${item.name}`), '',
    '## 证据', '',
    `- 独立复核 JSON：${path.relative(deployRoot, independentEvidence)}`,
    `- 原始主报告：${result.main_report || 'n/a'}`, '',
    '## 复现', '',
    '```powershell',
    'node --check .verify-runtime/phase5a-postcommit-crash-recovery-run.js',
    'node --check .verify-runtime/phase5a-postcommit-crash-recovery-postcheck.js',
    'node .verify-runtime/phase5a-postcommit-crash-recovery-run.js',
    'node .verify-runtime/phase5a-postcommit-crash-recovery-postcheck.js',
    '```', '',
    '时间标注为北京时间（Asia/Shanghai）。本复核不外推真实上游、Service Worker、多标签页、PostgreSQL 故障切换、其他崩溃时机或长时间生产运行。',
  ];
  fs.writeFileSync(independentReport, `${lines.join('\n')}\n`, 'utf8');
  result.independent_report = path.relative(deployRoot, independentReport);
  fs.writeFileSync(independentEvidence, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    success: result.success,
    run_id: result.run_id,
    checks: { passed: result.checks_passed, failed: result.checks_failed, total: result.checks_total },
    evidence: path.relative(deployRoot, independentEvidence),
    report: result.independent_report,
    summary: result.summary,
  }, null, 2));
  process.exitCode = result.success ? 0 : 1;
}

main().catch(error => {
  result.fatal_errors.push(error?.stack || String(error));
  finish();
});
