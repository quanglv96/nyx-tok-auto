const {ipcRenderer} = require('electron');

const $ = id => document.getElementById(id);
const FIELDS = ['dataDir', 'searchUrls', 'caption', 'videosPerUrl', 'delayMinutes', 'maxScrolls',
    'chromePath', 'chromeProfileDir', 'telegramToken', 'telegramAdmin', 'scheduleEnabled', 'scheduleTimes', 'postsPerDay', 'autoStart', 'autoRun',
    'tfRandom', 'tfRotate', 'tfColor', 'tfFps', 'tfAudio', 'tfPip', 'reactionPath'];
const STEPS = ['B1 Truy cập Pinterest', 'B2 Bắt API', 'B3 Lọc video mới', 'B4 Tải video', 'B5 Đăng TikTok', 'B6 Thông báo & xoá'];
const MAX_LOG_LINES = 1500;

// ---------- Steps ----------
$('steps').innerHTML = STEPS.map((s, i) => `<div class="step" id="step${i + 1}"><b>${s}</b><small></small></div>`).join('');

function setStep({step, status, detail}) {
    if (step === 0) {
        if (status === 'idle') STEPS.forEach((_, i) => paint(i + 1, '', ''));
        else $('stateChip').textContent = `Đang chạy — ${detail}`;
        return;
    }
    // bắt đầu bước mới → reset các bước phía sau
    if (status === 'running') for (let i = step + 1; i <= STEPS.length; i++) paint(i, '', '');
    paint(step, status, detail);
    if (status === 'running') $('stateChip').textContent = 'Đang chạy';
}

function paint(n, status, detail) {
    const el = $(`step${n}`);
    el.className = `step ${status}`;
    el.querySelector('small').textContent = detail ?? '';
}

// ---------- Logs ----------
function addLog({type, msg}) {
    const box = $('logs');
    const line = document.createElement('div');
    line.className = type;
    line.textContent = msg;
    box.appendChild(line);
    while (box.childElementCount > MAX_LOG_LINES) box.firstChild.remove();
    if ($('autoScroll').checked) box.scrollTop = box.scrollHeight;
}

// ---------- Config ----------
async function loadConfig() {
    const cfg = await ipcRenderer.invoke('get-config');
    FIELDS.forEach(f => $(f).type === 'checkbox' ? $(f).checked = !!cfg[f] : $(f).value = cfg[f] ?? '');
    urls = parseUrls(cfg.searchUrls ?? '');
    renderUrls();
    $('version').textContent = `v${cfg.version}`;
    $('st-total').textContent = cfg.total;
}

function readForm() {
    const cfg = {};
    FIELDS.forEach(f => cfg[f] = $(f).type === 'checkbox' ? $(f).checked : $(f).type === 'number' ? Number($(f).value) : $(f).value.trim());
    return cfg;
}

async function call(channel, ...args) {
    try {
        return await ipcRenderer.invoke(channel, ...args);
    } catch (err) {
        const msg = err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
        addLog({type: 'error', msg: `❌ ${msg}`});
        alert(msg);
    }
}

document.querySelectorAll('[data-pick]').forEach(btn => btn.onclick = async () => {
    const dir = await call('pick-dir');
    if (dir) $(btn.dataset.pick).value = dir;
});
document.querySelectorAll('[data-pick-file]').forEach(btn => btn.onclick = async () => {
    const file = await call('pick-file', btn.dataset.kind);
    if (file) $(btn.dataset.pickFile).value = file;
});

