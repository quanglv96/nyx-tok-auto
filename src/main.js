import {app, BrowserWindow, ipcMain, dialog, shell, Menu} from 'electron';
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import {bus, log, logError, logOk, setLogDir} from './logger.js';
import {loadConfig, saveConfig} from './config.js';
import {ensureEnv} from './ensureEnv.js';
import crypto from 'crypto';
import {Pipeline, downloadVideo} from './pipeline.js';
import {crawlerFor} from './crawlers/index.js';
import {uploadToTiktok} from './tiktok.js';
import {uploadToFacebook} from './facebook.js';
import {humanSession} from './human.js';
import {transformVideo, tfTag, cmdLine, randomOpts} from './transform.js';
import {openChrome} from './chrome.js';
import {sendTelegram} from './telegram.js';
import {setupAutoUpdater} from './updater.js';
import {VERSION} from './version.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let win = null;
let pipeline = null;
let loginCtx = null;
let envPromise = null;
let autoStarted = false;
let testRunning = false; // test tính năng đang chạy — bấm Dừng test thì false

const send = (channel, data) => win?.webContents.send(channel, data);
for (const ch of ['log', 'step', 'stats', 'plan']) bus.on(ch, d => send(ch, d));

function checkEnv() {
    envPromise ??= ensureEnv(loadConfig())
        .then(env => {
            send('env', {ok: true});
            return env;
        })
        .catch(err => {
            logError('ENV', err.message);
            send('env', {ok: false, error: err.message});
            envPromise = null; // cho phép thử lại khi bấm Start
            throw err;
        });
    return envPromise;
}

function countIds(dataDir) {
    try {
        return fs.readFileSync(path.join(dataDir, 'crawled_ids.txt'), 'utf8').split(/\r?\n/).filter(Boolean).length;
    } catch {
        return 0;
    }
}

function createWindow() {
    win = new BrowserWindow({
        width: 1320,
        height: 880,
        title: `NTT Auto v${VERSION}`,
        webPreferences: {nodeIntegration: true, contextIsolation: false},
    });
    // Ẩn thanh menu nhưng giữ menu Edit → Ctrl+C/V/X/A/Z vẫn chạy (removeMenu() làm mất các phím tắt này)
    win.setMenu(Menu.buildFromTemplate([{role: 'editMenu'}]));
    win.setMenuBarVisibility(false);
    // Chuột phải trong ô nhập: Cắt / Sao chép / Dán / Chọn tất cả
    win.webContents.on('context-menu', (_, p) => p.isEditable && Menu.buildFromTemplate([
        {role: 'cut', label: 'Cắt'}, {role: 'copy', label: 'Sao chép'}, {role: 'paste', label: 'Dán'},
        {type: 'separator'}, {role: 'selectAll', label: 'Chọn tất cả'},
    ]).popup({window: win}));
    win.loadFile(path.join(__dirname, 'index.html'));
    win.webContents.on('did-finish-load', () => {
        setupAutoUpdater(win);
        send('state', {running: !!pipeline?.running});
        checkEnv().catch(() => {});
        if (!autoStarted && loadConfig().autoRun) {
            autoStarted = true;
            log('RUN', '🚀 Tự động bắt đầu');
            startPipeline().catch(err => logError('RUN', err.message));
        }
    });
}

// ======================
// IPC
// ======================
ipcMain.handle('get-config', () => {
    const cfg = loadConfig();
    return {...cfg, version: VERSION, total: countIds(cfg.dataDir)};
});

ipcMain.handle('save-config', (_, cfg) => {
    saveConfig(cfg);
    if (app.isPackaged) app.setLoginItemSettings({openAtLogin: !!loadConfig().autoStart});
    setLogDir(path.join(loadConfig().dataDir, 'logs'));
    logOk('CONFIG', 'Đã lưu cấu hình' + (pipeline?.running ? ' — áp dụng từ lần chạy sau' : ''));
});

