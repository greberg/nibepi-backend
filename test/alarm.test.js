const test = require('node:test');
const assert = require('node:assert');
const { resetAlarmList, shouldReset, gapAfter, MIN_GAP_MS, SLOW_GAP_MS } = require('../lib/alarm');

test('default list is the MODBUS communication alarm only', () => {
    assert.deepStrictEqual(resetAlarmList({}), [251]);
    assert.deepStrictEqual(resetAlarmList({system:{}}), [251]);
});

test('config overrides the list and drops junk', () => {
    assert.deepStrictEqual(resetAlarmList({system:{reset_alarms:[251, '252', 0, -1, 'x']}}), [251, 252]);
    assert.deepStrictEqual(resetAlarmList({system:{reset_alarms:[]}}), []);
});

test('resets only listed alarms', () => {
    assert.strictEqual(shouldReset(251, [251], undefined, 0), true);
    assert.strictEqual(shouldReset(0, [251], undefined, 0), false);
    assert.strictEqual(shouldReset(162, [251], undefined, 0), false);
    assert.strictEqual(shouldReset('x', [251], undefined, 0), false);
    assert.strictEqual(shouldReset(251, [], undefined, 0), false);
});

test('waits between resets', () => {
    assert.strictEqual(shouldReset(251, [251], 1000, 1000 + MIN_GAP_MS - 1), false);
    assert.strictEqual(shouldReset(251, [251], 1000, 1000 + MIN_GAP_MS), true);
});

test('backs off after resets that did not clear the alarm', () => {
    assert.strictEqual(gapAfter(0), MIN_GAP_MS);
    assert.strictEqual(gapAfter(2), MIN_GAP_MS);
    assert.strictEqual(gapAfter(3), SLOW_GAP_MS);
    assert.strictEqual(shouldReset(251, [251], 0, MIN_GAP_MS, gapAfter(3)), false);
    assert.strictEqual(shouldReset(251, [251], 0, SLOW_GAP_MS, gapAfter(3)), true);
});
