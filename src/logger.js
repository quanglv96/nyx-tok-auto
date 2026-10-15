// Logger dùng chung: đẩy log/step/stats lên dashboard qua `bus` + ghi file theo ngày
import fs from 'fs';
import path from 'path';
import {EventEmitter} from 'events';

export const bus = new EventEmitter();
let logDir = null;

const now = () => new Date().toLocaleString('sv-SE', {timeZone: 'Asia/Ho_Chi_Minh', hour12: false});

export function setLogDir(dir) {
    try {
        fs.mkdirSync(dir, {recursive: true});
        logDir = dir;
    } catch {
        logDir = null;
    }
}

export function log(tag, msg, type = 'info') {
    const ts = now();
    const line = `[${ts}] [${tag}] ${msg}`;
    bus.emit('log', {type, msg: line});
    if (!logDir) return;
    try {
        fs.appendFileSync(path.join(logDir, `${ts.slice(0, 10)}.log`), `${type.toUpperCase().padEnd(5)} ${line}\n`);
    } catch {}
}

export const logOk = (tag, msg) => log(tag, `✅ ${msg}`, 'ok');
export const logWarn = (tag, msg) => log(tag, `⚠️ ${msg}`, 'warn');
export const logError = (tag, msg) => log(tag, `❌ ${msg}`, 'error');

// step: 1..6 (0 = reset), status: idle | running | ok | error
export const setStep = (step, status, detail = '') => bus.emit('step', {step, status, detail});