ipcMain.handle('pick-dir', async () =>
    (await dialog.showOpenDialog(win, {properties: ['openDirectory', 'createDirectory']})).filePaths[0]);

const FILE_FILTERS = {chrome: {name: 'Chrome', extensions: ['exe']}, video: {name: 'Video', extensions: ['mp4', 'mov', 'webm', 'mkv', 'm4v']}};
ipcMain.handle('pick-file', async (_, kind = 'chrome') =>
    (await dialog.showOpenDialog(win, {properties: ['openFile'], filters: [FILE_FILTERS[kind]]})).filePaths[0]);

// Công cụ test: link (Pinterest pin / link video) hoặc file → tải gốc (cache theo link) → xử lý theo tuỳ chọn đang chọn trên form
ipcMain.handle('test-transform', async (_, source, opts) => {
    opts = randomOpts(opts); // bật random thì test cũng random như lúc chạy thật
    const env = await checkEnv();
    const dir = path.join(loadConfig().dataDir, 'test');
    let input = source;
    if (/^https?:\/\//i.test(source)) {
        const name = `goc_${crypto.createHash('md5').update(source).digest('hex').slice(0, 10)}.mp4`;
        input = path.join(dir, name);
        if (!fs.existsSync(input)) {
            log('TEST', `⬇️ Tải video gốc: ${source}`);
            input = await downloadVideo(env, source, dir, name, {
                onProgress: pct => send('test-progress', `Đang tải ${pct}`),
                onLog: line => log('TEST', line),
            });
            if (!input) throw new Error('Tải video gốc lỗi — xem log');
        }
    } else if (!source || !fs.existsSync(source)) {
        throw new Error('Nhập link video hoặc chọn file');
    }
    fs.mkdirSync(dir, {recursive: true});
    const output = path.join(dir, `${path.parse(input).name}__${tfTag(opts)}.mp4`);
    const t = Date.now();
    log('TEST', `🎬 Xử lý ${path.basename(input)} (${tfTag(opts)})`);
    const res = await transformVideo(env.ffmpeg, input, opts, {
        output,
        onProgress: pct => send('test-progress', `Đang xử lý ${pct}%`),
        onLog: line => log('TEST', line),
    });
    const seconds = (Date.now() - t) / 1000;
    logOk('TEST', `Xong ${path.basename(output)} sau ${seconds.toFixed(1)}s`);
    return {input, output: res.output, cmd: cmdLine(env.ffmpeg, res.args), seconds, tag: tfTag(opts)};
});

ipcMain.handle('show-file', (_, p) => shell.showItemInFolder(p));

async function startPipeline() {
    if (pipeline?.running) return;
    const env = await checkEnv();
    if (loginCtx) await loginCtx.close().catch(() => {});
    pipeline = new Pipeline(loadConfig(), env);
    send('state', {running: true});
    pipeline.start().finally(() => send('state', {running: false}));
}

ipcMain.handle('start', startPipeline);

ipcMain.handle('stop', () => pipeline?.stop());

ipcMain.handle('replan', () => {
    if (pipeline?.running) pipeline.replan(loadConfig());
    else log('RUN', '🗓️ Chưa chạy — lịch mới được lên khi bấm Bắt đầu');
});

// Chrome dùng cho đăng nhập & test tính năng (cùng profile với pipeline → đang chạy thì dùng chung Chrome của pipeline)
async function toolChrome() {
    if (pipeline?.running) {
        if (!pipeline.ctx) throw new Error('Pipeline đang mở Chrome — thử lại sau vài giây');
        return pipeline.ctx;
    }
    if (!loginCtx) {
        loginCtx = await openChrome(loadConfig());
        loginCtx.on('close', () => loginCtx = null);
    }
    return loginCtx;
}

