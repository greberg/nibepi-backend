'use strict';
// Status page (lib/webui.js): the status JSON and its redaction, basic auth,
// /healthz, /api/log, and that the server starts and stops cleanly.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const WebUI = require('../lib/webui');
const log = require('../log');

const NOW = 1760100000000;
const SECRET = 'mqtt-s3cret-pw';

const config = () => ({
    connection: {enable: 'serial'}, serial: {port: '/dev/ttyAMA0'},
    mqtt: {host: 'broker.lan', port: '1883', user: 'nibepi', pass: SECRET, topic: 'nibe/modbus/'},
    system: {rmu_emulation: true}, gateway: {raw_set: 'none'}
});

const lease = (reg, extra) => Object.assign({register: reg, name: 'n', min: -10, max: 10, active: false, restoring: false,
    value: null, written: null, expires: null, baseline: null, neutral: 0, neutral_from: null, owner: null, error: null}, extra);

const snapshot = (extra = {}) => Object.assign({
    version: '2.0.0',
    core: {state: 'up', restarts: 1, model: 'F1255', firmware: 9000, lastData: NOW - 5000, connected: true},
    busHealth: {timestamp: NOW - 30000, ok: 400, chksum: 1, no_respond: 2, errors: 3},
    busHistory: [{timestamp: NOW - 90000, ok: 410, chksum: 0, no_respond: 0, errors: 0}, {timestamp: NOW - 30000, ok: 400, chksum: 1, no_respond: 2, errors: 3}],
    mqtt: {connected: true, active: true, connects: 2, reconnects: 1, lastConnect: NOW - 60000, lastDisconnect: NOW - 70000,
        lastError: 'Connection refused: Not authorized', lastErrorAt: NOW - 70000},
    rawSet: 'none',
    leases: [lease('47011', {active: true, value: -2, written: -2, owner: 'ha', expires: NOW + 600000, baseline: 0}),
        lease('10060', {neutral: null, neutral_from: '47398'})],
    rmu: [
        {system: 1, address: 0x19, detected: true, writable: true, lastPoll: NOW - 2000, readOnly: false, roomRegister: '10060',
            room: {register: '10060', title: 'Room', value: 21.5, unit: '°C', timestamp: NOW - 2000},
            lastWrite: {value: 21.5, at: NOW - 3000, ok: true, error: null}, lease: lease('10060', {neutral_from: '47398'})},
        {system: 2, address: 0x1A, detected: true, writable: false, lastPoll: NOW - 2000, readOnly: true, roomRegister: '10160', room: null, lastWrite: null, lease: null},
        {system: 3, address: 0x1B, detected: false, writable: null, lastPoll: null, readOnly: null, roomRegister: '10260', room: null, lastWrite: null, lease: null}
    ],
    values: [{register: '40004', title: 'BT1 Outdoor Temperature', value: 3.4, raw: 34, unit: '°C', timestamp: NOW - 10000}]
}, extra);

test('status JSON shape', () => {
    const s = WebUI.buildStatus(snapshot(), config(), {now: NOW, uptime: 120, logLevel: 'info', auth: true});
    for (const key of ['generated', 'version', 'uptime_s', 'started', 'config', 'core', 'bus', 'mqtt', 'raw_set', 'leases', 'rmu', 'values', 'alerts', 'ui']) {
        assert.ok(key in s, key);
    }
    assert.equal(s.core.state, 'up');
    assert.equal(s.core.model, 'F1255');
    assert.equal(s.core.firmware, '9000');
    assert.equal(s.core.last_data_age_s, 5);
    assert.equal(s.core.data_ok, true);
    assert.equal(s.uptime_s, 120);
    assert.deepEqual(s.config.mqtt, {enabled: true, host: 'broker.lan', port: 1883, topic: 'nibe/modbus/', user: 'nibepi', password_set: true, discovery: false});
    assert.equal(s.config.serial_port, '/dev/ttyAMA0');
    assert.equal(s.config.nibegw, null);
    assert.equal(s.bus.last_minute.errors, 3);
    assert.equal(s.bus.history.length, 2);
    assert.equal(s.mqtt.connected, true);
    assert.equal(s.mqtt.reconnects, 1);
    assert.equal(s.raw_set, 'none');
    assert.equal(s.leases[0].expires_in_s, 600);
    assert.equal(s.leases[1].neutral_from, '47398');
    assert.deepEqual(s.rmu.map(r => r.mode), ['emulated', 'read-only', 'not-detected']);
    assert.equal(s.rmu[1].reason, 'Another RMU40 answers on the bus');
    assert.equal(s.rmu[0].last_write.value, 21.5);
    assert.equal(s.rmu[0].last_poll_age_s, 2);
    assert.equal(s.values[0].name, 'Outdoor (BT1)');
    assert.deepEqual(s.alerts, []);
    assert.equal(s.ui.auth, true);
});

test('rmu_emulation false explains read-only', () => {
    const cfg = config();
    cfg.system.rmu_emulation = false;
    const s = WebUI.buildStatus(snapshot(), cfg, {now: NOW});
    assert.equal(s.rmu[1].reason, 'system.rmu_emulation is false');
    assert.equal(s.config.rmu_emulation, false);
});

