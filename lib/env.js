'use strict';
// Environment overrides for the gateway. config.json stays the place for
// everything the gateway changes itself (polled registers, lease baselines,
// adjust_s1/s2, the pump model); the environment sets up the deployment.
// Overrides apply in memory only and are never written back to config.json,
// so a password passed as NIBEPI_MQTT_PASS does not end up on disk.
//
// An empty variable counts as unset, as docker compose passes `FOO=` for a
// variable that is listed but not given a value.

const DEFAULT_CONFIG_DIR = '/etc/nibepi';
const DEFAULT_HEALTH_FILE = '/dev/shm/nibepi-health.json';

const value = (env, name) => {
    const v = env[name];
    if(v===undefined || v===null) return undefined;
    const text = String(v).trim();
    return text==='' ? undefined : text;
};

const configDir = (env = process.env) => value(env, 'NIBEPI_CONFIG_DIR') || DEFAULT_CONFIG_DIR;
const healthFile = (env = process.env) => value(env, 'NIBEPI_HEALTH_FILE') || DEFAULT_HEALTH_FILE;

const parsePort = (text) => {
    if(!/^\d+$/.test(text)) return NaN;
    const port = Number(text);
    return (port>=1 && port<=65535) ? port : NaN;
};

// "all", "none" or a comma separated list of registers.
const parseRawSet = (text) => {
    const lower = text.toLowerCase();
    if(lower==='all' || lower==='none') return lower;
    const regs = text.split(',').map(r => r.trim()).filter(r => r!=='');
    if(regs.length===0 || !regs.every(r => /^\d+$/.test(r))) return undefined;
    return regs;
};

// {overrides: [{path, value, secret}], errors: [text]} for the variables
// set in env. path is the key path in config.json, e.g. ['mqtt','host'].
function readOverrides(env = process.env) {
    const overrides = [];
    const errors = [];
    const set = (path, v, secret = false) => overrides.push({path, value:v, secret});

    const connection = value(env, 'NIBEPI_CONNECTION');
    if(connection!==undefined) {
        if(connection==='serial' || connection==='nibegw') set(['connection','enable'], connection);
        else errors.push(`NIBEPI_CONNECTION must be serial or nibegw, not "${connection}"`);
    }
    const serialPort = value(env, 'NIBEPI_SERIAL_PORT');
    if(serialPort!==undefined) set(['serial','port'], serialPort);
    const gwHost = value(env, 'NIBEPI_NIBEGW_HOST');
    if(gwHost!==undefined) set(['nibegw','host'], gwHost);
    const gwPort = value(env, 'NIBEPI_NIBEGW_PORT');
    if(gwPort!==undefined) {
        const port = parsePort(gwPort);
        if(Number.isFinite(port)) set(['nibegw','port'], port);
        else errors.push(`NIBEPI_NIBEGW_PORT must be a port number, not "${gwPort}"`);
    }
    const mqttHost = value(env, 'NIBEPI_MQTT_HOST');
    if(mqttHost!==undefined) {
        set(['mqtt','host'], mqttHost);
        set(['mqtt','enable'], true);
    }
    const mqttPort = value(env, 'NIBEPI_MQTT_PORT');
    if(mqttPort!==undefined) {
        const port = parsePort(mqttPort);
        if(Number.isFinite(port)) set(['mqtt','port'], port);
        else errors.push(`NIBEPI_MQTT_PORT must be a port number, not "${mqttPort}"`);
    }
    const mqttUser = value(env, 'NIBEPI_MQTT_USER');
    if(mqttUser!==undefined) set(['mqtt','user'], mqttUser);
    const mqttPass = value(env, 'NIBEPI_MQTT_PASS');
    if(mqttPass!==undefined) set(['mqtt','pass'], mqttPass, true);
    const topic = value(env, 'NIBEPI_MQTT_TOPIC');
    if(topic!==undefined) {
        // Every topic is built as <topic><reg>, so it must end in a slash.
        set(['mqtt','topic'], topic.endsWith('/') ? topic : topic+'/');
    }
    const rawSet = value(env, 'NIBEPI_RAW_SET');
    if(rawSet!==undefined) {
        const policy = parseRawSet(rawSet);
        if(policy!==undefined) set(['gateway','raw_set'], policy);
        else errors.push(`NIBEPI_RAW_SET must be all, none or a comma separated list of registers, not "${rawSet}"`);
    }
    return {overrides, errors};
}

module.exports = {
    DEFAULT_CONFIG_DIR: DEFAULT_CONFIG_DIR,
    DEFAULT_HEALTH_FILE: DEFAULT_HEALTH_FILE,
    configDir: configDir,
    healthFile: healthFile,
    readOverrides: readOverrides,
    parseRawSet: parseRawSet
};
