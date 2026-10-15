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

function run(cmd, args) {
    return new Promise((resolve, reject) => {
        const p = spawn(cmd, args, {windowsHide: true, env: {...process.env, PYTHONIOENCODING: 'utf-8'}});
        let out = '';
        p.stdout.on('data', d => out += d);
        p.stderr.on('data', d => out += d);
        p.on('error', reject);
        p.on('close', code => code === 0 ? resolve(out) : reject(new Error(`${path.basename(cmd)} ${args.join(' ')} → exit ${code}\n${out.slice(-500)}`)));
    });
}

async function pythonVersion(cmd, args = []) {
    try {
        const m = /Python 3\.(\d+)\.\d+/.exec(await run(cmd, [...args, '--version']));
        return m && Number(m[1]) >= 9 ? m[0] : null;
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