test('the password never appears, wherever it hides', () => {
    const cfg = config();
    cfg.mqtt.host = `user:${SECRET}@broker.lan`;
    const snap = snapshot();
    snap.mqtt.lastError = `bad password ${SECRET}`;
    snap.leases[0].error = SECRET;
    const s = WebUI.buildStatus(snap, cfg, {now: NOW, secrets: [SECRET]});
    const text = JSON.stringify(s);
    assert.equal(text.includes(SECRET), false);
    assert.equal(text.includes('"pass"'), false);
    assert.equal(s.config.mqtt.host, 'broker.lan');
    // Not even without the secrets list: the config summary has no password field.
    assert.equal(JSON.stringify(WebUI.buildStatus(snapshot(), config(), {now: NOW})).includes(SECRET), false);
});

test('nibegw mode summary', () => {
    const s = WebUI.configSummary({connection: {enable: 'nibegw'}, serial: {port: 'gw.lan'}, nibegw: {}, mqtt: {}});
    assert.deepEqual(s.nibegw, {host: 'gw.lan', port: 9999});
    assert.equal(s.serial_port, null);
    assert.equal(s.mqtt.enabled, false);
});

test('alerts: core down, MQTT disconnected, no data for 10 minutes', () => {
    const snap = snapshot({core: {state: 'down', restarts: 3, model: '', lastData: NOW - 601000}});
    snap.mqtt.connected = false;
    const s = WebUI.buildStatus(snap, config(), {now: NOW});
    const texts = s.alerts.map(a => a.text).join('\n');
    assert.match(texts, /core is down/);
    assert.match(texts, /No data from the pump for 10 minutes/);
    assert.match(texts, /MQTT is disconnected/);
    assert.equal(s.core.data_ok, false);
});

test('/healthz rule: lastData within 10 minutes', () => {
    assert.equal(WebUI.healthOf({lastData: NOW - 599000}, NOW).ok, true);
    assert.equal(WebUI.healthOf({lastData: NOW - 600000}, NOW).ok, false);
    assert.equal(WebUI.healthOf({lastData: null}, NOW).ok, false);
    assert.equal(WebUI.healthOf({}, NOW).ok, false);
});

test('basic auth accepts the right pair only', () => {
    const h = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
    assert.equal(WebUI.checkAuth(undefined, null, null), true);
    assert.equal(WebUI.checkAuth(h('admin', 'pw:with:colons'), 'admin', 'pw:with:colons'), true);
    assert.equal(WebUI.checkAuth(h('admin', 'wrong'), 'admin', 'pw'), false);
    assert.equal(WebUI.checkAuth(h('root', 'pw'), 'admin', 'pw'), false);
    assert.equal(WebUI.checkAuth(undefined, 'admin', 'pw'), false);
    assert.equal(WebUI.checkAuth('Bearer x', 'admin', 'pw'), false);
    assert.equal(WebUI.checkAuth('Basic ' + Buffer.from('nocolon').toString('base64'), 'admin', 'pw'), false);
});

