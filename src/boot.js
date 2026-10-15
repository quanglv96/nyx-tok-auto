// Entry: chạy code hot-update mới nhất (userData/code/<version>) nếu mới hơn bản cài & cùng dependencies, không thì code đóng gói
import {app} from 'electron';
import fs from 'fs';
import path from 'path';
import module from 'module';
import {pathToFileURL} from 'url';
import {VERSION, readPkg, newer, sameShell} from './version.js';

const codeDir = path.join(app.getPath('userData'), 'code');
const shell = readPkg(app.getAppPath());
let best = null;

if (app.isPackaged) {
    let dirs = [];
    try { dirs = fs.readdirSync(codeDir); } catch {}
    for (const v of dirs) {
        try {
            if (newer(v, best?.v ?? VERSION) && sameShell(readPkg(path.join(codeDir, v)), shell)) best = {v, dir: path.join(codeDir, v)};
        } catch {}
    }
    // Dọn bản cũ (bỏ qua nếu đang bị khoá)
    for (const v of dirs) if (v !== best?.v) try { fs.rmSync(path.join(codeDir, v), {recursive: true, force: true}); } catch {}
}

if (best) {
    // Code ở userData không có node_modules → import bare (playwright, electron-updater...) lấy từ app.asar
    const base = pathToFileURL(path.join(app.getAppPath(), 'package.json')).href;
    module.registerHooks({
        resolve(spec, ctx, next) {
            try {
                return next(spec, ctx);
            } catch (err) {
                if (err.code !== 'ERR_MODULE_NOT_FOUND' || /^[./]|^[a-z]+:/i.test(spec)) throw err;
                return next(spec, {...ctx, parentURL: base});
            }
        },
    });
    await import(pathToFileURL(path.join(best.dir, 'src', 'main.js')).href);
} else {
    await import('./main.js');
}
