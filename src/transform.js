// B4b: biến đổi video sau khi tải (phá perceptual hash / audio fingerprint) → 1080x1920, libx264 CRF 20 + aac
import fs from 'fs';
import path from 'path';
import {spawn} from 'child_process';

const W = 1080, H = 1920;
const VIDEO_EXT = /\.(mp4|mov|webm|mkv|m4v)$/i;
const between = (rand, a, b) => a + rand() * (b - a);
const sign = rand => rand() < 0.5 ? -1 : 1;
const even = n => Math.ceil(n / 2) * 2;

// Lấp đầy khung, cắt phần thừa
const cover = (w, h) => `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1`;
// Video vừa khung 9:16 trên nền chính nó làm mờ → không mất nội dung khi video gốc không phải 9:16 (blur ở 1/4 độ phân giải cho nhanh)
const fitBlur = (inp, out) =>
    `[${inp}]split[${out}_a][${out}_b];` +
    `[${out}_a]${cover(W / 4, H / 4)},boxblur=10,scale=${W}:${H}[${out}_bg];` +
    `[${out}_b]scale=${W}:${H}:force_original_aspect_ratio=decrease,setsar=1[${out}_fg];` +
    `[${out}_bg][${out}_fg]overlay=(W-w)/2:(H-h)/2[${out}]`;

// Zoom tối thiểu để khung W×H xoay góc a không lộ viền đen
export const minZoom = a => Math.cos(Math.abs(a)) + (H / W) * Math.sin(Math.abs(a));

// Tuỳ chọn kết hợp tự do: tfRotate (xoay 1–2° + zoom), tfColor (contrast/saturation/brightness), tfFps (24/25),
// tfAudio (tốc độ + pitch ±2–3%), tfPip (reaction đè góc trên phải)
export const tfEnabled = o => !!(o.tfRandom || o.tfRotate || o.tfColor || o.tfFps || o.tfAudio || o.tfPip);

// tfRandom: mỗi video chọn ngẫu nhiên ≥1 hiệu ứng (có thể kết hợp nhiều) trong các ô đã tick; không tick ô nào = random trong tất cả.
// Không có reaction → loại PiP khỏi pool (không dùng video gốc làm PiP).
const EFFECTS = ['tfRotate', 'tfColor', 'tfFps', 'tfAudio', 'tfPip'];
export function randomOpts(o, rand = Math.random) {
    if (!o.tfRandom) return o;
    const all = pickReaction(o.reactionPath) ? EFFECTS : EFFECTS.filter(k => k !== 'tfPip');
    let pool = all.filter(k => o[k]);
    if (!pool.length) pool = all;
    let picked = pool.filter(() => rand() < 0.5);
    if (!picked.length) picked = [pool[Math.floor(rand() * pool.length)]];
    return {...o, ...Object.fromEntries(EFFECTS.map(k => [k, picked.includes(k)]))};
}

export const tfTag = o => [o.tfRotate && 'xoay', o.tfColor && 'mau', o.tfFps && 'fps', o.tfAudio && 'pitch',
    o.tfPip && 'pip'].filter(Boolean).join('-') || 'fit';

// main = {audio, duration}; pip = {file, audio, duration} hoặc null
export function buildArgs({input, output, main, pip, opts, rand = Math.random}) {
    const args = ['-hide_banner', '-nostats', '-progress', 'pipe:1', '-i', input];
    // reaction ngắn hơn video gốc → lặp lại
    if (pip) args.push('-stream_loop', '-1', '-i', pip.file);

    // 1. Vừa khung → [base] 1080x1920
    let graph = fitBlur('0:v', 'base');

    // 2. Biến đổi trên khung
    const post = [];
    if (opts.tfRotate) {
        const angle = sign(rand) * between(rand, 1, 2) * Math.PI / 180;
        // 3–5% theo yêu cầu, nhưng góc > ~1.3° cần zoom hơn 5% mới che hết viền đen
        const zoom = Math.max(between(rand, 1.03, 1.05), minZoom(angle) + 0.002);
        post.push(`scale=${even(W * zoom)}:${even(H * zoom)}`, `rotate=${angle.toFixed(5)}:ow=${W}:oh=${H}:bilinear=1`);
    }
    if (opts.tfColor) post.push(`eq=contrast=${between(rand, 1.03, 1.05).toFixed(3)}:saturation=1.05:brightness=0.02`);
    // asetrate đổi cả tốc độ lẫn pitch; video setpts cùng hệ số để không lệch tiếng
    const speed = opts.tfAudio ? 1 + sign(rand) * between(rand, 0.02, 0.03) : 1;
    if (speed !== 1) post.push(`setpts=PTS/${speed.toFixed(4)}`);
    if (opts.tfFps) post.push(`fps=${rand() < 0.5 ? 24 : 25}`);
    else if (pip) post.push('fps=30'); // ghép nhiều nguồn khác FPS → ép CFR
    post.push('setsar=1');

    // 3. PiP đè lên sau cùng → không bị xoay/zoom cắt, góc trên phải (chừa 160px đỉnh cho thanh trạng thái / icon tìm kiếm TikTok)
    if (pip) {
        const pw = even(W * between(rand, 0.25, 0.30));
        graph += `;[base]${post.join(',')}[m];[1:v]scale=${pw}:-2,setsar=1,pad=iw+8:ih+8:4:4:white[pip];` +
            `[m][pip]overlay=W-w-40:160:shortest=1[v]`;
    } else {
        graph += `;[base]${post.join(',')}[v]`;
    }

    // 4. Audio: gốc + reaction (nếu có tiếng) trộn chung, rồi đổi pitch
    const chain = 'aresample=44100' + (speed !== 1 ? `,asetrate=${Math.round(44100 * speed)},aresample=44100` : '');
    const ins = [main.audio && '[0:a]', pip?.audio && '[1:a]'].filter(Boolean);
    const audio = ins.length > 1 ? `${ins.join('')}amix=inputs=${ins.length}:duration=first:dropout_transition=0,${chain}[a]`
        : ins.length ? `${ins[0]}${chain}[a]` : null;

    if (pip) args.push('-t', (main.duration / speed).toFixed(3)); // dài đúng bằng video gốc
    args.push('-filter_complex', audio ? `${graph};${audio}` : graph, '-map', '[v]');
    args.push(...(audio ? ['-map', '[a]', '-c:a', 'aac', '-b:a', '192k', '-ar', '44100'] : ['-an']));
    args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p',
        '-map_metadata', '-1', '-map_chapters', '-1', '-movflags', '+faststart', '-y', output);
    return args;
}

