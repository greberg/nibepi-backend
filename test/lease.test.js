'use strict';
// Lease state machine with a fake clock and a fake pump: node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const { LeaseManager, buildTable, neutralValue, parseRequest, rawSetRefusal } = require('../lib/lease');

const settle = () => new Promise(resolve => setImmediate(resolve));

// Timers that only run when advance() moves the clock.
class FakeClock {
    constructor() { this.t = 1700000000000; this.timers = []; this.seq = 0; }
    now() { return this.t; }
    setTimeout(fn, ms) { const id = ++this.seq; this.timers.push({id, at:this.t+ms, fn}); return id; }
    clearTimeout(id) { this.timers = this.timers.filter(t => t.id!==id); }
    async advance(ms) {
        const end = this.t + ms;
        await settle();
        for (;;) {
            this.timers.sort((a,b) => a.at-b.at || a.id-b.id);
            const next = this.timers[0];
            if(next===undefined || next.at>end) break;
            this.timers.shift();
            this.t = next.at;
            next.fn();
            await settle();
        }
        this.t = end;
        await settle();
    }
}

function setup(opts={}) {
    const h = {
        clock: new FakeClock(),
        pump: Object.assign({'47011':1, '47010':0, '47041':1, '48132':0}, opts.pump),
        writes: [], reads: [], persisted: [], states: [], faults: [], failWrites: 0
    };
    h.m = new LeaseManager({
        clock: h.clock,
        table: buildTable(opts.overrides),
        write: async (reg, value) => {
            if(h.failWrites>0) { h.failWrites--; throw new Error('No ACK when writing register '+reg); }
            h.writes.push([reg, value]);
            h.pump[reg] = value;
        },
        read: async (reg) => { h.reads.push(reg); return h.pump[reg]; },
        validate: (reg, value) => (value===7.5 ? 'Invalid value (7.5) for register '+reg : null),
        persist: async (baselines) => { h.persisted.push(baselines); },
        publish: (reg, state) => h.states.push([reg, state]),
        fault: (message) => h.faults.push(message),
        neutral: (reg, spec) => neutralValue(spec, {home:{adjust_s1:2, adjust_s2:'x'}})
    });
    h.lastState = (reg) => { const s = h.states.filter(x => x[0]===reg); return s.length ? s[s.length-1][1] : undefined; };
    return h;
}
const lease = (value, ttl=900, owner='ha') => JSON.stringify({value, ttl, owner});

test('acquire captures a fresh baseline, persists it, then writes', async () => {
    const h = setup();
    const res = await h.m.acquire('47011', lease(-2));
    assert.equal(res.ok, true);
    assert.deepEqual(h.reads, ['47011']);
    assert.deepEqual(h.persisted, [{'47011':1}]);
    assert.deepEqual(h.writes, [['47011', -2]]);
    const s = h.lastState('47011');
    assert.equal(s.active, true);
    assert.equal(s.written, -2);
    assert.equal(s.baseline, 1);
    assert.equal(s.neutral, 2);
    assert.equal(s.owner, 'ha');
    assert.equal(s.expires, h.clock.now()+900000);
});

test('renewal with the same value only extends the expiry', async () => {
    const h = setup();
    await h.m.acquire('47011', lease(-2));
    await h.clock.advance(600000);
    await h.m.acquire('47011', lease(-2));
    assert.deepEqual(h.writes, [['47011', -2]]);
    assert.equal(h.reads.length, 1);
    assert.equal(h.persisted.length, 1, 'renewals do not touch the SD card');
    await h.clock.advance(600000);        // past the first expiry
    assert.equal(h.m.state('47011').active, true);
    assert.deepEqual(h.faults, []);
});

test('a change inside min_interval is deferred, and the last value wins', async () => {
    const h = setup();
    await h.m.acquire('47011', lease(-2));
    await h.clock.advance(10000);
    await h.m.acquire('47011', lease(-3));
    await h.clock.advance(10000);
    await h.m.acquire('47011', lease(-4));
    assert.deepEqual(h.writes, [['47011', -2]]);
    assert.equal(h.m.state('47011').value, -4);
    await h.clock.advance(39999);
    assert.equal(h.writes.length, 1);
    await h.clock.advance(1);             // 60 s after the first write
    assert.deepEqual(h.writes, [['47011', -2], ['47011', -4]]);
    assert.equal(h.m.state('47011').written, -4);
});

test('expiry restores neutral and reports a fault', async () => {
    const h = setup();
    await h.m.acquire('47011', lease(-2, 60));
    await h.clock.advance(60000);
    assert.deepEqual(h.writes, [['47011', -2], ['47011', 2]]);   // neutral = home.adjust_s1
    assert.deepEqual(h.faults, ['Lease för 47011 gick ut, återställer']);
    assert.equal(h.m.ownerOf('47011'), null);
    assert.deepEqual(h.persisted[h.persisted.length-1], {});
    const s = h.lastState('47011');
    assert.equal(s.active, false);
    assert.equal(s.written, 2);
});

