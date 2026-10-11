#!/usr/bin/env node
'use strict';
// NibePi gateway: the core on the RS485 serial port (or a NibeGW), MQTT,
// register leases and the health file. Control logic lives elsewhere (the
// nibepi Home Assistant component) and talks to it over MQTT; the leases
// keep the pump safe on their own when that side disappears.
//
//   node gateway.js        (npm start)
//
// Settings come from <NIBEPI_CONFIG_DIR>/config.json (default /etc/nibepi),
// created from default.json on the first run, with the NIBEPI_* environment
// variables in lib/env.js on top. Logs go to stdout/stderr. With
// NIBEPI_UI_PORT set, a read-only status page (lib/webui.js) listens there.
const fs = require('fs');
const Env = require('./lib/env');
const log = require('./log');
const nibe = require('./index.js');
const WebUI = require('./lib/webui');

const HEALTH_FILE = Env.healthFile();
const HEALTH_MS = 60000;
const STOP_TIMEOUT_MS = 10000;
const NIBEGW_LISTEN_PORT = 9999;

nibe.data.on('fault', (data) => {
    if(data===undefined || data===null) return;
    log.warn(data.from, data.message);
});

function applyEnvironment() {
    const env = Env.readOverrides(process.env);
    for (const error of env.errors) log.error('Config', error);
    if(env.errors.length!==0) return false;
    nibe.applyOverrides(env.overrides);
    // Whether it came from config.json or the environment, the MQTT
    // password is masked in every log line from here on.
    const mqtt = nibe.getConfig().mqtt;
    if(mqtt!==null && typeof mqtt==='object') log.addSecret(mqtt.pass);
    const names = env.overrides.filter(o => !(o.path[0]==='mqtt' && o.path[1]==='enable')).map(o => o.path.join('.'));
    log.info('Config', `Config file ${nibe.getConfigFile()}`+(names.length!==0 ? `, from the environment: ${names.join(', ')}` : ''));
    log.info('Config', `Log level ${log.levelName()}, health file ${HEALTH_FILE}`);
    return true;
}

// The first start only: the backend supervises and restarts the core itself.
function startCore() {
    const config = nibe.getConfig();
    const mode = config.connection.enable===undefined ? 'serial' : config.connection.enable;
    const onReady = (err) => {
        if(err) log.error('Core', err);
        log.info('Core', `Nibe ${nibe.getConfig().system.pump} is connected`);
    };
    if(mode==='serial') {
        const port = typeof config.serial.port==='string' ? config.serial.port.trim() : '';
        if(port==='') {
            log.error('Config', 'No serial port: set NIBEPI_SERIAL_PORT or serial.port');
            return false;
        }
        if(!fs.existsSync(port)) {
            log.warn('Core', `Serial port ${port} does not exist, the core keeps retrying until it appears`);
        }
        log.info('Core', `Starting the core on serial port ${port}`);
        nibe.initiateCore(null, port, onReady);
        return true;
    }
    if(mode==='nibegw') {
        const gw = config.nibegw!==null && typeof config.nibegw==='object' ? config.nibegw : {};
        // Older configs kept the NibeGW host in serial.port.
        const host = typeof gw.host==='string' && gw.host.trim()!=='' ? gw.host.trim()
            : (typeof config.serial.port==='string' ? config.serial.port.trim() : '');
        const listen = Number(gw.port);
        const port = Number.isInteger(listen) && listen>0 && listen<=65535 ? listen : NIBEGW_LISTEN_PORT;
        if(host==='') {
            log.error('Config', 'No NibeGW host: set NIBEPI_NIBEGW_HOST or nibegw.host');
            return false;
        }
        log.info('Core', `Starting the NibeGW client for ${host}, listening on UDP ${port}`);
        nibe.initiateCore(host, port, onReady);
        return true;
    }
    log.error('Config', `connection.enable "${mode}" is not supported, use serial or nibegw (Modbus TCP was removed, see the nodered-final tag)`);
    return false;
}

// MQTT is on when a broker host is set (NIBEPI_MQTT_HOST or mqtt.host),
// unless config.json says mqtt.enable false and the environment does not
// set a host.
function startMQTT() {
    const mqtt = nibe.getConfig().mqtt;
    // Every gateway topic, leases included, hangs off this prefix.
    if(typeof mqtt.topic!=='string' || mqtt.topic==='') mqtt.topic = 'nibe/modbus/';
    const host = typeof mqtt.host==='string' ? mqtt.host.trim() : '';
    if(host==='') {
        log.warn('MQTT', 'No MQTT host (NIBEPI_MQTT_HOST or mqtt.host), MQTT is off');
        return;
    }
    if(mqtt.enable===false) {
        log.warn('MQTT', 'mqtt.enable is false in config.json, MQTT is off');
        return;
    }
    const port = mqtt.port===undefined || mqtt.port===null || mqtt.port==='' ? 1883 : mqtt.port;
    nibe.handleMQTT(true, host, port, mqtt.user, mqtt.pass, (err) => {
        if(err) log.error('MQTT', err.message ? err.message : err);
    });
}

