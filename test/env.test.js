'use strict';
// Environment overrides: parsing (lib/env.js) and that overrides are never
// written to config.json (index.js, in a child process per case).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { readOverrides, configDir, healthFile, parseRawSet, uiOptions, buildId } = require('../lib/env');

test('build id', () => {
    assert.equal(buildId({}), null);
    assert.equal(buildId({NIBEPI_BUILD: ' 20261017-8c768f5 '}), '20261017-8c768f5');
    assert.equal(buildId({NIBEPI_BUILD: ''}), null);
    assert.equal(buildId({NIBEPI_BUILD: '<script>'}), null);
    assert.equal(buildId({NIBEPI_BUILD: 'x'.repeat(65)}), null);
});

const byPath = (list) => Object.fromEntries(list.map(o => [o.path.join('.'), o.value]));

test('no variables, no overrides', () => {
    assert.deepEqual(readOverrides({}), {overrides: [], errors: []});
    assert.equal(configDir({}), '/etc/nibepi');
    assert.equal(healthFile({}), '/dev/shm/nibepi-health.json');
});

test('empty variables count as unset', () => {
    const env = {NIBEPI_MQTT_HOST: '', NIBEPI_MQTT_PASS: '  ', NIBEPI_CONFIG_DIR: ''};
    assert.deepEqual(readOverrides(env).overrides, []);
    assert.equal(configDir(env), '/etc/nibepi');
});

test('every variable maps to its config key', () => {
    const r = readOverrides({
        NIBEPI_CONNECTION: 'nibegw', NIBEPI_SERIAL_PORT: '/dev/ttyUSB0',
        NIBEPI_NIBEGW_HOST: 'nibegw.local', NIBEPI_NIBEGW_PORT: '9998',
        NIBEPI_MQTT_HOST: 'broker', NIBEPI_MQTT_PORT: '1884', NIBEPI_MQTT_USER: 'u',
        NIBEPI_MQTT_PASS: 'p', NIBEPI_MQTT_TOPIC: 'nibe/gw', NIBEPI_RAW_SET: 'none',
        NIBEPI_MQTT_DISCOVERY: 'true'
    });
    assert.deepEqual(r.errors, []);
    assert.deepEqual(byPath(r.overrides), {
        'connection.enable': 'nibegw', 'serial.port': '/dev/ttyUSB0',
        'nibegw.host': 'nibegw.local', 'nibegw.port': 9998,
        'mqtt.host': 'broker', 'mqtt.enable': true, 'mqtt.port': 1884, 'mqtt.user': 'u',
        'mqtt.pass': 'p', 'mqtt.topic': 'nibe/gw/', 'gateway.raw_set': 'none',
        'mqtt.discovery': true
    });
    assert.equal(r.overrides.find(o => o.path.join('.')==='mqtt.pass').secret, true);
});

test('invalid values are errors, not overrides', () => {
    const r = readOverrides({NIBEPI_CONNECTION: 'tcp', NIBEPI_MQTT_PORT: 'abc', NIBEPI_NIBEGW_PORT: '70000', NIBEPI_RAW_SET: '47011,x', NIBEPI_MQTT_DISCOVERY: 'yes'});
    assert.equal(r.overrides.length, 0);
    assert.equal(r.errors.length, 5);
});

test('MQTT discovery: true or false, empty is unset', () => {
    assert.deepEqual(byPath(readOverrides({NIBEPI_MQTT_DISCOVERY: ' TRUE '}).overrides), {'mqtt.discovery': true});
    assert.deepEqual(byPath(readOverrides({NIBEPI_MQTT_DISCOVERY: 'false'}).overrides), {'mqtt.discovery': false});
    assert.deepEqual(readOverrides({NIBEPI_MQTT_DISCOVERY: ''}), {overrides: [], errors: []});
});

test('raw_set: all, none or a list', () => {
    assert.equal(parseRawSet('ALL'), 'all');
    assert.equal(parseRawSet('none'), 'none');
    assert.deepEqual(parseRawSet('47011, 47041,'), ['47011', '47041']);
    assert.equal(parseRawSet(','), undefined);
});

