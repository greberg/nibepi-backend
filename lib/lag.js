'use strict';
// Event-loop lag: a timer that should fire every `interval` ms. When it
// fires much later, the whole process was blocked, and with a tick this
// small that is almost always the whole Pi (CPU starved, memory swapping,
// under-voltage throttling, a hung SD card). The serial port is not read
// meanwhile, so the pump gets no answers: "No respond" for every queued
// read and its MODBUS40 alarm 251. Logging it makes such an incident
// distinguishable from a problem on the RS485 bus.
const createLagMonitor = ({ interval = 1000, threshold = 5000, now = Date.now, onLag = () => {} } = {}) => {
    let last = now();
    let worst = 0;
    const tick = () => {
        const t = now();
        const lag = Math.max(0, t - last - interval);
        last = t;
        if(lag > worst) worst = lag;
        if(lag >= threshold) onLag(lag);
        return lag;
    };
    return {
        tick,
        worst: () => worst,
        start() {
            const handle = setInterval(tick, interval);
            if(handle.unref) handle.unref();
            return handle;
        },
    };
};

module.exports = { createLagMonitor };
