// Version của code đang chạy (đóng gói hoặc hot-update) + helper so sánh — không side effect, boot.js & updater.js dùng chung
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';

export const readPkg = dir => JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
export const VERSION = readPkg(path.join(path.dirname(fileURLToPath(import.meta.url)), '..')).version;

export function newer(a, b) {
    const x = a.split('.').map(Number), y = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
    return false;
}

// Cùng dependencies + major Electron → chỉ cần thay code, không phải cài lại app
// (package.json đóng gói bị electron-builder bỏ devDependencies → so Electron với runtime)
export const sameShell = (hot, shell, electron = process.versions.electron) =>
    JSON.stringify(hot.dependencies) === JSON.stringify(shell.dependencies)
    && hot.devDependencies?.electron?.match(/\d+/)?.[0] === electron?.split('.')[0];