test('status page: off unless NIBEPI_UI_PORT is a port', () => {
    assert.equal(uiOptions({}).enabled, false);
    assert.equal(uiOptions({NIBEPI_UI_PORT: ''}).enabled, false);
    assert.equal(uiOptions({NIBEPI_UI_PORT: '0'}).enabled, false);
    assert.deepEqual(uiOptions({NIBEPI_UI_PORT: '0'}).errors, []);
    const bad = uiOptions({NIBEPI_UI_PORT: 'web'});
    assert.equal(bad.enabled, false);
    assert.equal(bad.errors.length, 1);
    const on = uiOptions({NIBEPI_UI_PORT: '8080'});
    assert.deepEqual(on, {enabled: true, port: 8080, bind: '0.0.0.0', user: null, pass: null, errors: []});
    assert.equal(uiOptions({NIBEPI_UI_PORT: '8080', NIBEPI_UI_BIND: '127.0.0.1'}).bind, '127.0.0.1');
});

test('status page: user and password together or not at all', () => {
    const both = uiOptions({NIBEPI_UI_PORT: '8080', NIBEPI_UI_USER: 'admin', NIBEPI_UI_PASS: ' pw '});
    assert.equal(both.enabled, true);
    assert.equal(both.user, 'admin');
    assert.equal(both.pass, ' pw ');
    const one = uiOptions({NIBEPI_UI_PORT: '8080', NIBEPI_UI_USER: 'admin', NIBEPI_UI_PASS: ''});
    assert.equal(one.enabled, false);
    assert.equal(one.errors.length, 1);
    assert.equal(uiOptions({NIBEPI_UI_PORT: '8080', NIBEPI_UI_USER: 'a:b', NIBEPI_UI_PASS: 'x'}).enabled, false);
});

// Loads index.js against a scratch config dir, applies overrides, saves,
// stops it and returns the saved config.json.
function saveWith(fileConfig, overrides) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nibepi-env-'));
    try {
        if(fileConfig!==undefined) fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(fileConfig));
        const script = `
            const nibe = require(${JSON.stringify(path.join(__dirname, '..', 'index.js'))});
            nibe.applyOverrides(${JSON.stringify(overrides)});
            nibe.getConfig().registers.push(40004);
            nibe.saveConfig().then(() => nibe.shutdown()).then(() => process.exit(0));`;
        execFileSync(process.execPath, ['-e', script], {env: Object.assign({}, process.env, {NIBEPI_CONFIG_DIR: dir, NIBEPI_LOG_LEVEL: 'error'}), stdio: 'pipe'});
        return JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    } finally {
        fs.rmSync(dir, {recursive: true, force: true});
    }
}

test('first run writes config.json from default.json, without overrides', () => {
    const saved = saveWith(undefined, [
        {path: ['mqtt', 'host'], value: 'broker'}, {path: ['mqtt', 'enable'], value: true},
        {path: ['mqtt', 'pass'], value: 'secret'}, {path: ['gateway', 'raw_set'], value: 'none'},
        {path: ['mqtt', 'discovery'], value: true}
    ]);
    const defaults = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'default.json'), 'utf8'));
    assert.equal(saved.mqtt.host, defaults.mqtt.host);
    assert.equal(saved.mqtt.discovery, false);
    assert.equal(saved.mqtt.pass, defaults.mqtt.pass);
    assert.equal('enable' in saved.mqtt, false);
    assert.equal(saved.gateway.raw_set, defaults.gateway.raw_set);
    assert.deepEqual(saved.registers, [40004]);
    assert.equal(JSON.stringify(saved).includes('secret'), false);
});

test('an old config keeps its unknown keys and its own values', () => {
    const old = {
        registers: [], connection: {enable: 'serial', series: 'fSeries'}, serial: {port: '/dev/ttyAMA0'},
        mqtt: {enable: true, host: '127.0.0.1', port: '1883', user: '', pass: 'old', topic: 'nibe/modbus/'},
        price: {enable: true, area: 'SE3'}, system: {readonly: true, docker: true}, log: {enable: false}
    };
    const saved = saveWith(old, [
        {path: ['mqtt', 'pass'], value: 'secret'}, {path: ['nibegw', 'host'], value: 'gw'},
        {path: ['serial', 'port'], value: '/dev/ttyUSB0'}, {path: ['mqtt', 'discovery'], value: true}
    ]);
    assert.equal(saved.mqtt.pass, 'old');
    assert.equal('discovery' in saved.mqtt, false);
    assert.equal(saved.serial.port, '/dev/ttyAMA0');
    assert.equal('nibegw' in saved, false);
    assert.deepEqual(saved.price, old.price);
    assert.deepEqual(saved.system, Object.assign({}, old.system));
    assert.equal(saved.connection.series, 'fSeries');
});
