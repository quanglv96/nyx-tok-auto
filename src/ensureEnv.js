// Kiểm tra & cài môi trường mỗi lần mở app: Python → venv → yt-dlp + ffmpeg → Chrome
import {app} from 'electron';
import fs from 'fs';
import path from 'path';
import {spawn} from 'child_process';
import {fileURLToPath} from 'url';
import {log, logOk, logWarn} from './logger.js';
import {findChrome} from './chrome.js';

const TAG = 'ENV';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function run(cmd, args, onLine) {
    return new Promise((resolve, reject) => {
        const p = spawn(cmd, args, {windowsHide: true, env: {...process.env, PYTHONIOENCODING: 'utf-8'}});
        let out = '';
        const onData = d => {
            out += d;
            if (onLine) String(d).split(/\r?\n/).forEach(l => l.trim() && onLine(l.trim()));
        };
        p.stdout.on('data', onData);
        p.stderr.on('data', onData);
        p.on('error', reject);
        p.on('close', code => code === 0 ? resolve(out) : reject(new Error(`${path.basename(cmd)} ${args.join(' ')} → exit ${code}\n${out.slice(-500)}`)));
    });
}

async function pythonVersion(cmd, args = [], min = 9, max = 99) {
    try {
        const m = /Python 3\.(\d+)\.\d+/.exec(await run(cmd, [...args, '--version']));
        return m && Number(m[1]) >= min && Number(m[1]) <= max ? m[0] : null;
    } catch {
        return null;
    }
}

async function findPython() {
    const local = process.env.LOCALAPPDATA ?? '';
    const candidates = [
        ['py', ['-3']],
        ['python', []],
        ...['314', '313', '312', '311', '310'].map(v => [path.join(local, 'Programs', 'Python', `Python${v}`, 'python.exe'), []]),
    ];
    for (const [cmd, args] of candidates) {
        const version = await pythonVersion(cmd, args);
        if (version) return {cmd, args, version};
    }
    return null;
}

export async function ensureEnv(cfg) {
    log(TAG, '🔍 Kiểm tra môi trường...');
    const venv = path.join(app.getPath('userData'), 'pyenv');
    const py = path.join(venv, 'Scripts', 'python.exe');

    // 1. Python + virtualenv
    if (!(await pythonVersion(py))) {
        let sys = await findPython();
        if (!sys) {
            logWarn(TAG, 'Không tìm thấy Python 3.9+ — đang cài Python 3.12 qua winget...');
            await run('winget', ['install', '-e', '--id', 'Python.Python.3.12', '--scope', 'user', '--silent',
                '--accept-package-agreements', '--accept-source-agreements']).catch(err => logWarn(TAG, err.message));
            sys = await findPython();
            if (!sys) throw new Error('Không cài được Python. Cài thủ công Python 3.12 (python.org) rồi mở lại app.');
        }
        log(TAG, `Tạo virtualenv bằng ${sys.version}`);
        fs.rmSync(venv, {recursive: true, force: true});
        await run(sys.cmd, [...sys.args, '-m', 'venv', venv]);
    }

    // 2. yt-dlp + ffmpeg (luôn kiểm tra bản mới — extractor yt-dlp hay phải cập nhật)
    log(TAG, '📦 Kiểm tra/cập nhật yt-dlp + ffmpeg...');
    try {
        const out = await run(py, ['-m', 'pip', 'install', '--upgrade', '--disable-pip-version-check', 'yt-dlp', 'imageio-ffmpeg']);
        const installed = /Successfully installed (.+)/.exec(out);
        log(TAG, installed ? `Đã cài: ${installed[1]}` : 'Thư viện Python đã là bản mới nhất');
    } catch (err) {
        logWarn(TAG, `pip install lỗi (offline?) — thử dùng bản đang có. ${err.message.split('\n')[0]}`);
    }
    const [ytdlp, ffmpeg] = (await run(py, ['-c',
        'import yt_dlp, imageio_ffmpeg; print(yt_dlp.version.__version__); print(imageio_ffmpeg.get_ffmpeg_exe())'])).trim().split(/\r?\n/);
    logOk(TAG, `yt-dlp ${ytdlp} | ffmpeg ${ffmpeg}`);

    // 3. Chrome
    const chrome = findChrome(cfg);
    if (!chrome) throw new Error('Không tìm thấy Google Chrome — cài Chrome hoặc nhập đường dẫn chrome.exe trong cấu hình');
    logOk(TAG, `Chrome: ${chrome}`);

    // Python không đọc được file trong app.asar → dùng bản extraResources; hot-update thì nằm sẵn ngoài ổ đĩa
    const script = __dirname.includes('app.asar')
        ? path.join(process.resourcesPath, 'python', 'downloader.py')
        : path.join(__dirname, 'python', 'downloader.py');
    logOk(TAG, 'Môi trường sẵn sàng');
    return {python: py, script, ffmpeg};
}

