/*MIT License

Copyright (c) 2019 Fredrik Anerdin

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
//const path = __dirname;
const nibepi_version = require('./package.json').version;
const Core = require(__dirname+'/lib/startCore')
const startCore = Core.startCoreF;
const startNibeGW = Core.startNibeGW;
const stopCoreProcess = require(__dirname+'/lib/stopCore');
const Lease = require(__dirname+'/lib/lease');
const log = require('./log');
// Mark where each run starts and ends. The stop line relies on log.js
// writing synchronously: nothing asynchronous runs on 'exit'.
log.info('System',`NibePi ${nibepi_version} starting`);
let model = "";
let rmu = {};
let firmware = "";
let register = [];
let mqtt_client;
let discovery = {components:{}, removed:{}, cleared:false, timer:undefined};
let config;
let leases;                // LeaseManager, created at the end of this file
const regQueue = [];
const EventEmitter = require('events').EventEmitter
const nibeEmit = new EventEmitter();
const fs = require('fs');
const Env = require(__dirname+'/lib/env');
// The image's build (date and backend commit), null outside the image.
const nibepi_build = Env.buildId();
if(nibepi_build!==null) log.info('System',`Build ${nibepi_build}`);
// NIBEPI_CONFIG_DIR, default /etc/nibepi. The gateway always runs with a
// writable config directory.
const path = Env.configDir();
const configFile = path+'/config.json';
if (!fs.existsSync(path)) {
    try {
        fs.mkdirSync(path, {recursive:true});
        log.info('Config',`Configuration directory created ${path}`);
    } catch(e) {
        log.error('Config',`Could not create the configuration directory ${path}: ${e.message}`);
    }
}
const readJSON = (file) => JSON.parse(fs.readFileSync(file,'utf8'));
// Set when the settings on disk could not be used; shown as a fault once
// the core is started, and the loaded config is written back.
let configLoadFault;
let configNeedsSave = false;
// config.json used to be written in place, so a power cut could leave it
// empty, and the old loader then silently replaced it with default.json.
// Now: config.json, else config.json.bak, else defaults - and the unreadable
// file is kept as config.json.corrupt-<timestamp>.
function loadConfig() {
    let error;
    try {
        return readJSON(configFile);
    } catch(e) {
        error = e;
    }
    if(error.code==='ENOENT' && !fs.existsSync(configFile+'.bak')) {
        log.info('Config',`${configFile} not found, creating it from the defaults`);
        configNeedsSave = true;
        return readJSON(__dirname+'/default.json');
    }
    log.error('Config',`${configFile} could not be read: ${error.message}`);
    configNeedsSave = true;
    try {
        let conf = readJSON(configFile+'.bak');
        log.error('Config',`Settings restored from ${configFile}.bak`);
        configLoadFault = 'Inställningsfilen var skadad, inställningarna är återställda från säkerhetskopian.';
        return conf;
    } catch(e) {
        log.error('Config',`${configFile}.bak could not be read either (${e.message}). ALL SETTINGS ARE RESET TO DEFAULTS.`);
    }
    let kept = '';
    if(fs.existsSync(configFile)) {
        let corrupt = configFile+'.corrupt-'+Date.now();
        try {
            fs.renameSync(configFile, corrupt);
            kept = ` Den skadade filen är sparad som ${corrupt}.`;
            log.error('Config',`The unreadable config file was moved to ${corrupt}`);
        } catch(e) {
            // writeFileAtomic moves it aside when it saves.
            log.error('Config',`Could not move the unreadable config file aside: ${e.message}`);
        }
    }
    configLoadFault = 'Inställningsfilen var skadad och kunde inte återställas, standardinställningar används.'+kept;
    return readJSON(__dirname+'/default.json');
}
// All disk writes go through one chain, so two saves cannot interleave.
let diskQueue = Promise.resolve();
const queueDisk = (job) => {
    const run = diskQueue.then(job);
    diskQueue = run.catch(() => {});
    return run;
}
const writeSynced = async (file,text) => {
    const handle = await fs.promises.open(file,'w');
    try {
        await handle.writeFile(text);
        await handle.sync();
    } finally {
        await handle.close();
    }
}
// Write file.tmp and fsync it, keep the current file as file.bak, then
// rename the new file over it: a power cut leaves either the old or the new
// file, never an empty one. A current file that is not valid JSON is moved
// aside as file.corrupt-<timestamp> instead of becoming the backup.
const writeFileAtomic = async (file,text) => {
    await writeSynced(file+'.tmp',text);
    let current;
    try {
        current = await fs.promises.readFile(file,'utf8');
    } catch(e) {}
    if(current!==undefined) {
        let valid = true;
        try { JSON.parse(current); } catch(e) { valid = false; }
        if(valid===true) {
            await writeSynced(file+'.bak',current);
        } else {
            await fs.promises.rename(file,file+'.corrupt-'+Date.now());
        }
    }
    await fs.promises.rename(file+'.tmp',file);
    try {
        const dir = await fs.promises.open(path,'r');
        try { await dir.sync(); } finally { await dir.close(); }
    } catch(e) {}
}
config = loadConfig();
// Sections the code reads without checking; an old or hand-edited file may
// lack them. Unknown keys are kept as they are.
for (const key of ['connection','serial','mqtt','system','home','gateway']) {
    if(config[key]===null || typeof config[key]!=='object' || Array.isArray(config[key])) config[key] = {};
}
if(!Array.isArray(config.registers)) config.registers = [];
// Replacement for .catch(console.log) on fire-and-forget reqData calls: no
// stack traces, nothing while the pump has not announced its model yet, and
// the same message at most once a minute (a noisy RS485 bus otherwise floods
// the log with identical "No respond" lines).
const logCatchSeen = new Map();
const logCatch = (err) => {
    const msg = err && err.message ? err.message : String(err);
    if (msg === 'Heatpump is not ready yet.') return;
    const now = Date.now();
    const seen = logCatchSeen.get(msg);
    if (seen && now - seen.at < 60000) { seen.skipped++; return; }
    const skipped = seen && seen.skipped ? ` (repeated ${seen.skipped} times in the last minute)` : '';
    logCatchSeen.set(msg, { at: now, skipped: 0 });
    log.warn('Read',`${msg}${skipped}`);
};
// F-series reads made before the pump has announced its model used to fail
// at once with 'Heatpump is not ready yet.', so every caller started at
// 'ready' got undefined and had to retry on the next event. They now wait
// here for the model, up to MODEL_WAIT_MS, and only then fail with the same
// message (callers and logCatch still recognise it).
const MODEL_WAIT_MS = 30000;
const modelWaiters = [];
const whenModelKnown = () => new Promise((resolve, reject) => {
    if (model.length !== 0) return resolve();
    const waiter = { resolve };
    waiter.timer = setTimeout(() => {
        const i = modelWaiters.indexOf(waiter);
        if (i !== -1) modelWaiters.splice(i, 1);
        logCatch(new Error('Still waiting for the heat pump to announce its model'));
        reject(new Error('Heatpump is not ready yet.'));
    }, MODEL_WAIT_MS);
    modelWaiters.push(waiter);
});
// Call once model and register table are both loaded.
const modelKnown = () => {
    while (modelWaiters.length !== 0) {
        const waiter = modelWaiters.shift();
        clearTimeout(waiter.timer);
        waiter.resolve();
    }
    // A restart leaves the pump with a MODBUS alarm: check it right away.
    setTimeout(() => checkCommsAlarm('start'), 5000);
    // Regular polling used to start only on the pump's first LOG.SET frame
    // (0x68). A pump without a LOG.SET never sends one, so registers were
    // only read when someone asked: BT2, BT3, BT6 every ~30 min.
    setTimeout(() => startRegularPolling(), 3000);
};
const startRegularPolling = () => {
    if(!Array.isArray(config.registers)) return;
    for (const reg of config.registers) addRegular(reg);
};
process.on('exit', (code) => {
    log.info('System',`NibePi stopping (exit code ${code})`);
});
var timer;
// Called after config has been changed in place: the lease baselines are
// taken from the live leases, so a save can never drop one that a restart
// still needs.
const updateConfig = () => {
    if(leases!==undefined) gatewayConfig().baselines = leases.baselines();
    scheduleConfigSave();
}
// Debounced: settings often change in bursts.
const scheduleConfigSave = (delay=5000) => {
    if(timer!==undefined) clearTimeout(timer);
    timer = setTimeout(() => {
        timer = undefined;
        saveConfig().catch((err) => {
            log.error('Config','Could not save the config file: '+(err && err.message ? err.message : err));
        });
    }, delay);
}
// Environment overrides (lib/env.js) live in memory only. Each one remembers
// what config.json had at that path, and that is what gets saved, so values
// from the environment - the MQTT password above all - never reach the disk.
const overrides = [];
const getPath = (obj,keys) => {
    let node = obj;
    for (const key of keys) {
        if(node===null || typeof node!=='object' || !Object.prototype.hasOwnProperty.call(node,key)) return {found:false};
        node = node[key];
    }
    return {found:true, value:node};
};
const setPath = (obj,keys,value) => {
    let node = obj;
    for (const key of keys.slice(0,-1)) {
        if(node[key]===null || typeof node[key]!=='object' || Array.isArray(node[key])) node[key] = {};
        node = node[key];
    }
    node[keys[keys.length-1]] = value;
};
const applyOverrides = (list) => {
    for (const item of list) {
        const keys = item.path;
        const known = overrides.find(o => o.path.join('.')===keys.join('.'));
        if(known!==undefined) {
            known.value = item.value;
        } else {
            overrides.push({
                path: keys,
                value: item.value,
                file: getPath(config,keys),
                parentInFile: getPath(config,keys.slice(0,-1)).found
            });
        }
        setPath(config,keys,item.value);
    }
};
// What config.json should hold: config with every override undone.
const persistedConfig = () => {
    const copy = JSON.parse(JSON.stringify(config));
    for (const o of overrides) {
        if(o.file.found===true) {
            setPath(copy,o.path,o.file.value);
            continue;
        }
        const parent = getPath(copy,o.path.slice(0,-1));
        if(parent.found!==true || parent.value===null || typeof parent.value!=='object') continue;
        delete parent.value[o.path[o.path.length-1]];
        // A section created only for an override goes too.
        if(o.parentInFile!==true && o.path.length>1 && Object.keys(parent.value).length===0) {
            const grand = o.path.length>2 ? getPath(copy,o.path.slice(0,-2)).value : copy;
            if(grand!==null && typeof grand==='object') delete grand[o.path[o.path.length-2]];
        }
    }
    return copy;
};
const saveConfig = () => queueDisk(async () => {
    const text = JSON.stringify(persistedConfig(),null,2);
    if(text.length<=2) return false;
    let saved = false;
    try {
        await writeFileAtomic(configFile,text);
        saved = true;
        log.info('Config',"Config file saved");
    } catch(err) {
        log.error('Config',err);
    }
    return saved;
});
// First run (or a repaired file): write config.json right away. The timer
// lets gateway.js apply its environment overrides first, which are left out.
if(configNeedsSave===true) scheduleConfigSave(0);
let core;
// Core supervision. index.js tracks the core it forked: an unexpected exit is
// reported and the core is forked again with backoff (2 s doubling to 60 s,
// back to 2 s after 10 minutes up). stopCore() marks a stop as intended, so
// a shutdown does not trigger a restart.
const RESTART_MIN_MS = 2000;
const RESTART_MAX_MS = 60000;
const RESTART_STABLE_MS = 600000;
const BUS_SILENT_MINUTES = 5;
let coreState = 'down';    // 'starting' | 'up' | 'down'
let coreGen = 0;           // bumped by every fork and stop; stale callbacks compare against it
let coreWanted = false;    // initiateCore called and not stopped since
let coreArgs;              // {host,port,cb} from the last initiateCore
let restartDelay = RESTART_MIN_MS;
let restartTimer;
let stableTimer;
let restartCount = 0;
let lastData = null;
let busSilentMinutes = 0;
const markData = () => {
    lastData = Date.now();
    if(coreState==='starting') coreState = 'up';
};
const reportedMissing = new Set();
// RS485 bus health per minute: frame counts from the core (backend.js) plus
// reads that timed out here. Emitted as 'busHealth', published to MQTT as
// <topic>bus_health, and logged as one line when there were errors.
let noRespondCount = 0;
let busHealth;
// The last hour of busHealth, oldest first, for the status page.
const BUS_HISTORY_MAX = 60;
const busHistory = [];
const onBusStats = (stats) => {
    busHealth = {
        timestamp: Date.now(),
        ok: stats.ok,
        chksum: stats.chksum,
        no_respond: noRespondCount,
        errors: stats.chksum + noRespondCount
    };
    noRespondCount = 0;
    busHistory.push(busHealth);
    if(busHistory.length>BUS_HISTORY_MAX) busHistory.splice(0, busHistory.length-BUS_HISTORY_MAX);
    if(config!==undefined && config.mqtt!==undefined && config.mqtt.topic!==undefined) {
        publishMQTT(config.mqtt.topic+"bus_health", JSON.stringify(busHealth));
    }
    if(busHealth.errors>0) {
        const text = `Bus last minute: ${busHealth.ok} ok, ${busHealth.chksum} CHKSUM, ${busHealth.no_respond} No respond`;
        log.info('Bus',text);
    }
    // Bus watchdog: a running core that decodes no valid frame for several
    // minutes has most likely lost the serial port without noticing.
    if(stats.ok===0 && core!==undefined && core.connected===true) {
        busSilentMinutes++;
        if(busSilentMinutes>=BUS_SILENT_MINUTES) {
            busSilentMinutes = 0;
            restartCore(`Ingen data från värmepumpen på ${BUS_SILENT_MINUTES} minuter, startar om kärnan`);
        }
    } else {
        busSilentMinutes = 0;
    }
};
const getHealth = () => {
    return {core:coreState, model:model, lastData:lastData, restarts:restartCount, busHealth:busHealth};
}
// RMU40 activity per system (1-4), for the status page: the last frame the
// pump sent to that room unit's address (0x19-0x1C) and whether the core
// answers it (rmu false) or stays silent because another RMU40 answers or
// rmu_emulation is false (rmu true). Kept across core restarts.
const rmuSeen = {};
const RMU_FIRST_ADDRESS = 0x19;
const noteRMUFrame = (m) => {
    const data = m.data;
    if(data===undefined || data===null || data.length<4) return;
    const system = data[2]-RMU_FIRST_ADDRESS+1;
    if(system<1 || system>4) return;
    rmuSeen[system] = {lastPoll:Date.now(), readOnly:m.rmu===true, command:data[3]};
}
// The last write to each RMU40 register (1xxxx) and how it ended. The pump
// fetches it on its next poll of the room unit, which is the ACK.
const rmuWrites = {};
const noteRMUWrite = (address,value,err,ack) => {
    if(String(address).charAt(0)!=="1") return;
    const ok = !err && ack!==false;
    rmuWrites[String(address)] = {value:value, at:Date.now(), ok:ok,
        error: ok ? null : (err && err.message ? err.message : (err ? String(err) : 'not acknowledged'))};
}
const resetCore = () => {
    model = "";
    reportedMissing.clear();
    register = [];
    firmware = "";
    // A new core starts with an empty poll list; regQueue must be empty too,
    // or decodeMessage never registers the regular registers with it again.
    regQueue.length = 0;
    rmu = {};
    announcedModel = undefined;
    cachedModelFailed = false;
    unsupportedModel = undefined;
}
// Errors thrown while handling core messages: logged, and shown as a fault
// at most once a minute per message.
const handlerFaultSeen = new Map();
const reportHandlerError = (err) => {
    const msg = err && err.message ? err.message : String(err);
    logCatch(new Error('Error handling data from the core: '+msg));
    log.debug('Core','Error handling data from the core: '+(err && err.stack ? err.stack : msg));
    const now = Date.now();
    const at = handlerFaultSeen.get(msg);
    if(at!==undefined && now-at<60000) return;
    handlerFaultSeen.set(msg,now);
    nibeEmit.emit('fault',{from:"Datahantering",message:'Fel vid hantering av data från kärnan: '+msg});
}
// Kill the running core on purpose (watchdog); the exit handler restarts it.
const restartCore = (message) => {
    const child = core;
    const gen = coreGen;
    log.error('Core',message);
    nibeEmit.emit('fault',{from:"core",message:message});
    // A 'fault' listener may already have stopped and restarted the core.
    if(gen!==coreGen || child===undefined || child.exitCode!==null || child.signalCode!==null) return;
    child.restartReason = message;
    child.kill('SIGTERM');
}
const superviseCore = (child,gen) => {
    // Without a listener a failed send to a dead core would throw.
    child.on('error', (err) => {
        log.error('Core','Core process error: '+err.message);
    });
    child.once('exit', (code,signal) => {
        if(gen!==coreGen || coreWanted!==true) return; // stopped on purpose
        clearTimeout(stableTimer);
        coreState = 'down';
        restartCount++;
        const delay = restartDelay;
        restartDelay = Math.min(restartDelay*2, RESTART_MAX_MS);
        const text = `Core exited unexpectedly (code ${code}, signal ${signal}), restarting in ${delay/1000} s`;
        log.error('Core',text);
        resetCore();
        // Scheduled before the fault is emitted: a 'fault' listener that
        // restarts the core itself calls stopCore, which cancels this timer.
        restartTimer = setTimeout(() => {
            if(gen!==coreGen || coreWanted!==true) return;
            forkCore();
        }, delay);
        if(child.restartReason===undefined) {
            nibeEmit.emit('fault',{from:"core",message:'Kärnan stoppades oväntat, startar om'});
        }
    });
}
// Stops the tracked core, plus the one passed in if that is another process.
// stopCore() with no argument stops the tracked core.
const stopCore = (child) => {
    coreWanted = false;
    coreGen++;
    clearTimeout(restartTimer);
    clearTimeout(stableTimer);
    coreState = 'down';
    if(child!==undefined && child!==core) stopCoreProcess(child);
    return stopCoreProcess(core);
}
// serial: initiateCore(null, serialPort, cb); nibegw: initiateCore(gatewayHost,
// localUdpPort, cb). cb(null, core) once the pump model is known.
const initiateCore = (host,port,cb) => {
    if(configLoadFault!==undefined) {
        // Delayed so the caller's 'fault' listeners are attached.
        const text = configLoadFault;
        configLoadFault = undefined;
        setTimeout(() => {
            nibeEmit.emit('fault',{from:"Inställningar",message:text});
            log.error('Config',text);
        }, 10000);
    }
    coreArgs = {host:host,port:port,cb:cb};
    coreWanted = true;
    clearTimeout(restartTimer);
    forkCore();
}
// Log levels the cores use; 'core' is every raw frame on the bus.
const coreLogLevel = (level) => level==='core' ? 'trace' : (log.LEVELS[level]!==undefined ? level : 'info');
// Forks the core for the current config, from initiateCore and on restarts.
const forkCore = () => {
    const host = coreArgs.host;
    const port = coreArgs.port;
    const cb = coreArgs.cb;
    // Never two cores on one serial port.
    if(core!==undefined && core.connected===true) stopCoreProcess(core);
    const gen = ++coreGen;
    coreState = 'starting';
    busSilentMinutes = 0;
    clearTimeout(stableTimer);
    // Take over a freshly forked core, unless it was stopped or superseded
    // during the fork delay in lib/startCore.
    const adopt = (child) => {
        if(gen!==coreGen || coreWanted!==true) {
            stopCoreProcess(child);
            return false;
        }
        core = child;
        superviseCore(child,gen);
        stableTimer = setTimeout(() => { restartDelay = RESTART_MIN_MS; }, RESTART_STABLE_MS);
        return true;
    };
    // Messages still in flight from a core that has been stopped or replaced
    // are dropped.
    const fromCore = (handler) => (m) => {
        if(gen!==coreGen) return;
        // An exception here would otherwise take the gateway down with it.
        try {
            handler(m);
        } catch(err) {
            reportHandlerError(err);
        }
    };
    const mode = config.connection.enable;
    let start;
    if(mode==="serial") {
        start = startCore(port);
    } else if(mode==="nibegw") {
        start = startNibeGW(host,port);
    } else {
        coreState = 'down';
        return;
    }
    start.then(result => {
        if(adopt(result)===false) return;
        if(mode==="serial" && config.system.rmu_emulation===false) {
            log.info('RMU40','RMU40 emulation disabled (system.rmu_emulation=false), RMU40 registers are read-only');
            core.send({type:"rmuEmulation",data:false});
        }
        if(config.system.reset_alarm_on_start===true) {
            // The pump only takes the reset of its MODBUS alarm (251) this
            // early; it also acknowledges any other alarm active right now.
            log.warn('Pump','Resetting pump alarms at start (system.reset_alarm_on_start), like the original NibePi');
            core.send({type:"resetOnStart"});
        }
        core.on('message', fromCore((m) => {
            if(m.type=="data") {
                markData();
                let n = m.data;
                announcment(m, (err,ready) => {
                    if(err) log.error('Pump',err);
                    if(ready===true) cb(null,result);
                });
                noteRMUFrame(m);
                if(mode==="serial") decodeRMU(n);
                decodeMessage(n);
            } else if(m.type=="fault") {
                nibeEmit.emit('fault',m.data);
            } else if(m.type=="ack") {
                nibeEmit.emit("ACK_"+m.data.register,m.data.ack);
            } else if(m.type=="writeResult") {
                onWriteResult(m.data);
            } else if(m.type=="busStats") {
                onBusStats(m.data);
            } else if(m.type=="log") {
                log.write(coreLogLevel(m.level),m.kind,m.data);
            }
        }));
    });
}


// Model name and firmware version from a product information message (0x6D).
const parsePump = (data) => {
    let modelLength = data[4]+5;
    let name = (Buffer.from(data).slice(8,modelLength).toString()).split(" ");
    if(name[0]=="VVM" || name[0]=="SMO" || name[0]=="Tehowatti" || name[0]=="STAR") {
        name[0] = name[0]+name[1];
    }
    name = name[0].split("-");
    return {model:name[0].replace(",",""), firmware:(data[6]*256)+data[7]};
}
let announcedModel;
let cachedModelFailed = false; // cached system.pump has no usable register table
let unsupportedModel;          // announced model without a register table, reported once
// Adds a model's register table to register; throws, leaving register
// untouched, when there is no usable table for it.
const loadModel = (name) => {
    if(!/^[A-Za-z0-9_]+$/.test(String(name))) throw new Error(`Unknown model name ${name}`);
    let reg = require(`./models/${name}.json`);
    if(!Array.isArray(reg) || reg.length===0) throw new Error(`No registers for ${name}`);
    for (i = 0; i < reg.length; i = i + 1) {
        let found = false;
        for (j = 0; j < register.length; j = j + 1) {
            if(register[j].register===reg[i].register) {
                found = true;
            }
        }
        if(found===false) {
            register.push(reg[i])
        }
    }
}
const announcment = (msg,cb) => {
    // The model is only persisted once its register table has loaded, so an
    // unsupported pump is not cached in config.json.
    const checkPump = (data,callback) => {
        let announced = parsePump(data);
        try {
            loadModel(announced.model);
        } catch(err) {
            return callback(err,announced);
        }
        model = announced.model;
        firmware = announced.firmware;
        config.system.pump = model;
        config.system.firmware = firmware;
        updateConfig();
        callback(null,announced);
        }
    if(model=="" && cachedModelFailed===false && config.system!==undefined && config.system.pump!==undefined && config.system.pump!=="" && config.system.firmware!==undefined && config.system.firmware!=="") {
        try {
            loadModel(config.system.pump);
        } catch(err) {
            // Wait for the pump's own announcement instead of retrying on
            // every frame, and keep model empty: no table, no model.
            cachedModelFailed = true;
            let text = `Heatpump is not supported ${config.system.pump}, waiting for the pump to announce its model`;
            log.error('Pump',text);
            nibeEmit.emit('fault',{from:"Värmepump",message:`Värmepumpen ${config.system.pump} i inställningarna stöds inte, väntar på att pumpen presenterar sig.`});
            return cb(null,false);
        }
        model = config.system.pump;
        firmware = config.system.firmware;
        modelKnown();
        cb(null,true)
        log.info('Pump',`Nibe ${model} connected, firmware ${firmware}, ${register.length} registers`);
        
    } else if(msg.data[3]==109) {
        
        checkCommsAlarm('announcement');
        
        //console.log(`Announcement message`);
        if(model=="") {
            checkPump(msg.data, function(err,announced) { 
                if(err) {
                    if(unsupportedModel!==announced.model) {
                        unsupportedModel = announced.model;
                        let text = `Heatpump ${announced.model} is not supported (${err.message})`;
                        log.error('Pump',text);
                        nibeEmit.emit('fault',{from:"Värmepump",message:`Värmepumpen ${announced.model} stöds inte.`});
                    }
                    return cb(null,false);
                }
                modelKnown();
                cb(null,true)
                log.info('Pump',`Nibe ${model} connected, firmware ${firmware}, ${register.length} registers`);
            });
        } else {
            // Model and firmware are cached in config.system and used from there at
            // start, so a firmware upgrade or a different pump only shows up here.
            let announced = parsePump(msg.data);
            if(announced.model!==model) {
                if(announcedModel!==announced.model) {
                    announcedModel = announced.model;
                    let text = `The pump announces itself as ${announced.model}, but the register map loaded is ${model}. Restart NibePi after removing system.pump and system.firmware from config.json.`;
                    log.error('Pump',text);
                    nibeEmit.emit('fault',{from:"Värmepump",message:text});
                }
            } else if(announced.firmware!==Number(firmware)) {
                let text = `Pump firmware changed from ${firmware} to ${announced.firmware}`;
                firmware = announced.firmware;
                config.system.firmware = firmware;
                updateConfig();
                log.info('Pump',text);
                scheduleDiscovery();
            }
        }
    } else if(msg.data[3]==98) {
        //log('info',msg.data)
        if(rmu['s'+((-24)+msg.data[2])]===undefined || rmu['s'+((-24)+msg.data[2])]===false) {
            rmu['s'+((-24)+msg.data[2])] = true;
            let reg = require(`./models/RMU40_S${((-24)+msg.data[2])}`);
            for (i = 0; i < reg.length; i = i + 1) {
                if(msg.rmu===true) { reg[i].mode = "R"; }
                let found = false;
                for (j = 0; j < register.length; j = j + 1) {
                    if(register[j].register===reg[i].register) {
                        found = true;
                    }
                }
                if(found===false) {
                    register.push(reg[i])
                }
            }
            if(msg.rmu===true) {
                log.info('RMU40','RMU40 System '+((-24)+msg.data[2])+' connected (read-only mode)');
            } else {
                log.info('RMU40','RMU40 System '+((-24)+msg.data[2])+' connected');
            }
            log.debug('RMU40',`Register is set. Length: ${register.length}`);
            cb(null,false)

        }
    } else {
        cb(null,false)
    }
}

async function reqData (address) {
    async function getDataFseries(address) {
        const promise = new Promise((resolve,reject) => {
        let index = register.findIndex(index => index.register == address);
        if(index!==-1 || (address!==undefined && config.system.testmode===true && address!=="00000")) {
            // One listener and one pair of timers per call, torn down together.
            // These used to be shared per address -- one timer slot keyed by the
            // register address, plus removeAllListeners(address) -- so two requests
            // for the same register cancelled each other's timers and deleted each
            // other's listeners. A register whose value was arriving perfectly
            // normally would then reject with "No respond from register". 45001 is
            // re-requested on every announcement message, so it overlapped with
            // itself constantly.
            let settled = false;
            let retryTimer;
            let failTimer;
            const request = () => {
                var data = [];
                data[0] = 0xc0;
                data[1] = 0x69;
                data[2] = 0x02;
                data[3] = (address & 0xFF);
                data[4] = ((address >> 8) & 0xFF);
                data[5] = Calc_CRC(data);
                core.send({type:"reqData",data:data});
            };
            const finish = (err,data) => {
                if(settled===true) return;
                settled = true;
                clearTimeout(retryTimer);
                clearTimeout(failTimer);
                nibeEmit.removeListener(address,listener);
                if(err!==null) { reject(err); } else { resolve(data); }
            };
            const listener = (data) => { finish(null,data); };
            nibeEmit.on(address,listener);
            retryTimer = setTimeout(() => {
                if(settled===true) return;
                if(register[index]!==undefined || config.system.testmode===true) {
                    failTimer = setTimeout(() => {
                        noRespondCount++;
                        finish(new Error('No respond from register ('+address+')'));
                    }, 30000);
                    if(register[index]!==undefined) register[index].logset = false;
                    request();
                } else {
                    finish(new Error('Register ('+address+') returned no data.'));
                }
            }, 7000);
            if((register[index]===undefined && config.system.testmode===true) || register[index].logset===undefined || register[index].logset===false) {
                request();
            }
        } else {
            reject(new Error('Register ('+address+') not in database'));
        }
        });
        return promise;
    }
    const promise = new Promise((resolve,reject) => {
        if(core!==undefined && core.connected!==undefined && core.connected===true) {
            whenModelKnown()
                .then(() => getDataFseries(address))
                .then(resolve, reject);
        } else {
            reject(new Error('Core is not started.'))
        }
    });
    return promise;
    
}


// Waits up to SET_WAIT_MS for a running core and a known model, then sends. cb is always called exactly once: cb(null,ack) when the
// core reports the write, cb(err) on rejection, timeout or no ACK. The two
// string errors are kept as they were for existing callers.
const SET_WAIT_MS = 30000;
const SET_ACK_MS = 60000;
// Refused writes are logged at most once a minute per register: a writer
// may retry a leased register on every run.
const refusalSeen = new Map();
const logRefusal = (address,text) => {
    const key = String(address);
    const now = Date.now();
    const at = refusalSeen.get(key);
    if(at!==undefined && now-at<60000) return;
    refusalSeen.set(key,now);
    log.warn('Gateway','Write refused: '+text);
}
// opts.lease marks the lease module's own writes. While a register is leased
// they are the only ones accepted, so two controllers cannot fight over it.
const setData = (address,value,cb=()=>{},opts) => {
    if(typeof cb!=='function') cb = ()=>{};
    const fromLease = (opts!==undefined && opts!==null && opts.lease===true);
    const leaseRefusal = () => {
        const err = leases!==undefined ? leases.writeRefusal(address,fromLease) : null;
        if(err!==null) logRefusal(address,err.message);
        return err;
    };
    const refused = leaseRefusal();
    if(refused!==null) return cb(refused);
    log.info('Write',`Setting data in register ${address}: ${value}`);
    let done = false;
    let waitTimer;
    let ackTimer;
    let ackListener;
    const finish = (err,result) => {
        if(done===true) return;
        done = true;
        clearTimeout(waitTimer);
        clearTimeout(ackTimer);
        if(ackListener!==undefined) nibeEmit.removeListener("ACK_"+address,ackListener);
        noteRMUWrite(address,value,err,result);
        if(err) return cb(err);
        cb(null,result);
    };
    const coreUp = () => (core!==undefined && core.connected===true);
    const ready = () => coreUp() && model.length!==0;
    const send = () => {
        // The lease may have started while this write waited for the core.
        const refused = leaseRefusal();
        if(refused!==null) return finish(refused);
        var output = setDataValue({register:address,value:value});
        if(output===-1) return finish('Register dont exist');
        if(output===-2) return finish('Register not writeable');
        if(output===-3) return finish(new Error('Value ('+value+') out of range for register '+address));
        if(output===-4) return finish(new Error('Invalid value ('+value+') for register '+address));
        if(output===undefined) return finish(new Error('Configuration is invalid'));
        ackListener = (result) => { finish(null,result); };
        nibeEmit.once("ACK_"+address,ackListener);
        ackTimer = setTimeout(() => {
            finish(new Error('No ACK when writing register '+address));
        }, SET_ACK_MS);
        if(address.toString().charAt(0)=="1") {
            core.send({type:"rmuSet",data:output});
        } else {
            core.send({type:"setData",data:output});
            reqData(address).catch(logCatch)
        }
    };
    const started = Date.now();
    const attempt = () => {
        if(ready()) return send();
        if(Date.now()-started>=SET_WAIT_MS) {
            return finish(new Error(coreUp() ? 'Heatpump is not ready yet.' : 'Core is not started.'));
        }
        waitTimer = setTimeout(attempt, 1000);
    };
    attempt();
}
function getData(address) {
    var item = register.find(item => item.register == address);
    if(item!==undefined || config.system.testmode===true) {
        var data = [];
        data[0] = 0xc0;
        data[1] = 0x69;
        data[2] = 0x02;
        data[3] = (address & 0xFF);
        data[4] = ((address >> 8) & 0xFF);
        data[5] = Calc_CRC(data);
        return(data);
    } else {
        // Logged once per register: request nodes for other models ask for
        // these on every poll.
        if(!reportedMissing.has(String(address))) {
            reportedMissing.add(String(address));
            log.warn('Register','Register('+address+') not in database - not available on this model, further requests are not logged');
        }
        return;
    }
}
// Raw value range per register size; "any" for registers without a size.
const sizeRange = {
    s8:[-128,127], u8:[0,255],
    s16:[-32768,32767], u16:[0,65535],
    s32:[-2147483648,2147483647], u32:[0,4294967295],
    any:[-2147483648,4294967295]
};
// Number from a write request: numbers, numeric strings ("21.5", "21,5",
// " 3 ") and Buffers (MQTT). Anything else, and empty strings, give NaN.
const parseWriteValue = (value) => {
    if(Buffer.isBuffer(value)) value = value.toString();
    if(typeof value!=='number' && typeof value!=='string') return NaN;
    let text = String(value).trim().replace(',','.');
    if(text==='') return NaN;
    return Number(text);
}
// Raw value for writing value to item: {raw}, or {code:-4} for a value that
// is not a number and {code:-3,value} for one out of range. Shared by
// setDataValue and validateWrite, which must agree.
const checkWriteValue = (item,input) => {
    // "abc", "", undefined or a Buffer used to become NaN or 0 here, and
    // NaN passed the range checks and was written as 0.
    let value = parseWriteValue(input);
    let factor = Number(item.factor);
    if(!Number.isFinite(value) || !Number.isFinite(factor) || factor===0) return {code:-4};
    let raw = Math.round(value*factor);
    // Always within what the register size can hold, and within the
    // model's min/max unless both are 0. Out of range is rejected, not
    // clamped: a clamped value is still a value nobody asked for.
    let min = Number(item.min);
    let max = Number(item.max);
    let range = sizeRange[item.size] || sizeRange.any;
    let outside = (raw<range[0] || raw>range[1]);
    if(min!==0 || max!==0) {
        if(raw>max || raw<min) outside = true;
    }
    if(outside===true) return {code:-3,value:value};
    return {code:0,raw:raw};
}
// The checks setData makes before writing, without writing, faults or logs:
// null when value may be written to address, else the reason.
const validateWrite = (address,value) => {
    const item = register.find(item => item.register == address);
    if(item===undefined) return register.length===0 ? 'Heatpump is not ready yet.' : 'Register dont exist';
    if(item.mode!=="R/W") return 'Register not writeable';
    const check = checkWriteValue(item,value);
    if(check.code===-4) return 'Invalid value ('+value+') for register '+address;
    if(check.code===-3) return 'Value ('+value+') out of range for register '+address;
    return null;
}
function setDataValue(incoming) {
    var item = register.find(item => item.register == incoming.register);
    if(item!==undefined) {
    var data = [];
    var rmu = {data:[],address:incoming.register,ackback:[]};
        if(item.mode=="R/W") {
            let check = checkWriteValue(item,incoming.value);
            if(check.code===-4) {
                nibeEmit.emit('fault',{from:"Skicka värde",message:'Ogiltigt värde ('+incoming.value+') till register '+incoming.register+', skickas inte.'});
                log.error('Data','Invalid value ('+incoming.value+') to register '+incoming.register+', not sent');
                return -4;
            }
            if(check.code===-3) {
                nibeEmit.emit('fault',{from:"Skicka värde",message:'Data ('+check.value+') utanför giltigt värde som får skickas.'});
                log.error('Data','Data ('+check.value+') out of range, to register '+incoming.register);
                return -3;
            }
            incoming.value = check.raw;
            if(item.register.charAt(0)=="1") {
                let len = 0x03;
                if(item.size=="s8" || item.size=="u8") {
                    len = 0x02;
                }
                rmu.data[0] = 0xc0;
                rmu.data[1] = 0x60;
                rmu.data[2] = len;
                rmu.data[3] = Number(item.register.charAt(3));
                if(item.size=="s8" || item.size=="u8") {
                    rmu.data[4] = (incoming.value & 0xFF);
                    rmu.data[5] = Calc_CRC(rmu.data);
                } else {
                    let value = incoming.value;
                    if(value>=32768) { value = value-7 } else { value = value+7 }
                    rmu.data[4] = (value & 0xFF);
                    rmu.data[5] = ((value >> 8) & 0xFF);
                    rmu.data[6] = Calc_CRC(rmu.data);
                } 
                rmu.ackback[0] = 92;
                rmu.ackback[1] = 0;
                rmu.ackback[2] = (Number(item.register.charAt(2))+25);
                rmu.ackback[3] = 96;
                rmu.ackback[4] = 6;
                rmu.ackback[5] = (incoming.register & 0xFF);
                rmu.ackback[6] = ((incoming.register >> 8) & 0xFF);
                rmu.ackback[7] = (incoming.value & 0xFF);
                rmu.ackback[8] = ((incoming.value >> 8) & 0xFF);
                rmu.ackback[9] = ((incoming.value >> 16) & 0xFF);
                rmu.ackback[10] = ((incoming.value >> 24) & 0xFF);
                rmu.ackback[11] = Calc_CRC(rmu.ackback);
            } else {
                data[0] = 0xc0;
                data[1] = 0x6b;
                data[2] = 0x06;
                data[3] = (incoming.register & 0xFF);
                data[4] = ((incoming.register >> 8) & 0xFF);
                data[5] = (incoming.value & 0xFF);
                data[6] = ((incoming.value >> 8) & 0xFF);
                data[7] = ((incoming.value >> 16) & 0xFF);
                data[8] = ((incoming.value >> 24) & 0xFF);
                data[9] = Calc_CRC(data);
            }
            log.debug('Data',`Sending data: ${incoming.register}, ${incoming.value}, ${JSON.stringify(data)}`);
            return data.length===0 ? rmu : data;
        } else {
            nibeEmit.emit('fault',{from:"Skicka värde",message:'Register('+incoming.register+') går ej att skriva till.'});
            log.error('Data','Register('+incoming.register+') not allowed write access');
            return -2;
        }
    } else {
        nibeEmit.emit('fault',{from:"Skicka värde",message:'Register('+incoming.register+') finns ej i databasen.'});
        log.error('Data','Register('+incoming.register+') not in database');
        return -1;
    }
}
function Calc_CRC(data) {
    var calc_checksum = 0;
    for (var i = 0; i < (data[2] + 5); i++)
        calc_checksum ^= data[i];
    // 0x5C is the bus start byte, so a checksum of 0x5C is sent as 0xC5, as in
    // openHAB's NibeGW; esphome-nibe drops a request whose checksum lacks it.
    if (calc_checksum === 0x5C) calc_checksum = 0xC5;
    return calc_checksum;
}
const addRegister = (address,logset=false) => {
    if(register.length!==0)  {
        let index = register.findIndex(index => index.register == address);
        if(index===-1 && config.system.testmode!==true) {
            return;
        };
        if(config.registers===undefined) {
            config.registers = [];
            updateConfig()
        }
        if(register[index]!==undefined) register[index].logset = logset;
        let confIndex = config.registers.findIndex(confIndex => confIndex == address);
        if(confIndex===-1) {
            log.info('Register',`Adding register ${address}`);
            config.registers.push(address);
            if(logset===false) {
                addRegular(address);
            }
            updateConfig()
        } else if(logset===false) {
            // Already in config.json but maybe not polled since this start
            // (addRegular skips one that is queued or pushed by the pump).
            addRegular(address);
        }
    }
    }
function removeRegister(address) {
    if(register!==[] && register.length>1)  {
    let index = register.findIndex(index => index.register == address);
    if(index===-1 && config.system.testmode!==true) {
        return;
    };
    if(config.registers===undefined) {
        config.registers = [];
        updateConfig()
    }
    let confIndex = config.registers.findIndex(confIndex => confIndex == address);
    if(confIndex!==-1) {
        config.registers.splice(confIndex,1);
        removeMQTTdiscovery(register[index]);
        updateConfig()
        removeRegular(address);
    }
  }
}
const decodeRMU = (buf) => {
    if((buf[2]==0x19 || buf[2]==0x1A || buf[2]==0x1B || buf[2]==0x1C) && buf[3]===98) {
        let data = [];
        let bitData = buf[21];
        let r = {};
        if(bitData>=128) { bitData = bitData-128; } else {  }
        if(bitData>=64) { bitData = bitData-64; }
        if(bitData>=32) { bitData = bitData-32; r[47393] = 1;} else { r[47393] = 0; } // Inside S2 activated
        if(bitData>=16) { bitData = bitData-16; r[47394] = 1;} else { r[47394] = 0; } // Inside S1 activated
        if(bitData>=8) { bitData = bitData-8; }
        if(bitData>=4) { bitData = bitData-4; }
        if(bitData>=2) { bitData = bitData-2; }
        if(bitData>=1) { bitData = bitData-1; }
        if(r[47394]===1) { r[47398] = buf[9]+50 } else { r[47011] = buf[9] };
        if(r[47393]===1) { r[47397] = buf[10]+50 } else { r[47010] = buf[10] };

        r[40004] = (buf[6] & 0xFF) << 8 | (buf[5] & 0xFF);
        if(r[40004]>=32768) { r[40004] = r[40004]+5 } else { r[40004] = r[40004]-5 }
        r[40013] = ((buf[8] & 0xFF) << 8 | (buf[7] & 0xFF))-5;
        r[40058] = ((buf[14] & 0xFF) << 8 | (buf[13] & 0xFF))-5;
        data[0] = 92;
        data[1] = 0;
        data[2] = buf[2];
        data[3] = buf[3];
        data[4] = data.length;
        data[5] = (40004 & 0xFF);
        data[6] = ((40004 >> 8) & 0xFF);
        data[7] = (r[40004] & 0xFF);
        data[8] = ((r[40004] >> 8) & 0xFF);
        data[9] = (40013 & 0xFF);
        data[10] = ((40013 >> 8) & 0xFF);
        data[11] = (r[40013] & 0xFF);
        data[12] = ((r[40013] >> 8) & 0xFF);
        data[13] = (40058-buf[2] & 0xFF);
        data[14] = ((40058-buf[2] >> 8) & 0xFF);
        data[15] = (r[40058] & 0xFF);
        data[16] = ((r[40058] >> 8) & 0xFF);
        if(r[47394]===1) { data[17] = (47398 & 0xFF); } else { data[17] = (47011 & 0xFF); }
        if(r[47394]===1) { data[18] = ((47398 >> 8) & 0xFF); } else { data[18] = ((47011 >> 8) & 0xFF); }
        if(r[47394]===1) { data[19] = r[47398]; } else { data[19] = r[47011]; }
        data[20] = 0;
        if(r[47393]===1) { data[21] = (47397 & 0xFF); } else { data[21] = (47010 & 0xFF); }
        if(r[47393]===1) { data[22] = ((47397 >> 8) & 0xFF); } else { data[22] = ((47010 >> 8) & 0xFF); }
        if(r[47393]===1) { data[23] = r[47397]; } else { data[23] = r[47010]; }
        data[24] = 0;
        data[25] = (47394 & 0xFF);
        data[26] = ((47394 >> 8) & 0xFF);
        data[27] = r[47394];
        data[28] = 0;
        data[29] = (47393 & 0xFF);
        data[30] = ((47393 >> 8) & 0xFF);
        data[31] = r[47393];
        data[32] = 0;
        data[33] = (10001 & 0xFF);
        data[34] = ((10001 >> 8) & 0xFF);
        data[35] = buf[24];
        data[36] = 0;
        let fan_address = Number(`10${buf[2]-25}10`);
        data[37] = (fan_address & 0xFF);
        data[38] = ((fan_address >> 8) & 0xFF);
        data[39] = buf[18];
        data[40] = 0;
        let hw_address = Number(`10${buf[2]-25}20`);
        data[41] = (hw_address & 0xFF);
        data[42] = ((hw_address >> 8) & 0xFF);
        data[43] = buf[15];
        data[44] = 0;
        data[45] = (10011 & 0xFF);
        data[46] = ((10011 >> 8) & 0xFF);
        if(buf[18]===0) { data[47] = 0; } else { data[47] = buf[26]; }
        data[48] = 0;
        data[49] = (10012 & 0xFF);
        data[50] = ((10012 >> 8) & 0xFF);
        if(buf[18]===0) { data[51] = 0; } else { data[51] = buf[27]; }
        data[52] = 0;
        data[53] = (10021 & 0xFF);
        data[54] = ((10021 >> 8) & 0xFF);
        data[55] = buf[16];
        data[56] = 0;
        data[57] = (10022 & 0xFF);
        data[58] = ((10022 >> 8) & 0xFF);
        data[59] = buf[17];
        data[60] = 0;
        data[4] = data.length;
        decodeMessage(data);
        /*
        if(i===26) address = 10011; 
        if(i===27) address = 10012;*/
    }
}
const addRegular = (address) => {
    if(core!==undefined && core.connected!==undefined && core.connected===true) {
    let regIndex = register.findIndex(regIndex => regIndex.register == address);
    if(register[regIndex]===undefined) return;
    if(register[regIndex]===-1 || (register[regIndex].logset!==undefined && register[regIndex].logset===true)) return;
    // getData() builds a fresh array each call, so comparing queue entries to it
    // with == was reference equality and never matched: every call re-requested
    // the register and pushed another copy onto regQueue, stretching the
    // round-robin poll interval for every register in it. Compare by value, the
    // way removeRegular already does.
    var stringed = getData(address).toString();
    let index = regQueue.findIndex(item => item.toString() === stringed);
    if(index===-1) {
        if(address.toString().charAt(0)=="1") {
            log.debug('Register',`RMU register not added to regular list, Register: ${address}`);
        } else {
            // Req data change
            reqData(address).catch(logCatch)
            regQueue.push(getData(address));
            log.info('Register',`Regular register added (${address})`);
            core.send({type:"regRegister",data:regQueue});
        }
        
        //
        
    }
} else {
    setTimeout((data) => {
        addRegular(data)
    }, 10000, address);
}
}
const removeRegular = (address) => {
    var stringed = getData(address).toString();
    if(core!==undefined && core.connected!==undefined && core.connected===true) {
    for (i = 0; i < regQueue.length; i = i + 1) {
        let value = regQueue[i].toString();
        if(stringed===value) {
            regQueue.splice(i,1)
            log.info('Register',`Regular register removed (${address})`);
            core.send({type:"regRegister",data:regQueue});
        }
    }
} else {
    setTimeout((data) => {
        removeRegular(data);
    }, 10000, address);
}
}

