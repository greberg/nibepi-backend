'use strict';
// Register leases: Home Assistant (or any MQTT client) owns a register for a
// limited time and must renew it. When it stops renewing - HA, broker or
// network gone - the lease expires and the register is restored on its own,
// so the pump never keeps a value nobody is responsible for any more.
//
// This file holds only the state machine. Clock, register reads and writes,
// validation, persistence and publishing are injected, so it runs (and is
// tested) without a pump, MQTT or a config file. index.js wires it up.

const DEFAULT_TTL = 900;        // s; grace leases after a restart and requests without ttl
const TTL_MIN = 60;
const TTL_MAX = 3600;
const DEFAULT_MIN_INTERVAL = 60;
const RESTORE_RETRY_MIN_MS = 5000;
const RESTORE_RETRY_MAX_MS = 300000;
const REJECT_LOG_MS = 60000;

// neutral: a number, null (restore the captured baseline), or a config path
// whose value is used when it is a finite number, else 0.
const DEFAULT_LEASES = {
    '47011': {name:'curve offset S1', min:-10, max:10, neutral:'home.adjust_s1', min_interval:60},
    '47010': {name:'curve offset S2', min:-10, max:10, neutral:'home.adjust_s2', min_interval:60},
    '47041': {name:'hot water comfort mode', min:0, max:2, neutral:null, min_interval:60},
    '47134': {name:'hot water period', min:0, max:180, neutral:null, min_interval:60},
    '48132': {name:'temporary lux', min:0, max:4, neutral:0, min_interval:30},
    '48660': {name:'cut-off frequency 1 active', min:0, max:1, neutral:0, min_interval:60},
    '48659': {name:'cut-off frequency 2 active', min:0, max:1, neutral:0, min_interval:60},
    '48662': {name:'cut-off frequency start 1', min:17, max:120, neutral:null, min_interval:60},
    '48664': {name:'cut-off frequency stop 1', min:17, max:120, neutral:null, min_interval:60},
    '48661': {name:'cut-off frequency start 2', min:17, max:120, neutral:null, min_interval:60},
    '48663': {name:'cut-off frequency stop 2', min:17, max:120, neutral:null, min_interval:60}
};

const finiteOrNull = (v) => (v===null || v===undefined || v==='' || !Number.isFinite(Number(v))) ? null : Number(v);

// Defaults merged with config.gateway.leases: {"<reg>": {min,max,neutral,min_interval}},
// null removes a default entry. Fields that are not usable fall back.
function buildTable(overrides) {
    const table = {};
    for (const reg of Object.keys(DEFAULT_LEASES)) table[reg] = Object.assign({}, DEFAULT_LEASES[reg]);
    if(overrides===null || typeof overrides!=='object' || Array.isArray(overrides)) return table;
    for (const reg of Object.keys(overrides)) {
        const spec = overrides[reg];
        if(spec===null) { delete table[reg]; continue; }
        if(typeof spec!=='object' || Array.isArray(spec) || !/^\d+$/.test(reg)) continue;
        const merged = Object.assign({min:null, max:null, neutral:null, min_interval:DEFAULT_MIN_INTERVAL}, table[reg] || {}, spec);
        merged.min = finiteOrNull(merged.min);
        merged.max = finiteOrNull(merged.max);
        if(typeof merged.neutral!=='string') merged.neutral = finiteOrNull(merged.neutral);
        const interval = Number(merged.min_interval);
        merged.min_interval = (Number.isFinite(interval) && interval>=0) ? interval : DEFAULT_MIN_INTERVAL;
        table[reg] = merged;
    }
    return table;
}

// Restore target for a spec, or null to use the baseline. Clamped to the
// lease limits: a neutral the lease itself would refuse (adjust_s1 = 15) would
// otherwise fail validation on every restore attempt, forever.
function neutralValue(spec, config) {
    if(spec===undefined || spec.neutral===null || spec.neutral===undefined) return null;
    let value;
    if(typeof spec.neutral==='string') {
        let node = config;
        for (const key of spec.neutral.split('.')) node = (node!==null && typeof node==='object') ? node[key] : undefined;
        value = (typeof node==='number' || (typeof node==='string' && node.trim()!=='')) ? Number(node) : NaN;
        if(!Number.isFinite(value)) value = 0;
    } else {
        value = Number(spec.neutral);
        if(!Number.isFinite(value)) return null;
    }
    if(spec.min!==null && spec.min!==undefined && value<spec.min) value = spec.min;
    if(spec.max!==null && spec.max!==undefined && value>spec.max) value = spec.max;
    return value;
}