ipcMain.handle('open-chrome', async () => {
    const ctx = await toolChrome();
    const pinterest = ctx.pages()[0] ?? await ctx.newPage();
    await pinterest.goto('https://www.pinterest.com/login/');
    await (await ctx.newPage()).goto('https://www.rednote.com/explore');
    await (await ctx.newPage()).goto('https://www.tiktok.com/tiktokstudio/upload');
    log('CHROME', 'Đã mở Chrome profile — đăng nhập Pinterest + Xiaohongshu + TikTok + Facebook rồi đóng cửa sổ Chrome');
});

// ---------- Test tính năng: chạy riêng từng bước trên Chrome đăng nhập, cfg lấy từ form (chưa cần Lưu) ----------
async function runTest(name, fn) {
    if (testRunning) throw new Error('Đang chạy 1 test khác');
    testRunning = true;
    log('TEST', `▶️ ${name}`);
    try {
        const res = await fn(await toolChrome());
        logOk('TEST', `Xong: ${name}`);
        return res;
    } finally {
        testRunning = false;
    }
}

// Crawl tới video đầu tiên (không đối chiếu / không ghi crawled_ids) rồi tải về thư mục test
ipcMain.handle('test-crawl', (_, url, cfg) => runTest(`Crawl ${url}`, async ctx => {
    const env = await checkEnv();
    const dir = path.join(loadConfig().dataDir, 'test');
    const videos = crawlerFor(url).crawl(ctx, url, {isRunning: () => testRunning, maxScrolls: Math.max(1, Number(cfg.maxScrolls) || 20)});
    for await (const v of videos) {
        log('TEST', `⬇️ Tải ${v.id}: ${v.url}`);
        const file = await downloadVideo(env, v.url, dir, `crawl_${v.id}.mp4`, {onLog: line => log('TEST', line)});
        if (!file) throw new Error(`Tải video ${v.id} lỗi — xem log`);
        return {...v, file};
    }
    throw new Error(testRunning ? 'Không tìm thấy video nào' : 'Đã dừng');
}));

const needFile = file => { if (!file || !fs.existsSync(file)) throw new Error('Chọn file video để đăng'); };
ipcMain.handle('test-tiktok', (_, file, cfg) => (needFile(file), runTest('Đăng TikTok', ctx => uploadToTiktok(ctx, file, cfg.caption ?? ''))));
ipcMain.handle('test-facebook', (_, file, cfg) => (needFile(file), runTest('Đăng Facebook', ctx => uploadToFacebook(ctx, file, cfg.fbHashtags || cfg.caption))));
ipcMain.handle('test-human', (_, site, minutes, cfg) => runTest(`Human ${site} ${minutes} phút`, ctx =>
    humanSession(ctx, site, Date.now() + Math.max(1, Number(minutes) || 3) * 60_000, () => testRunning, Number(cfg.humanLikeRate) || 0)));
ipcMain.handle('test-stop', () => { if (testRunning) log('TEST', '⏹️ Đang dừng test...'); testRunning = false; });

ipcMain.handle('test-telegram', async () => {
    if (!(await sendTelegram(loadConfig(), '🔔 Test thông báo từ NTT Auto'))) throw new Error('Chưa nhập Bot token / Admin');
    logOk('TELEGRAM', 'Đã gửi tin test');
});

ipcMain.handle('open-data-dir', () => {
    const dir = loadConfig().dataDir;
    fs.mkdirSync(dir, {recursive: true});
    return shell.openPath(dir);
});

ipcMain.handle('recheck-env', () => {
    envPromise = null;
    return checkEnv();
});

// ======================
// APP
// ======================
app.whenReady().then(() => {
    setLogDir(path.join(loadConfig().dataDir, 'logs'));
    if (app.isPackaged) app.setLoginItemSettings({openAtLogin: !!loadConfig().autoStart});
    createWindow();
});

app.on('window-all-closed', async () => {
    pipeline?.stop();
    await loginCtx?.close().catch(() => {});
    app.quit();
});
