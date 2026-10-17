'use strict';
// Read-only status page for the gateway: connection, bus health, the
// emulated RMU40 room units, leases, key register values and the recent
// warnings and errors. node:http only, no dependencies, and nothing here
// changes anything: every endpoint is a GET.
//
//   GET /             the page (lib/webui.html, self-contained: no CDN, the
//                     LAN may be offline)
//   GET /api/status   JSON snapshot, see buildStatus()
//   GET /api/log      recent log lines: ?level=info|warn|error&limit=1..500
//   GET /healthz      200 / 503 by the Docker healthcheck's rule: data from
//                     the pump within the last 10 minutes. No auth.
//
// gateway.js starts it when NIBEPI_UI_PORT is set (lib/env.js uiOptions).
// With NIBEPI_UI_USER and NIBEPI_UI_PASS set, everything but /healthz needs
// HTTP Basic auth. Passwords never leave the process: the snapshot is built
// from an allow-list of fields, and known secrets are masked on top.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const STALE_MS = 600000;          // the Docker HEALTHCHECK's limit for lastData
const LOG_LIMIT_DEFAULT = 200;
const LOG_LIMIT_MAX = 500;
const MASK = '***';
const PAGE_FILE = path.join(__dirname, 'webui.html');
const REALM = 'NibePi gateway';

// Names for the key values on the page.
const VALUE_NAMES = {
    '40004': 'Outdoor (BT1)',
    '40008': 'Supply S1 (BT2)',
    '40012': 'Return (BT3)',
    '40013': 'Hot water top (BT7)',
    '40014': 'Hot water charging (BT6)',
    '40033': 'Room S1 (BT50)',
    '47011': 'Curve offset S1',
    '43086': 'Priority'
};

const finite = (v) => (v!==null && v!==undefined && v!=='' && Number.isFinite(Number(v))) ? Number(v) : null;
const text = (v) => (typeof v==='string' && v.trim()!=='') ? v.trim() : null;
const age = (ts, now) => finite(ts)===null ? null : Math.max(0, Math.round((now-Number(ts))/1000));

// A broker host written as user:pass@host would carry credentials.
const stripUserinfo = (host) => {
    const h = text(host);
    return h===null ? null : h.replace(/^.*@/, '');
};

// Every string in value with a secret masked; a string equal to a secret
// (however short) becomes the mask.
function redactDeep(value, secrets) {
    const list = (secrets || []).filter(s => typeof s==='string' && s!=='').sort((a, b) => b.length-a.length);
    if(list.length===0) return value;
    const walk = (v) => {
        if(typeof v==='string') {
            if(list.includes(v)) return MASK;
            let out = v;
            for (const s of list) if(s.length>=4 && out.includes(s)) out = out.split(s).join(MASK);
            return out;
        }
        if(Array.isArray(v)) return v.map(walk);
        if(v!==null && typeof v==='object') {
            const out = {};
            for (const k of Object.keys(v)) out[k] = walk(v[k]);
            return out;
        }
        return v;
    };
    return walk(value);
}

// Deployment settings worth seeing, picked field by field from config.json
// (with the environment applied). Never the password itself.
function configSummary(config) {
    const c = (config!==null && typeof config==='object') ? config : {};
    const obj = (v) => (v!==null && typeof v==='object' && !Array.isArray(v)) ? v : {};
    const connection = obj(c.connection);
    const serial = obj(c.serial);
    const gw = obj(c.nibegw);
    const mqtt = obj(c.mqtt);
    const system = obj(c.system);
    const mode = connection.enable===undefined ? 'serial' : String(connection.enable);
    const host = stripUserinfo(mqtt.host);
    const port = finite(mqtt.port);
    return {
        connection: mode,
        serial_port: mode==='serial' ? text(serial.port) : null,
        nibegw: mode==='nibegw' ? {
            host: text(gw.host) || (mode==='nibegw' ? text(serial.port) : null),
            port: finite(gw.port) || 9999
        } : null,
        mqtt: {
            enabled: host!==null && mqtt.enable!==false,
            host: host,
            port: port===null ? 1883 : port,
            topic: text(mqtt.topic),
            user: text(mqtt.user),
            password_set: text(mqtt.pass)!==null,
            discovery: mqtt.discovery===true
        },
        rmu_emulation: system.rmu_emulation!==false
    };
}

