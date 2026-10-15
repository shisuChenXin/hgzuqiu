import {
    SelectionMappingError,
    calculateSelectionMapping,
} from '../src/services/selection-mapping-service';

const identitySettings = { mapping_mode: 'identity' as const, enabled: false, version: 1 };
const inverseSettings = { mapping_mode: 'inverse' as const, enabled: true, version: 7 };

let passed = 0;
const failures: string[] = [];

const assertEqual = (actual: unknown, expected: unknown, label: string): void => {
    if (actual !== expected) {
        failures.push(`${label}: expected=${String(expected)}, actual=${String(actual)}`);
        return;
    }
    passed += 1;
};

const assertError = (run: () => unknown, label: string): void => {
    try {
        run();
        failures.push(`${label}: expected SelectionMappingError, but no error was thrown`);
    } catch (error) {
        if (!(error instanceof SelectionMappingError)) {
            failures.push(`${label}: expected SelectionMappingError, got=${error?.constructor?.name ?? typeof error}`);
            return;
        }
        passed += 1;
    }
};

const identity = calculateSelectionMapping({
    whitelabelId: 1,
    settings: identitySettings,
    market_category: 'handicap',
    market_side: 'home',
    market_rtype: 'CNRH',
    market_chose_team: 'H',
});
assertEqual(identity.displayedMarketSide, 'home', 'identity displayed side');
assertEqual(identity.executedMarketSide, 'home', 'identity executed side');
assertEqual(identity.executedMarketRtype, 'CNRH', 'identity executed rtype');
assertEqual(identity.executedMarketChoseTeam, 'H', 'identity executed chose_team');
assertEqual(identity.mappingApplied, false, 'identity not applied');

const cases: Array<{
    label: string;
    category: string;
    side: string;
    rtype?: string;
    chose?: string;
    expectedSide: string;
    expectedRtype?: string;
    expectedChose?: string;
}> = [
    { label: 'home->away', category: 'handicap', side: 'home', rtype: 'CNRH', chose: 'H', expectedSide: 'away', expectedRtype: 'CNRC', expectedChose: 'C' },
    { label: 'away->home', category: 'handicap', side: 'away', rtype: 'CNRC', chose: 'C', expectedSide: 'home', expectedRtype: 'CNRH', expectedChose: 'H' },
    { label: 'over->under', category: 'overunder', side: 'over', rtype: 'CNOUC', chose: 'H', expectedSide: 'under', expectedRtype: 'CNOUH', expectedChose: 'C' },
    { label: 'under->over', category: 'overunder', side: 'under', rtype: 'CNOUH', chose: 'C', expectedSide: 'over', expectedRtype: 'CNOUC', expectedChose: 'H' },
    { label: 'draw unchanged', category: 'moneyline', side: 'draw', rtype: 'CNRN', chose: 'N', expectedSide: 'draw', expectedRtype: 'CNRN', expectedChose: 'N' },
];

for (const item of cases) {
    const mapped = calculateSelectionMapping({
        whitelabelId: 1,
        settings: inverseSettings,
        market_category: item.category,
        market_side: item.side,
        market_rtype: item.rtype,
        market_chose_team: item.chose,
    });
    assertEqual(mapped.displayedMarketSide, item.side, `${item.label} displayed side`);
    assertEqual(mapped.executedMarketSide, item.expectedSide, `${item.label} executed side`);
    assertEqual(mapped.executedMarketRtype, item.expectedRtype, `${item.label} executed rtype`);
    assertEqual(mapped.executedMarketChoseTeam, item.expectedChose, `${item.label} executed chose_team`);
    assertEqual(mapped.mappingApplied, item.side !== item.expectedSide, `${item.label} applied flag`);
}

assertError(() => calculateSelectionMapping({
    whitelabelId: 1,
    settings: inverseSettings,
    market_category: 'handicap',
}), 'inverse missing market_side');

assertError(() => calculateSelectionMapping({
    whitelabelId: 1,
    settings: inverseSettings,
    market_category: 'handicap',
    market_side: 'over',
}), 'handicap/over mismatch');

assertError(() => calculateSelectionMapping({
    whitelabelId: 1,
    settings: inverseSettings,
    market_category: 'overunder',
    market_side: 'home',
}), 'overunder/home mismatch');

assertError(() => calculateSelectionMapping({
    whitelabelId: 1,
    settings: inverseSettings,
    market_category: 'handicap',
    market_side: 'home',
    market_rtype: 'CNRX',
}), 'unsafe market_rtype');

assertError(() => calculateSelectionMapping({
    whitelabelId: 1,
    settings: inverseSettings,
    market_category: 'moneyline',
    market_side: 'middle',
}), 'invalid market_side');

assertError(() => calculateSelectionMapping({
    whitelabelId: 1,
    settings: inverseSettings,
    market_category: 'moneyline',
    market_side: 'home',
    market_chose_team: 'X',
}), 'invalid market_chose_team');

console.log(JSON.stringify({ passed, failed: failures.length, failures }, null, 2));
if (failures.length > 0) {
    process.exitCode = 1;
}
