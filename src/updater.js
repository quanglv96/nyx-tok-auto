// Tự cập nhật từ GitHub Releases: chỉ đổi code → tải code.tgz (vài KB) vào userData/code/<version>;
// đổi dependencies/Electron (hoặc release không có code.tgz) → tải bộ cài đầy đủ qua electron-updater
import pkg from 'electron-updater';
import {app, dialog, ipcMain} from 'electron';
import fs from 'fs';
import path from 'path';
import {execFile} from 'child_process';
import {promisify} from 'util';
import {log} from './logger.js';
import {VERSION, readPkg, newer, sameShell} from './version.js';

const REPO = 'quanglv96/nyx-tok-auto';
const TAR = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');

const {autoUpdater} = pkg;
let isSetup = false;

export function setupAutoUpdater(win) {
    if (isSetup) return;
    isSetup = true;

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;
    autoUpdater.allowDowngrade = false;

    const sendUpdate = (event, data = {}) => win?.webContents.send('updater', {event, ...data});

    autoUpdater.on('checking-for-update', () => {
        log('UPDATER', '🔍 Kiểm tra bản cập nhật...');
        sendUpdate('checking');
    });

    autoUpdater.on('update-available', (info) => {
        log('UPDATER', `🆕 Có bản mới v${info.version}`, 'ok');
        sendUpdate('available', {version: info.version});
        dialog.showMessageBox(win, {
            type: 'info',
            title: 'Có bản cập nhật',
            message: `🆕 Phiên bản ${info.version} đã có`,
            detail: 'Tải và cài bản mới ngay?',
            buttons: ['Tải ngay', 'Để sau'],
            defaultId: 0,
            cancelId: 1,
        }).then(({response}) => {
            if (response === 0) {
                autoUpdater.downloadUpdate();
                sendUpdate('downloading', {percent: 0});
            } else {
                sendUpdate('idle');
            }
        });
    });

    autoUpdater.on('update-not-available', (info) => {
        log('UPDATER', `✅ Đang dùng bản mới nhất v${info.version}`);
        sendUpdate('idle');
    });

    autoUpdater.on('download-progress', (p) => {
        const percent = Math.round(p.percent);
        log('UPDATER', `⬇️ ${percent}% — ${(p.transferred / 1048576).toFixed(1)}/${(p.total / 1048576).toFixed(1)} MB`);
        sendUpdate('downloading', {percent});
    });

    autoUpdater.on('update-downloaded', (info) => {
        log('UPDATER', `✅ Bản v${info.version} sẵn sàng cài`, 'ok');
        sendUpdate('downloaded', {version: info.version});
        dialog.showMessageBox(win, {
            type: 'info',
            title: 'Cập nhật sẵn sàng',
            message: `✅ Đã tải phiên bản ${info.version}`,
            detail: 'Khởi động lại để cài đặt?',
            buttons: ['Khởi động lại', 'Để sau'],
            defaultId: 0,
            cancelId: 1,
        }).then(({response}) => {
            if (response === 0) autoUpdater.quitAndInstall(false, true);
        });
    });

    autoUpdater.on('error', (err) => {
        log('UPDATER', `❌ Lỗi cập nhật: ${err.message}`, 'error');
        sendUpdate('error', {message: err.message});
    });

    // true = đã xử lý bằng code update; false = cần bộ cài đầy đủ
    async function codeUpdate() {
        sendUpdate('checking');
        const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`);
        if (!res.ok) throw new Error(`GitHub API ${res.status}`);
        const rel = await res.json();
        const version = rel.tag_name.replace(/^v/, '');
        if (!newer(version, VERSION)) {
            log('UPDATER', `✅ Đang dùng bản mới nhất v${VERSION}`);
            sendUpdate('idle');
            return true;
        }
        const asset = rel.assets.find(a => a.name === 'code.tgz');
        if (!asset) return false;

        log('UPDATER', `🆕 Có bản mới v${version} — tải code...`, 'ok');
        sendUpdate('downloading', {percent: 0});
        const dl = await fetch(asset.browser_download_url);
        if (!dl.ok) throw new Error(`Tải code.tgz lỗi ${dl.status}`);
        const dir = path.join(app.getPath('userData'), 'code', version);
        const tgz = `${dir}.tgz`;
        fs.rmSync(dir, {recursive: true, force: true});
        fs.mkdirSync(dir, {recursive: true});
        fs.writeFileSync(tgz, Buffer.from(await dl.arrayBuffer()));
        try {
            await promisify(execFile)(TAR, ['-xzf', tgz, '-C', dir], {windowsHide: true});
        } finally {
            fs.rmSync(tgz, {force: true});
        }
        if (!sameShell(readPkg(dir), readPkg(app.getAppPath()))) {
            fs.rmSync(dir, {recursive: true, force: true});
            log('UPDATER', `v${version} đổi dependencies — cần bộ cài đầy đủ`);
            return false;
        }

        log('UPDATER', `✅ Code v${version} sẵn sàng — áp dụng khi mở lại app`, 'ok');
        sendUpdate('downloaded', {version});
        const {response} = await dialog.showMessageBox(win, {
            type: 'info',
            title: 'Cập nhật sẵn sàng',
            message: `✅ Đã tải phiên bản ${version}`,
            detail: 'Khởi động lại để dùng bản mới? (Để sau = tự áp dụng lần mở app tới)',
            buttons: ['Khởi động lại', 'Để sau'],
            defaultId: 0,
            cancelId: 1,
        });
        if (response === 0) {
            app.relaunch();
            app.quit();
        }
        return true;
    }

    const check = async () => {
        if (!app.isPackaged) return log('UPDATER', '⚠️ Dev mode — bỏ qua kiểm tra cập nhật', 'warn');
        const done = await codeUpdate().catch(err => {
            log('UPDATER', `⚠️ Code update lỗi: ${err.message} — thử bộ cài đầy đủ`, 'warn');
            return false;
        });
        if (!done) autoUpdater.checkForUpdates().catch(() => {});
    };
    setTimeout(check, 3000);
    ipcMain.removeAllListeners('check-for-updates');
    ipcMain.on('check-for-updates', check);
}