function leaseView(l, now) {
    if(l===null || l===undefined) return null;
    return {
        register: l.register===undefined ? null : String(l.register),
        name: l.name===undefined ? null : l.name,
        min: l.min===undefined ? null : l.min,
        max: l.max===undefined ? null : l.max,
        active: l.active===true,
        restoring: l.restoring===true,
        value: l.value===undefined ? null : l.value,
        written: l.written===undefined ? null : l.written,
        owner: l.owner===undefined ? null : l.owner,
        expires: finite(l.expires),
        expires_in_s: finite(l.expires)===null ? null : Math.round((Number(l.expires)-now)/1000),
        baseline: l.baseline===undefined ? null : l.baseline,
        neutral: l.neutral===undefined ? null : l.neutral,
        neutral_from: l.neutral_from===undefined ? null : l.neutral_from,
        error: l.error===undefined ? null : l.error
    };
}

const valueView = (v, now) => (v===null || v===undefined) ? null : {
    register: String(v.register),
    name: VALUE_NAMES[String(v.register)] || null,
    title: v.title===undefined ? null : v.title,
    value: v.value===undefined ? null : v.value,
    unit: v.unit===undefined ? '' : v.unit,
    timestamp: finite(v.timestamp),
    age_s: age(v.timestamp, now)
};

// How a room unit looks from here:
//   not-detected  the pump has not polled that RMU40 (menu 5.2), or not yet
//   emulated      the core answers the pump as this RMU40; 10x60 is writable
//   read-only     another RMU40 answers, or system.rmu_emulation is false
function rmuView(r, emulation, now) {
    const detected = r.detected===true;
    let mode = 'not-detected';
    let reason = 'The pump has not polled this RMU40 since the core started (enable it in menu 5.2)';
    if(detected) {
        const readOnly = r.readOnly===true || r.writable===false;
        if(readOnly) {
            mode = 'read-only';
            reason = emulation===false ? 'system.rmu_emulation is false' : 'Another RMU40 answers on the bus';
        } else {
            mode = 'emulated';
            reason = 'NibePi answers the pump as this RMU40';
        }
    }
    const w = r.lastWrite;
    return {
        system: r.system,
        address: finite(r.address),
        detected: detected,
        mode: mode,
        reason: reason,
        last_poll: finite(r.lastPoll),
        last_poll_age_s: age(r.lastPoll, now),
        room_register: r.roomRegister===undefined ? null : String(r.roomRegister),
        room: valueView(r.room, now),
        last_write: (w===null || w===undefined) ? null : {
            value: w.value===undefined ? null : w.value,
            at: finite(w.at),
            age_s: age(w.at, now),
            ok: w.ok===true,
            error: w.error===undefined ? null : w.error
        },
        lease: leaseView(r.lease, now)
    };
}

// Problems worth a banner across the top of the page.
function alertsFor(s) {
    const out = [];
    if(s.core.state==='down') out.push({level:'error', text:'The core is down'+(s.core.restarts>0 ? ` (${s.core.restarts} restarts)` : '')});
    else if(s.core.state==='starting') out.push({level:'warn', text:'The core is starting'});
    if(!s.core.data_ok) {
        out.push({level:'error', text: s.core.last_data===null ? 'No data from the pump yet'
            : `No data from the pump for ${Math.round(s.core.last_data_age_s/60)} minutes`});
    }
    if(s.mqtt.enabled && !s.mqtt.connected) out.push({level:'error', text:'MQTT is disconnected'+(s.mqtt.last_error ? `: ${s.mqtt.last_error}` : '')});
    else if(!s.mqtt.enabled) out.push({level:'warn', text:'MQTT is off (no NIBEPI_MQTT_HOST)'});
    for (const l of s.leases) {
        if(l.error) out.push({level:'warn', text:`Lease ${l.register}: ${l.error}`});
    }
    return out;
}