// Same format config_node.js used, so the Docker HEALTHCHECK keeps working;
// there are no controllers here.
let healthErrorShown = false;
function writeHealth() {
    let health;
    try { health = nibe.getHealth(); } catch(err) { health = {}; }
    const out = {
        ts: Date.now(),
        core: health.core!==undefined ? health.core : null,
        model: health.model!==undefined && health.model!=="" ? health.model : null,
        lastData: Number.isFinite(Number(health.lastData)) && Number(health.lastData)>0 ? Number(health.lastData) : null,
        restarts: health.restarts!==undefined ? health.restarts : null,
        busHealth: health.busHealth!==undefined ? health.busHealth : null,
        controllers: {}
    };
    const tmp = HEALTH_FILE+'.tmp';
    const failed = (err) => {
        if(healthErrorShown===true) return;
        healthErrorShown = true;
        log.warn('Health', `Could not write ${HEALTH_FILE} (set NIBEPI_HEALTH_FILE): ${err.message}`);
    };
    fs.writeFile(tmp, JSON.stringify(out), (err) => {
        if(err) return failed(err);
        fs.rename(tmp, HEALTH_FILE, (err) => {
            if(err) return failed(err);
            healthErrorShown = false;
        });
    });
}

// The status page. Its errors are logged and never stop the gateway.
let webui;
function startUI() {
    const opts = Env.uiOptions(process.env);
    for (const error of opts.errors) log.error('UI', `${error}; the status page is off`);
    if(opts.enabled!==true) return;
    if(opts.pass!==null) log.addSecret(opts.pass);
    const mqttPass = () => {
        const mqtt = nibe.getConfig().mqtt;
        return (mqtt!==null && typeof mqtt==='object' && typeof mqtt.pass==='string' && mqtt.pass!=='') ? [mqtt.pass] : [];
    };
    try {
        webui = WebUI.createWebUI({source:nibe, log:log, user:opts.user, pass:opts.pass, secrets:mqttPass});
    } catch(err) {
        log.error('UI', `Could not load the status page: ${err.message}`);
        return;
    }
    webui.listen(opts.port, opts.bind).then(() => {
        const where = opts.bind==='0.0.0.0' || opts.bind==='::' ? `port ${opts.port}` : `${opts.bind}:${opts.port}`;
        log.info('UI', `Status page on ${where}`+(opts.user!==null ? ', basic auth on' : ', no auth (LAN only)'));
    }, (err) => {
        log.error('UI', `Could not start the status page on ${opts.bind}:${opts.port}: ${err.message}`);
        webui = undefined;
    });
}

let healthTimer;
let stopping = false;
// Leases are not released: their baselines are persisted, and the next start
// gives the owner one TTL to renew before restoring.
function stop(signal) {
    if(stopping===true) return;
    stopping = true;
    log.info('System', `${signal} received, stopping the gateway`);
    clearInterval(healthTimer);
    if(webui!==undefined) webui.close();
    setTimeout(() => {
        log.error('System', 'Stop timed out, exiting');
        process.exit(1);
    }, STOP_TIMEOUT_MS).unref();
    nibe.shutdown().then(() => {
        log.info('System', 'Gateway stopped');
        process.exit(0);
    }, (err) => {
        log.error('System', `Error while stopping: ${err && err.message ? err.message : err}`);
        process.exit(1);
    });
}
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
process.on('unhandledRejection', (reason) => {
    log.error('System', `Unhandled rejection: ${reason && reason.stack ? reason.stack : reason}`);
});
// Unknown state: exit and let the supervisor (Docker, systemd) restart us.
// The leases survive that through their persisted baselines.
process.on('uncaughtException', (err) => {
    log.error('System', `Uncaught exception: ${err && err.stack ? err.stack : err}`);
    process.exit(1);
});

if(applyEnvironment()!==true || startCore()!==true) {
    process.exit(1);
}
startMQTT();
startUI();
healthTimer = setInterval(writeHealth, HEALTH_MS);
writeHealth();
log.info('System', 'NibePi gateway started');