test('expiry restores the baseline when there is no neutral', async () => {
    const h = setup({pump:{'47041':1}});
    await h.m.acquire('47041', lease(2, 60));
    await h.clock.advance(60000);
    assert.deepEqual(h.writes, [['47041', 2], ['47041', 1]]);
});

test('a neutral path that is not a finite number restores 0', async () => {
    const h = setup({pump:{'47010':3}});
    await h.m.acquire('47010', lease(-1, 60));
    await h.clock.advance(60000);
    assert.deepEqual(h.writes, [['47010', -1], ['47010', 0]]);
});

test('ttl is clamped to 60..3600 s', async () => {
    const h = setup();
    await h.m.acquire('47011', lease(-2, 5));
    assert.equal(h.m.state('47011').expires, h.clock.now()+60000);
    await h.m.acquire('47011', lease(-2, 99999));
    assert.equal(h.m.state('47011').expires, h.clock.now()+3600000);
});

test('release restores at once and clears the baseline', async () => {
    const h = setup();
    await h.m.acquire('48132', lease(4));
    await h.m.release('48132');
    assert.deepEqual(h.writes, [['48132', 4], ['48132', 0]]);
    assert.equal(h.m.ownerOf('48132'), null);
    assert.deepEqual(h.persisted, [{'48132':0}, {}]);
    await h.clock.advance(3600000);
    assert.equal(h.writes.length, 2, 'no expiry after release');
});

test('a restore within min_interval is not delayed', async () => {
    const h = setup();
    await h.m.acquire('47041', lease(2));
    await h.clock.advance(1000);
    await h.m.release('47041');
    assert.deepEqual(h.writes, [['47041', 2], ['47041', 1]]);
});

test('grace lease after a restart restores unless renewed', async () => {
    const h = setup({pump:{'47041':2}});
    assert.deepEqual(h.m.start({'47041':1, 'bad':'x'}), ['47041']);
    assert.equal(h.m.ownerOf('47041'), 'grace');
    assert.deepEqual(h.writes, []);
    await h.clock.advance(900000);
    assert.deepEqual(h.writes, [['47041', 1]]);       // persisted baseline
    assert.deepEqual(h.faults, ['Lease för 47041 gick ut, återställer']);
    assert.deepEqual(h.persisted, [{}]);
});

test('grace lease renewed in time keeps the old baseline', async () => {
    const h = setup({pump:{'47041':2}});
    h.m.start({'47041':1});
    await h.clock.advance(300000);
    await h.m.acquire('47041', lease(2));
    assert.deepEqual(h.reads, [], 'baseline is not read again');
    assert.equal(h.m.state('47041').baseline, 1);
    assert.equal(h.m.ownerOf('47041'), 'ha');
    await h.clock.advance(800000);                     // past the grace expiry
    assert.deepEqual(h.faults, []);
    await h.m.release('47041');
    assert.deepEqual(h.writes[h.writes.length-1], ['47041', 1]);
});

test('invalid requests are rejected without writing', async () => {
    const h = setup();
    const cases = [
        ['40004', lease(1), /cannot be leased/],
        ['47011', lease(11), /outside lease limits/],
        ['47011', lease(7.5), /Invalid value/],
        ['47011', 'not json', /not JSON/],
        ['47011', JSON.stringify({value:'abc'}), /finite number/],
        ['47011', JSON.stringify({value:null}), /finite number/],
        ['47011', JSON.stringify([1]), /JSON object/]
    ];
    for (const [reg, payload, pattern] of cases) {
        const res = await h.m.acquire(reg, payload);
        assert.equal(res.ok, false);
        assert.match(res.error, pattern);
        assert.match(h.lastState(reg).error, pattern);
    }
    assert.deepEqual(h.writes, []);
    assert.deepEqual(h.reads, []);
    assert.equal(h.m.ownerOf('47011'), null);
});

test('a baseline that cannot be read rejects the lease', async () => {
    const h = setup();
    h.m.read = async () => { throw new Error('No respond from register (47011)'); };
    const res = await h.m.acquire('47011', lease(-2));
    assert.equal(res.ok, false);
    assert.match(res.error, /No respond/);
    assert.deepEqual(h.writes, []);
    assert.equal(h.m.ownerOf('47011'), null);
});

test('a rejected request keeps the active lease', async () => {
    const h = setup();
    await h.m.acquire('47011', lease(-2));
    await h.m.acquire('47011', lease(20));
    const s = h.m.state('47011');
    assert.equal(s.active, true);
    assert.equal(s.value, -2);
    assert.match(s.error, /outside/);
});