test('the page has a CSP that allows only its own inline blocks', () => {
    const page = WebUI.loadPage();
    assert.match(page.html, /<title>NibePi gateway<\/title>/);
    assert.equal(/(src|href)=["']https?:/i.test(page.html), false, 'no external resources');
    assert.match(page.csp, /script-src 'sha256-[A-Za-z0-9+/=]+'/);
    assert.match(page.csp, /default-src 'none'/);
    assert.equal(page.html.includes('\r'), false);
});

// ---- the server --------------------------------------------------------------

const request = (port, pathname, opts = {}) => new Promise((resolve, reject) => {
    const req = http.request({host: '127.0.0.1', port: port, path: pathname, method: opts.method || 'GET', headers: opts.headers || {}}, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8')}));
    });
    req.on('error', reject);
    req.end();
});

async function withServer(opts, fn) {
    let lastData = NOW - 5000;
    const source = {
        getStatus: () => snapshot({core: {state: 'up', restarts: 0, model: 'F1255', firmware: 9000, lastData: lastData}}),
        getConfig: config,
        getHealth: () => ({core: 'up', lastData: lastData})
    };
    const ui = WebUI.createWebUI(Object.assign({source: source, log: log, now: () => NOW, uptime: () => 60, secrets: () => [SECRET]}, opts));
    const addr = await ui.listen(0, '127.0.0.1');
    try {
        await fn(addr.port, (v) => { lastData = v; });
    } finally {
        await ui.close();
    }
    assert.equal(ui.server.listening, false);
}

test('server: endpoints without auth', async () => {
    log.setLevel('error');
    log.clearRecent();
    log.warn('MQTT', `oops ${SECRET}`);
    log.info('Core', 'hello');
    await withServer({}, async (port, setLastData) => {
        const page = await request(port, '/');
        assert.equal(page.status, 200);
        assert.match(page.headers['content-type'], /text\/html/);
        assert.match(page.headers['content-security-policy'], /default-src 'none'/);
        assert.match(page.body, /NibePi gateway/);

        const status = await request(port, '/api/status');
        assert.equal(status.status, 200);
        assert.equal(status.headers['cache-control'], 'no-store');
        const s = JSON.parse(status.body);
        assert.equal(s.core.model, 'F1255');
        assert.equal(status.body.includes(SECRET), false);

        const logs = JSON.parse((await request(port, '/api/log?level=warn&limit=5')).body);
        assert.equal(logs.level, 'warn');
        assert.equal(logs.lines.length, 1);
        assert.equal(logs.lines[0].area, 'MQTT');
        assert.equal(JSON.stringify(logs).includes(SECRET), false);
        const all = JSON.parse((await request(port, '/api/log?level=bogus&limit=99999')).body);
        assert.equal(all.level, 'info');
        assert.equal(all.limit, 500);
        assert.deepEqual(all.lines.map(l => l.message.split(' ')[0]), ['hello', 'oops']);

        assert.equal((await request(port, '/healthz')).status, 200);
        setLastData(NOW - 11 * 60000);
        const sick = await request(port, '/healthz');
        assert.equal(sick.status, 503);
        assert.equal(JSON.parse(sick.body).ok, false);

        assert.equal((await request(port, '/nope')).status, 404);
        const post = await request(port, '/api/status', {method: 'POST'});
        assert.equal(post.status, 405);
        assert.equal(post.headers.allow, 'GET, HEAD');
        const head = await request(port, '/api/status', {method: 'HEAD'});
        assert.equal(head.status, 200);
        assert.equal(head.body, '');
    });
});

test('server: basic auth on everything but /healthz', async () => {
    const auth = 'Basic ' + Buffer.from('admin:ui-pass-123').toString('base64');
    await withServer({user: 'admin', pass: 'ui-pass-123'}, async (port) => {
        for (const p of ['/', '/api/status', '/api/log']) {
            const r = await request(port, p);
            assert.equal(r.status, 401, p);
            assert.match(r.headers['www-authenticate'], /^Basic realm="NibePi gateway"/);
        }
        const bad = await request(port, '/api/status', {headers: {authorization: 'Basic ' + Buffer.from('admin:nope').toString('base64')}});
        assert.equal(bad.status, 401);
        const ok = await request(port, '/api/status', {headers: {authorization: auth}});
        assert.equal(ok.status, 200);
        assert.equal(ok.body.includes('ui-pass-123'), false);
        assert.equal(JSON.parse(ok.body).ui.auth, true);
        assert.equal((await request(port, '/healthz')).status, 200);
    });
});

test('server: a busy port rejects listen, close is safe twice', async () => {
    const ui1 = WebUI.createWebUI({source: {getStatus: snapshot, getConfig: config}, log: log});
    const addr = await ui1.listen(0, '127.0.0.1');
    const ui2 = WebUI.createWebUI({source: {getStatus: snapshot, getConfig: config}, log: log});
    await assert.rejects(ui2.listen(addr.port, '127.0.0.1'), /EADDRINUSE/);
    await ui1.close();
    await ui1.close();
    await ui2.close();
});

// index.js getStatus() against a scratch config dir, through buildStatus.
test('index.js getStatus has the fields buildStatus reads, and no password', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nibepi-ui-'));
    try {
        const script = `
            const nibe = require(${JSON.stringify(path.join(__dirname, '..', 'index.js'))});
            const WebUI = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'webui.js'))});
            nibe.applyOverrides([{path:['mqtt','pass'], value:${JSON.stringify(SECRET)}}, {path:['mqtt','host'], value:'broker'}]);
            const snap = nibe.getStatus();
            const s = WebUI.buildStatus(snap, nibe.getConfig(), {});
            process.stdout.write(JSON.stringify({snap, s}));
            nibe.shutdown().then(() => process.exit(0));`;
        const out = execFileSync(process.execPath, ['-e', script], {env: Object.assign({}, process.env, {NIBEPI_CONFIG_DIR: dir, NIBEPI_LOG_LEVEL: 'error'}), stdio: ['ignore', 'pipe', 'pipe']}).toString();
        assert.equal(out.includes(SECRET), false);
        const {snap, s} = JSON.parse(out);
        assert.equal(snap.core.state, 'down');
        assert.equal(snap.rmu.length, 4);
        assert.deepEqual(snap.rmu.map(r => r.roomRegister), ['10060', '10160', '10260', '10360']);
        assert.equal(snap.leases.find(l => l.register === '10060').neutral_from, '47398');
        assert.ok(snap.leases.length >= 15);
        assert.equal(s.mqtt.enabled, true);
        assert.equal(s.mqtt.connected, false);
        assert.equal(s.config.mqtt.password_set, true);
        assert.deepEqual(s.rmu.map(r => r.mode), ['not-detected', 'not-detected', 'not-detected', 'not-detected']);
    } finally {
        fs.rmSync(dir, {recursive: true, force: true});
    }
});
