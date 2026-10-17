'use strict';

const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { createRequire } = require('module');

const deployRoot = path.resolve(__dirname, '..');
const mainRepo = path.resolve(deployRoot, '..', 'hgzuqiu');
const backendEnvFile = fs.existsSync(path.join(deployRoot, 'backend', '.env'))
  ? path.join(deployRoot, 'backend', '.env')
  : path.join(mainRepo, 'backend', '.env');
const backendRequire = createRequire(path.join(deployRoot, 'backend', 'package.json'));
const { Client } = backendRequire('pg');
const evidenceRoot = path.join(deployRoot, '证据', 'phase3g-ui-replay');
const reportRoot = path.join(deployRoot, '报告');
const startedAt = new Date();
const checks = [];
const fatal = [];

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
function parseJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
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
function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function same(left, right) { return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right)); }
function probePort(port, timeout = 500) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = ok => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeout, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function scanFiles(files, env) {
  const findings = [];
  const literalNames = [
    ['db_password', env.DB_PASSWORD], ['jwt_secret', env.JWT_SECRET], ['isports_api_key', env.ISPORTS_API_KEY],
  ].filter(item => item[1]);
  const patterns = [
    ['jwt', /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
    ['authorization', /authorization\s*[:=]/gi],
    ['cookie', /\bset-cookie\s*[:=]/gi],
    ['connection_string', /(?:postgres(?:ql)?|postgresql\+native):\/\/[^\s"'<>]+/gi],
  ];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const [kind, pattern] of patterns) {
      const matches = text.match(pattern) || [];
      matches.forEach((_, index) => findings.push({ file: path.relative(deployRoot, file), kind, match_index: index, match: '<redacted>' }));
    }
    for (const [kind, value] of literalNames) {
      const pattern = new RegExp(escapeRegExp(value), 'g');
      const matches = text.match(pattern) || [];
      matches.forEach((_, index) => findings.push({ file: path.relative(deployRoot, file), kind, match_index: index, match: '<redacted>' }));
    }
  }
  return findings;
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

const latestFile = path.join(evidenceRoot, 'latest-run-id.txt');
const latestLines = fs.existsSync(latestFile)
  ? fs.readFileSync(latestFile, 'utf8').split(/\r?\n/).map(v => v.trim()).filter(Boolean)
  : [];
const runId = latestLines[0] || null;
const evidenceDir = runId ? path.join(evidenceRoot, runId) : null;
const finalFile = evidenceDir ? path.join(evidenceDir, 'final-assertions.json') : null;
const final = finalFile && fs.existsSync(finalFile) ? parseJson(finalFile) : null;
const mainReportRel = final?.report_file || null;
const mainReportFile = mainReportRel ? path.join(deployRoot, mainReportRel) : null;
const mainReport = mainReportFile && fs.existsSync(mainReportFile) ? fs.readFileSync(mainReportFile, 'utf8') : '';
const postcheckFile = evidenceDir ? path.join(evidenceDir, 'independent-postcheck.json') : null;
const postcheckReport = runId ? path.join(reportRoot, `${runId}-phase3g-独立复核报告.md`) : null;
const result = {
  postcheck: 'phase3g-independent-postcheck',
  run_id: runId,
  started_at_utc: startedAt.toISOString(),
  started_at_beijing: beijingTime(startedAt),
  main_report: mainReportRel,
  evidence_dir: evidenceDir ? path.relative(deployRoot, evidenceDir) : null,
  checks,
  fatal_errors: fatal,
  summary: {},
  success: false,
};

async function main() {
  if (!runId || !evidenceDir || !fs.existsSync(evidenceDir)) throw new Error(`latest evidence directory missing: ${runId}`);
  if (!final) throw new Error('final assertions missing or unparsable');
  const env = parseEnvFile(backendEnvFile);
  const gitCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: deployRoot, encoding: 'utf8' });
  const currentGitCommit = gitCommit.status === 0 ? gitCommit.stdout.trim() : null;
  const load = name => parseJson(path.join(evidenceDir, name));

  check('latest_run_id_file_contains_exactly_one_id', latestLines.length === 1 && /^[0-9T-]+-\d+$/.test(runId), 1, latestLines.length);
  const matchingDirs = fs.readdirSync(evidenceRoot, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name === runId);
  check('latest_run_directory_name_unique', matchingDirs.length === 1, 1, matchingDirs.length);

  const jsonFiles = walk(evidenceDir).filter(file => /\.json$/i.test(file));
  const unparsable = [];
  for (const file of jsonFiles) {
    try { parseJson(file); } catch (error) { unparsable.push({ file: path.relative(evidenceDir, file), error: error.message }); }
  }
  check('all_evidence_json_files_parsable', unparsable.length === 0, [], unparsable);

  const requiredFiles = [
    'final-assertions.json', 'browser-network-sanitized.json', 'db-final.json', 'mock-events.json',
    'double-click-dom-events.json', 'double-click-state.json', 'refresh-backend-accepted-db-state.json',
    'refresh-replay-network-evidence.json', 'browser-host-boundary.json', 'source-proof.json',
    'watched-file-hashes-before.json', 'watched-file-hashes-after.json', 'target-port-guard-after.json',
    'stop-evidence.json', 'evidence-secret-scan.json',
  ];
  const missing = requiredFiles.filter(name => !fs.existsSync(path.join(evidenceDir, name)));
  check('required_independent_evidence_files_present', missing.length === 0, [], missing);

  check('main_run_success_flag_true', final.success === true, true, final.success);
  check('main_run_fatal_errors_empty', Array.isArray(final.fatal_errors) && final.fatal_errors.length === 0, [], final.fatal_errors || null);
  const mainCounts = { total: final.assertions?.length || 0, passed: (final.assertions || []).filter(item => item.passed).length };
  check('main_assertions_39_of_39_passed', mainCounts.total === 39 && mainCounts.passed === 39, { total: 39, passed: 39 }, mainCounts);
  check('main_run_id_matches_evidence_directory', final.run_id === runId, runId, final.run_id);
  check('main_git_commit_matches_current_head', final.git_commit === currentGitCommit, currentGitCommit, final.git_commit);

  const client = new Client(dbConfig(final.database));
  await client.connect();
  try {
    const currentDatabase = (await client.query('SELECT current_database() AS name')).rows[0]?.name;
    check('postcheck_connected_to_declared_database', currentDatabase === final.database, final.database, currentDatabase);

    const bets = (await client.query(`
      SELECT b.id, b.user_id, b.account_id, a.username AS account_username, b.match_id, b.status,
             b.official_bet_id, b.bet_amount::text AS bet_amount, b.virtual_bet_amount::text AS virtual_bet_amount,
             b.created_at, b.confirmed_at
        FROM bets b JOIN crown_accounts a ON a.id=b.account_id ORDER BY b.id
    `)).rows;
    const idempotency = (await client.query(`
      SELECT id, user_id, idempotency_key, request_hash, status, bet_ids, http_status, created_at, updated_at
        FROM bet_idempotency_requests ORDER BY id
    `)).rows;
    const transactions = (await client.query(`
      SELECT id, user_id, account_id, bet_id, transaction_id, transaction_type, amount::text AS amount,
             balance_before::text AS balance_before, balance_after::text AS balance_after, created_at
        FROM coin_transactions ORDER BY id
    `)).rows;
    const integrity = (await client.query(`
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
    const matchCounts = bets.reduce((acc, bet) => ({ ...acc, [String(bet.match_id)]: (acc[String(bet.match_id)] || 0) + 1 }), {});
    check('db_bets_total_2_confirmed_2', bets.length === 2 && bets.every(bet => bet.status === 'confirmed'), { total: 2, confirmed: 2 }, {
      total: bets.length, confirmed: bets.filter(bet => bet.status === 'confirmed').length,
    });
    check('db_bets_one_per_target_match', matchCounts['940001'] === 1 && matchCounts['940002'] === 1, { 940001: 1, 940002: 1 }, matchCounts);
    check('db_idempotency_total_2_created_2', idempotency.length === 2 && idempotency.every(row => row.status === 'created'), { total: 2, created: 2 }, {
      total: idempotency.length, created: idempotency.filter(row => row.status === 'created').length,
    });
    check('db_idempotency_maps_to_unique_bets', new Set(idempotency.flatMap(row => row.bet_ids || [])).size === 2 && idempotency.every(row => (row.bet_ids || []).length === 1), true, idempotency.map(row => row.bet_ids));
    const charge = transactions.filter(item => item.transaction_type === '消耗');
    check('db_charge_transactions_total_2_unique_linked', charge.length === 2 && new Set(charge.map(item => item.transaction_id)).size === 2 && new Set(charge.map(item => item.bet_id)).size === 2, true, {
      total: charge.length, unique_transaction_ids: new Set(charge.map(item => item.transaction_id)).size, linked_bets: [...new Set(charge.map(item => item.bet_id))].sort(),
    });
    check('db_integrity_issues_0', integrity.length === 0, [], integrity);

    const network = load('browser-network-sanitized.json');
    const postRequests = network.filter(item => item.kind === 'request' && item.is_post_bets === true);
    const postResponses = network.filter(item => item.kind === 'response' && item.is_post_bets === true);
    const postFailures = network.filter(item => item.kind === 'request_failed' && item.is_post_bets === true);
    const doubleRequests = postRequests.filter(item => String(item.post_data?.match_id) === '940001');
    const doubleResponses = postResponses.filter(item => String(item.post_data?.match_id) === '940001');
    check('network_total_post_bets_requests_2', postRequests.length === 2, 2, postRequests.length);
    check('double_click_post_bets_requests_1', doubleRequests.length === 1, 1, doubleRequests.length);
    check('double_click_response_status_202', doubleResponses.length === 1 && doubleResponses[0]?.status === 202, 202, doubleResponses.map(item => item.status));

    const dom = load('double-click-dom-events.json');
    const doubleState = load('double-click-state.json');
    const markedConfirmClicks = (dom.click_events || []).filter(event => event.on_marked_confirm_button === true).length;
    check('double_click_dom_and_marked_clicks_2', (dom.click_events || []).length === 2 && markedConfirmClicks === 2 && doubleState.counts?.marked_confirm_clicks === 2, { dom_clicks: 2, marked_confirm_clicks: 2 }, {
      dom_clicks: (dom.click_events || []).length, marked_confirm_clicks: markedConfirmClicks, state_marked: doubleState.counts?.marked_confirm_clicks,
    });

    const refresh = load('refresh-replay-network-evidence.json');
    const refreshAccepted = load('refresh-backend-accepted-db-state.json');
    const reloadAt = new Date(refresh.counts?.reload_started_at).getTime();
    const refreshKey = refresh.counts?.idempotency_key;
    const refreshRequests = postRequests.filter(item => item.post_data?.idempotency_key === refreshKey);
    const calculatedBefore = refreshRequests.filter(item => new Date(item.at).getTime() < reloadAt).length;
    const calculatedAfter = refreshRequests.filter(item => new Date(item.at).getTime() >= reloadAt).length;
    const refreshFailures = postFailures.filter(item => item.post_data?.idempotency_key === refreshKey);
    check('refresh_backend_route_response_202', refresh.route?.backend_response?.status === 202 && refreshAccepted.route_response?.status === 202, 202, {
      route_evidence: refresh.route?.backend_response?.status, accepted_state: refreshAccepted.route_response?.status,
    });
    check('refresh_db_confirmed_before_reload', (refreshAccepted.bets || []).length === 1 && refreshAccepted.bets[0]?.status === 'confirmed' && new Date(refreshAccepted.bets[0]?.confirmed_at).getTime() < reloadAt, true, {
      bets: (refreshAccepted.bets || []).length, status: refreshAccepted.bets[0]?.status, confirmed_at: refreshAccepted.bets[0]?.confirmed_at, reload_at: refresh.counts?.reload_started_at,
    });
    check('refresh_before_after_recomputed_1_0', calculatedBefore === 1 && calculatedAfter === 0, { before: 1, after: 0 }, { before: calculatedBefore, after: calculatedAfter });
    check('refresh_request_aborted_in_browser', refreshFailures.length >= 1 && refreshFailures.some(item => item.failure === 'net::ERR_ABORTED'), true, refreshFailures.map(item => item.failure));

    const dbKeys = idempotency.map(row => row.idempotency_key).sort();
    const networkKeys = postRequests.map(item => item.post_data?.idempotency_key).filter(Boolean).sort();
    check('network_keys_match_db_one_to_one', same(dbKeys, networkKeys) && new Set(networkKeys).size === 2, true, { db_keys: dbKeys, network_keys: networkKeys });

    const mock = load('mock-events.json');
    const mockByGid = (mock.ft_bet_events || []).reduce((acc, event) => ({ ...acc, [String(event.params?.gid)]: (acc[String(event.params?.gid)] || 0) + 1 }), {});
    const officialIds = new Set(bets.map(bet => bet.official_bet_id));
    check('mock_ft_bet_one_per_match', mockByGid['940001'] === 1 && mockByGid['940002'] === 1, { 940001: 1, 940002: 1 }, mockByGid);
    check('mock_ft_bet_response_200_and_ticket_matches_db', (mock.ft_bet_events || []).length === 2 && (mock.ft_bet_events || []).every(event => event.response_status === 200 && officialIds.has(event.ticket_id)), true, (mock.ft_bet_events || []).map(event => ({ gid: event.params?.gid, status: event.response_status, ticket_id: event.ticket_id })));

    const hosts = [...new Set(network.filter(item => item.host).map(item => item.host))];
    const nonLoopback = hosts.filter(host => !['127.0.0.1', '::1', 'localhost'].includes(host));
    check('browser_only_loopback_hosts', hosts.length > 0 && nonLoopback.length === 0, [], nonLoopback);

    const sourceFile = path.join(deployRoot, 'frontend', 'src', 'components', 'Betting', 'BetFormModal.tsx');
    const source = fs.readFileSync(sourceFile, 'utf8');
    const sourceProof = load('source-proof.json');
    const sourceChecks = {
      submitting_guard_found: source.includes('if (submittingRef.current) return;') && source.includes('submittingRef.current = true;'),
      per_submit_key_found: source.includes('idempotency_key: generateBetIdempotencyKey()'),
      modal_closes_before_background_request: source.indexOf('handleCancel();') >= 0 && source.indexOf('betApi.createBet(requestData)') >= 0 && source.indexOf('handleCancel();') < source.indexOf('betApi.createBet(requestData)'),
    };
    check('source_guard_key_and_order_proven', sourceProof.submitting_guard_found === true && sourceProof.per_submit_key_found === true && sourceProof.modal_closes_before_background_request === true && same(sourceChecks, {
      submitting_guard_found: sourceProof.submitting_guard_found,
      per_submit_key_found: sourceProof.per_submit_key_found,
      modal_closes_before_background_request: sourceProof.modal_closes_before_background_request,
    }), true, sourceChecks);

    const beforeHashes = load('watched-file-hashes-before.json');
    const afterHashes = load('watched-file-hashes-after.json');
    const currentHashes = Object.fromEntries(Object.keys(beforeHashes).map(file => [file, sha256File(path.join(deployRoot, file))]));
    check('watched_hashes_unchanged_and_current', same(beforeHashes, afterHashes) && same(beforeHashes, currentHashes), true, { before_after_same: same(beforeHashes, afterHashes), after_current_same: same(afterHashes, currentHashes) });

    check('guard_database_unchanged', load('guard-db-before.json').sha256 === load('guard-db-after.json').sha256, true, {
      before: load('guard-db-before.json').sha256, after: load('guard-db-after.json').sha256,
    });

    const evidenceScan = scanFiles(walk(evidenceDir).filter(file => /\.(?:json|jsonl|txt|md)$/i.test(file)), env);
    check('independent_evidence_secret_scan_clean', evidenceScan.length === 0, [], evidenceScan);
    const reportScan = mainReport ? scanFiles([mainReportFile], env) : [{ kind: 'missing_report' }];
    check('main_report_exists_without_sensitive_literals', Boolean(mainReport) && reportScan.length === 0, true, { exists: Boolean(mainReport), findings: reportScan });
    check('main_report_records_39_of_39', mainReport.includes('39/39 passed') && mainReport.includes(runId), true, {
      has_run_id: mainReport.includes(runId), has_assertion_count: mainReport.includes('39/39 passed'),
    });

    const ports = [];
    for (const port of [3301, 3302, 3202, 10090]) if (await probePort(port)) ports.push(port);
    check('target_ports_3301_3302_3202_10090_free', ports.length === 0, [], ports);
    check('main_stop_evidence_all_ports_down', load('stop-evidence.json').all_target_ports_down === true && load('target-port-guard-after.json').target_ports_open_after?.length === 0, true, {
      stop_evidence: load('stop-evidence.json').all_target_ports_down, after_guard: load('target-port-guard-after.json').target_ports_open_after,
    });

    result.summary = {
      check_counts: { total: checks.length, passed: checks.filter(item => item.passed).length, failed: checks.filter(item => !item.passed).length },
      database: final.database,
      network_counts: {
        total_post_bets: postRequests.length,
        double_click_post_bets: doubleRequests.length,
        refresh_before_reload: calculatedBefore,
        refresh_after_reload: calculatedAfter,
        refresh_aborted: refreshFailures.length,
      },
      database_counts: {
        bets: bets.length,
        confirmed_bets: bets.filter(item => item.status === 'confirmed').length,
        idempotency: idempotency.length,
        charge_transactions: charge.length,
        integrity_issues: integrity.length,
      },
      mock_counts: mockByGid,
      browser_hosts: hosts,
      non_loopback_hosts: nonLoopback,
      target_ports_open_now: ports,
      evidence_secret_scan_findings: evidenceScan.length,
      conclusion_level: 'runtime_proven + source_proven; boundary cases remain not_tested',
      not_tested: ['其他浏览器与操作系统', '浏览器后退/前进', 'Service Worker 重试', '多标签页', '离线队列', '真实 Crown 上游', '网络层自动重试策略'],
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}

main().catch(error => {
  fatal.push(error?.stack || String(error));
}).finally(() => {
  const passed = checks.filter(item => item.passed).length;
  result.checked_at_utc = new Date().toISOString();
  result.checked_at_beijing = beijingTime(new Date());
  result.success = fatal.length === 0 && checks.length > 0 && passed === checks.length;
  result.summary = result.summary && Object.keys(result.summary).length ? result.summary : {
    check_counts: { total: checks.length, passed, failed: checks.length - passed },
  };
  if (postcheckFile) writeJson(postcheckFile, result);
  if (postcheckReport) {
    const counts = result.summary.check_counts;
    const lines = [
      '# Phase 3G 浏览器双击与刷新重放独立复核报告',
      '',
      `- Run ID：\`${runId || 'missing'}\``,
      `- 北京时间：\`${result.checked_at_beijing}\``,
      `- 主 Run 数据库：\`${final?.database || 'missing'}\``,
      `- 独立复核断言：\`${counts.passed}/${counts.total} passed\``,
      `- 结论：\`${result.success ? '通过' : '未通过'}\``,
      '',
      '## 复核范围',
      '',
      '- 直接连接主 Run 声明的 PostgreSQL 数据库复核 bets、幂等表、扣款流水与完整性问题。',
      '- 从原始脱敏浏览器网络证据独立重算 POST 计数、reload 前后计数与 aborted 事件。',
      '- 复核 mock `FT_bet` 每场一次、响应 200、ticket 与数据库官方注单对应。',
      '- 复核 `BetFormModal.tsx` 的同步防重入、请求级幂等键与 modal 关闭顺序。',
      '- 独立扫描证据与主报告中的敏感字面量、JWT、Authorization/Cookie、数据库连接串。',
      '- 复测 3301/3302/3202/10090 端口均为空。',
      '',
      '## 结论边界',
      '',
      '- `runtime_proven` 仅覆盖本次 Chromium、本地 backend/frontend/mock/DB 与本报告列出的输入。',
      '- `source_proven` 仅覆盖当前源码结构与本 Run 运行行为的一致性。',
      '- 其他浏览器与操作系统、后退/前进、Service Worker 重试、多标签页、离线队列、真实 Crown 上游、网络层自动重试策略仍为 `not_tested`。',
      '',
      '## 复核产物',
      '',
      `- \`证据/phase3g-ui-replay/${runId || 'missing'}/independent-postcheck.json\``,
    ];
    fs.mkdirSync(path.dirname(postcheckReport), { recursive: true });
    fs.writeFileSync(postcheckReport, `${lines.join('\n')}\n`, 'utf8');
  }
  console.log(JSON.stringify({
    success: result.success, run_id: runId, checks: result.summary.check_counts,
    report: postcheckReport ? path.relative(deployRoot, postcheckReport) : null, fatal_errors: fatal,
  }, null, 2));
  if (!result.success) process.exitCode = 1;
});