// Câu lệnh để hiển thị / copy chạy tay
export const cmdLine = (ffmpeg, args) => [ffmpeg, ...args].map(a => /[\s;\[\]"',]/.test(a) ? `"${a}"` : a).join(' ');

function run(ffmpeg, args, {onChild, onTime} = {}) {
    return new Promise((resolve, reject) => {
        const p = spawn(ffmpeg, args, {windowsHide: true});
        onChild?.(p);
        let err = '';
        p.stdout.on('data', d => {
            const m = /out_time_us=(\d+)/.exec(d);
            if (m) onTime?.(Number(m[1]) / 1e6);
        });
        p.stderr.on('data', d => err = (err + d).slice(-3000));
        p.on('error', reject);
        p.on('close', code => code === 0 ? resolve(err)
            : reject(Object.assign(new Error(`ffmpeg exit ${code}: ${err.trim().split(/\r?\n/).slice(-3).join(' | ')}`), {stderr: err})));
    });
}

// Không có ffprobe trong imageio-ffmpeg → đọc thông tin từ stderr của `ffmpeg -i`
export async function probe(ffmpeg, file) {
    const out = await run(ffmpeg, ['-hide_banner', '-i', file]).catch(err => err.stderr ?? '');
    const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(out);
    if (!d) throw new Error(`Không đọc được video ${path.basename(file)}`);
    return {duration: +d[1] * 3600 + +d[2] * 60 + +d[3], audio: /Stream #.*Audio:/.test(out)};
}

// File cụ thể hoặc thư mục (chọn ngẫu nhiên 1 video)
export function pickReaction(p, rand = Math.random) {
    if (!p || !fs.existsSync(p)) return null;
    if (!fs.statSync(p).isDirectory()) return p;
    const files = fs.readdirSync(p).filter(f => VIDEO_EXT.test(f));
    return files.length ? path.join(p, files[Math.floor(rand() * files.length)]) : null;
}

export async function transformVideo(ffmpeg, input, opts, {output, onChild, onProgress, onLog} = {}) {
    const main = await probe(ffmpeg, input);
    let pip = null;
    if (opts.tfPip) {
        const file = pickReaction(opts.reactionPath);
        if (file) {
            onLog?.(`PiP: ${path.basename(file)}`);
            pip = {file, ...await probe(ffmpeg, file)};
        } else {
            // Không dùng chính video gốc làm PiP → lỗi, pipeline bỏ video này
            throw new Error(`PiP: không có video reaction trong "${opts.reactionPath || '(chưa chọn)'}"`);
        }
    }
    output ??= input.replace(/\.mp4$/i, '') + '_tf.mp4';
    const args = buildArgs({input, output, main, pip, opts});
    onLog?.(`🎞️ Áp dụng hiệu ứng: ${tfTag(opts)} (${main.duration.toFixed(1)}s)`);
    let mark = 0; // log tiến trình mỗi 25%
    try {
        await run(ffmpeg, args, {onChild, onTime: t => {
            const pct = Math.min(99, Math.round(t * 100 / main.duration));
            onProgress?.(pct);
            if (pct >= mark + 25) onLog?.(`⏳ Xử lý ${mark = pct - pct % 25}%`);
        }});
    } catch (err) {
        fs.rmSync(output, {force: true});
        throw err;
    }
    return {output, args};
}
