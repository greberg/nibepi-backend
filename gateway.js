#!/usr/bin/env node
'use strict';
// NibePi as a standalone gateway, without Node-RED: the core on the serial
// port (or NibeGW / Modbus TCP), MQTT, register leases and the health file.
// Control logic lives elsewhere (Home Assistant) and talks to it over MQTT;
// the leases keep the pump safe on their own when that side disappears.
//
//   node gateway.js        (npm run gateway)
//
// Settings come from /etc/nibepi/config.json as for the Node-RED setup.
// Logs go to stdout.
const fs = require('fs');
const nibe = require('./index.js');

const HEALTH_FILE = '/dev/shm/nibepi-health.json';
const HEALTH_MS = 60000;
const STOP_TIMEOUT_MS = 10000;

const ensure = (config, key) => {
    if(config[key]===null || typeof config[key]!=='object') config[key] = {};
    return config[key];
};

nibe.data.on('fault', (data) => {
    if(data===undefined || data===null) return;
    console.log(`[fault] ${data.from}: ${data.message}`);
});

// Same steps as handleCore in node-red-contrib-nibepi's config_node.js, for
// the first start only: the backend supervises and restarts the core itself.
function startCore() {
    const config = nibe.getConfig();
    const connection = ensure(config, 'connection');
    const serial = ensure(config, 'serial');
    const tcp = ensure(config, 'tcp');
    console.log(`Heatpump series: ${connection.series}`);
    const onReady = (err) => {
        if(err) console.log(err);
        const conf = nibe.getConfig();
        const name = connection.series==="sSeries" ? conf.tcp.pump : (conf.system!==undefined ? conf.system.pump : '');
        console.log(`Nibe ${name} is connected`);
    };
    if(connection.series==="fSeries") {
        if(serial.port!==undefined && serial.port!=="" && (connection.enable==="serial" || connection.enable==="nibegw")) {
            nibe.initiateCore(null, serial.port, onReady);
            return true;
        }
    } else if(connection.series==="sSeries") {
        if(tcp.host!==undefined && tcp.host!=="" && tcp.port!==undefined && tcp.port!=="" && connection.enable==="tcp") {
            nibe.initiateCore(tcp.host, tcp.port, onReady);
            return true;
        }
    }
    return false;
}

function startMQTT() {
    const config = nibe.getConfig();
    const mqtt = ensure(config, 'mqtt');
    // Every gateway topic, leases included, hangs off this prefix.
    if(typeof mqtt.topic!=='string' || mqtt.topic==='') mqtt.topic = 'nibe/modbus/';
    nibe.handleMQTT(mqtt.enable, mqtt.host, mqtt.port, mqtt.user, mqtt.pass, (err) => {
        if(err) console.log(`MQTT: ${err.message ? err.message : err}`);
    });
}

// Same format as config_node.js writes it, so the Docker HEALTHCHECK works
// for both; there are no Node-RED controllers here.
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
    fs.writeFile(tmp, JSON.stringify(out), (err) => {
        if(err) return; // no /dev/shm outside Linux
        fs.rename(tmp, HEALTH_FILE, () => {});
    });
}

let healthTimer;
let stopping = false;
// Leases are not released: their baselines are persisted, and the next start
// gives the owner one TTL to renew before restoring.
function stop(signal) {
    if(stopping===true) return;
    stopping = true;
    console.log(`${signal} received, stopping the gateway`);
    clearInterval(healthTimer);
    setTimeout(() => {
        console.log('Stop timed out, exiting');
        process.exit(1);
    }, STOP_TIMEOUT_MS).unref();
    nibe.shutdown().then(() => {
        console.log('Gateway stopped');
        process.exit(0);
    }, (err) => {
        console.log(`Error while stopping: ${err && err.message ? err.message : err}`);
        process.exit(1);
    });
}
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
process.on('unhandledRejection', (reason) => {
    console.log(`Unhandled rejection: ${reason && reason.stack ? reason.stack : reason}`);
});
// Unknown state: exit and let the supervisor (Docker, systemd) restart us.
// The leases survive that through their persisted baselines.
process.on('uncaughtException', (err) => {
    console.log(`Uncaught exception: ${err && err.stack ? err.stack : err}`);
    process.exit(1);
});

if(startCore()!==true) {
    console.log('No usable connection in config.json: set connection.series and connection.enable, and serial.port or tcp.host/tcp.port');
    process.exit(1);
}
startMQTT();
healthTimer = setInterval(writeHealth, HEALTH_MS);
writeHealth();
console.log('NibePi gateway started');
