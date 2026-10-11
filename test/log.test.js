'use strict';
// log.js: the in-memory ring of recent lines for the status page, and
// masking of secrets.
const test = require('node:test');
const assert = require('node:assert/strict');
const log = require('../log');

// Nothing printed while testing; lines at info and above are still kept.
log.setLevel('error');

test.beforeEach(() => {
    log.clearRecent();
    log.clearSecrets();
    log.setLevel('error');
});

test('info and above are kept whatever the level, debug and trace are not', () => {
    log.info('A', 'one');
    log.debug('A', 'two');
    log.trace('A', 'three');
    log.warn('B', 'four');
    const lines = log.recent();
    assert.deepEqual(lines.map(l => l.message), ['four', 'one']);
    assert.equal(lines[0].level, 'warn');
    assert.equal(lines[0].area, 'B');
    assert.equal(typeof lines[0].ts, 'number');
});

test('newest first, limited, and bounded to RECENT_MAX', () => {
    for (let i = 0; i < log.RECENT_MAX + 50; i++) log.info('Loop', `line ${i}`);
    assert.equal(log.recent({limit: 10000}).length, log.RECENT_MAX);
    const three = log.recent({limit: 3});
    assert.deepEqual(three.map(l => l.message), [`line ${log.RECENT_MAX + 49}`, `line ${log.RECENT_MAX + 48}`, `line ${log.RECENT_MAX + 47}`]);
    assert.equal(log.recent({limit: 'x'}).length, 200);
});

test('level filter: warn includes errors, error only errors', () => {
    log.error('E', 'bad');
    log.warn('W', 'meh');
    log.info('I', 'fine');
    assert.deepEqual(log.recent({level: 'warn'}).map(l => l.level), ['warn', 'error']);
    assert.deepEqual(log.recent({level: 'error'}).map(l => l.level), ['error']);
    assert.equal(log.recent({level: 'info'}).length, 3);
    // Unknown or lower levels fall back to info.
    assert.equal(log.recent({level: 'debug'}).length, 3);
    assert.equal(log.recent({level: 'nonsense'}).length, 3);
});

test('warnings survive a flood of info lines', () => {
    log.warn('W', 'kept');
    for (let i = 0; i < log.RECENT_MAX * 2; i++) log.info('Loop', `line ${i}`);
    assert.deepEqual(log.recent({level: 'warn'}).map(l => l.message), ['kept']);
    assert.equal(log.recent().some(l => l.message === 'kept'), false);
});

test('the warning list is bounded too', () => {
    for (let i = 0; i < log.PROBLEM_MAX + 20; i++) log.error('E', `e ${i}`);
    assert.equal(log.recent({level: 'warn', limit: 1000}).length, log.PROBLEM_MAX);
});

test('secrets are masked in kept lines, also inside objects and errors', () => {
    log.addSecret('hunter22');
    log.info('MQTT', 'connecting with hunter22 now');
    log.error('MQTT', new Error('auth hunter22 failed'));
    log.warn('Cfg', {pass: 'hunter22'});
    const text = JSON.stringify(log.recent());
    assert.equal(text.includes('hunter22'), false);
    assert.equal(text.includes('***'), true);
});

test('short or empty secrets are not registered', () => {
    log.addSecret('');
    log.addSecret(undefined);
    log.addSecret('ab');
    log.info('X', 'ab cd');
    assert.equal(log.recent()[0].message, 'ab cd');
});

test('returned entries are copies', () => {
    log.info('X', 'orig');
    log.recent()[0].message = 'changed';
    assert.equal(log.recent()[0].message, 'orig');
});