// The /api/status body from getStatus() (index.js) and getConfig().
// opts: now, uptime (s), logLevel, auth (bool), secrets [strings].
function buildStatus(snapshot, config, opts = {}) {
    const now = finite(opts.now) || Date.now();
    const snap = (snapshot!==null && typeof snapshot==='object') ? snapshot : {};
    const core = snap.core || {};
    const mqtt = snap.mqtt || {};
    const cfg = configSummary(config);
    const lastData = finite(core.lastData);
    const bus = snap.busHealth || null;
    const busPoint = (b) => ({timestamp:finite(b.timestamp), ok:finite(b.ok) || 0, chksum:finite(b.chksum) || 0,
        no_respond:finite(b.no_respond) || 0, errors:finite(b.errors) || 0});
    const uptime = finite(opts.uptime);
    const status = {
        generated: now,
        version: snap.version===undefined ? null : snap.version,
        build: typeof snap.build==='string' ? snap.build : null,
        uptime_s: uptime===null ? null : Math.round(uptime),
        started: uptime===null ? null : Math.round(now-uptime*1000),
        log_level: opts.logLevel || null,
        config: cfg,
        core: {
            state: core.state || 'down',
            connected: core.connected===true,
            restarts: finite(core.restarts) || 0,
            model: text(core.model),
            firmware: (core.firmware===undefined || core.firmware==='' || core.firmware===null) ? null : String(core.firmware),
            last_data: lastData,
            last_data_age_s: age(lastData, now),
            data_ok: lastData!==null && now-lastData<STALE_MS
        },
        bus: {
            last_minute: bus===null ? null : busPoint(bus),
            history: Array.isArray(snap.busHistory) ? snap.busHistory.map(busPoint) : []
        },
        mqtt: {
            enabled: cfg.mqtt.enabled,
            connected: mqtt.connected===true,
            connects: finite(mqtt.connects) || 0,
            reconnects: finite(mqtt.reconnects) || 0,
            last_connect: finite(mqtt.lastConnect),
            last_disconnect: finite(mqtt.lastDisconnect),
            last_error: mqtt.lastError===undefined ? null : mqtt.lastError,
            last_error_at: finite(mqtt.lastErrorAt)
        },
        raw_set: snap.rawSet===undefined ? 'all' : snap.rawSet,
        leases: Array.isArray(snap.leases) ? snap.leases.map(l => leaseView(l, now)) : [],
        rmu: Array.isArray(snap.rmu) ? snap.rmu.map(r => rmuView(r, cfg.rmu_emulation, now)) : [],
        values: Array.isArray(snap.values) ? snap.values.map(v => valueView(v, now)).filter(v => v!==null) : [],
        ui: {auth: opts.auth===true}
    };
    status.alerts = alertsFor(status);
    return redactDeep(status, opts.secrets);
}

// /healthz: the HEALTHCHECK's pump rule (lastData within 10 minutes).
function healthOf(health, now = Date.now()) {
    const h = health || {};
    const lastData = finite(h.lastData);
    const ok = lastData!==null && now-lastData<STALE_MS;
    return {ok:ok, core:h.core || null, last_data:lastData, last_data_age_s:age(lastData, now)};
}

const sha256 = (v) => crypto.createHash('sha256').update(String(v), 'utf8').digest();
// Constant time for any lengths: both sides are hashed to 32 bytes first.
const safeEqual = (a, b) => crypto.timingSafeEqual(sha256(a), sha256(b));

// true when no user is configured, or the Authorization header matches.
function checkAuth(header, user, pass) {
    if(user===null || user===undefined) return true;
    if(typeof header!=='string') return false;
    const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header);
    if(m===null) return false;
    const decoded = Buffer.from(m[1], 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    if(i<0) return false;
    // Both compared every time, so the timing says nothing about which failed.
    const userOk = safeEqual(decoded.slice(0, i), user);
    const passOk = safeEqual(decoded.slice(i+1), pass);
    return userOk && passOk;
}

// The page, and a Content-Security-Policy that allows exactly its inline
// <style> and <script> blocks (by hash) and nothing from anywhere else.
function loadPage(file = PAGE_FILE) {
    // Served with LF line ends: browsers normalise CRLF before hashing an
    // inline block, so the hashes must be taken over LF text.
    const html = fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n');
    const hashes = (tag) => {
        const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g');
        const out = [];
        let m;
        while((m = re.exec(html))!==null) out.push(`'sha256-${crypto.createHash('sha256').update(m[1], 'utf8').digest('base64')}'`);
        return out.join(' ');
    };
    const csp = [
        "default-src 'none'",
        `script-src ${hashes('script') || "'none'"}`,
        `style-src ${hashes('style') || "'none'"}`,
        "connect-src 'self'",
        "img-src 'self' data:",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'"
    ].join('; ');
    return {html:html, csp:csp};
}

const BASE_HEADERS = {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY'
};