// ---------- Danh sách URL crawl (lưu vào searchUrls dạng mỗi dòng 1 URL) ----------
let urls = [];
const parseUrls = text => text.split(/[\s,;]+/).filter(s => /^https?:\/\//.test(s)); // cùng cách tách với pipeline

// "mèo hài hước · pins" cho dễ đọc thay vì chuỗi %C3%A8...
function describe(u) {
    try {
        const url = new URL(u);
        return [url.searchParams.get('q') || url.pathname, url.pathname.split('/').filter(Boolean).pop() ?? ''];
    } catch { return [u, '']; }
}

function renderUrls() {
    $('searchUrls').value = urls.join('\n');
    $('urlCount').textContent = urls.length;
    $('urlList').replaceChildren(...urls.map((u, i) => {
        const item = document.createElement('div');
        item.className = 'url-item';
        const [kw, type] = describe(u);
        const head = document.createElement('div');
        head.className = 'kw';
        head.append(Object.assign(document.createElement('b'), {textContent: `${i + 1}. ${kw}`}),
            Object.assign(document.createElement('small'), {textContent: type}));
        const input = Object.assign(document.createElement('input'), {value: u, title: u});
        input.onchange = () => updateUrl(i, input.value.trim());
        const del = Object.assign(document.createElement('button'), {textContent: '✕', title: 'Xoá', className: 'danger'});
        del.onclick = () => confirm(`Xoá URL "${kw}"?`) && saveUrls(urls.filter((_, j) => j !== i));
        const row = document.createElement('div');
        row.className = 'row';
        row.append(input, del);
        item.append(head, row);
        return item;
    }));
}

function saveUrls(next) {
    urls = next;
    renderUrls();
    call('save-config', readForm());
}

function addUrls() {
    const found = parseUrls($('urlNew').value);
    const fresh = [...new Set(found)].filter(u => !urls.includes(u));
    if (!found.length) return alert('Không tìm thấy URL hợp lệ (phải bắt đầu bằng http:// hoặc https://)');
    if (fresh.length < found.length) addLog({type: 'warn', msg: `⚠️ Bỏ qua ${found.length - fresh.length} URL trùng`});
    $('urlNew').value = '';
    if (fresh.length) saveUrls([...urls, ...fresh]);
}

function updateUrl(i, u) {
    if (!/^https?:\/\/\S+$/.test(u)) alert('URL không hợp lệ');
    else if (urls.some((x, j) => x === u && j !== i)) alert('URL đã có trong danh sách');
    else return saveUrls(urls.map((x, j) => j === i ? u : x));
    renderUrls(); // sai → trả lại giá trị cũ
}

$('btnUrlAdd').onclick = addUrls;
$('urlNew').onkeydown = e => { if (e.key === 'Enter') addUrls(); }; // không return false — sẽ chặn mọi phím gõ
// Dán URL hợp lệ → thêm luôn, không cần Enter (chờ giá trị dán vào ô xong mới đọc)
$('urlNew').onpaste = () => setTimeout(() => parseUrls($('urlNew').value).length && addUrls());

$('btnSave').onclick =() => call('save-config', readForm());
$('btnStart').onclick = async () => {
    await call('save-config', readForm());
    $('btnStart').disabled = true;
    await call('start');
    if ($('btnStop').disabled) $('btnStart').disabled = false; // start lỗi
};
$('btnStop').onclick = () => call('stop');
$('btnChrome').onclick = async () => { await call('save-config', readForm()); await call('open-chrome'); };
$('btnTele').onclick = async () => { await call('save-config', readForm()); await call('test-telegram'); };
$('btnData').onclick = () => call('open-data-dir');
$('btnEnv').onclick = () => { setEnv(null); call('recheck-env'); };
$('btnClear').onclick = () => $('logs').innerHTML = '';

// ---------- Events từ main ----------
function setEnv(env) {
    const chip = $('envChip');
    chip.className = `chip ${env ? (env.ok ? 'ok' : 'err') : ''}`;
    chip.textContent = !env ? 'Đang kiểm tra môi trường…' : env.ok ? 'Môi trường OK' : 'Lỗi môi trường';
    chip.title = env?.error ?? '';
}

ipcRenderer.on('log', (_, d) => addLog(d));
ipcRenderer.on('step', (_, d) => setStep(d));
ipcRenderer.on('env', (_, d) => setEnv(d));
ipcRenderer.on('stats', (_, s) => Object.entries(s).forEach(([k, v]) => $(`st-${k}`) && ($(`st-${k}`).textContent = v)));
ipcRenderer.on('state', (_, {running}) => {
    $('btnStart').disabled = running;
    $('btnStop').disabled = !running;
    $('btnChrome').disabled = running;
    $('stateChip').className = `chip ${running ? 'run' : ''}`;
    $('stateChip').textContent = running ? 'Đang chạy' : 'Đang dừng';
});
ipcRenderer.on('updater', (_, u) => {
    const chip = $('updChip');
    const text = {available: `Có bản v${u.version}`, downloading: `Đang tải cập nhật ${u.percent}%`, downloaded: `v${u.version} sẵn sàng cài`}[u.event];
    chip.hidden = !text;
    chip.textContent = text ?? '';
});

// ---------- Tabs ----------
document.querySelectorAll('[data-view]').forEach(btn => btn.onclick = () => {
    document.querySelectorAll('[data-view]').forEach(b => {
        b.classList.toggle('active', b === btn);
        $(b.dataset.view).hidden = b !== btn;
    });
});

// ---------- Test chỉnh sửa video ----------
const {pathToFileURL} = require('url');
const fs = require('fs');
let testResult = null;

function showVideo(id, file) {
    const v = $(id), info = $(`${id}Info`);
    v.src = `${pathToFileURL(file).href}?t=${Date.now()}`; // cùng tên file nhưng nội dung mới → tránh cache
    return new Promise(resolve => v.onloadedmetadata = () => {
        info.textContent = `${v.videoWidth}x${v.videoHeight} · ${v.duration.toFixed(1)}s · ${(fs.statSync(file).size / 1048576).toFixed(1)} MB`;
        resolve();
    });
}

// Đồng bộ timeline 2 video: play/pause/tua ở video nào thì video kia theo.
// Bật pitch thì bản xử lý dài/ngắn hơn 2–3% → quy đổi thời gian theo tỉ lệ độ dài.
const vIn = $('testIn'), vOut = $('testOut');
const ratio = () => vOut.duration / vIn.duration || 1;
const SYNC_TOLERANCE = 0.12; // giây — lệch ít hơn thì bỏ qua (tránh 2 video tua qua lại vô hạn)
function follow(from, to, toTime) {
    from.onplay = () => to.paused && to.play();
    from.onpause = () => !to.paused && to.pause();
    from.onseeked = () => Math.abs(to.currentTime - toTime()) > SYNC_TOLERANCE && (to.currentTime = toTime());
}
follow(vIn, vOut, () => vIn.currentTime * ratio());
follow(vOut, vIn, () => vOut.currentTime / ratio());
// Video gốc làm chuẩn khi đang chạy: lệch (do decode, loop) thì kéo bản xử lý về đúng vị trí
vIn.ontimeupdate = () => {
    if (!vIn.paused && Math.abs(vOut.currentTime - vIn.currentTime * ratio()) > 0.25) vOut.currentTime = vIn.currentTime * ratio();
};

function playBoth(fromStart) {
    if (fromStart) vIn.currentTime = vOut.currentTime = 0;
    vIn.play();
}

$('btnTest').onclick = async () => {
    $('btnTest').disabled = true;
    $('testStatus').textContent = 'Đang chạy…';
    try {
        testResult = await call('test-transform', $('testSource').value.trim(), readForm());
        if (!testResult) return $('testStatus').textContent = 'Lỗi — xem log';
        $('testCmd').textContent = testResult.cmd;
        await Promise.all([showVideo('testIn', testResult.input), showVideo('testOut', testResult.output)]);
        playBoth(true);
        $('testStatus').textContent = `[${testResult.tag}] Xong sau ${testResult.seconds.toFixed(1)}s → ${testResult.output}`;
        $('btnTestShow').disabled = $('btnTestCopy').disabled = false;
    } finally {
        $('btnTest').disabled = false;
    }
};
$('btnTestPlay').onclick = () => vIn.paused ? playBoth(false) : vIn.pause();
$('btnTestRestart').onclick = () => playBoth(true);
$('btnTestAudio').onclick = () => {
    // 2 tiếng cùng lúc khó nghe → chỉ bật tiếng 1 bên, bấm để đổi
    vIn.muted = !vIn.muted;
    vOut.muted = !vIn.muted;
    $('btnTestAudio').textContent = `🔊 Tiếng: ${vIn.muted ? 'đã xử lý' : 'gốc'}`;
};
$('btnTestShow').onclick = () => call('show-file', testResult.output);
$('btnTestCopy').onclick = () => navigator.clipboard.writeText(testResult.cmd);
ipcRenderer.on('test-progress', (_, text) => $('testStatus').textContent = text);

loadConfig();