const clampTtl = (ttl) => Math.min(TTL_MAX, Math.max(TTL_MIN, ttl));
const errorText = (err) => (err && err.message) ? err.message : String(err);

// {value, ttl, owner} from a lease/<reg>/set payload (JSON text, Buffer or object).
function parseRequest(payload, defaultTtl) {
    let req = payload;
    if(Buffer.isBuffer(req)) req = req.toString();
    if(typeof req==='string') {
        try { req = JSON.parse(req); } catch(e) { throw new Error('Payload is not JSON'); }
    }
    if(req===null || typeof req!=='object' || Array.isArray(req)) throw new Error('Payload must be a JSON object');
    let value = req.value;
    if(typeof value==='string' && value.trim()!=='') value = Number(value);
    if(typeof value!=='number' || !Number.isFinite(value)) throw new Error('value must be a finite number');
    let ttl = defaultTtl;
    if(req.ttl!==undefined && req.ttl!==null) {
        ttl = Number(req.ttl);
        if(!Number.isFinite(ttl)) throw new Error('ttl must be a number of seconds');
    }
    const owner = (req.owner===undefined || req.owner===null || String(req.owner).trim()==='') ? 'mqtt' : String(req.owner).slice(0,64);
    return {value:value, ttl:clampTtl(ttl), owner:owner};
}

const realClock = {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t)
};

