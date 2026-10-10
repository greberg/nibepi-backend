const startCoreF = (port) => {
    const promise = new Promise((resolve,reject) => {
    setTimeout((port) => {
        let output = {};
        const path = require('path');
        let reqPath = path.join(__dirname, '../');
        const { fork } = require('child_process');
        output.core = fork(reqPath+'/backend.js', {
            detached: true
        });
        output.core.send({start:true,port:port });
        resolve(output.core);
    }, 2000, port);
    });
    return promise;    
}
// host: the NibeGW (or esphome-nibe) device; listenPort: the local UDP port
// it sends frames to.
const startNibeGW = (host,listenPort) => {
    const promise = new Promise((resolve,reject) => {
        setTimeout(() => {
            let output = {};
            const path = require('path');
            let reqPath = path.join(__dirname, '../');
            const { fork } = require('child_process');
            output.core = fork(reqPath+'/nibegw-client.js', {
                detached: true
            });
            output.core.send({start:true,port:host,listenPort:listenPort});
            resolve(output.core);
        }, 2000);
        });
        return promise;    
    }
module.exports = {
    startCoreF:startCoreF,
    startNibeGW:startNibeGW
}