const {ipcRenderer} = require('electron');

const $ = id => document.getElementById(id);
const FIELDS = ['dataDir', 'searchUrls', 'xhsUrls', 'pinterestEnabled', 'xhsEnabled', 'caption', 'tiktokEnabled', 'fbEnabled', 'fbHashtags', 'videosPerUrl', 'delayMinutes', 'maxScrolls',
    'chromePath', 'chromeProfileDir', 'telegramToken', 'telegramAdmin', 'scheduleEnabled', 'scheduleTimes', 'humanEnabled', 'humanTiktok', 'humanFacebook', 'humanXhs', 'humanLikeRate', 'humanTimes','humanMinutes', 'autoStart', 'autoRun',
    'tfRandom', 'tfRotate', 'tfColor', 'tfFps', 'tfAudio', 'tfPip', 'reactionPath'];
const STEPS = ['B1 Truy cập nguồn', 'B2 Quét video', 'B3 Lọc video mới', 'B4 Tải video', 'B5 Đăng TikTok', 'B6 Đăng Facebook', 'B7 Thông báo & xoá'];
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
let testBusy = false; // đang chạy test tính năng → log hiện thêm ở tab Test
function addLog({type, msg}) {
    for (const box of testBusy ? [$('logs'), $('testLogs')] : [$('logs')]) {
        const line = document.createElement('div');
        line.className = type;
        line.textContent = msg;
        box.appendChild(line);
        while (box.childElementCount > MAX_LOG_LINES) box.firstChild.remove();
        if ($('autoScroll').checked) box.scrollTop = box.scrollHeight;
    }
}

