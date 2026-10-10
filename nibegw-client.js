const dgram = require('dgram');
var server = dgram.createSocket('udp4');

var HOST = "127.0.0.1";
var PORT = 9999;
// 48852=0: Modbus40 word order. No alarm reset (45171) at start: that
// acknowledged every pending pump alarm. index.js resets only MODBUS alarm 251.
const sendQueue = [[192,107,6,212,190,0,0,0,0,199]];
const getQueue = [];
var regQueue = [];
var regCount = 0;
let checkACK = {};
// FIFO with one entry per register, as in backend.js: a newer write to a
// register replaces the queued one, so the last value set is what the pump
// ends up with. Capped so it cannot grow without bound.
const QUEUE_MAX = 100;
const writeAddress = (msg) => (msg[4] * 256 + msg[3]);
function queueWrite(queue, msg) {
    const address = writeAddress(msg);
    const index = queue.findIndex(queued => writeAddress(queued) === address);
    if(index!==-1) {
        queue[index] = msg;
        return;
    }
    queue.push(msg);
    if(queue.length>QUEUE_MAX) {
        const dropped = queue.shift();
        if(process.connected===true) {
            process.send({type:"log",data:`Write queue full, dropped the oldest write to register ${writeAddress(dropped)}`,level:"error",kind:"Queue"});
        }
    }
}
process.on('message', (m) => {
    if(m.start===true) {
        if(m.port!==undefined) {
            HOST = m.port;
            start()
        } else {
            if(process.connected===true) {
                process.send({type:"log",data:'Error starting backend, no serial port specified',level:"error",kind:"Serialport"});
	        console.log('Error in the core');
}
        }
    } else if(m.type=="reqData") {
        if(m.data!==undefined) {
            let found = false;
            for (i = 0; i < getQueue.length; i = i + 1) {
                let address = (getQueue[i][4]*256)+getQueue[i][3];
                if((m.data[4]*256)+m.data[3]==address) {
                    found = true;
                }
            }
            if(found===false) getQueue.unshift(m.data)
        }
        ;
    } else if(m.type=="setData") {
        queueWrite(sendQueue, m.data);
    } else if(m.type=="regRegister") {
        regQueue = m.data;
    }
  });
  // Always exit when the parent goes away, as in backend.js.
  process.on('disconnect', (m) => {
      console.log('Shutting down the core.')
      process.exit(99);
  });