// opts: source {getStatus, getConfig, getHealth}, log {recent, levelName,
// warn}, user, pass, secrets() -> [strings], uptime() -> s, now() -> ms,
// page {html, csp} (default: loadPage()).
function createWebUI(opts = {}) {
    const source = opts.source;
    const log = opts.log || {};
    const user = opts.user===undefined ? null : opts.user;
    const pass = opts.pass===undefined ? null : opts.pass;
    const now = opts.now || (() => Date.now());
    const uptime = opts.uptime || (() => process.uptime());
    const secrets = () => {
        const list = typeof opts.secrets==='function' ? opts.secrets() : (opts.secrets || []);
        return pass!==null ? list.concat([pass]) : list;
    };
    const page = opts.page || loadPage();
    let errorShown = false;

    const send = (req, res, code, type, body, extra = {}) => {
        const buf = Buffer.from(body, 'utf8');
        res.writeHead(code, Object.assign({}, BASE_HEADERS, {
            'Content-Type': type,
            'Content-Length': buf.length
        }, extra));
        res.end(req.method==='HEAD' ? undefined : buf);
    };
    const json = (req, res, code, value) => send(req, res, code, 'application/json; charset=utf-8',
        JSON.stringify(redactDeep(value, secrets())), {'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'"});

    const routes = {
        '/': (req, res) => send(req, res, 200, 'text/html; charset=utf-8', page.html, {'Content-Security-Policy': page.csp}),
        '/api/status': (req, res) => {
            const status = buildStatus(source.getStatus(), source.getConfig(), {
                now: now(), uptime: uptime(), auth: user!==null, secrets: secrets(),
                logLevel: typeof log.levelName==='function' ? log.levelName() : null
            });
            json(req, res, 200, status);
        },
        '/api/log': (req, res, url) => {
            const level = ['error', 'warn', 'info'].includes(url.searchParams.get('level')) ? url.searchParams.get('level') : 'info';
            let limit = Number(url.searchParams.get('limit'));
            if(!Number.isInteger(limit) || limit<=0) limit = LOG_LIMIT_DEFAULT;
            limit = Math.min(limit, LOG_LIMIT_MAX);
            const lines = typeof log.recent==='function' ? log.recent({level:level, limit:limit}) : [];
            json(req, res, 200, {level:level, limit:limit, lines:lines});
        },
        '/healthz': (req, res) => {
            const h = healthOf(typeof source.getHealth==='function' ? source.getHealth() : {}, now());
            json(req, res, h.ok ? 200 : 503, h);
        }
    };

    const handler = (req, res) => {
        try {
            const url = new URL(req.url, 'http://localhost');
            const route = routes[url.pathname];
            if(route===undefined) return send(req, res, 404, 'text/plain; charset=utf-8', 'Not found\n');
            if(req.method!=='GET' && req.method!=='HEAD') {
                return send(req, res, 405, 'text/plain; charset=utf-8', 'Read-only: GET only\n', {'Allow': 'GET, HEAD'});
            }
            if(url.pathname!=='/healthz' && !checkAuth(req.headers.authorization, user, pass)) {
                return send(req, res, 401, 'text/plain; charset=utf-8', 'Authentication required\n',
                    {'WWW-Authenticate': `Basic realm="${REALM}", charset="UTF-8"`});
            }
            route(req, res, url);
        } catch(err) {
            if(errorShown===false && typeof log.warn==='function') {
                errorShown = true;
                log.warn('UI', `Status page error: ${err && err.message ? err.message : err}`);
            }
            if(!res.headersSent) send(req, res, 500, 'text/plain; charset=utf-8', 'Internal error\n');
            else res.destroy();
        }
    };

    const server = http.createServer(handler);
    // A slow or idle client must not hold a socket for long.
    server.requestTimeout = 10000;
    server.headersTimeout = 10000;
    server.keepAliveTimeout = 5000;

    const listen = (port, host) => new Promise((resolve, reject) => {
        const failed = (err) => reject(err);
        server.once('error', failed);
        server.listen(port, host, () => {
            server.removeListener('error', failed);
            server.on('error', (err) => {
                if(typeof log.warn==='function') log.warn('UI', `Status page server error: ${err.message}`);
            });
            resolve(server.address());
        });
    });
    const close = () => new Promise((resolve) => {
        if(!server.listening) return resolve();
        server.close(() => resolve());
        if(typeof server.closeAllConnections==='function') server.closeAllConnections();
    });
    return {server:server, listen:listen, close:close, handler:handler};
}

module.exports = {
    createWebUI: createWebUI,
    buildStatus: buildStatus,
    configSummary: configSummary,
    healthOf: healthOf,
    checkAuth: checkAuth,
    redactDeep: redactDeep,
    loadPage: loadPage,
    STALE_MS: STALE_MS,
    VALUE_NAMES: VALUE_NAMES
};