// ---------- Config ----------
async function loadConfig() {
    const cfg = await ipcRenderer.invoke('get-config');
    FIELDS.forEach(f => $(f).type === 'checkbox' ? $(f).checked = !!cfg[f] : $(f).value = cfg[f] ?? '');
    syncPlatforms();
    HOUR_GRIDS.forEach(g => g.load(cfg[g.field] ?? ''));
    URL_LISTS.forEach(l => l.load(cfg[l.field] ?? ''));
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

// ---------- Danh sách URL crawl: mỗi nguồn 1 danh sách riêng (lưu vào field dạng mỗi dòng 1 URL) ----------
const parseUrls = text => text.split(/[\s,;]+/).filter(s => /^https?:\/\//.test(s)); // cùng cách tách với pipeline
const hostIs = re => u => { try { return re.test(new URL(u).hostname); } catch { return false; } };

// "mèo hài hước · pins" cho dễ đọc thay vì chuỗi %C3%A8...
function describe(u) {
    try {
        const url = new URL(u);
        let kw = url.searchParams.get('q') || url.searchParams.get('keyword') || url.pathname;
        try { kw = decodeURIComponent(kw); } catch {} // keyword Xiaohongshu bị encode 2 lần
        return [kw, url.pathname.split('/').filter(Boolean).pop() ?? ''];
    } catch { return [u, '']; }
}

// p = tiền tố id trong index.html (<p>List, <p>New, <p>Add, <p>Count, <p>Enabled), field = ô ẩn lưu cấu hình
function urlList(p, enabledId, field, label, match) {
    const l = {field, urls: []};
    const save = next => { l.urls = next; render(); call('save-config', readForm()); };

    function render() {
        $(field).value = l.urls.join('\n');
        $(`${p}Count`).textContent = l.urls.length;
        $(`${p}List`).replaceChildren(...l.urls.map((u, i) => {
            const item = document.createElement('div');
            item.className = 'url-item';
            const [kw, type] = describe(u);
            const head = document.createElement('div');
            head.className = 'kw';
            head.append(Object.assign(document.createElement('b'), {textContent: `${i + 1}. ${kw}`}),
                Object.assign(document.createElement('small'), {textContent: type}));
            const input = Object.assign(document.createElement('input'), {value: u, title: u});
            input.onchange = () => update(i, input.value.trim());
            const del = Object.assign(document.createElement('button'), {textContent: '✕', title: 'Xoá', className: 'danger'});
            del.onclick = () => confirm(`Xoá URL "${kw}"?`) && save(l.urls.filter((_, j) => j !== i));
            const row = document.createElement('div');
            row.className = 'row';
            row.append(input, del);
            item.append(head, row);
            return item;
        }));
    }

    function add() {
        const found = parseUrls($(`${p}New`).value);
        if (!found.length) return alert('Không tìm thấy URL hợp lệ (phải bắt đầu bằng http:// hoặc https://)');
        const wrong = found.filter(u => !match(u));
        if (wrong.length) return alert(`Không phải URL ${label}:\n${wrong.join('\n')}`);
        const fresh = [...new Set(found)].filter(u => !l.urls.includes(u));
        if (fresh.length < found.length) addLog({type: 'warn', msg: `⚠️ Bỏ qua ${found.length - fresh.length} URL trùng`});
        $(`${p}New`).value = '';
        if (fresh.length) save([...l.urls, ...fresh]);
    }

    function update(i, u) {
        if (!/^https?:\/\/\S+$/.test(u) || !match(u)) alert(`URL ${label} không hợp lệ`);
        else if (l.urls.some((x, j) => x === u && j !== i)) alert('URL đã có trong danh sách');
        else return save(l.urls.map((x, j) => j === i ? u : x));
        render(); // sai → trả lại giá trị cũ
    }

    $(`${p}Add`).onclick = add;
    $(`${p}New`).onkeydown = e => { if (e.key === 'Enter') add(); }; // không return false — sẽ chặn mọi phím gõ
    // Dán URL hợp lệ → thêm luôn, không cần Enter (chờ giá trị dán vào ô xong mới đọc)
    $(`${p}New`).onpaste = () => setTimeout(() => parseUrls($(`${p}New`).value).length && add());
    $(enabledId).onchange = () => call('save-config', readForm());
    l.load = text => { l.urls = parseUrls(text); render(); };
    return l;
}

const URL_LISTS = [
    urlList('pin', 'pinterestEnabled', 'searchUrls', 'Pinterest', hostIs(/(^|\.)pinterest\.|^pin\.it$/i)),
    urlList('xhs', 'xhsEnabled', 'xhsUrls', 'Xiaohongshu', hostIs(/(^|\.)(rednote|xiaohongshu)\.com$/i)),
];

// Tích chọn nền tảng đăng: bỏ tích thì khoá ô caption/hashtag tương ứng, lưu ngay
function syncPlatforms() {
    $('caption').disabled = !$('tiktokEnabled').checked;
    $('fbHashtags').disabled = !$('fbEnabled').checked;
}
for (const id of ['tiktokEnabled', 'fbEnabled']) $(id).onchange = () => { syncPlatforms(); call('save-config', readForm()); };

// Khung giờ đăng / lướt: 24 ô tick theo giờ, lưu vào field dạng "05:00-06:00, 12:00-13:00" (mỗi ô 1 video / 1 phiên)
const pad = h => `${String(h % 24).padStart(2, '0')}:00`;
function hourGrid(gridId, field, countId) {
    const boxes = Array.from({length: 24}, (_, h) => Object.assign(document.createElement('input'), {type: 'checkbox', value: h}));
    const sync = () => {
        const on = boxes.filter(b => b.checked).map(b => `${pad(+b.value)}-${pad(+b.value + 1)}`);
        $(field).value = on.join(', ');
        $(countId).replaceChildren('Đã chọn ', Object.assign(document.createElement('b'), {textContent: `${on.length} giờ`}),
            on.length ? `: ${on.join(' · ')}` : ' — chưa tick giờ nào');
    };
    $(gridId).replaceChildren(...boxes.map(box => {
        box.onchange = () => { sync(); call('save-config', readForm()); };
        const label = Object.assign(document.createElement('label'), {className: 'check'});
        label.append(box, `${pad(+box.value)}-${pad(+box.value + 1)}`);
        return label;
    }));
    // Cấu hình cũ dạng tự gõ ("07:30-09:00") → tick các giờ nằm trong khung
    const load = text => {
        const ranges = text.split(/[,;\n]/).map(s => s.trim().split('-').map(t => {
            const [h, m] = t.split(':').map(Number);
            return h * 60 + (m || 0);
        })).filter(r => r.every(Number.isFinite)).map(([a, b = a]) => [a, b < a ? b + 1440 : b]);
        const hit = x => ranges.some(([a, b]) => a === b ? Math.floor(a / 60) * 60 === x : a <= x && x < b);
        boxes.forEach(box => box.checked = hit(box.value * 60) || hit(box.value * 60 + 1440));
        sync();
    };
    return {field, load};
}
const HOUR_GRIDS = [hourGrid('hourGrid', 'scheduleTimes', 'hourCount'), hourGrid('humanHourGrid', 'humanTimes', 'humanHourCount')];

$('btnSave').onclick =() => call('save-config', readForm());
$('btnStart').onclick = async () => {
    await call('save-config', readForm());
    $('btnStart').disabled = true;
    await call('start');
    if ($('btnStop').disabled) $('btnStart').disabled = false; // start lỗi
};
$('btnStop').onclick = () => call('stop');
$('btnReplan').onclick = async () => { await call('save-config', readForm()); await call('replan'); };
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
const fmtTime = ts => new Date(ts).toLocaleString('vi-VN', {hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit'});
ipcRenderer.on('plan', (_, plan) => $('plan').replaceChildren(...plan.map(e => Object.assign(document.createElement('div'), {
    className: e.status,
    textContent: `${{done: '✅', skip: '⏭️', pending: '⬜'}[e.status]} ${fmtTime(e.at)} ${e.text}`,
}))));
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
    $('btnUpdate').disabled = u.event === 'checking' || u.event === 'downloading';
});
$('btnUpdate').onclick = () => ipcRenderer.send('check-for-updates');

// ---------- Tabs (nav chính + tab con trong Cấu hình / Test: mỗi nav chỉ bật/tắt các view của nó) ----------
document.querySelectorAll('[data-view]').forEach(btn => btn.onclick = () => {
    btn.parentElement.querySelectorAll('[data-view]').forEach(b => {
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
// ---------- Test tính năng: crawl / đăng TikTok / đăng Facebook / human ----------
const TESTS = {
    crawl: () => call('test-crawl', $('tCrawlUrl').value.trim() || URL_LISTS.flatMap(l => l.urls)[0] || '', readForm()).then(r => r && ($('tFile').value = r.file)),
    tiktok: () => confirm('Đăng THẬT video này lên TikTok?') && call('test-tiktok', $('tFile').value.trim(), readForm()),
    facebook: () => confirm('Đăng THẬT video này lên Facebook?') && call('test-facebook', $('tFile').value.trim(), readForm()),
    'human-tiktok': () => call('test-human', 'tiktok', $('tHumanMin').value, readForm()),
    'human-facebook': () => call('test-human', 'facebook', $('tHumanMin').value, readForm()),
    'human-xhs': () => call('test-human', 'xiaohongshu', $('tHumanMin').value, readForm()),
};
document.querySelectorAll('[data-test]').forEach(btn => btn.onclick = async () => {
    const all = document.querySelectorAll('.tbtn');
    all.forEach(b => b.disabled = true);
    $('btnTestStop').disabled = false;
    $('testLogs').innerHTML = '';
    testBusy = true;
    try {
        await TESTS[btn.dataset.test]();
    } finally {
        testBusy = false;
        all.forEach(b => b.disabled = false);
        $('btnTestStop').disabled = true;
    }
});
$('btnTestStop').onclick = () => call('test-stop');

ipcRenderer.on('test-progress', (_, text) => $('testStatus').textContent = text);

loadConfig();
