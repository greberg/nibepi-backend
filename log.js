'use strict';
// Gateway logging: one line per message on stdout, warnings and errors on
// stderr, so `docker logs` has everything. Optionally also appended to a file.
//
//   NIBEPI_LOG_LEVEL  error | warn | info (default) | debug | trace
//                     trace adds every raw frame on the bus
//   NIBEPI_LOG_FILE   path of a log file, off when unset
//
// Read here at load, so messages logged while index.js loads its config
// already follow them.
const fs = require('fs');

const LEVELS = {error:0, warn:1, info:2, debug:3, trace:4};
const DEFAULT_LEVEL = 'info';
// One rotated generation is kept, so a log file costs at most twice this.
const MAX_BYTES = 5 * 1024 * 1024;

let threshold = LEVELS[DEFAULT_LEVEL];
let filePath = null;
let fd = null;
let size = 0;

// Returns false, leaving the level as it was, for an unknown name.
function setLevel(name) {
    const level = String(name === undefined || name === null ? '' : name).trim().toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(LEVELS, level)) return false;
    threshold = LEVELS[level];
    return true;
}

function levelName() {
    return Object.keys(LEVELS).find(name => LEVELS[name] === threshold);
}

function enabled(level) {
    return LEVELS[level] !== undefined && LEVELS[level] <= threshold;
}

function openFile(flags) {
    try {
        fd = fs.openSync(filePath, flags);
        size = fs.fstatSync(fd).size;
    } catch (e) {
        fd = null;
        size = 0;
        process.stderr.write(`Could not open the log file ${filePath}: ${e.message}\n`);
    }
}

function setFile(path) {
    if (fd !== null) {
        try { fs.closeSync(fd); } catch (e) { /* ignore */ }
        fd = null;
    }
    filePath = (typeof path === 'string' && path.trim() !== '') ? path.trim() : null;
    if (filePath !== null) openFile('a');
}

function rotate() {
    try { if (fd !== null) fs.closeSync(fd); } catch (e) { /* ignore */ }
    fd = null;
    let renamed = false;
    try { fs.renameSync(filePath, filePath + '.1'); renamed = true; } catch (e) { renamed = false; }
    // A failed rename would leave the file over the limit, and every line
    // would try another rotation: truncate instead.
    openFile(renamed ? 'a' : 'w');
}

// Lines are written synchronously, so the ones explaining why the process
// stops are not lost with it.
function toFile(line) {
    if (fd === null) return;
    const bytes = Buffer.byteLength(line);
    if (size + bytes > MAX_BYTES) rotate();
    if (fd === null) return;
    try {
        fs.writeSync(fd, line);
        size += bytes;
    } catch (e) {
        // EACCES or ENOSPC must not take the gateway down over a log line.
        try { fs.closeSync(fd); } catch (e2) { /* ignore */ }
        fd = null;
    }
}

function format(message) {
    if (message instanceof Error) return message.stack || message.message;
    if (Array.isArray(message)) return `[${message}]`;
    if (message !== null && typeof message === 'object') {
        try { return JSON.stringify(message); } catch (e) { return String(message); }
    }
    return String(message);
}

function write(level, kind, message) {
    if (!enabled(level)) return;
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${kind}] ${format(message)}\n`;
    try {
        if (LEVELS[level] <= LEVELS.warn) process.stderr.write(line);
        else process.stdout.write(line);
    } catch (e) { /* closed stdout must not crash the gateway */ }
    toFile(line);
}

if (process.env.NIBEPI_LOG_LEVEL !== undefined && process.env.NIBEPI_LOG_LEVEL !== '' && !setLevel(process.env.NIBEPI_LOG_LEVEL)) {
    write('warn', 'Log', `Unknown NIBEPI_LOG_LEVEL "${process.env.NIBEPI_LOG_LEVEL}", using ${DEFAULT_LEVEL}`);
}
setFile(process.env.NIBEPI_LOG_FILE);

module.exports = {
    LEVELS: LEVELS,
    setLevel: setLevel,
    levelName: levelName,
    setFile: setFile,
    enabled: enabled,
    write: write,
    error: (kind, message) => write('error', kind, message),
    warn: (kind, message) => write('warn', kind, message),
    info: (kind, message) => write('info', kind, message),
    debug: (kind, message) => write('debug', kind, message),
    trace: (kind, message) => write('trace', kind, message)
};
