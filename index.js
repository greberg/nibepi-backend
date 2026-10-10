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
const startCoreS = Core.startCoreS;
const startNibeGW = Core.startNibeGW;
const stopCoreProcess = require(__dirname+'/lib/stopCore');
var log = require('./log');
var child = require('child_process');
var docker = false;
let exec = child.exec;
let spawn = child.spawn;
let model = "";
let rmu = {};
let firmware = "";
let register = [];
let mqtt_client;
let mqtt_subcribers = [];
let mqttData = {};
let discovery = {components:{}, removed:{}, cleared:false, timer:undefined};
let red = false;
let config;
const regQueue = [];
const EventEmitter = require('events').EventEmitter
const nibeEmit = new EventEmitter();
const fs = require('fs');
const path = "/etc/nibepi"
const configFile = path+'/config.json';
const graphFile = path+'/graph.json';
if (!fs.existsSync(path)) {
    // Plain mkdir works in the container and wherever the user may create it;
    // the sudo route is for a bare Pi with a read-only root filesystem.
    try {
        fs.mkdirSync(path, {recursive:true});
        console.log(`Configuration directory created ${path}`);
    } catch(e) {
        exec(`sudo mount -o remount,rw / && sudo mkdir ${path} && sudo chown ${process.env.USER}:${process.env.USER} ${path}`, function(error, stdout, stderr) {
            if(error) {
                exec(`mkdir ${path} && chown ${process.env.USER}:${process.env.USER} ${path}`, function(error, stdout, stderr) {
                    if(error) {console.log('Error creating config directory')} else { console.log('Created config directory')}
                });
            } else {
                console.log(`Configuration directory created ${path}`);
            }
        });
    }
}
const readJSON = (file) => JSON.parse(fs.readFileSync(file,'utf8'));
// Set when the settings on disk could not be used; shown as a fault once
// Node-RED has started the core, and the loaded config is written back.
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
        console.log('Config file not found, loading default.');
        configNeedsSave = true;
        return readJSON(__dirname+'/default.json');
    }
    console.error(`[nibepi] ${configFile} could not be read: ${error.message}`);
    configNeedsSave = true;
    try {
        let conf = readJSON(configFile+'.bak');
        console.error(`[nibepi] Settings restored from ${configFile}.bak`);
        configLoadFault = 'Inställningsfilen var skadad, inställningarna är återställda från säkerhetskopian.';
        return conf;
    } catch(e) {
        console.error(`[nibepi] ${configFile}.bak could not be read either (${e.message}). ALL SETTINGS ARE RESET TO DEFAULTS.`);
    }
    let kept = '';
    if(fs.existsSync(configFile)) {
        let corrupt = configFile+'.corrupt-'+Date.now();
        try {
            fs.renameSync(configFile, corrupt);
            kept = ` Den skadade filen är sparad som ${corrupt}.`;
            console.error(`[nibepi] The unreadable config file was moved to ${corrupt}`);
        } catch(e) {
            // Read-only root: writeFileAtomic moves it aside when it saves.
            console.error(`[nibepi] Could not move the unreadable config file aside: ${e.message}`);
        }
    }
    configLoadFault = 'Inställningsfilen var skadad och kunde inte återställas, standardinställningar används.'+kept;
    return readJSON(__dirname+'/default.json');
}
function requireGraph(){
    const promise = new Promise((resolve,reject) => {
        for (const file of [graphFile, graphFile+'.bak']) {
            try {
                return resolve(readJSON(file));
            } catch (e) {}
        }
        reject('No graphs to load.')
    });
    return promise;
}
// All disk writes go through one chain, so the remount rw/ro of one save
// cannot interleave with another write.
let diskQueue = Promise.resolve();
const queueDisk = (job) => {
    const run = diskQueue.then(job);
    diskQueue = run.catch(() => {});
    return run;
}
const execPromise = (cmd) => new Promise((resolve,reject) => {
    exec(cmd, (error) => { if(error) { reject(error); } else { resolve(); } });
});
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
// Mark where each run starts and ends, so the log can be read from a restart.
// Written whenever file logging is on, whatever the categories. The stop line
// relies on log.js writing synchronously: nothing asynchronous runs on 'exit'.
const logEnabled = () => config!==undefined && config.log!==undefined && config.log.enable===true;
// Replacement for .catch(console.log) on fire-and-forget reqData calls: no
// stack traces, nothing while the pump has not announced its model yet, and
// the same message at most once a minute (a noisy RS485 bus otherwise floods
// the log with identical "No respond" lines). Same behaviour as the
// logCatch helper in node-red-contrib-nibepi's config_node.js.
const logCatchSeen = new Map();
const logCatch = (err) => {
    const msg = err && err.message ? err.message : String(err);
    if (msg === 'Heatpump is not ready yet.') return;
    const now = Date.now();
    const seen = logCatchSeen.get(msg);
    if (seen && now - seen.at < 60000) { seen.skipped++; return; }
    const skipped = seen && seen.skipped ? ` (repeated ${seen.skipped} times in the last minute)` : '';
    logCatchSeen.set(msg, { at: now, skipped: 0 });
    console.warn(`[nibepi] ${msg}${skipped}`);
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
};
log(logEnabled(),`NibePi ${nibepi_version} starting`,true,"System");
process.on('exit', (code) => {
    log(logEnabled(),`NibePi stopping (exit code ${code})`,true,"System");
});
// Deployment target: container vs bare Raspberry Pi. Decides whether config
// writes go straight to disk, or bracket themselves with sudo mount remount,rw
// to get at a read-only SD card. Precedence: NIBEPI_DOCKER, then
// config.system.docker, else false (bare Pi).
if(process.env.NIBEPI_DOCKER!==undefined) {
    let v = String(process.env.NIBEPI_DOCKER).trim().toLowerCase();
    docker = (v==='1' || v==='true' || v==='yes' || v==='on');
} else if(config!==undefined && config.system!==undefined && config.system.docker!==undefined) {
    docker = (config.system.docker===true || String(config.system.docker).toLowerCase()==='true');
}
var timer;
const saveGraph = (data) => {
    if(config.system===undefined || config.system.save_graph!==true) return Promise.reject();
    if(data===undefined) return Promise.reject(new Error('Cant save empty graph'));
    if(config.log===undefined) config.log = {};
    return queueDisk(async () => {
        const text = JSON.stringify(data,null,2);
        if(docker===true) {
            // Container: the filesystem is already writable and there is no SD
            // card to protect, so skip the remount dance entirely.
            try {
                await writeFileAtomic(graphFile,text);
            } catch(err) {
                throw new Error('Error saving graph to disc, write error');
            }
            log(config.log.enable,"Graphs saved",config.log['info'],"Graph");
            return 'Graferna sparade';
        }
        try {
            await execPromise('sudo mount -o remount,rw /');
        } catch(error) {
            log(config.log.enable,"Could not open the system for write mode",config.log['error'],"Config");
            throw new Error('Error saving graph, could not set RW mode');
        }
        let writeError;
        try {
            await writeFileAtomic(graphFile,text);
            log(config.log.enable,"Graphs saved",config.log['info'],"Graph");
            nibeEmit.emit('fault',{from:"Grafer",message:'Graferna är sparade till SD-kort'});
        } catch(err) {
            writeError = new Error('Error saving graph to disc, write error');
        }
        if(config.system.readonly===true) {
            try {
                await execPromise('sudo mount -o remount,ro /');
                console.log('Read only mode set.')
            } catch(error) {
                nibeEmit.emit('fault',{from:"Grafer",message:'Kunde inte sätta läsbart läge på filsystemet.'});
            }
        }
        if(writeError!==undefined) throw writeError;
        return 'Graferna sparade till SD-kort';
    });
}
let startingMQTT = false;
const updateConfig = (data) => {
    // A partial or non-object config used to replace the settings and then
    // throw below; ignore it instead.
    if(data===null || typeof data!=='object' || Array.isArray(data)) {
        console.log('[nibepi] Ignoring config update that is not an object');
        if(config!==undefined && config.log!==undefined) log(config.log.enable,"Ignoring config update that is not an object",config.log['error'],"Config");
        return;
    }
    config = data;
    for (const key of ['mqtt','system','log','home']) {
        if(config[key]===null || typeof config[key]!=='object') config[key] = {};
    }
    if(config.update===undefined) config.update = {}
    if(config.update.version!==nibepi_version) {
        config.update.version = nibepi_version
    }
        handleMQTT(config.mqtt.enable,config.mqtt.host,config.mqtt.port,config.mqtt.user,config.mqtt.pass, (err,result) => {
            if(err) {
                return console.log(err);
            } else {

            }
        })
    
    nibeEmit.emit('config',config);
    scheduleConfigSave();
}
// Debounced: settings often change in bursts.
const scheduleConfigSave = () => {
    if(timer!==undefined) clearTimeout(timer);
    timer = setTimeout(() => {
        saveConfig().catch((err) => {
            console.log('[nibepi] Could not save the config file: '+(err && err.message ? err.message : err));
        });
    }, 5000);
}
const saveConfig = () => queueDisk(async () => {
    if(config.system===undefined) config.system = {};
    if(config.log===undefined) config.log = {};
    const text = JSON.stringify(config,null,2);
    if(text.length<=2) return false;
    if(docker===false) {
        try {
            await execPromise('sudo mount -o remount,rw /');
        } catch(error) {
            log(config.log.enable,"Could not open the system for write mode",config.log['error'],"Config");
            return false;
        }
    }
    let saved = false;
    try {
        await writeFileAtomic(configFile,text);
        saved = true;
        log(config.log.enable,"Config file saved",config.log['info'],"Config");
        nibeEmit.emit('fault',{from:"Inställningar",message:'Inställningarna är sparade till SD-kort'});
    } catch(err) {
        log(config.log.enable,err,config.log['error'],"Config");
    }
    if(docker===false && config.system.readonly===true) {
        try {
            await execPromise('sudo mount -o remount,ro /');
            console.log('Read only mode set.')
        } catch(error) {
            nibeEmit.emit('fault',{from:"Inställningar",message:'Kunde inte sätta läsbart läge på filsystemet.'});
            log(config.log.enable,"Could not set read-only mode.",config.log['error'],"Config");
        }
    }
    return saved;
});
if(configNeedsSave===true) scheduleConfigSave();
let core;
// Core supervision. index.js tracks the core it forked: an unexpected exit is
// reported and the core is forked again with backoff (2 s doubling to 60 s,
// back to 2 s after 10 minutes up). stopCore() marks a stop as intended, so
// port or series changes from Node-RED do not trigger a restart.
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
const onBusStats = (stats) => {
    busHealth = {
        timestamp: Date.now(),
        ok: stats.ok,
        chksum: stats.chksum,
        no_respond: noRespondCount,
        errors: stats.chksum + noRespondCount
    };
    noRespondCount = 0;
    nibeEmit.emit('busHealth', busHealth);
    if(config!==undefined && config.mqtt!==undefined && config.mqtt.topic!==undefined) {
        publishMQTT(config.mqtt.topic+"bus_health", JSON.stringify(busHealth));
    }
    if(busHealth.errors>0) {
        const text = `Bus last minute: ${busHealth.ok} ok, ${busHealth.chksum} CHKSUM, ${busHealth.no_respond} No respond`;
        console.log(text);
        if(config!==undefined && config.log!==undefined) log(config.log.enable,text,config.log['info'],"Bus");
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
const getBusHealth = () => busHealth;
const getHealth = () => {
    return {core:coreState, model:model, lastData:lastData, restarts:restartCount, busHealth:busHealth};
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
}
// Kill the running core on purpose (watchdog); the exit handler restarts it.
const restartCore = (message) => {
    const child = core;
    const gen = coreGen;
    console.log(message);
    if(config!==undefined && config.log!==undefined) log(config.log.enable,message,config.log['error'],"Core");
    nibeEmit.emit('fault',{from:"core",message:message});
    // A 'fault' listener may already have stopped and restarted the core.
    if(gen!==coreGen || child===undefined || child.exitCode!==null || child.signalCode!==null) return;
    child.restartReason = message;
    child.kill('SIGTERM');
}
const superviseCore = (child,gen) => {
    // Without a listener a failed send to a dead core would throw in Node-RED.
    child.on('error', (err) => {
        console.log('Core process error: '+err.message);
    });
    child.once('exit', (code,signal) => {
        if(gen!==coreGen || coreWanted!==true) return; // stopped on purpose
        clearTimeout(stableTimer);
        coreState = 'down';
        restartCount++;
        const delay = restartDelay;
        restartDelay = Math.min(restartDelay*2, RESTART_MAX_MS);
        const text = `Core exited unexpectedly (code ${code}, signal ${signal}), restarting in ${delay/1000} s`;
        console.log(text);
        if(config!==undefined && config.log!==undefined) log(config.log.enable,text,config.log['error'],"Core");
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
// stopCore(nibe.core) from node-red-contrib-nibepi keeps working, and
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
const initiateCore = (host,port,cb) => {
    if(config.log===undefined) config.log = {};
    if(docker===false) {
        if(config.system.readonly===true) {
            exec('sudo mount -o remount,ro /', function(error, stdout, stderr) {
                if(error) {
                    log(config.log.enable,"Could not set read-only mode at startup.",config.log['error'],"Startup");
                    return(false);
                } else {
                    console.log('Read only mode set.')
                    return (true)
                }
            })
        } else {
            exec('sudo mount -o remount,rw /', function(error, stdout, stderr) {
                if(error) {
                    log(config.log.enable,"Could not set write mode at startup.",config.log['error'],"Startup");
                    return(false);
                } else {
                    return (true)
                }
            })
        }
    }
    if(configLoadFault!==undefined) {
        // Delayed so the 'fault' listeners in Node-RED are attached.
        const text = configLoadFault;
        configLoadFault = undefined;
        setTimeout(() => {
            nibeEmit.emit('fault',{from:"Inställningar",message:text});
            log(config.log.enable,text,config.log['error'],"Config");
        }, 10000);
    }
    coreArgs = {host:host,port:port,cb:cb};
    coreWanted = true;
    clearTimeout(restartTimer);
    forkCore();
}
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
        handler(m);
    };
    let forked = false;

if(config.connection!==undefined && config.connection.series!==undefined) {
    if(config.connection.series=="fSeries") {
        if(config.connection.enable=="serial") {
            forked = true;
            startCore(port).then(result => {
                if(adopt(result)===false) return;
                if(config.system!==undefined && config.system.rmu_emulation===false) {
                    console.log('RMU40 emulation disabled (system.rmu_emulation=false), RMU40 registers are read-only');
                    core.send({type:"rmuEmulation",data:false});
                }
                
                core.on('message', fromCore((m) => {
                    if(m.type=="data") {
                        markData();
                        let n = m.data;
                        announcment(m, (err,ready) => {
                            if(err) console.log(err);
                            if(ready===true) {
                                config.serial.port = port;
                                cb(null,result);
                            } else {
        
                            }
                        });
                        decodeRMU(n);
                        decodeMessage(n);
                    } else if(m.type=="fault") {
                        nibeEmit.emit('fault',m.data);
                    } else if(m.type=="ack") {
                        nibeEmit.emit("ACK_"+m.data.register,m.data.ack);
                    } else if(m.type=="busStats") {
                        onBusStats(m.data);
                    } else if(m.type=="log") {
                        if(config.log===undefined) {
                            config.log = {};
                            updateConfig(config);
                        }
                        log(config.log.enable,m.data,config.log[m.level],m.kind);
                    }
                  }));
            });
        } else if(config.connection.enable=="nibegw") {
            forked = true;
            startNibeGW(port).then(result => {
                if(adopt(result)===false) return;
                
                core.on('message', fromCore((m) => {
                    if(m.type=="data") {
                        markData();
                        let n = m.data;
                        announcment(m, (err,ready) => {
                            if(err) console.log(err);
                            if(ready===true) {
                                config.serial.port = port;
                                cb(null,result);
                            } else {
        
                            }
                        });
                        decodeMessage(n);
                    } else if(m.type=="fault") {
                        nibeEmit.emit('fault',m.data);
                    } else if(m.type=="ack") {
                        nibeEmit.emit("ACK_"+m.data.register,m.data.ack);
                    } else if(m.type=="log") {
                        if(config.log===undefined) {
                            config.log = {};
                            updateConfig(config);
                        }
                        log(config.log.enable,m.data,config.log[m.level],m.kind);
                    }
                  }));
            });
        }
        
    } else if(config.connection.series=="sSeries") {
                    forked = true;
                    startCoreS(host,port).then(result => {
                        if(adopt(result)===false) return;
                        core.on('message', fromCore((m) => {
                            if(m.type=="started") {
                                if(coreState==='starting') coreState = 'up';
                                let data = m.data;
                                if(config.tcp!==undefined && config.tcp.pump!==undefined) {
                                    let reg = require(`./models/${config.tcp.pump}.json`);
                                    if(reg!==undefined) {
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
                                        if(regQueue.length===0) {
                                            for (var i = 0; i < config.registers.length; i++) {
                                                addRegular(config.registers[i]);
                                            }
                                        }
                                    }
                                    
                                }
                                
                                if(data===true) {
                                    cb(null,result);
                                }
                                // Process message
                            } else if(m.type=="data") {
                                markData();
                                let data = m.data;
                                decodeS(data);
                            } else if(m.type=="ack") {
                                nibeEmit.emit("ACK_"+m.data.register,m.data.ack);
                            } else if(m.type=="fault") {
                                nibeEmit.emit('fault',m.data);
                            } else if(m.type=="log") {
                                if(config.log===undefined) {
                                    config.log = {};
                                    updateConfig(config);
                                }
                                log(config.log.enable,m.data,config.log[m.level],m.kind);
                            }
                          }));
                    });
    }
}
    if(forked===false) coreState = 'down';
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
const announcment = (msg,cb) => {
    const checkPump = (data,callback) => {
        let announced = parsePump(data);
        model = announced.model;
        firmware = announced.firmware;
        config.system.pump = model;
        config.system.firmware = firmware;
        updateConfig(config);
        callback(null);
        }
    if(model=="" && config.system.pump!==undefined && config.system.pump!=="" && config.system.firmware!==undefined && config.system.firmware!=="") {
        model = config.system.pump;
        firmware = config.system.firmware;
        try {
            let reg = require(`./models/${model}.json`);
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
            modelKnown();
            cb(null,true)
            console.log(`Nibe ${model} connected`);
            console.log(`Firmware ${firmware}`);
            console.log(`Register is set. Length: ${register.length}`)
        } catch(err) {
            console.log(`Heatpump is not supported ${model}`)
        }
        
    } else if(msg.data[3]==109) {
        
        let index = register.findIndex(i => i.register == 45001);
        if(index!==-1) {
            reqData(45001).then(atad => {
                let data = Object.assign({}, atad);
                if(data!==undefined && data.raw_data===251) {
                    console.log('Resetting alarm.')
                    setData(45171,1);
                }
            }).catch(logCatch)
        }
        
        //console.log(`Announcement message`);
        if(model=="") {
            checkPump(msg.data, function(err) { 
                if(err) throw err;
                let reg = require(`./models/${model}.json`);
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
                modelKnown();
                cb(null,true)
                console.log(`${model} connected`);
                console.log(`Firmware ${firmware}`);
                console.log(`Register is set. Length: ${register.length}`)
            });
        } else {
            // Model and firmware are cached in config.system and used from there at
            // start, so a firmware upgrade or a different pump only shows up here.
            let announced = parsePump(msg.data);
            if(announced.model!==model) {
                if(announcedModel!==announced.model) {
                    announcedModel = announced.model;
                    let text = `The pump announces itself as ${announced.model}, but the register map loaded is ${model}. Restart NibePi after removing system.pump and system.firmware from config.json.`;
                    console.log(text);
                    nibeEmit.emit('fault',{from:"Värmepump",message:text});
                    log(config.log.enable,text,config.log['error'],"Pump");
                }
            } else if(announced.firmware!==Number(firmware)) {
                let text = `Pump firmware changed from ${firmware} to ${announced.firmware}`;
                firmware = announced.firmware;
                config.system.firmware = firmware;
                updateConfig(config);
                console.log(text);
                log(config.log.enable,text,config.log['info'],"Pump");
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
                console.log('RMU40 System '+((-24)+msg.data[2])+' connected (read-only mode)');
            } else {
                console.log('RMU40 System '+((-24)+msg.data[2])+' connected');
                // EMIT HERE
                nibeEmit.emit('rmu_ready','s'+((-24)+msg.data[2]));
            }
            console.log(`Register is set. Length: ${register.length}`)
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
    async function getDataSseries(address) {
        const promise = new Promise((resolve,reject) => {
            let index = register.findIndex(index => index.register == address);
            if(index!==-1 || (address!==undefined && config.system.testmode===true && address!=="00000")) {
                let settled = false;
                let failTimer;
                const finish = (err,data) => {
                    if(settled===true) return;
                    settled = true;
                    clearTimeout(failTimer);
                    nibeEmit.removeListener(address,listener);
                    if(err!==null) { reject(err); } else { resolve(data); }
                };
                const listener = (data) => { finish(null,data); };
                nibeEmit.on(address,listener);
                failTimer = setTimeout(() => {
                    noRespondCount++;
                    finish(new Error('No respond from register ('+address+')'));
                }, 30000);
                core.send({type:"reqData",data:address});
            } else {
                reject(new Error('Register ('+address+') not in database'));
            }

        });
        return promise;
    }
    const promise = new Promise((resolve,reject) => {
        if(core!==undefined && core.connected!==undefined && core.connected===true) {
            if(config.connection===undefined || config.connection.series===undefined) return reject(new Error('Configuration is invalid'));
            if(config.connection.series=="fSeries") {
                whenModelKnown()
                    .then(() => getDataFseries(address))
                    .then(resolve, reject);
            } else if(config.connection.series=="sSeries") {
                getDataSseries(address).then(result => {
                    resolve(result)
                }).catch((error => {
                    reject(error)
                })).catch(err => {
                    reject(err)
                });
            }
            
        } else {
            reject(new Error('Core is not started.'))
        }
    });
    return promise;
    
}


// Waits up to SET_WAIT_MS for a running core (and, on F-series, a known
// model), then sends. cb is always called exactly once: cb(null,ack) when the
// core reports the write, cb(err) on rejection, timeout or no ACK. The two
// string errors are kept as they were for existing callers.
const SET_WAIT_MS = 30000;
const SET_ACK_MS = 60000;
const setData = (address,value,cb=()=>{}) => {
    if(typeof cb!=='function') cb = ()=>{};
    console.log(`Setting data in register ${address}: ${value}`)
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
        if(err) return cb(err);
        cb(null,result);
    };
    const coreUp = () => (core!==undefined && core.connected===true);
    const ready = () => coreUp() && (config.connection===undefined || config.connection.series!=="fSeries" || model.length!==0);
    const send = () => {
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
        if(config.connection.enable!==undefined && (config.connection.enable=="serial" || config.connection.enable=="nibegw")) {
            var data = [];
            data[0] = 0xc0;
            data[1] = 0x69;
            data[2] = 0x02;
            data[3] = (address & 0xFF);
            data[4] = ((address >> 8) & 0xFF);
            data[5] = Calc_CRC(data);
            return(data);
        } else if(config.connection.enable!==undefined && config.connection.enable=="tcp") {
            return(address);
        }
            
    } else {
        // Logged once per register: request nodes for other models ask for
        // these on every poll.
        if(!reportedMissing.has(String(address))) {
            reportedMissing.add(String(address));
            console.log('Register('+address+') not in database - not available on this model, further requests are not logged');
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
function setDataValue(incoming) {
    var item = register.find(item => item.register == incoming.register);
    if(item!==undefined) {
    var data = [];
    var rmu = {data:[],address:incoming.register,ackback:[]};
        if(item.mode=="R/W") {
            var min = Number(item.min);
            var max = Number(item.max);
            var corruptData;
            // "abc", "", undefined or a Buffer used to become NaN or 0 here, and
            // NaN passed the range checks and was written as 0.
            let value = parseWriteValue(incoming.value);
            let factor = Number(item.factor);
            if(!Number.isFinite(value) || !Number.isFinite(factor) || factor===0) {
                nibeEmit.emit('fault',{from:"Skicka värde",message:'Ogiltigt värde ('+incoming.value+') till register '+incoming.register+', skickas inte.'});
                log(config.log.enable,'Invalid value ('+incoming.value+') to register '+incoming.register+', not sent',config.log['error'],"Data");
                return -4;
            }
            let raw = Math.round(value*factor);
            // Always within what the register size can hold, and within the
            // model's min/max unless both are 0. Out of range is rejected, not
            // clamped: a clamped value is still a value nobody asked for.
            let range = sizeRange[item.size] || sizeRange.any;
            let outside = (raw<range[0] || raw>range[1]);
            if(min!==0 || max!==0) {
                if(raw>max || raw<min) outside = true;
            }
            if(outside===true) {
                nibeEmit.emit('fault',{from:"Skicka värde",message:'Data ('+value+') utanför giltigt värde som får skickas.'});
                log(config.log.enable,'Data ('+value+') out of range, to register '+incoming.register,config.log['error'],"Data");
                return -3;
            }
            incoming.value = raw;
            if(config.connection.enable!==undefined && (config.connection.enable=="serial" || config.connection.enable=="nibegw")) {
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
                if(corruptData===undefined) {
                    log(config.log.enable,`Sending data: ${incoming.register}, ${incoming.value}, ${JSON.stringify(data)}`,config.log['info'],"Data");
                    if(data.length===0) {
                        return rmu;
                    } else {
                        return data;
                    }
                }
            } else if(config.connection.enable!==undefined && config.connection.enable=="tcp") {
                if(corruptData===undefined) {
                    item.data = incoming.value;
                    log(config.log.enable,`Sending data: ${incoming.register}, ${incoming.value}`,config.log['info'],"Data");
                    return item;
                }
            }
        } else {
            nibeEmit.emit('fault',{from:"Skicka värde",message:'Register('+incoming.register+') går ej att skriva till.'});
            log(config.log.enable,'Register('+incoming.register+') not allowed write access',config.log['error'],"Data");
            return -2;
        }
    } else {
        nibeEmit.emit('fault',{from:"Skicka värde",message:'Register('+incoming.register+') finns ej i databasen.'});
        log(config.log.enable,'Register('+incoming.register+') not in database',config.log['error'],"Data");
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
            updateConfig(config)
        }
        if(register[index]!==undefined) register[index].logset = logset;
        let confIndex = config.registers.findIndex(confIndex => confIndex == address);
        if(confIndex===-1) {
            log(config.log.enable,`Adding register ${address}`,config.log['info'],"Register");
            config.registers.push(address);
            if(logset===false) {
                addRegular(address);
            }
            updateConfig(config)
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
        updateConfig(config)
    }
    let confIndex = config.registers.findIndex(confIndex => confIndex == address);
    if(confIndex!==-1) {
        config.registers.splice(confIndex,1);
        removeMQTTdiscovery(register[index]);
        updateConfig(config)
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
            log(config.log.enable,`RMU register not added to regular list, Register: ${address}`,config.log['debug'],"Register");
        } else {
            // Req data change
            reqData(address).catch(logCatch)
            regQueue.push(getData(address));
            log(config.log.enable,`Regular register added (${address})`,config.log['info'],"Register");
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
            log(config.log.enable,`Regular register removed (${address})`,config.log['info'],"Register");
            core.send({type:"regRegister",data:regQueue});
        }
    }
} else {
    setTimeout((data) => {
        removeRegular(data);
    }, 10000, address);
}
}

async function decodeS(data) {
    if(register.length===0) return;
    let address = data.register;
    data = data.data;
    let timeNow = Date.now();
    var index = register.findIndex(index => index.register == address);
    if (index!==-1) {
        if (register[index].size == "s32") {
            if (data >= 2147483648) {
                data = (data - 4294967296);
            }
        }
        else if (register[index].size == "s16") {
            if (data >= 32768) {
                data = data - 65536;
            }          
        }
        else if (register[index].size == "s8") {
            if (data >= 128 && data < 32768) {
                data = data - 256;
            } else if (data >= 32768) {
                data = data - 65536;
            }
        }
        else if (register[index].size == "u32") {
            data = data>>>0;
        }
        data = data / register[index].factor;
        let corruptData = false;
        let min = Number(register[index].min);
        let max = Number(register[index].max);
        if (min !== undefined && max !== undefined) {
            if (min !== 0 || max !== 0) {
                if ((data > max / register[index].factor) || (data < min / register[index].factor)) {
                    nibeEmit.emit('fault',{from:"Datahantering",message:'Korrupt värde från register '+address+", Värde: "+data+register[index].unit});
                    log(config.log.enable,register[index].register+", "+register[index].titel+": "+register[index].data+" "+register[index].unit,config.log['error'],"CORRUPT");
                    corruptData = true;
                }
            }
        }
        if(corruptData===false) {
            register[index].data = data;
            register[index].raw_data = data;
            register[index].timestamp = timeNow;
            nibeEmit.emit('data',register[index]);
            nibeEmit.emit(address,register[index]);
            addMQTTdiscovery(register[index]);
            publishMQTT(config.mqtt.topic+address+"/json",JSON.stringify(register[index]))
            publishMQTT(config.mqtt.topic+address+"/raw",register[index].raw_data)
            publishMQTT(config.mqtt.topic+address,register[index].data)
            log(config.log.enable,JSON.stringify(register[index]),config.log['debug'],"Data");
            log(config.log.enable,register[index].register+", "+register[index].titel+": "+register[index].data+" "+register[index].unit,config.log['debug'],"Data");
        }
    } else if((config.system.testmode===true && address!=="00000")) {
        let output = {
            register:address,
            data:data,
            raw_data:data,
            factor:1,
            unit:"",
            size:"",
            titel:"Unknown register "+address,
            info:"",
            mode:"R",
            min:0,
            max:0,
            timestamp:timeNow
        }
        log(config.log.enable,JSON.stringify(output),config.log['debug'],"Data");
        nibeEmit.emit('data',output);
        nibeEmit.emit(address,output);
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
                        log(config.log.enable,register[index].register+", "+register[index].titel+": "+register[index].data+" "+register[index].unit,config.log['error'],"CORRUPT");
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
                nibeEmit.emit('data',register[index]);
                
                nibeEmit.emit(address,register[index]);
                addMQTTdiscovery(register[index]);
                publishMQTT(config.mqtt.topic+address+"/json",JSON.stringify(register[index]))
                publishMQTT(config.mqtt.topic+address+"/raw",register[index].raw_data)
                publishMQTT(config.mqtt.topic+address,register[index].data)
                log(config.log.enable,JSON.stringify(register[index]),config.log['debug'],"Data");
                log(config.log.enable,register[index].register+", "+register[index].titel+": "+register[index].data+" "+register[index].unit,config.log['debug'],"Data");
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
const refreshConfig = () => {
    nibeEmit.emit('config',config);
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
    mqtt_client = mqtt.connect('mqtt://' + mqtt_host, mqtt_Options);
    
    mqtt_client.on('connect', function () {
        nibeEmit.emit('fault',{from:"MQTT",message:'MQTT Brokern är ansluten'});
        console.log("MQTT Broker is connected.")
        mqtt_client.publish(config.mqtt.topic+'status', 'online', {qos:1, retain:true});
        mqtt_client.subscribe('homeassistant/status');
        cleanOldDiscovery();
        scheduleDiscovery();
        resolve(mqtt_client);
    });
    mqtt_client.on('close',function(err){
        if (mqtt_client.reconnecting === false) {
            nibeEmit.emit('fault',{from:"MQTT",message:'MQTT Brokern är frånkopplad'});
        }
        console.log("MQTT Broker is disconnected")
    });
    mqtt_client.on('error',function(error){
        nibeEmit.emit('fault',{from:"MQTT",message:'Kunde inte ansluta till MQTT Brokern'});
        console.log("Could not connect to MQTT broker")
        reject(mqtt_client);
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
        updateConfig(config);
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
            log(config.log.enable,`Removed MQTT Discovery device`,config.log['info'],"MQTT");
        }
        discovery.cleared = true;
        return;
    }
    let topic = 'homeassistant/device/'+discoveryId()+'/config';
    let cmps = {};
    for (const reg in discovery.removed) cmps[reg] = {p:'sensor'};
    Object.assign(cmps, discovery.components);
    if(Object.keys(cmps).length===0) return;
    let message = {
        dev: {ids:[discoveryId()], name:'Nibe '+model, mf:'NIBE', mdl:model, sw:String(firmware)},
        o: {name:'NibePi', sw:nibepi_version, url:'https://github.com/fnordpojk/nibepi-backend'},
        avty_t: config.mqtt.topic+'status',
        cmps: cmps,
    };
    publishMQTTpromise(topic,JSON.stringify(message),true).then(() => {
        discovery.cleared = false;
        discovery.removed = {};
        log(config.log.enable,`Published MQTT Discovery device, ${Object.keys(discovery.components).length} sensors`,config.log['info'],"MQTT");
    },(error => {}));
}
function addMQTTdiscovery(data) {
    if(config.mqtt===undefined) {
        config.mqtt = {};
        updateConfig(config);
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
            log(config.log.enable,`Cleared old MQTT Discovery object, register ${match[1]}`,config.log['info'],"MQTT");
        }
    } catch(e) {}
}
const handleMQTT = (on,host,port,user,pass,cb) => {
    if(on===undefined || on=="" || on=="false" || on===false) {
        startingMQTT = false;
        if(mqtt_client!==undefined) {
            mqtt_client.end();
            console.log('Terminated MQTT session, shutdown');
        }
        return cb(null,false)
    };
    if(host===undefined || host=="") return cb(err = new Error('No MQTT host defined'));
    if(port===undefined || port=="") return cb(err = new Error('No MQTT port defined'));
    if(mqtt_client===undefined || mqtt_client.connected!==true) {
        console.log('Startar MQTT')
        if(startingMQTT===false) {
            startingMQTT = true;
    startMQTT(host,port,user,pass).then(result => {
        startingMQTT = false
        //mqtt_client = result;
        config.mqtt.host = host;
        config.mqtt.port = port;
        config.mqtt.enable = true;
        result.subscribe(config.mqtt.topic+'#');
        updateSensors(config);
        if(mqtt_client!==undefined && mqtt_client.connected===true) {
            mqtt_client.on('message', function (topic, message) {
                if(topic==='homeassistant/status') {
                    if(message.toString()==='online') scheduleDiscovery();
                    return;
                }
                if(topic.startsWith('homeassistant/sensor/')) {
                    clearOldDiscovery(topic,message);
                    return;
                }
                let subTopic = config.mqtt.topic;
                let subscribed = false;
                for (const arr of mqtt_subcribers) {
                    if(topic===arr) {
                        let save = topic.replace(/\//g,"_");
                        let messageString = message.toString().replace(/\,/g,".");
                        if(mqttData[save]===undefined) mqttData[save] = {};
                        mqttData[save].data = Number(messageString);
                        mqttData[save].raw_data = Number(messageString);
                        mqttData[save].register = save;
                        mqttData[save].timestamp = Date.now();
                        nibeEmit.emit('mqttData',mqttData[save]);
                        subscribed = true;
                    }
                }
                if(subscribed===false && topic.includes(subTopic)) {
                    topic = topic.replace(config.mqtt.topic,'')
                    topic = topic.split('/');
                    if(topic[0]=="adjust_s1") {
                        if(topic.includes('set')) {
                            if(!isNaN(message)) {
                                if(config.home!==undefined) config.home.adjust_s1 = message
                                updateConfig(config);
                                publishMQTT(config.mqtt.topic+"adjust_s1",config.home.adjust_s1)
                            }
                        } else if(topic.includes('get')) {
                            publishMQTT(config.mqtt.topic+"adjust_s1",config.home.adjust_s1)
                        }
                    } else if(topic[0]=="adjust_s2") {
                        if(topic.includes('set')) {
                            if(!isNaN(message)) {
                                if(config.home!==undefined) config.home.adjust_s2 = message
                                updateConfig(config);
                                publishMQTT(config.mqtt.topic+"adjust_s2",config.home.adjust_s2)
                            }
                        } else if(topic.includes('get')) {
                            publishMQTT(config.mqtt.topic+"adjust_s2",config.home.adjust_s2)
                        }
                    } else if(topic.includes('set')) {
                        setData(topic[0],message.toString(),(err,result) => {
                            if(err) return console.log(err);
                        });
                    } else if(topic.includes('get')) {
                        reqData(topic[0]).catch(logCatch);
                    } else if(topic.includes('add')) {
                        addRegister(topic[0])
                    } else if(topic.includes('remove')) {
                        removeRegister(topic[0])
                    }
                }
                //console.log('Incoming MQTT message:', topic, message.toString());
            });
        }
        cb(null,true);
    }).catch((reject => {
        startingMQTT = false
        console.log(reject)
        if(mqtt_client!==undefined) {
            mqtt_client.end();
        }
        startingMQTT = false;
        console.log('Terminated MQTT session');
        return cb(null,false)
    }));
}
} else {
    return cb(null,true)
}

}
const publishMQTT = (topic,message,retain=false) => {
    if(mqtt_client!==undefined) {
        if(mqtt_client.connected===true && mqtt_client.disconnecting!==true) {
            mqtt_client.publish(topic, message.toString(),{retain:retain});
        }
    }
    
}
const publishMQTTpromise = (topic,message,retain=false) => {
    const promise = new Promise((resolve,reject) => {
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
const redOn = (enable=true) => {
    if(core!==undefined && core.connected===true) core.send({type:"red",data:enable});
}
const updateSensors = (config) => {
    if(config.home===undefined) {
        config.home = {};
        updateConfig(config);
    }
	if(config.home.inside_sensors===undefined) {
        config.home.inside_sensors = [];
        updateConfig(config);
    }
	
    for (const arr of config.home.inside_sensors) {
        if(arr.source=="mqtt") {
            let found = false;
            for (i = 0; i < mqtt_subcribers.length; i = i + 1) {
                if(mqtt_subcribers[i]===arr.register) found = true;
            }
            if(found===false) {
                mqtt_subcribers.push(arr.register);
            }
        }
    }
    if(mqtt_client!==undefined && mqtt_client.connected===true) {
        for (const arr of mqtt_subcribers) {
            mqtt_client.subscribe(arr);
        }
        // Once for the whole list, not once per sensor: every updateSensor
        // restarts all plugins through 'ready' in node-red-contrib-nibepi.
        if(mqtt_subcribers.length!==0) nibeEmit.emit('updateSensor',true);
    }
}
const addSensor = (data) => {
    updateConfig(data);
    updateSensors(data);
}
const removeSensor = (data) => {
    if(config.home.inside_sensors!==undefined) {
        let i = config.home.inside_sensors.findIndex(i => i.register == data.register);
        if(i!==-1) {
            config.home.inside_sensors.splice(i,1);
            i = mqtt_subcribers.findIndex(i => i == data);
            mqtt_subcribers.splice(i,1);
            let mqttRemove = data.register.replace(/\//g,"_");
            delete mqttData[mqttRemove];
            updateConfig(config);
            mqtt_client.unsubscribe(data.register);
            nibeEmit.emit('updateSensor',true);
        }
    }
}
const getMQTTData = (data) => {
    const promise = new Promise((resolve,reject) => {
        if(data!==undefined) data = data.replace(/\//g,"_");
    if(mqttData[data]!==undefined) {
        resolve(mqttData[data]);
    } else {
        reject({})
    }
    });
    return promise;
}
const writeLog = (data,plugin,level) => {
    let from = "System";
    if(plugin=="fan") from = "Automatiskt luftflöde";
    if(plugin=="hw") from = "Varmvattenreglering";
    // The contrib package passes "hotwater" and "price"; "hw" is legacy and is
    // passed by nothing. Without these the messages were labelled "System",
    // and config.log[plugin] never matched so they were never written to file.
    if(plugin=="hotwater") from = "Varmvattenreglering";
    if(plugin=="price") from = "Elprisreglering";
    if(plugin=="weather") from = "Prognosreglering";
    if(plugin=="diagnostic") from = "Diagnostik";
    if(level=="info" || level=="error") {
        nibeEmit.emit('fault',{from:from,message:data});
    }
    if(config.log[plugin]!==undefined) {
        log(config.log.enable,data,config.log[plugin],from);
    }
    
    return;
}
const setDocker = (cmd) => {
    docker = cmd;
}
module.exports = {
    reqData:reqData,
    setData:setData,
    addRegister:addRegister,
    removeRegister:removeRegister,
    initiateCore:initiateCore,
    stopCore:stopCore,
    resetCore:resetCore,
    data:nibeEmit,
    getConfig:getConfig,
    setConfig:updateConfig,
    getRegister:getRegister,
    getBusHealth:getBusHealth,
    getHealth:getHealth,
    handleMQTT:handleMQTT,
    redOn:redOn,
    addSensor: addSensor,
    removeSensor: removeSensor,
    getMQTTData:getMQTTData,
    log:writeLog,
    saveGraph:saveGraph,
    requireGraph:requireGraph,
    setDocker:setDocker,
    refreshConfig:refreshConfig
}