class LeaseManager {
    // opts: table, defaultTtl, clock {now,setTimeout,clearTimeout},
    // write(reg,value) -> Promise, read(reg) -> Promise<number> (fresh from the pump),
    // validate(reg,value) -> null or reason, persist(baselines) -> Promise,
    // publish(reg,state), fault(message), log(message), neutral(reg,spec) -> number|null
    constructor(opts={}) {
        this.table = opts.table || buildTable();
        this.defaultTtl = clampTtl(Number.isFinite(Number(opts.defaultTtl)) ? Number(opts.defaultTtl) : DEFAULT_TTL);
        this.clock = opts.clock || realClock;
        this.write = opts.write;
        this.read = opts.read;
        this.validate = opts.validate || (() => null);
        this.persist = opts.persist || (() => Promise.resolve());
        this.publish = opts.publish || (() => {});
        this.fault = opts.fault || (() => {});
        this.log = opts.log || (() => {});
        this.neutral = opts.neutral || ((reg, spec) => neutralValue(spec, {}));
        this.leases = new Map();     // reg -> entry, while active or restoring
        this.lastWrite = new Map();  // reg -> ms of the last write, across leases
        this.chains = new Map();     // reg -> tail of that register's job chain
        this.rejectSeen = new Map();
        this.stopped = false;
    }
    setTable(table) {
        this.table = table;
    }
    // Jobs per register run one at a time: a write that waits for its ACK
    // must not overlap another write to the same register (the ACK listeners
    // cannot tell them apart), and a release must see the finished acquire.
    _run(reg, job) {
        const prev = this.chains.get(reg) || Promise.resolve();
        const next = prev.then(() => (this.stopped===true ? undefined : job()));
        const tail = next.catch((err) => { this.log(`Lease ${reg}: ${errorText(err)}`); });
        this.chains.set(reg, tail);
        tail.then(() => { if(this.chains.get(reg)===tail) this.chains.delete(reg); });
        return next;
    }
    // Grace leases for baselines persisted by an earlier run: a lease was
    // active when it stopped. The owner gets one TTL to renew, else restore.
    start(baselines) {
        const started = [];
        if(baselines===null || typeof baselines!=='object') return started;
        for (const reg of Object.keys(baselines)) {
            const baseline = finiteOrNull(baselines[reg]);
            if(baseline===null || this.leases.has(reg)) continue;
            const spec = this.table[reg] || {min:null, max:null, neutral:null, min_interval:DEFAULT_MIN_INTERVAL};
            const entry = this._newEntry(reg, spec, baseline, 'grace');
            entry.expires = this.clock.now() + this.defaultTtl*1000;
            this.leases.set(reg, entry);
            this._armExpiry(entry);
            this._publish(entry);
            started.push(reg);
        }
        return started;
    }
    _newEntry(reg, spec, baseline, owner) {
        return {reg:reg, spec:spec, status:'active', owner:owner, value:null, written:null,
            expires:null, baseline:baseline, error:null, retryDelay:RESTORE_RETRY_MIN_MS, timers:{}};
    }
    acquire(reg, payload) {
        reg = String(reg);
        return this._run(reg, () => this._acquire(reg, payload));
    }
    async _acquire(reg, payload) {
        const spec = this.table[reg];
        if(spec===undefined) return this._reject(reg, `Register ${reg} cannot be leased`);
        let req;
        try { req = parseRequest(payload, this.defaultTtl); } catch(err) { return this._reject(reg, err.message); }
        if((spec.min!==null && spec.min!==undefined && req.value<spec.min) || (spec.max!==null && spec.max!==undefined && req.value>spec.max)) {
            return this._reject(reg, `Value ${req.value} outside lease limits ${spec.min}..${spec.max}`);
        }
        const invalid = this.validate(reg, req.value);
        if(invalid) return this._reject(reg, invalid);
        let entry = this.leases.get(reg);
        if(entry===undefined) {
            let baseline;
            try {
                baseline = Number(await this.read(reg));
            } catch(err) {
                return this._reject(reg, `Could not read the current value: ${errorText(err)}`);
            }
            if(!Number.isFinite(baseline)) return this._reject(reg, 'Could not read the current value');
            entry = this._newEntry(reg, spec, baseline, req.owner);
            this.leases.set(reg, entry);
            // Persisted before the first write: a crash after writing must
            // still find the baseline at the next start.
            await this._persist();
            this.log(`Lease ${reg} acquired by ${req.owner}, baseline ${baseline}`);
        } else if(entry.status==='restoring') {
            // The owner is back before the restore went through; the original
            // baseline is kept (and is still persisted).
            this._clearTimer(entry, 'retry');
            entry.status = 'active';
            entry.retryDelay = RESTORE_RETRY_MIN_MS;
            this.log(`Lease ${reg} taken again by ${req.owner} during restore`);
        }
        entry.spec = spec;
        entry.owner = req.owner;
        entry.value = req.value;
        entry.error = null;
        entry.expires = this.clock.now() + req.ttl*1000;
        this._armExpiry(entry);
        this._publish(entry);
        await this._flush(entry);
        return {ok:true, state:this.state(reg)};
    }
    _reject(reg, message) {
        const entry = this.leases.get(reg);
        if(entry!==undefined) entry.error = message;
        const state = entry!==undefined ? this._state(entry) : this._inactive(reg);
        state.error = message;
        this.publish(reg, state);
        const key = reg+'|'+message;
        const now = this.clock.now();
        const seen = this.rejectSeen.get(key);
        if(seen===undefined || now-seen>=REJECT_LOG_MS) {
            this.rejectSeen.set(key, now);
            this.log(`Lease request for ${reg} rejected: ${message}`);
        }
        return {ok:false, error:message};
    }
    // Writes entry.value unless it is already written, at most once per
    // min_interval per register. A value arriving inside the interval is
    // written when it ends; whatever the latest value is then wins.
    async _flush(entry) {
        const reg = entry.reg;
        if(this.leases.get(reg)!==entry || entry.status!=='active') return;
        if(entry.value===null || entry.value===entry.written) return;
        const interval = entry.spec.min_interval*1000;
        const now = this.clock.now();
        const last = this.lastWrite.get(reg);
        if(last!==undefined && now-last<interval) {
            if(entry.timers.write===undefined) {
                entry.timers.write = this.clock.setTimeout(() => {
                    entry.timers.write = undefined;
                    this._run(reg, () => this._flush(entry));
                }, last+interval-now);
            }
            return;
        }
        const value = entry.value;
        this.lastWrite.set(reg, now);
        try {
            await this.write(reg, value);
        } catch(err) {
            entry.error = `Write failed: ${errorText(err)}`;
            this.log(`Lease ${reg}: could not write ${value}: ${errorText(err)}`);
            this._publish(entry);
            // Retried no faster than the interval, and never in a tight loop
            // when min_interval is 0.
            if(entry.timers.write===undefined) {
                entry.timers.write = this.clock.setTimeout(() => {
                    entry.timers.write = undefined;
                    this._run(reg, () => this._flush(entry));
                }, Math.max(interval, RESTORE_RETRY_MIN_MS));
            }
            return;
        }
        if(this.leases.get(reg)!==entry) return;
        entry.written = value;
        entry.error = null;
        this._publish(entry);
    }
    _armExpiry(entry) {
        this._clearTimer(entry, 'expiry');
        const delay = Math.max(0, entry.expires - this.clock.now());
        entry.timers.expiry = this.clock.setTimeout(() => {
            entry.timers.expiry = undefined;
            this._run(entry.reg, () => this._expire(entry));
        }, delay);
    }
    async _expire(entry) {
        if(this.leases.get(entry.reg)!==entry || entry.status!=='active') return;
        if(this.clock.now()<entry.expires) return this._armExpiry(entry);
        this.fault(`Lease för ${entry.reg} gick ut, återställer`);
        this.log(`Lease ${entry.reg} (${entry.owner}) expired, restoring`);
        await this._restore(entry, 'expired');
    }
    release(reg) {
        reg = String(reg);
        return this._run(reg, async () => {
            const entry = this.leases.get(reg);
            if(entry===undefined) {
                this.publish(reg, this._inactive(reg));
                return;
            }
            if(entry.status==='restoring') return;
            this.log(`Lease ${reg} released by ${entry.owner}`);
            await this._restore(entry, 'released');
        });
    }
    // Writes neutral, or else the baseline. Until that write succeeds the
    // register stays owned, so nobody else writes in between.
    async _restore(entry, reason) {
        const reg = entry.reg;
        this._clearTimer(entry, 'write');
        this._clearTimer(entry, 'expiry');
        this._clearTimer(entry, 'retry');
        entry.status = 'restoring';
        entry.reason = reason;
        const neutral = this.neutral(reg, entry.spec);
        const target = neutral!==null ? neutral : entry.baseline;
        if(target===null || !Number.isFinite(target)) {
            this.fault(`Lease för ${reg} saknar värde att återställa till, släpper registret`);
            return this._finish(entry, null, reason);
        }
        this._publish(entry);
        this.lastWrite.set(reg, this.clock.now());
        try {
            await this.write(reg, target);
        } catch(err) {
            const delay = entry.retryDelay;
            entry.retryDelay = Math.min(delay*2, RESTORE_RETRY_MAX_MS);
            entry.error = `Restore failed: ${errorText(err)}`;
            this.log(`Lease ${reg}: restore to ${target} failed (${errorText(err)}), retrying in ${delay/1000} s`);
            if(delay===RESTORE_RETRY_MIN_MS || delay===RESTORE_RETRY_MAX_MS) {
                this.fault(`Kunde inte återställa register ${reg} till ${target} (${errorText(err)}), försöker igen om ${delay/1000} s`);
            }
            entry.timers.retry = this.clock.setTimeout(() => {
                entry.timers.retry = undefined;
                this._run(reg, async () => {
                    if(this.leases.get(reg)===entry && entry.status==='restoring') await this._restore(entry, entry.reason);
                });
            }, delay);
            this._publish(entry);
            return;
        }
        if(entry.retryDelay!==RESTORE_RETRY_MIN_MS) this.fault(`Register ${reg} är återställt till ${target}`);
        this.log(`Lease ${reg} restored to ${target} (${reason})`);
        await this._finish(entry, target, reason);
    }
    async _finish(entry, written, reason) {
        this._clearTimer(entry, 'retry');
        if(this.leases.get(entry.reg)===entry) this.leases.delete(entry.reg);
        await this._persist();
        const state = this._inactive(entry.reg);
        state.written = written;
        this.publish(entry.reg, state);
    }
    async _persist() {
        try {
            await this.persist(this.baselines());
        } catch(err) {
            this.log(`Could not persist lease baselines: ${errorText(err)}`);
        }
    }
    _clearTimer(entry, name) {
        if(entry.timers[name]!==undefined) {
            this.clock.clearTimeout(entry.timers[name]);
            entry.timers[name] = undefined;
        }
    }
    // Name of whoever holds reg, or null: other writers are refused while set.
    ownerOf(reg) {
        const entry = this.leases.get(String(reg));
        if(entry===undefined) return null;
        return entry.status==='restoring' ? `${entry.owner} (restoring)` : entry.owner;
    }
    // Error for a write to reg that does not come from this module while the
    // register is leased, else null. setData calls it for every write.
    writeRefusal(reg, fromLease=false) {
        if(fromLease===true) return null;
        const owner = this.ownerOf(reg);
        return owner===null ? null : new Error(`Register ${reg} is leased by ${owner}`);
    }
    baselines() {
        const out = {};
        for (const [reg, entry] of this.leases) out[reg] = entry.baseline;
        return out;
    }
    _state(entry) {
        return {active:entry.status==='active', restoring:entry.status==='restoring',
            value:entry.value, written:entry.written, expires:entry.expires,
            baseline:entry.baseline, neutral:this.neutral(entry.reg, entry.spec),
            owner:entry.owner, error:entry.error};
    }
    _inactive(reg) {
        return {active:false, restoring:false, value:null, written:null, expires:null,
            baseline:null, neutral:this.neutral(reg, this.table[reg]), owner:null, error:null};
    }
    _publish(entry) {
        if(this.leases.get(entry.reg)===entry) this.publish(entry.reg, this._state(entry));
    }
    state(reg) {
        reg = String(reg);
        const entry = this.leases.get(reg);
        return entry!==undefined ? this._state(entry) : this._inactive(reg);
    }
    // Leased registers; with all, every register in the table as well (after
    // a broker reconnect, so a stale retained state is overwritten).
    publishAll(all=false) {
        const regs = new Set(this.leases.keys());
        if(all===true) for (const reg of Object.keys(this.table)) regs.add(reg);
        for (const reg of regs) this.publish(reg, this.state(reg));
    }
    summary() {
        const out = {};
        for (const [reg, entry] of this.leases) {
            out[reg] = {active:entry.status==='active', expires:entry.expires};
            if(entry.status==='restoring') out[reg].restoring = true;
        }
        return out;
    }
    // Shutdown: timers stop, nothing is restored. Persisted baselines start
    // grace leases on the next run.
    stop() {
        this.stopped = true;
        for (const entry of this.leases.values()) {
            for (const name of Object.keys(entry.timers)) this._clearTimer(entry, name);
        }
    }
}

// Why a plain <topic><reg>/set may not write reg, or null when it may.
// policy is config.gateway.raw_set: "all" (default), "none" or a list of
// registers. Anything else refuses: an unreadable policy fails closed.
function rawSetRefusal(policy, reg, owner) {
    reg = String(reg);
    if(owner!==null && owner!==undefined) return `register ${reg} is leased by ${owner}`;
    if(policy===undefined || policy===null || policy==='all') return null;
    if(policy==='none') return 'raw /set is disabled (gateway.raw_set "none")';
    if(Array.isArray(policy)) {
        return policy.some(r => String(r)===reg) ? null : `register ${reg} is not in gateway.raw_set`;
    }
    return `gateway.raw_set ${JSON.stringify(policy)} is not "all", "none" or a list`;
}

module.exports = {
    LeaseManager: LeaseManager,
    rawSetRefusal: rawSetRefusal,
    buildTable: buildTable,
    neutralValue: neutralValue,
    parseRequest: parseRequest,
    DEFAULT_LEASES: DEFAULT_LEASES,
    DEFAULT_TTL: DEFAULT_TTL
};