test('ownership: other writers are refused while leased and restoring', async () => {
    const h = setup();
    assert.equal(h.m.writeRefusal('47011'), null);
    await h.m.acquire('47011', lease(-2, 60));
    assert.equal(h.m.writeRefusal('47011').message, 'Register 47011 is leased by ha');
    assert.equal(h.m.writeRefusal(47011).message, 'Register 47011 is leased by ha');
    assert.equal(h.m.writeRefusal('47011', true), null, 'the lease module itself passes');
    h.failWrites = 2;
    await h.clock.advance(60000);                       // expires, restore fails
    assert.equal(h.m.writeRefusal('47011').message, 'Register 47011 is leased by ha (restoring)');
    assert.equal(h.lastState('47011').restoring, true);
    await h.clock.advance(5000);                        // retry 1 fails
    assert.equal(h.writes.length, 1);
    await h.clock.advance(9999);
    assert.equal(h.writes.length, 1, 'backoff doubles');
    await h.clock.advance(1);                           // retry 2 succeeds
    assert.deepEqual(h.writes, [['47011', -2], ['47011', 2]]);
    assert.equal(h.m.writeRefusal('47011'), null);
    assert.match(h.faults[1], /Kunde inte återställa register 47011/);
    assert.match(h.faults[h.faults.length-1], /återställt till 2/);
});

test('the owner can take the lease back while a restore is retrying', async () => {
    const h = setup();
    await h.m.acquire('47041', lease(2, 60));
    h.failWrites = 1;
    await h.clock.advance(60000);
    await h.m.acquire('47041', lease(0));
    assert.equal(h.m.state('47041').active, true);
    assert.equal(h.m.state('47041').baseline, 1);
    await h.clock.advance(60000);
    assert.deepEqual(h.writes, [['47041', 2], ['47041', 0]], 'no stale restore retry');
});

test('a failed lease write is retried after min_interval', async () => {
    const h = setup();
    h.failWrites = 1;
    await h.m.acquire('47011', lease(-2));
    assert.match(h.m.state('47011').error, /Write failed/);
    await h.clock.advance(60000);
    assert.deepEqual(h.writes, [['47011', -2]]);
    assert.equal(h.m.state('47011').error, null);
});

test('stop clears timers without restoring', async () => {
    const h = setup();
    await h.m.acquire('47011', lease(-2, 60));
    h.m.stop();
    await h.clock.advance(120000);
    assert.deepEqual(h.writes, [['47011', -2]]);
    assert.equal(h.clock.timers.length, 0);
});

test('lease table overrides merge and null removes', () => {
    const t = buildTable({'47011':{max:5}, '47041':null, '40940':{min:-100, max:100}, 'x':{min:1}});
    assert.equal(t['47011'].max, 5);
    assert.equal(t['47011'].min, -10);
    assert.equal(t['47011'].neutral, 'home.adjust_s1');
    assert.equal(t['47041'], undefined);
    assert.deepEqual([t['40940'].min, t['40940'].max, t['40940'].neutral, t['40940'].min_interval], [-100, 100, null, 60]);
    assert.equal(t.x, undefined);
});

test('neutral values', () => {
    const t = buildTable();
    assert.equal(neutralValue(t['47011'], {home:{adjust_s1:-3}}), -3);
    assert.equal(neutralValue(t['47011'], {home:{adjust_s1:''}}), 0);
    assert.equal(neutralValue(t['47011'], {}), 0);
    assert.equal(neutralValue(t['47011'], {home:{adjust_s1:15}}), 10, 'clamped to the lease limits');
    assert.equal(neutralValue(t['48132'], {}), 0);
    assert.equal(neutralValue(t['47041'], {}), null);
});

test('parseRequest defaults', () => {
    assert.deepEqual(parseRequest(Buffer.from('{"value":"-2"}'), 900), {value:-2, ttl:900, owner:'mqtt'});
});

test('raw /set policy', () => {
    assert.equal(rawSetRefusal(undefined, '47011', null), null);
    assert.equal(rawSetRefusal('all', '47011', null), null);
    assert.match(rawSetRefusal('all', '47011', 'ha'), /leased by ha/);
    assert.match(rawSetRefusal('none', '47011', null), /disabled/);
    assert.equal(rawSetRefusal([47011, '47010'], '47011', null), null);
    assert.equal(rawSetRefusal([47011, '47010'], '47010', null), null);
    assert.match(rawSetRefusal([47011], '48132', null), /not in gateway.raw_set/);
    assert.match(rawSetRefusal([47011], '47011', 'ha'), /leased/);
    assert.match(rawSetRefusal('some', '47011', null), /not "all"/);
});