const decodeMessage = (buf) => {
    
    
    if(register.length===0) return;
    if(buf[3]!==104 && buf[3]!==106 && buf[3]!==98 && buf[3]!==96) return;
    var data;
    let timeNow = Date.now();
    for (i = 5; i < buf.length-3; i = i + 1) {
        var address = (buf[i + 1] * 256 + buf[i]);
        var index = register.findIndex(index => index.register == address);
        if (index!==-1) {
            if (buf[3]===104 || buf[3]===98 || buf[3]===96) {
                addRegister(address,true)
            } else {
                if(register[index].logset===true) {
                    removeRegular(address);
                }
            } 
            //log('info',`Register: ${register[index].register} found at index ${index}, ${JSON.stringify(register[index])}`)
            if (register[index].size == "s32") {
                if (buf[3]===104) {
                    data = buf[i + 2] | buf[i + 3]<<8 | buf[i + 6] <<16 | buf[i + 7] <<24;
                    
                    if (data >= 2147483648) {
                        data = (data - 4294967296);
                    }
                    i = i + 7;
                }
                else {
                    data = buf[i + 4] | buf[i + 5] <<8 | buf[i + 2] <<16 | buf[i + 3] <<24;
                    //data = buf[i + 2] | buf[i + 3] <<8 | buf[i + 4] <<16 | buf[i + 5] <<24;
                    
                    if (data >= 2147483648) {
                        data = (data - 4294967296);
                    }
                    i = i + 5;
                }
            }
            else if (register[index].size == "s16") {
                data = (buf[i + 3] & 0xFF) << 8 | (buf[i + 2] & 0xFF);
                
                i = i + 3;
                if (data >= 32768) {
                    data = data - 65536;
                }          
            }
            else if (register[index].size == "s8") {
                data = (buf[i + 3] & 0xFF) << 8 | (buf[i + 2] & 0xFF);
                
                i = i + 3;
                if (data >= 128 && data < 32768) {
                    data = data - 256;
                } else if (data >= 32768) {
                    data = data - 65536;
                }
            }
            else if (register[index].size == "u32") {
                if (buf[3]===104) {
                    data = buf[i + 2] | buf[i + 3]<<8 | buf[i + 6] <<16 | buf[i + 7] <<24;
                    data = data>>>0;
                    
                    i = i + 7;
                }
                else {
                    data = (buf[i + 4] & 0xFF) | (buf[i + 5] & 0xFF) << 8 | (buf[i + 2] & 0xFF) << 16 | (buf[i + 3] & 0xFF) << 24;
                    //data = (buf[i + 2] & 0xFF) | (buf[i + 3] & 0xFF) << 8 | (buf[i + 4] & 0xFF) << 16 | (buf[i + 5] & 0xFF) << 24;
                    //data = (buf[i + 2] & 0xFF) << 16 | (buf[i + 3] & 0xFF) << 24 | (buf[i + 4] & 0xFF) | (buf[i + 5] & 0xFF) << 8; Old way
                    data = data>>>0;
                    
                    i = i + 5;
                }
            }
            else if (register[index].size == "u16") {
                data = (buf[i + 3] & 0xFF) << 8 | (buf[i + 2] & 0xFF);
                
                i = i + 3;
            }
            else if (register[index].size == "u8") {
                    data = (buf[i + 3] & 0xFF) << 8 | (buf[i + 2] & 0xFF);
                    
                    i = i + 3;
            }
            else {
                i = i + 3;
            }
            data = data / register[index].factor;
            var map = register[index].map;
            var valueMap;
            if (map !== undefined) {
                for (y = 0; y < map.length; y = y + 1) {
                    var mapValue = Object.values(map[y]);
                    if (Number(Object.keys(map[y])) == data) {
                        valueMap = mapValue[0];
                        
                    }
                }
            }
            let corruptData = false;
            let min = Number(register[index].min);
            let max = Number(register[index].max);
            if (min !== undefined && max !== undefined) {
                if (min !== 0 || max !== 0) {
                    if ((data > max / register[index].factor) || (data < min / register[index].factor)) {
                        nibeEmit.emit('fault',{from:"Datahantering",message:'Korrupt värde från register '+address+", Värde: "+data+register[index].unit});
                        log.error('CORRUPT',register[index].register+", "+register[index].titel+": "+register[index].data+" "+register[index].unit);
                        corruptData = true;
                    }
                }
            }
            if(corruptData===false) {
                if(valueMap!==undefined) {
                    register[index].data = valueMap;
                    valueMap = undefined;
                } else {
                register[index].data = data;
                }
                register[index].raw_data = data;
                register[index].timestamp = timeNow;
                
                nibeEmit.emit(address,register[index]);
                addMQTTdiscovery(register[index]);
                publishMQTT(config.mqtt.topic+address+"/json",JSON.stringify(register[index]))
                publishMQTT(config.mqtt.topic+address+"/raw",register[index].raw_data)
                publishMQTT(config.mqtt.topic+address,register[index].data)
                log.debug('Data',JSON.stringify(register[index]));
                log.debug('Data',register[index].register+", "+register[index].titel+": "+register[index].data+" "+register[index].unit);
            }
            address = undefined;
        } else {
            i = i + 3;
        }
    }
    
    if(regQueue.length===0 && buf[3]===104) {
        for (var i = 0; i < config.registers.length; i++) {
            addRegular(config.registers[i]);
        }
    }
}
const getConfig = () => {
    //nibeEmit.emit('config',config);
    return config;
}

