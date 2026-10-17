// Which pump alarms the gateway may acknowledge by itself.
//
// While the gateway restarts, the pump stops getting answers from its
// MODBUS40 accessory (NibePi) and raises alarm 251. Upstream reset every
// alarm (45171=1) on each core start, which also acknowledged real alarms;
// only the communication alarm is reset now, checked at start and once a
// minute so it doesn't depend on when the pump sends its 0x6D frames.
// system.reset_alarms in config.json overrides the list.
const DEFAULT_RESET_ALARMS = [251];
const MIN_GAP_MS = 120000;
// After this many resets that didn't clear the alarm, try only every 30 min.
const MAX_QUICK_TRIES = 3;
const SLOW_GAP_MS = 30 * 60000;
const gapAfter = (failures) => (failures >= MAX_QUICK_TRIES ? SLOW_GAP_MS : MIN_GAP_MS);

const resetAlarmList = (config) => {
    const list = config && config.system && config.system.reset_alarms;
    if(!Array.isArray(list)) return DEFAULT_RESET_ALARMS.slice();
    return list.map(Number).filter(n => Number.isInteger(n) && n > 0);
};

// raw: the value of 45001 (0 = no alarm). Resets at most every MIN_GAP_MS.
const shouldReset = (raw, list, lastResetAt, now, minGap = MIN_GAP_MS) => {
    const n = Number(raw);
    if(!Number.isInteger(n) || n === 0) return false;
    if(!list.includes(n)) return false;
    if(lastResetAt !== undefined && lastResetAt !== null && now - lastResetAt < minGap) return false;
    return true;
};

module.exports = { DEFAULT_RESET_ALARMS, MIN_GAP_MS, SLOW_GAP_MS, MAX_QUICK_TRIES, gapAfter, resetAlarmList, shouldReset };