let shuttingDown = false;
// Socket error: report it and exit non-zero so index.js restarts the core.
// Exit once the fault is handed to the IPC channel, or after a second.
function shutDown(message) {
    if(shuttingDown===true) return;
    shuttingDown = true;
    console.log('Error in the core, shutting it down: '+message);
    const exit = () => process.exit(1);
    setTimeout(exit, 1000);
    if(process.connected===true) {
        try {
            process.send({type:"fault",data:{from:"core",message:message}}, exit);
        } catch(e) {
            setImmediate(exit);
        }
    } else {
        setImmediate(exit);
    }
}
// Only frames from the configured gateway are answered. HOST may be a host
// name, so accept every address it resolves to (refreshed periodically).
const net = require('net');
const dns = require('dns');
let gatewayAddresses = new Set();
const droppedFrom = new Set();
function resolveGateway() {
    if(net.isIP(HOST)!==0) {
        gatewayAddresses = new Set([HOST]);
        return;
    }
    dns.lookup(HOST, {all:true, family:4}, (err, addresses) => {
        if(err) {
            if(process.connected===true) {
                process.send({type:"log",data:'Could not resolve NibeGW host '+HOST+': '+err.message,level:"error",kind:"NibeGW"});
            }
            return;
        }
        gatewayAddresses = new Set(addresses.map(a => a.address));
    });
}
// Same checksum test as checkMessage in backend.js.
function validFrame(data) {
    if(data.length<6 || data.length<data[4]+6) return false;
    let msgChecksum = data[data[4]+5];
    let calcChecksum = 0;
    for(let i = 2; i < (data[4] + 5); i++) {
        calcChecksum ^= data[i];
    }
    return (msgChecksum==calcChecksum) || (msgChecksum==0xC5 && calcChecksum==0x5C);
}
//start()
// Gateways track a reply target per source ip:port. Opening a fresh socket
// for every request gives each one a new ephemeral source port, so the
// gateway's target list grows without bound until it runs out of buffers and
// stops answering (esphome-nibe logs "New target added <ip>:<port>", then
// "UDP sendto failed ..., error: 12"). Send from the socket already bound to
// PORT instead, so the source port never changes.
function send(data, port) {
    data = Buffer.from(data)
    server.send(data, 0, data.length, port, HOST, function(err, bytes) {
        if(err!==null && err!==undefined && process.connected===true) {
            process.send({type:"log",data:'UDP send to '+HOST+':'+port+' failed: '+err.message,level:"error",kind:"NibeGW"});
        }
    });
}
function write(data) {
    send(data, 10001);
}
function read(data) {
    send(data, 10000);
}
function start() {
    server.on('error', function(err) {
        shutDown('NibeGW socket error: '+err.message);
    });
    resolveGateway();
    setInterval(resolveGateway, 600000);
    server.bind(PORT, "0.0.0.0");
    server.on('listening', function() {
        var address = server.address();
       console.log('NibeGW client is listening on ' + HOST + ':' + address.port);
      });      
    server.on('message', function(message, remote) {
        if(!gatewayAddresses.has(remote.address)) {
            if(gatewayAddresses.size===0) return;
            if(!droppedFrom.has(remote.address)) {
                droppedFrom.add(remote.address);
                if(process.connected===true) {
                    process.send({type:"log",data:'Ignoring UDP packets from '+remote.address+', not the NibeGW host '+HOST,level:"error",kind:"NibeGW"});
                }
            }
            return;
        }
        if(!validFrame(message)) {
            if(process.connected===true) {
                process.send({type:"log",data:Array.from(message),level:"error",kind:"CHKSUM"});
            }
            return;
        }
        makeResponse(Buffer.from(message)).then(result => {
                result = Array.from(result);
                let doubleFound = false;
                for (i = 5; i < result.length - 1; i = i + 1) {
                    if(result[i]===92 && result[i+1]===92) {
                        result.splice(i, 1);
                        result[4] = result[4]-1;
                        doubleFound = true;
                    }
                }
                if(doubleFound===true) {
                    var calcChecksum = 0;
                    for(i = 2; i < (result[4] + 5); i++) {
                        calcChecksum ^= result[i];
                    }
                    result[result.length-1] = calcChecksum;
                }
                if(process.connected===true) {
                    process.send({type:"data",data:result,rmu:checkACK[result[2]]});
                    process.send({type:"log",data:result,level:"debug",kind:"OK"});
                }
        }, err => {
    
        })    
    });
}


const makeResponse = (data) => {
    const promise = new Promise((resolve,reject) => {
    // Read from heatpump
    
    if(data[3]==105 && data[4]==0x00) {
        if(getQueue!==undefined && getQueue.length!==0) {
            /*
            let array = [];
            for (i = 0; i < getQueue.length; i = i + 1) {
                array[i] = (getQueue[i][4]*256)+getQueue[i][3];
            }
            
            console.log(JSON.stringify(array))
            */
            var lastMsg = getQueue.pop();
            
            if(lastMsg!==undefined) {
                read(lastMsg)
                resolve(data);
            } else if(getQueue.length!==0) {
                lastMsg = getQueue.pop();
                if(lastMsg!==undefined) {
                    read(lastMsg)
                    resolve(data);
                } else {
                    resolve(data);
                }
            } else {
                    resolve(data);
            }
        } else {
            if(regQueue.length!==0) {
                if(regCount>=regQueue.length) regCount = 0;
                read(regQueue[regCount])
                regCount++;
                resolve(data);
            } else {
                resolve(data);
        }
        }
    // Write to heatpump
    } else if(data[3]==107 && data[4]==0x00) {
        if(sendQueue.length!==0) {
            var lastMsg = sendQueue.shift();
            if(lastMsg!==undefined) {
                let address = (lastMsg[4] * 256 + lastMsg[3]);
                if(process.connected===true) {
                    process.send({type:"ack",data:{register:address,ack:true}});
                    process.send({type:"log",data:`Register: ${address}, Buffer: ${JSON.stringify(lastMsg)}`,level:"debug",kind:"SENT"});
                }
                write(lastMsg);
                resolve(data);
            } else {
                    resolve(data);
            }
        } else {
                resolve(data);
        }
    } else {
            if(data[3]==109) {

            } else if(data[3]==238) {

            } else if(data[3]==106 || data[3]==104) {

            } else {

            }
            resolve(data);
    }
});
return promise;
}
