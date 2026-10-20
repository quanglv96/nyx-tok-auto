// Che sub tiếng Trung in cứng bằng subswap/ (PaddleOCR → ô che kính mờ theo thời gian từng câu)
import path from 'path';
import {spawn} from 'child_process';

const NO_SUB = 3; // mã thoát của `main.py cover` khi video không có sub

let envPromise = null;
// import lười: ensureEnv.js cần electron → pipeline.js vẫn test được bằng node thuần
const subEnv = onStatus => envPromise ??= import('./ensureEnv.js').then(m => m.ensureSubEnv(onStatus)).catch(err => {
    envPromise = null;
    throw err;
});

// → {output: <workDir>/<tên video>/nosub.mp4, hoặc null nếu video không có sub, cmd}
export async function coverSub(ffmpeg, input, workDir, {onChild, onProgress, onLog} = {}) {
    onProgress?.('Kiểm tra môi trường OCR…');
    const sub = await subEnv(onProgress);
    const args = [sub.script, '--work-dir', workDir, 'cover', input];
    const cmd = [sub.python, ...args].map(a => /\s/.test(a) ? `"${a}"` : a).join(' ');
    onProgress?.('Đọc video + khởi tạo OCR (~10–30s, lần đầu tải thêm model ~100 MB)…');
    const code = await new Promise((resolve, reject) => {
        const p = spawn(sub.python, args, {windowsHide: true, env: {...process.env, PYTHONIOENCODING: 'utf-8', FFMPEG: ffmpeg}});
        onChild?.(p);
        let tail = '';
        const onData = d => {
            tail = (tail + d).slice(-3000);
            // tqdm ghi đè dòng bằng \r: "OCR:  45%|..." → thanh trạng thái; còn lại → log
            for (const line of String(d).split(/[\r\n]+/)) {
                const bar = /^(.+?):\s+(\d+)%\|/.exec(line);
                if (bar) onProgress?.(`${bar[1]} ${bar[2]}%`);
                else if (/subswap: |Error|Traceback/.test(line)) onLog?.(line.replace(/^.*?subswap: /, ''));
            }
        };
        p.stdout.on('data', onData);
        p.stderr.on('data', onData);
        p.on('error', reject);
        p.on('close', code => code === 0 || code === NO_SUB ? resolve(code)
            : reject(new Error(`subswap lỗi (exit ${code}):\n${tail.split(/[\r\n]+/).slice(-6).join('\n')}`)));
    });
    return {output: code === NO_SUB ? null : path.join(workDir, path.parse(input).name, 'nosub.mp4'), cmd};
}