const getRegister = () => {
    return register;
}
function startMQTT(host,port,user,pass) {
    return new Promise(function(resolve, reject) {
    const mqtt = require('mqtt');
    if(user=="") user = undefined;
    if(pass=="") pass = undefined;
    var mqtt_host = host;
    var mqtt_port = port;
    var mqtt_subscribe_topic = 'nibe';
    var mqtt_publish_topic = 'nibe';
    var mqtt_username = user;
    var mqtt_password = pass;
    var mqtt_client_id = 'nibe_' + Math.random().toString(16);
    // MQTT CLIENT OPTIONS
    var mqtt_Options = {
        port: mqtt_port,
        keepalive: 60,
        clientId: mqtt_client_id,
        protocolId: 'MQTT',
        //protocolVersion: 4,
        clean: true,
        reconnectPeriod: 5000,
        connectTimeout: 30 * 1000,
        rejectUnauthorized: false,
        will: { topic: config.mqtt.topic+'status', payload: 'offline', qos: 1, retain: true }
    };
    if(mqtt_username!==undefined) mqtt_Options.username = mqtt_username
    if(mqtt_password!==undefined) mqtt_Options.password = mqtt_password
    // One client per set of settings, kept for the process lifetime: mqtt.js
    // reconnects by itself (reconnectPeriod) and resubscribes on reconnect.
    const client = mqtt.connect('mqtt://' + mqtt_host, mqtt_Options);
    mqtt_client = client;
    mqttState.since = Date.now();
    client.on('connect', function () {
        if(client!==mqtt_client) return;
        mqttState.connects++;
        mqttState.lastConnect = Date.now();
        mqttErrorShown = false;
        log.info('MQTT','MQTT broker is connected');
        client.publish(config.mqtt.topic+'status', 'online', {qos:1, retain:true});
        client.subscribe('homeassistant/status');
        client.subscribe(config.mqtt.topic+'#');
        // Every lease register, so a retained state left from before an
        // outage is overwritten with the current one.
        publishGatewayState();
        leases.publishAll(true);
        cleanOldDiscovery();
        scheduleDiscovery();
        resolve(client);
    });
    client.on('close',function(err){
        if(client===mqtt_client) mqttState.lastDisconnect = Date.now();
        log.info('MQTT','MQTT broker is disconnected');
    });
    client.on('reconnect',function(){
        if(client===mqtt_client) mqttState.reconnects++;
    });
    // Not ended on error: the broker may simply start after the gateway, and the
    // client keeps retrying. Reported once until the next successful connect.
    client.on('error',function(error){
        if(client===mqtt_client) {
            mqttState.lastError = error && error.message ? error.message : String(error);
            mqttState.lastErrorAt = Date.now();
        }
        if(client===mqtt_client && mqttErrorShown===false) {
            mqttErrorShown = true;
            log.error('MQTT','Could not connect to MQTT broker: '+(error && error.message ? error.message : error));
        }
        reject(error);
      });
    // Registered once per client, so each message is handled once.
    client.on('message', function (topic, message, packet) {
        if(client!==mqtt_client) return;
        onMQTTMessage(topic, message, packet);
    });
})
}
//
// Home Assistant MQTT discovery, device-based: one config message for the pump at
// homeassistant/device/<id>/config, with one component per polled register.
// https://www.home-assistant.io/integrations/mqtt/#mqtt-discovery
function discoveryId() {
    if(config.system===undefined) config.system = {};
    if(config.system.id===undefined || config.system.id===0 || config.system.id==="") {
        config.system.id = require('crypto').randomBytes(5).toString('hex');
        updateConfig();
    }
    return 'nibepi_'+config.system.id;
}
const discoveryUnits = {
    '°C': {device_class:'temperature', state_class:'measurement'},
    'A': {device_class:'current', state_class:'measurement'},
    'V': {device_class:'voltage', state_class:'measurement'},
    'W': {device_class:'power', state_class:'measurement'},
    'kW': {device_class:'power', state_class:'measurement'},
    'Wh': {device_class:'energy', state_class:'total_increasing'},
    'kWh': {device_class:'energy', state_class:'total_increasing'},
    'Hz': {device_class:'frequency', state_class:'measurement'},
    '%': {state_class:'measurement'},
};
function discoveryComponent(data) {
    let component = {
        p: 'sensor',
        name: data.titel,
        unique_id: discoveryId()+'_'+data.register,
        state_topic: config.mqtt.topic+data.register,
    };
    // A register with a value map publishes text, which Home Assistant only accepts
    // from a sensor without a unit or class.
    let unit = (data.unit || '').trim();
    if(data.map===undefined && unit!=='') {
        component.unit_of_measurement = unit;
        Object.assign(component, discoveryUnits[unit] || {});
    }
    return component;
}
function scheduleDiscovery() {
    if(discovery.timer!==undefined) clearTimeout(discovery.timer);
    discovery.timer = setTimeout(publishDiscovery, 3000);
}
function publishDiscovery() {
    discovery.timer = undefined;
    if(mqtt_client===undefined || mqtt_client.connected!==true || config.mqtt===undefined) return;
    if(config.mqtt.discovery!==true) {
        // The broker may still hold a retained device config from an earlier run.
        let hasId = config.system!==undefined && config.system.id!==undefined && config.system.id!==0 && config.system.id!=="";
        if(discovery.cleared!==true && hasId) {
            publishMQTT('homeassistant/device/'+discoveryId()+'/config','',true);
            log.info('MQTT',`Removed MQTT Discovery device`);
        }
        discovery.cleared = true;
        return;
    }
    let topic = 'homeassistant/device/'+discoveryId()+'/config';
    let cmps = {};
    for (const reg in discovery.removed) cmps[reg] = {p:'sensor'};
    Object.assign(cmps, discovery.components);
    if(Object.keys(cmps).length===0) return;
    // Bus health is not a register: announce it so Home Assistant gets a sensor
    // without a hand-written MQTT entity (errors per minute, details as attributes).
    cmps.bus_health = {
        p: 'sensor',
        name: 'Bus errors',
        unique_id: discoveryId()+'_bus_health',
        state_topic: config.mqtt.topic+'bus_health',
        value_template: '{{ value_json.errors }}',
        json_attributes_topic: config.mqtt.topic+'bus_health',
        unit_of_measurement: 'errors/min',
        state_class: 'measurement',
        entity_category: 'diagnostic',
    };
    let message = {
        dev: {ids:[discoveryId()], name:'Nibe '+model, mf:'NIBE', mdl:model, sw:String(firmware)},
        o: {name:'NibePi', sw:nibepi_version, url:'https://github.com/fnordpojk/nibepi-backend'},
        avty_t: config.mqtt.topic+'status',
        cmps: cmps,
    };
    publishMQTTpromise(topic,JSON.stringify(message),true).then(() => {
        discovery.cleared = false;
        discovery.removed = {};
        log.info('MQTT',`Published MQTT Discovery device, ${Object.keys(discovery.components).length} sensors`);
    },(error => {}));
}
function addMQTTdiscovery(data) {
    if(config.mqtt===undefined) {
        config.mqtt = {};
        updateConfig();
    }
    if(config.mqtt.discovery!==true) {
        if(discovery.cleared!==true) {
            discovery.components = {};
            if(discovery.timer===undefined) scheduleDiscovery();
        }
        return;
    }
    if(discovery.components[data.register]!==undefined) return;
    if(config.registers.findIndex(j => j == data.register)===-1) return;
    discovery.components[data.register] = discoveryComponent(data);
    delete discovery.removed[data.register];
    scheduleDiscovery();
}
function removeMQTTdiscovery(data) {
    if(data===undefined || discovery.components[data.register]===undefined) return;
    delete discovery.components[data.register];
    discovery.removed[data.register] = true;
    scheduleDiscovery();
}
// Earlier versions published one retained config per register, without a unique_id,
// at homeassistant/sensor/<register>/config. Clear the ones pointing at our topics.
function cleanOldDiscovery() {
    if(discovery.cleaning===true) return;
    discovery.cleaning = true;
    mqtt_client.subscribe('homeassistant/sensor/+/config');
    setTimeout(() => {
        if(mqtt_client!==undefined) mqtt_client.unsubscribe('homeassistant/sensor/+/config');
        discovery.cleaning = false;
    }, 10000);
}
function clearOldDiscovery(topic,message) {
    let match = topic.match(/^homeassistant\/sensor\/(\d+)\/config$/);
    if(match===null || message.length===0) return;
    try {
        let old = JSON.parse(message.toString());
        if(old.state_topic===config.mqtt.topic+match[1] && old.unique_id===undefined) {
            publishMQTT(topic,'',true);
            log.info('MQTT',`Cleared old MQTT Discovery object, register ${match[1]}`);
        }
    } catch(e) {}
}
// <topic>lease/<reg>/set|release. Retained requests are ignored: the broker
// replays them on every reconnect, which would renew a lease its owner has
// stopped renewing, or release one it still holds.
function onLeaseMessage(topic, message, packet) {
    if(topic.length!==3 || !/^\d+$/.test(topic[1])) return;
    const reg = topic[1];
    const action = topic[2];
    if(action!=='set' && action!=='release') return; // incl. our own .../state
    if(packet!==undefined && packet.retain===true) {
        if(message.length!==0) logRefusal('lease'+reg,`retained lease/${reg}/${action} ignored, lease requests must not be retained`);
        return;
    }
    const job = action==='set' ? leases.acquire(reg,message) : leases.release(reg);
    job.catch(err => gatewayLog(`Lease ${reg}: ${err && err.message ? err.message : err}`));
}
// Incoming MQTT messages: Home Assistant status, old discovery objects,
// leases and <topic><register>/set|get|add|remove.
function onMQTTMessage(topic, message, packet) {
    if(topic==='homeassistant/status') {
        if(message.toString()==='online') scheduleDiscovery();
        return;
    }
    if(topic.startsWith('homeassistant/sensor/')) {
        clearOldDiscovery(topic,message);
        return;
    }
    if(topic.startsWith(config.mqtt.topic)) {
        topic = topic.replace(config.mqtt.topic,'')
        topic = topic.split('/');
        // Before the generic handlers: lease/47011/set is no raw set of a
        // register called "lease", and the gateway's own retained state
        // topics come back through the <topic># subscription.
        if(topic[0]==="lease") {
            onLeaseMessage(topic, message, packet);
        } else if(topic[0]==="gateway") {
            // gateway/state, published here
        } else if(topic[0]=="adjust_s1") {
            if(topic.includes('set')) {
                // Stored as a number: a Buffer here broke Number(adjust_s1) later.
                let value = parseWriteValue(message);
                if(Number.isFinite(value)) {
                    if(config.home===undefined) config.home = {};
                    config.home.adjust_s1 = value;
                    updateConfig();
                    publishMQTT(config.mqtt.topic+"adjust_s1",config.home.adjust_s1)
                }
            } else if(topic.includes('get')) {
                if(config.home!==undefined) publishMQTT(config.mqtt.topic+"adjust_s1",config.home.adjust_s1)
            }
        } else if(topic[0]=="adjust_s2") {
            if(topic.includes('set')) {
                // Stored as a number: a Buffer here broke Number(adjust_s2) later.
                let value = parseWriteValue(message);
                if(Number.isFinite(value)) {
                    if(config.home===undefined) config.home = {};
                    config.home.adjust_s2 = value;
                    updateConfig();
                    publishMQTT(config.mqtt.topic+"adjust_s2",config.home.adjust_s2)
                }
            } else if(topic.includes('get')) {
                if(config.home!==undefined) publishMQTT(config.mqtt.topic+"adjust_s2",config.home.adjust_s2)
            }
        } else if(topic.includes('set')) {
            const refused = Lease.rawSetRefusal(gatewayConfig().raw_set,topic[0],leases.ownerOf(topic[0]));
            if(refused!==null) return logRefusal(topic[0],'raw /set: '+refused);
            setData(topic[0],message.toString(),(err,result) => {
                if(err) return log.warn('Write',err);
            });
        } else if(topic.includes('get')) {
            reqData(topic[0]).catch(logCatch);
        } else if(topic.includes('add')) {
            addRegister(topic[0])
        } else if(topic.includes('remove')) {
            removeRegister(topic[0])
        }
    }
}
let mqttKey;               // settings mqtt_client was created with
let mqttErrorShown = false;
// Connection history for the status page.
const mqttState = {since:null, connects:0, reconnects:0, lastConnect:null, lastDisconnect:null, lastError:null, lastErrorAt:null};
// Called on every config update. Creates the client once and replaces it
// (ending the old one first) only when the broker settings or topic change.
// Before, every update while the broker was down created another client
// without ending the old one, and after the outage each of them handled
// every .../set message.
const handleMQTT = (on,host,port,user,pass,cb=()=>{}) => {
    if(on===undefined || on=="" || on=="false" || on===false) {
        if(mqtt_client!==undefined) {
            mqtt_client.end();
            mqtt_client = undefined;
            mqttKey = undefined;
            log.info('MQTT','Terminated MQTT session');
        }
        return cb(null,false)
    };
    if(host===undefined || host=="") return cb(err = new Error('No MQTT host defined'));
    if(port===undefined || port=="") return cb(err = new Error('No MQTT port defined'));
    const key = JSON.stringify([String(host),String(port),user||'',pass||'',config.mqtt.topic]);
    if(mqtt_client!==undefined && key===mqttKey) {
        return cb(null,mqtt_client.connected===true);
    }
    if(mqtt_client!==undefined) {
        log.info('MQTT','MQTT settings changed, reconnecting');
        mqtt_client.end();
        mqtt_client = undefined;
    }
    log.info('MQTT',`Connecting to MQTT broker ${host}:${port}`);
    mqttKey = key;
    mqttErrorShown = false;
    startMQTT(host,port,user,pass).then(() => {
        cb(null,true);
    }, () => {
        cb(null,false);
    });
}
const publishMQTT = (topic,message,retain=false) => {
    if(message===undefined || message===null) return;
    if(mqtt_client!==undefined) {
        if(mqtt_client.connected===true && mqtt_client.disconnecting!==true) {
            mqtt_client.publish(topic, message.toString(),{retain:retain});
        }
    }
    
}
const publishMQTTpromise = (topic,message,retain=false) => {
    const promise = new Promise((resolve,reject) => {
    if(message===undefined || message===null) return reject(false);
    if(mqtt_client!==undefined) {
        if(mqtt_client.connected===true && mqtt_client.disconnecting!==true) {
            mqtt_client.publish(topic, message.toString(),{retain:retain});
            resolve(true);
        } else {
            reject(false);
        }
    } else {
        reject(false);
    }
});
return promise;
}
const gatewayConfig = () => {
    if(config.gateway===null || typeof config.gateway!=='object' || Array.isArray(config.gateway)) config.gateway = {};
    return config.gateway;
}
const gatewayLog = (message) => {
    log.info('Gateway',message);
}
const publishLeaseState = (reg,state) => {
    publishMQTT(config.mqtt.topic+'lease/'+reg+'/state',JSON.stringify(state),true);
}
// Retained summary for the HA component: which leases are held and whether
// the core is getting data.
const publishGatewayState = () => {
    const rawSet = gatewayConfig().raw_set;
    publishMQTT(config.mqtt.topic+'gateway/state',JSON.stringify({
        version: nibepi_version,
        build: nibepi_build,
        leases: leases.summary(),
        raw_set: rawSet===undefined ? "all" : rawSet,
        core: coreState,
        lastData: lastData
    }),true);
}
// Register leases (lib/lease.js). Created last, once everything it calls is
// defined. Baselines go to config.gateway.baselines only on acquire and
// restore, never on renewals: every save is an SD card write.
leases = new Lease.LeaseManager({
    table: Lease.buildTable(gatewayConfig().leases),
    write: (reg,value) => new Promise((resolve,reject) => {
        setData(reg,value,(err,ack) => {
            if(err) return reject(err instanceof Error ? err : new Error(String(err)));
            // A core may answer a refused write with ack false.
            if(ack===false) return reject(new Error('Write to register '+reg+' was not acknowledged'));
            resolve(ack);
        },{lease:true});
    }),
    read: (reg) => reqData(reg).then(data => Number(data.raw_data)),
    // RMU40 registers (1xxxx) only exist once the pump polls that room unit,
    // and are read-only when another RMU40 answers: say so instead of
    // "Register dont exist" or "Register not writeable".
    validate: (reg,value) => {
        if(register.length!==0) {
            const refusal = Lease.rmuRefusal(reg,register.find(item => item.register == reg));
            if(refusal!==null) return refusal;
        }
        return validateWrite(reg,value);
    },
    normalize: (reg,value) => {
        const item = register.find(item => item.register == reg);
        return item!==undefined ? Lease.roundToFactor(value,item.factor) : value;
    },
    persist: (baselines) => {
        gatewayConfig().baselines = baselines;
        return saveConfig().then(saved => {
            if(saved!==true) throw new Error('config.json could not be saved');
        });
    },
    publish: publishLeaseState,
    fault: (message) => nibeEmit.emit('fault',{from:"Gateway",message:message}),
    log: gatewayLog,
    neutral: (reg,spec) => Lease.neutralValue(spec,config)
});
{
    const grace = leases.start(gatewayConfig().baselines);
    if(grace.length!==0) {
        const text = `Lease aktiv vid omstart för register ${grace.join(', ')}, återställs om ${Lease.DEFAULT_TTL/60} minuter om den inte förnyas`;
        gatewayLog(`Grace lease for ${grace.join(', ')}: restored in ${Lease.DEFAULT_TTL} s unless renewed`);
        // Delayed so the caller's 'fault' listeners are attached.
        setTimeout(() => nibeEmit.emit('fault',{from:"Gateway",message:text}), 10000);
    }
}
// Lease states at least once a minute while active, as the contract says.
let gatewayTimer = setInterval(() => {
    publishGatewayState();
    leases.publishAll();
    checkCommsAlarm('watch');
}, 60000);
// The pump's answer to each write (backend.js): refused writes are logged,
// and listeners such as the alarm reset get the result.
const onWriteResult = (result) => {
    const reg = result.register;
    // Warnings, so they show in the status page's default (warn) log view.
    if(result.ok===false) log.warn('Write',`The pump refused the write to register ${reg} (NAK)`);
    else if(String(reg)==='45171') log.warn('Write',`Alarm reset: the pump ${result.ok===true ? 'accepted it (ACK)' : 'did not answer'}`);
    else if(result.ok===null) log.warn('Write',`No answer from the pump to the write to register ${reg}`);
    else log.debug('Write',`The pump accepted the write to register ${reg}`);
    nibeEmit.emit('writeResult_'+reg, result.ok);
};
// Acknowledge the pump's communication alarm (251) that a gateway restart
// leaves behind, and nothing else (lib/alarm.js).
const alarm = require('./lib/alarm');
let alarmCheck = {running:false, lastResetAt:undefined, failures:0};
const checkCommsAlarm = (reason) => {
    if(alarmCheck.running || coreState!=='up' || model==="") return;
    if(register.findIndex(i => i.register == 45001)===-1 || register.findIndex(i => i.register == 45171)===-1) return;
    alarmCheck.running = true;
    reqData(45001).then(data => {
        const raw = data!==undefined ? data.raw_data : undefined;
        if(Number(raw)===0) alarmCheck.failures = 0;
        if(!alarm.shouldReset(raw, alarm.resetAlarmList(config), alarmCheck.lastResetAt, Date.now(), alarm.gapAfter(alarmCheck.failures))) return;
        alarmCheck.lastResetAt = Date.now();
        log.warn('Pump',`Alarm ${raw} active (${reason}), resetting it (attempt ${alarmCheck.failures+1})`);
        // 45171 may act on a change to 1 only: a 1 left from an earlier
        // reset would make another 1 a no-op. Log it, then write 0 and 1.
        const writeReset = (cb) => {
            setData(45171, 0, (err0) => {
                if(err0) log.warn('Pump',`Writing 0 to the alarm reset failed: ${err0.message || err0}`);
                setData(45171, 1, cb);
            });
        };
        reqData(45171).then(before => {
            log.warn('Pump',`Alarm reset register 45171 holds ${before!==undefined ? before.raw_data : 'nothing'} before the reset`);
        }).catch(logCatch).finally(() => writeReset((err) => {
            if(err) return log.error('Pump',`Could not reset alarm ${raw}: ${err.message || err}`);
            setTimeout(() => {
                reqData(45001).then(after => {
                    const now = after!==undefined ? after.raw_data : undefined;
                    if(Number(now)===Number(raw)) {
                        alarmCheck.failures++;
                        log.error('Pump',`Alarm ${raw} is still active after the reset`);
                        nibeEmit.emit('fault',{from:"Värmepump",message:`Larm ${raw} kvarstår efter återställning.`});
                    } else {
                        alarmCheck.failures = 0;
                        log.info('Pump',`Alarm ${raw} reset`);
                    }
                }).catch(logCatch);
            }, 30000);
        }));
    }).catch(logCatch).finally(() => { alarmCheck.running = false; });
};
// Clean stop for gateway.js. Nothing is released or restored: the persisted
// baselines start grace leases on the next run, so the owner can renew
// across a restart. A pending config save is written first, and MQTT says
// offline itself since a clean disconnect does not fire the last will.
const shutdown = async () => {
    clearInterval(gatewayTimer);
    leases.stop();
    if(timer!==undefined) {
        clearTimeout(timer);
        timer = undefined;
        await saveConfig().catch(() => {});
    }
    await diskQueue;
    const client = mqtt_client;
    if(client!==undefined) {
        mqtt_client = undefined;
        mqttKey = undefined;
        const within = (ms,work) => Promise.race([new Promise(resolve => work(resolve)), new Promise(resolve => setTimeout(resolve,ms))]);
        if(client.connected===true) {
            await within(2000, done => client.publish(config.mqtt.topic+'status','offline',{qos:1, retain:true}, () => done()));
        }
        await within(2000, done => client.end(false, {}, () => done()));
    }
    await stopCore();
}
// A read-only snapshot for the status page (lib/webui.js), which shapes and
// redacts it. Register values come from the cache; nothing is read from the
// pump here.
const STATUS_REGISTERS = ['40004','40008','40012','40013','40014','40033','47011','43086','45001','45171'];
const cachedValue = (reg) => {
    const item = register.find(item => item.register == reg);
    if(item===undefined) return null;
    return {register:String(reg), title:item.titel, value:item.data===undefined ? null : item.data,
        raw:item.raw_data===undefined ? null : item.raw_data, unit:item.unit===undefined ? '' : item.unit,
        timestamp:item.timestamp===undefined ? null : item.timestamp, mode:item.mode};
}
const getStatus = () => {
    const table = leases!==undefined ? leases.table : {};
    const leaseList = Object.keys(table).sort().map(reg => Object.assign(
        {register:reg, name:table[reg].name===undefined ? null : table[reg].name,
            min:table[reg].min===undefined ? null : table[reg].min, max:table[reg].max===undefined ? null : table[reg].max},
        leases.state(reg)));
    const rmuList = [1,2,3,4].map(system => {
        const room = String(10000+(system-1)*100+60);
        const item = register.find(item => item.register == room);
        return {
            system: system,
            address: RMU_FIRST_ADDRESS+system-1,
            detected: rmu['s'+system]===true,
            writable: item!==undefined ? item.mode==='R/W' : null,
            lastPoll: rmuSeen[system]!==undefined ? rmuSeen[system].lastPoll : null,
            readOnly: rmuSeen[system]!==undefined ? rmuSeen[system].readOnly : null,
            roomRegister: room,
            room: cachedValue(room),
            lastWrite: rmuWrites[room]!==undefined ? Object.assign({}, rmuWrites[room]) : null,
            lease: leases!==undefined && table[room]!==undefined ? leases.state(room) : null
        };
    });
    const values = STATUS_REGISTERS.map(cachedValue).filter(v => v!==null && v.timestamp!==null);
    return {
        version: nibepi_version,
        build: nibepi_build,
        core: {state:coreState, restarts:restartCount, model:model, firmware:firmware, lastData:lastData,
            connected: core!==undefined && core.connected===true},
        busHealth: busHealth===undefined ? null : Object.assign({}, busHealth),
        busHistory: busHistory.map(b => Object.assign({}, b)),
        mqtt: Object.assign({connected: mqtt_client!==undefined && mqtt_client.connected===true, active: mqtt_client!==undefined}, mqttState),
        rawSet: gatewayConfig().raw_set===undefined ? 'all' : gatewayConfig().raw_set,
        leases: leaseList,
        rmu: rmuList,
        values: values
    };
}
module.exports = {
    reqData:reqData,
    setData:setData,
    validateWrite:validateWrite,
    getLeases:() => leases,
    shutdown:shutdown,
    addRegister:addRegister,
    removeRegister:removeRegister,
    initiateCore:initiateCore,
    stopCore:stopCore,
    data:nibeEmit,
    getConfig:getConfig,
    getConfigFile:() => configFile,
    applyOverrides:applyOverrides,
    saveConfig:saveConfig,
    getRegister:getRegister,
    getHealth:getHealth,
    getStatus:getStatus,
    handleMQTT:handleMQTT
}
