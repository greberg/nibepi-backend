'use strict';
// Lease state machine with a fake clock and a fake pump: node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const { LeaseManager, buildTable, neutralValue, parseRequest, rawSetRefusal, roundToFactor, rmuRefusal } = require('../lib/lease');

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
        pump: Object.assign({'47011':1, '47010':0, '47041':1, '48132':0, '47047':50, '10060':20, '47398':20.5}, opts.pump),
        writes: [], reads: [], persisted: [], states: [], faults: [], failWrites: 0, failReads: 0
    };
    // Register factors as in the model files; other registers are not rounded.
    const factors = {'10060':10, '47398':10, '47047':10};
    h.m = new LeaseManager({
        clock: h.clock,
        table: buildTable(opts.overrides),
        write: async (reg, value) => {
            if(h.failWrites>0) { h.failWrites--; throw new Error('No ACK when writing register '+reg); }
            h.writes.push([reg, value]);
            h.pump[reg] = value;
        },
        read: async (reg) => {
            h.reads.push(reg);
            if(h.failReads>0) { h.failReads--; throw new Error('No respond from register ('+reg+')'); }
            return h.pump[reg];
        },
        validate: opts.validate || ((reg, value) => (value===7.5 ? 'Invalid value (7.5) for register '+reg : null)),
        normalize: (reg, value) => roundToFactor(value, factors[reg]),
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

test('RMU40 room temperature: one decimal, no baseline read, persisted for a restart', async () => {
    const h = setup();
    const res = await h.m.acquire('10060', lease(21.4));
    assert.equal(res.ok, true);
    assert.deepEqual(h.reads, [], 'no baseline for a neutral_from lease');
    assert.deepEqual(h.writes, [['10060', 21.4]], 'not rounded to 21');
    assert.equal(Math.round(h.writes[0][1]*10), 214, 'raw value for factor 10');
    assert.deepEqual(h.persisted, [{'10060':null}]);
    const s = h.lastState('10060');
    assert.equal(s.baseline, null);
    assert.equal(s.neutral_from, '47398');
    await h.clock.advance(60000);
    await h.m.acquire('10060', lease(21.43));      // the same raw 214
    assert.equal(h.writes.length, 1);
    assert.equal(h.m.state('10060').value, 21.4);
    for (const [value, pattern] of [[4.9, /outside lease limits 5..35/], [35.1, /outside lease limits/]]) {
        assert.match((await h.m.acquire('10060', lease(value))).error, pattern);
    }
    assert.equal(h.m.state('10060').value, 21.4, 'a rejected value keeps the lease');
});

test('stop temperature HW luxury: factor-10 values, 45..70, restores the baseline', async () => {
    const h = setup({pump:{'47047':50.5}});
    const res = await h.m.acquire('47047', lease(60));
    assert.equal(res.ok, true);
    assert.deepEqual(h.reads, ['47047'], 'a baseline is read');
    assert.deepEqual(h.persisted, [{'47047':50.5}]);
    assert.deepEqual(h.writes, [['47047', 60]]);
    await h.clock.advance(60000);
    await h.m.acquire('47047', lease(62.54));
    assert.deepEqual(h.writes[1], ['47047', 62.5], 'rounded to one decimal');
    assert.equal(Math.round(h.writes[1][1]*10), 625, 'raw value for factor 10');
    await h.clock.advance(60000);
    await h.m.acquire('47047', lease(62.51));         // the same raw 625
    assert.equal(h.writes.length, 2);
    for (const value of [44.9, 70.1]) {
        assert.match((await h.m.acquire('47047', lease(value))).error, /outside lease limits 45..70/);
    }
    assert.equal(h.m.state('47047').value, 62.5, 'a rejected value keeps the lease');
    await h.m.release('47047');
    assert.deepEqual(h.writes[2], ['47047', 50.5], 'release restores the baseline');
    assert.deepEqual(h.persisted[h.persisted.length-1], {});
});

test('lease table: stop temperature HW luxury', () => {
    const t = buildTable();
    assert.deepEqual([t['47047'].min, t['47047'].max, t['47047'].neutral, t['47047'].min_interval], [45, 70, null, 60]);
    assert.equal(neutralValue(t['47047'], {}), null);
});

test('a sensor feed: changes are written once per min_interval, last value wins, renewals do not write', async () => {
    const h = setup();
    await h.m.acquire('10060', lease(21.4, 300));
    await h.clock.advance(20000);
    await h.m.acquire('10060', lease(21.5, 300));
    await h.clock.advance(20000);
    await h.m.acquire('10060', lease(21.6, 300));
    await h.clock.advance(20000);                     // 60 s after the first write
    assert.deepEqual(h.writes, [['10060', 21.4], ['10060', 21.6]]);
    await h.clock.advance(60000);
    await h.m.acquire('10060', lease(21.6, 300));
    await h.clock.advance(60000);
    await h.m.acquire('10060', lease(21.6, 300));
    assert.equal(h.writes.length, 2, 'renewals with the same value do not write');
    await h.m.acquire('10060', lease(21.2, 300));     // more than 60 s since the last write
    assert.deepEqual(h.writes[2], ['10060', 21.2]);
});

test('neutral_from: expiry reads the setpoint fresh and writes it', async () => {
    const h = setup();
    await h.m.acquire('10060', lease(23, 60));
    h.pump['47398'] = 21;                              // setpoint changed meanwhile
    await h.clock.advance(60000);
    assert.deepEqual(h.reads, ['47398']);
    assert.deepEqual(h.writes, [['10060', 23], ['10060', 21]]);
    assert.deepEqual(h.faults, ['Lease för 10060 gick ut, återställer']);
    assert.equal(h.m.ownerOf('10060'), null);
    assert.deepEqual(h.persisted[h.persisted.length-1], {});
    assert.equal(h.lastState('10060').written, 21);
});

test('neutral_from: release restores the setpoint at once', async () => {
    const h = setup();
    await h.m.acquire('10060', lease(19.5));
    await h.m.release('10060');
    assert.deepEqual(h.writes, [['10060', 19.5], ['10060', 20.5]]);
});

test('neutral_from: a failed read is retried with backoff and keeps the register blocked', async () => {
    const h = setup();
    await h.m.acquire('10060', lease(23, 60));
    h.failReads = 2;
    await h.clock.advance(60000);                      // expires, read fails
    assert.equal(h.writes.length, 1);
    assert.equal(h.m.writeRefusal('10060').message, 'Register 10060 is leased by ha (restoring)');
    assert.match(h.lastState('10060').error, /Restore failed: No respond/);
    assert.match(h.faults[1], /Kunde inte återställa register 10060, läsning av register 47398 misslyckades/);
    await h.clock.advance(5000);                       // retry 1 fails
    assert.equal(h.writes.length, 1);
    await h.clock.advance(9999);
    assert.equal(h.writes.length, 1, 'backoff doubles');
    h.pump['47398'] = 'x';
    h.failReads = 0;
    await h.clock.advance(1);                          // retry 2 reads no number
    assert.equal(h.writes.length, 1);
    h.pump['47398'] = 22;
    await h.clock.advance(20000);                      // retry 3 succeeds
    assert.deepEqual(h.writes, [['10060', 23], ['10060', 22]]);
    assert.equal(h.m.writeRefusal('10060'), null);
    assert.match(h.faults[h.faults.length-1], /återställt till 22/);
});

test('neutral_from: grace lease after a restart restores the setpoint', async () => {
    const h = setup();
    assert.deepEqual(h.m.start({'10060':null, '47041':null}), ['10060']);
    await h.clock.advance(900000);
    assert.deepEqual(h.writes, [['10060', 20.5]]);
});

test('RMU40 refusals', () => {
    const rw = {register:'10060', mode:'R/W'};
    assert.equal(rmuRefusal('10060', rw), null);
    assert.equal(rmuRefusal('47011', undefined), null, 'not an RMU40 register');
    assert.equal(rmuRefusal('10060', undefined), 'RMU40 S1 is not connected: enable RMU40 for climate system 1 in the pump (menu 5.2) and keep system.rmu_emulation on');
    assert.match(rmuRefusal(10360, undefined), /^RMU40 S4 is not connected: enable RMU40 for climate system 4/);
    assert.equal(rmuRefusal('10160', {register:'10160', mode:'R'}), 'RMU40 S2 is read-only (another RMU40 answers on the bus or rmu_emulation=false)');
});

test('an RMU40 lease is rejected until the room unit is connected, then accepted', async () => {
    const table = [];                                  // the register table, filled as in index.js
    const h = setup({validate: (reg) => rmuRefusal(reg, table.find(item => item.register==reg))});
    let res = await h.m.acquire('10060', lease(21));
    assert.equal(res.ok, false);
    assert.match(res.error, /RMU40 S1 is not connected/);
    assert.match(h.lastState('10060').error, /not connected/);
    table.push({register:'10060', mode:'R'});
    res = await h.m.acquire('10060', lease(21));
    assert.match(res.error, /RMU40 S1 is read-only/);
    table[0].mode = 'R/W';
    res = await h.m.acquire('10060', lease(21));
    assert.equal(res.ok, true);
    assert.deepEqual(h.writes, [['10060', 21]]);
});

test('roundToFactor', () => {
    assert.equal(roundToFactor(21.4, 10), 21.4);
    assert.equal(roundToFactor(21.43, 10), 21.4);
    assert.equal(roundToFactor(-2.6, 1), -3);
    assert.equal(roundToFactor(7.5, undefined), 7.5);
});

test('lease table: neutral_from defaults and overrides', () => {
    const d = buildTable();
    assert.deepEqual(['10060','10160','10260','10360'].map(r => [d[r].neutral_from, d[r].min, d[r].max, d[r].min_interval]),
        [['47398',5,35,60], ['47397',5,35,60], ['47396',5,35,60], ['47395',5,35,60]]);
    const t = buildTable({'10060':{neutral:21}, '10160':{max:30}, '40940':{neutral_from:47398, neutral:3}, '40941':{neutral_from:'x'}});
    assert.deepEqual([t['10060'].neutral, t['10060'].neutral_from], [21, null], 'neutral alone replaces neutral_from');
    assert.deepEqual([t['10160'].max, t['10160'].neutral_from], [30, '47397']);
    assert.deepEqual([t['40940'].neutral, t['40940'].neutral_from], [null, '47398']);
    assert.equal(t['40941'].neutral_from, null);
    assert.equal(t['47011'].neutral_from, undefined);
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