// Môi trường riêng cho subswap (xoá / dịch sub): PaddlePaddle chỉ có wheel cho Python 3.10–3.13
// → venv riêng, chỉ cài khi bấm nút lần đầu (~1 GB) để không làm chậm lúc mở app
const SUB_PY = {min: 10, max: 13};

async function findSubPython() {
    const local = process.env.LOCALAPPDATA ?? '';
    const candidates = [
        ...['13', '12', '11', '10'].map(v => ['py', [`-3.${v}`]]),
        ...['313', '312', '311', '310'].map(v => [path.join(local, 'Programs', 'Python', `Python${v}`, 'python.exe'), []]),
        ['python', []],
    ];
    for (const [cmd, args] of candidates) {
        const version = await pythonVersion(cmd, args, SUB_PY.min, SUB_PY.max);
        if (version) return {cmd, args, version};
    }
    return null;
}

export async function ensureSubEnv(onStatus) {
    const TAG = 'SUB';
    const dir = __dirname.includes('app.asar')
        ? path.join(process.resourcesPath, 'subswap')
        : path.join(__dirname, '..', 'subswap');
    const venv = path.join(app.getPath('userData'), 'subenv');
    const py = path.join(venv, 'Scripts', 'python.exe');
    const result = {python: py, script: path.join(dir, 'main.py')};

    if (!(await pythonVersion(py, [], SUB_PY.min, SUB_PY.max))) {
        let sys = await findSubPython();
        if (!sys) {
            logWarn(TAG, 'OCR cần Python 3.10–3.13 — đang cài Python 3.12 qua winget...');
            await run('winget', ['install', '-e', '--id', 'Python.Python.3.12', '--scope', 'user', '--silent',
                '--accept-package-agreements', '--accept-source-agreements']).catch(err => logWarn(TAG, err.message));
            sys = await findSubPython();
            if (!sys) throw new Error('Không cài được Python 3.12. Cài thủ công từ python.org rồi bấm lại.');
        }
        log(TAG, `Tạo môi trường OCR bằng ${sys.version}`);
        onStatus?.('Đang tạo môi trường Python cho OCR…');
        fs.rmSync(venv, {recursive: true, force: true});
        await run(sys.cmd, [...sys.args, '-m', 'venv', venv]);
    }

    // requirements.txt đổi (cập nhật app) hoặc venv thiếu module subswap thực sự import → cài lại
    const req = path.join(dir, 'requirements.txt');
    const stamp = path.join(venv, 'requirements.installed');
    const want = fs.readFileSync(req, 'utf8');
    if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === want) {
        // find_spec chỉ dò module, không import → nhanh (import paddleocr mất vài giây)
        const missing = (await run(py, ['-c',
            'import importlib.util as u; print(" ".join(m for m in ("paddle", "paddleocr", "cv2", "numpy", "PIL", "yaml", "tqdm", "dotenv", "anthropic") if not u.find_spec(m)))'])
            .catch(() => 'python lỗi')).trim();
        if (!missing) return result;
        logWarn(TAG, `Môi trường OCR thiếu thư viện: ${missing} — cài lại`);
    }

    log(TAG, '📦 Cài PaddleOCR + thư viện (lần đầu ~1 GB, khoảng 5–6 phút)...');
    // pip im lặng nhiều phút lúc tải/giải nén → đồng hồ chạy trên thanh trạng thái + log mỗi bước lớn
    const t0 = Date.now();
    let phase = 'tải thư viện';
    const timer = setInterval(() => onStatus?.(`Đang cài môi trường OCR (lần đầu ~5–6 phút): ${phase}… ${Math.round((Date.now() - t0) / 1000)}s`), 1000);
    try {
        await run(py, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', req], line => {
            if (/^Collecting \S+ \(from -r/.test(line)) log(TAG, line.replace(/ \(from -r.*/, ''));
            else if (/^Downloading paddle/.test(line)) log(TAG, line);
            else if (/^Installing collected packages/.test(line)) {
                phase = 'cài đặt / giải nén';
                log(TAG, 'Đã tải xong, đang cài đặt các gói...');
            } else if (/^(Successfully|ERROR)/.test(line)) log(TAG, line.slice(0, 300));
        });
    } finally {
        clearInterval(timer);
    }
    fs.writeFileSync(stamp, want);
    logOk(TAG, 'Môi trường OCR sẵn sàng');
    return result;
}
