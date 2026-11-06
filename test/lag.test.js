'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createLagMonitor } = require('../lib/lag');

test('reports a tick that came far too late, not ordinary jitter', () => {
    let t = 0;
    const seen = [];
    const monitor = createLagMonitor({ interval: 1000, threshold: 5000, now: () => t, onLag: (lag) => seen.push(lag) });
    t = 1000; assert.strictEqual(monitor.tick(), 0);
    t = 2300; assert.strictEqual(monitor.tick(), 300);
    t = 75000; monitor.tick();            // blocked for ~72 s
    t = 76000; monitor.tick();
    assert.deepStrictEqual(seen, [71700]);
    assert.strictEqual(monitor.worst(), 71700);
});

test('a clock going backwards is no lag', () => {
    let t = 10000;
    const monitor = createLagMonitor({ now: () => t });
    t = 5000;
    assert.strictEqual(monitor.tick(), 0);
});
