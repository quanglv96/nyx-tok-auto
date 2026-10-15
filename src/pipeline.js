// Luồng chính B1 → B7, lặp qua danh sách URL Pinterest cho tới khi bấm Dừng
import fs from 'fs';
import path from 'path';
import {spawn} from 'child_process';
import {bus, log, logOk, logWarn, logError, setStep} from './logger.js';
import {openChrome} from './chrome.js';
import {uploadToTiktok} from './tiktok.js';
import {uploadToFacebook} from './facebook.js';
import {sendTelegram} from './telegram.js';
import {transformVideo, tfEnabled, tfTag, randomOpts} from './transform.js';

const API = '/resource/ApiCResource/create/';
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;

// B3: tìm videoUrl ở mọi tầng (thường là options.events[].event_data.videoUrl), id lấy từ object_id_str/object_id gần nhất.
// event_data đôi khi là chuỗi JSON → parse luôn.
export function extractVideos(json) {
    const out = [];
    const walk = (node, id) => {
        if (typeof node === 'string' && /^\s*[[{]/.test(node)) {
            try { node = JSON.parse(node); } catch { return; }
        }
        if (!node || typeof node !== 'object') return;
        id = node.object_id_str ?? node.object_id ?? id;
        if (typeof node.videoUrl === 'string' && id) out.push({id: String(id), url: node.videoUrl});
        for (const v of Object.values(node)) walk(v, id);
    };
    walk(json);
    return out;
}

// File id đã crawl (cả video lỗi) — mỗi dòng 1 id, chỉ append
export class IdStore {
    constructor(file) {
        this.file = file;
        fs.mkdirSync(path.dirname(file), {recursive: true});
        this.ids = new Set(fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean) : []);
    }
    has(id) { return this.ids.has(id); }
    add(id) {
        if (this.ids.has(id)) return;
        this.ids.add(id);
        fs.appendFileSync(this.file, `${id}\n`);
    }
    get size() { return this.ids.size; }
}

// Lịch đăng: "08:00-09:00, 12:30-13:00, 20:00" → [{start, end}] tính theo phút trong ngày.
// "HH:MM" đơn lẻ = đăng đúng giờ đó. Khung qua nửa đêm (23:00-01:00) được hỗ trợ.
export function parseSchedule(text) {
    const toMin = s => {
        const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
        return m && +m[1] < 24 && +m[2] < 60 ? +m[1] * 60 + +m[2] : null;
    };
    return String(text ?? '').split(/[,;\n]/).map(s => s.trim()).filter(Boolean).map(part => {
        const [a, b = a] = part.split('-');
        const start = toMin(a), end = toMin(b);
        if (start === null || end === null) throw new Error(`Khung giờ không hợp lệ: "${part}" (đúng dạng 08:00-09:30)`);
        return {start, end: end < start ? end + 1440 : end};
    }).sort((x, y) => x.start - y.start);
}

// Chia khoảng [start, end] thành n khung bằng nhau, mỗi khung đăng 1 video — "05:00-23:00", n=6 → mỗi khung 3h
export function splitSlots(slots, n) {
    const start = slots[0].start, end = Math.max(...slots.map(s => s.end));
    const step = (end - start) / n;
    return Array.from({length: n}, (_, i) => ({start: Math.round(start + i * step), end: Math.round(start + (i + 1) * step)}));
}

// Khung gần nhất chưa dùng (bắt đầu sau `after`) và chưa kết thúc → giờ đăng random trong khung
export function pickSlot(slots, now, after = 0, rand = Math.random) {
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    for (let d = -1; d <= 1; d++) {
        for (const s of slots) {
            const day = new Date(midnight);
            day.setDate(day.getDate() + d);
            const start = day.getTime() + s.start * 60_000;
            const end = day.getTime() + s.end * 60_000;
            if (start <= after || end < now) continue;
            const from = Math.max(start, now);
            return {start, at: from + Math.floor(rand() * (end - from))};
        }
    }
    return null;
}

// Fisher–Yates: mỗi vòng dùng URL theo thứ tự ngẫu nhiên, mỗi URL đúng 1 lần
export function shuffle(arr, rand = Math.random) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

const fmtTime = ts => new Date(ts).toLocaleString('vi-VN', {hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit'});

// Gọi downloader.py (yt-dlp + ffmpeg) → đường dẫn .mp4 hoặc null nếu lỗi
export function downloadVideo(env, url, dir, filename, {onChild, onProgress, onLog} = {}) {
    return new Promise(resolve => {
        const p = spawn(env.python, [env.script, url, dir, filename], {windowsHide: true, env: {...process.env, PYTHONIOENCODING: 'utf-8'}});
        onChild?.(p);
        const timer = setTimeout(() => p.kill(), DOWNLOAD_TIMEOUT_MS);
        let saved = null, buf = '';
        const onData = d => {
            const lines = (buf + d).split(/\r?\n/);
            buf = lines.pop();
            for (const line of lines.map(l => l.trim()).filter(Boolean)) {
                if (line.startsWith('SAVED:')) saved = line.slice(6);
                else if (line.startsWith('PROGRESS ')) onProgress?.(line.slice(9));
                else onLog?.(line);
            }
        };
        p.stdout.on('data', onData);
        p.stderr.on('data', onData);
        p.on('error', err => onLog?.(err.message));
        p.on('close', code => {
            clearTimeout(timer);
            resolve(code === 0 && saved && fs.existsSync(saved) ? saved : null);
        });
    });
}

export class Pipeline {
    running = false;
    stats = {found: 0, downloaded: 0, uploaded: 0, failed: 0};
    lastSlot = 0;
    lastPostAt = 0;
    slotOpen = false; // đã tới giờ của khung hiện tại, đang crawl/đăng

    constructor(cfg, env) {
        this.cfg = cfg;
        this.env = env;
        this.delayMs = Math.max(0, Number(cfg.delayMinutes) || 0) * 60_000;
        this.slots = cfg.scheduleEnabled ? parseSchedule(cfg.scheduleTimes) : [];
        const perDay = Math.floor(Number(cfg.postsPerDay) || 0);
        if (this.slots.length && perDay > 0) this.slots = splitSlots(this.slots, perDay);
        if (cfg.scheduleEnabled && !this.slots.length) throw new Error('Đã bật lịch đăng nhưng chưa nhập khung giờ');
    }

    async start() {
        this.running = true;
        this.ids = new IdStore(path.join(this.cfg.dataDir, 'crawled_ids.txt'));
        this.videoDir = path.join(this.cfg.dataDir, 'videos');
        this.#emitStats();
        log('RUN', `▶️ Bắt đầu | đã có ${this.ids.size} id trong lịch sử`);
        const hhmm = m => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
        if (this.slots.length) log('RUN', `🗓️ Lịch đăng: ${this.slots.map(s => `${hhmm(s.start)}-${hhmm(s.end)}`).join(', ')} (random phút trong mỗi khung)`);
        try {
            this.ctx = await openChrome(this.cfg);
            this.ctx.on('close', () => {
                if (this.running) logWarn('RUN', 'Chrome bị đóng — dừng');
                this.running = false;
            });
            await this.#loop();
        } catch (err) {
            if (this.running) {
                logError('RUN', err.message);
                await this.#notify(`❌ App dừng do lỗi:\n${err.message}`);
            }
        } finally {
            this.running = false;
            await this.ctx?.close().catch(() => {});
            setStep(0, 'idle');
            log('RUN', '⏹️ Đã dừng');
        }
    }

    stop() {
        if (!this.running) return;
        log('RUN', '⏹️ Đang dừng...');
        this.running = false;
        this.child?.kill();
    }

    async #loop() {
        // Nhiều URL: tách theo xuống dòng / dấu cách / , ; — bỏ trùng và dòng không phải URL
        const urls = [...new Set(this.cfg.searchUrls.split(/[\s,;]+/).filter(s => /^https?:\/\//.test(s)))];
        if (!urls.length) throw new Error('Chưa cấu hình danh sách URL Pinterest');

        while (this.running) {
            let posted = 0;
            for (const url of shuffle(urls)) {
                if (!this.running) break;
                // Có lịch: tới giờ random trong khung mới crawl; chưa đăng được thì thử URL tiếp trong cùng khung
                if (this.slots.length && !this.slotOpen) {
                    await this.#waitSlot();
                    if (!this.running) break;
                    this.slotOpen = true;
                }
                try {
                    const n = await this.#crawlUrl(url);
                    posted += n;
                    if (n) this.slotOpen = false;
                } catch (err) {
                    if (!this.running) break;
                    setStep(1, 'error', err.message);
                    logError('B1', `${url}: ${err.message}`);
                    await this.#notify(`❌ B1 lỗi truy cập Pinterest\n${url}\n${err.message}`);
                }
            }
            if (this.running && !posted) {
                logWarn('RUN', 'Vòng này không đăng được video nào');
                await this.#wait();
            }
        }
    }

    async #crawlUrl(url) {
        setStep(1, 'running', url);
        const page = await this.ctx.newPage();
        const queue = [];
        const seen = new Set();

        // B2: bắt request ApiCResource/create ở cấp context (cả sendBeacon / service worker, không cần chờ response)
        // Chỉ bắt khi đang cuộn — lúc tải/đăng/chờ thì bỏ qua (Pinterest vẫn bắn beacon ngầm)
        let apiHits = 0, listening = true;
        const onRequest = req => {
            if (!listening || !req.url().includes(API)) return;
            apiHits++;
            const body = req.postData() ?? '';
            const found = extractVideos(new URLSearchParams(body).get('data') ?? body);
            for (const v of found) {
                if (seen.has(v.id)) continue;
                seen.add(v.id);
                if (this.ids.has(v.id)) continue;
                queue.push(v);
                this.stats.found++;
                log('B3', `🎬 Video mới ${v.id}`);
            }
        };
        this.ctx.on('request', onRequest);

        try {
            log('B1', `🌐 ${url}`);
            await page.goto(url, {waitUntil: 'domcontentloaded', timeout: 60_000});
            setStep(1, 'ok', url);
            setStep(2, 'running', 'đang cuộn & bắt API ApiCResource/create');

            const max = this.slots.length ? 1 : Math.max(1, Number(this.cfg.videosPerUrl) || 1); // mỗi khung 1 video
            const maxScrolls = Math.max(1, Number(this.cfg.maxScrolls) || 20);
            let posted = 0, emptyScrolls = 0;

            while (this.running && posted < max) {
                const v = queue.shift();
                listening = !v;
                if (!v) {
                    if (emptyScrolls++ >= maxScrolls) {
                        logWarn('B2', `Cuộn ${maxScrolls} lần không thấy video mới (bắt được ${apiHits} request ApiCResource, ${seen.size} video) — sang URL khác`);
                        break;
                    }
                    await page.bringToFront().catch(() => {});
                    await page.mouse.wheel(0, 1200 + Math.random() * 1000);
                    await new Promise(r => setTimeout(r, 3000));
                    continue;
                }
                emptyScrolls = 0;
                setStep(3, 'ok', `video ${v.id} (còn ${queue.length} trong hàng chờ)`);
                this.ids.add(v.id); // lưu ngay, kể cả khi tải/đăng lỗi
                this.#emitStats();

                const file = await this.#transform(await this.#download(v), v);
                if (!file) continue; // tải/xử lý lỗi → quay lại B3 lấy video khác
                if (await this.#upload(file, v)) {
                    posted++;
                    if (this.running && !this.slots.length) await this.#wait(); // có lịch thì khung giờ quyết định
                    setStep(2, 'running', 'đang cuộn & bắt API ApiCResource/create');
                }
            }
            return posted;
        } finally {
            this.ctx.off('request', onRequest);
            await page.close().catch(() => {});
        }
    }

    // B4: gọi downloader.py (yt-dlp + ffmpeg)
    async #download(v) {
        setStep(4, 'running', `video ${v.id}`);
        log('B4', `⬇️ Tải ${v.id}: ${v.url}`);
        const file = await downloadVideo(this.env, v.url, this.videoDir, `${v.id}.mp4`, {
            onChild: p => this.child = p,
            onProgress: pct => setStep(4, 'running', `video ${v.id} — ${pct}`),
            onLog: line => log('B4', line),
        });
        this.child = null;

        if (file) {
            this.stats.downloaded++;
            this.#emitStats();
            setStep(4, 'ok', path.basename(file));
            logOk('B4', `Đã tải ${file}`);
            return file;
        }
        if (!this.running) return null;
        this.stats.failed++;
        this.#emitStats();
        setStep(4, 'error', `video ${v.id} lỗi — tìm video khác`);
        logError('B4', `Tải lỗi video ${v.id} — quay lại B3`);
        await this.#notify(`❌ B4 tải video lỗi\nID: ${v.id}\n${v.url}`);
        return null;
    }

    // B4b: ffmpeg biến đổi video (theo các tuỳ chọn tf*) — lỗi thì bỏ video, không đăng bản gốc
    async #transform(file, v) {
        if (!file || !tfEnabled(this.cfg)) return file;
        const opts = randomOpts(this.cfg);
        setStep(4, 'running', `video ${v.id} — xử lý ffmpeg (${tfTag(opts)})`);
        if (opts !== this.cfg) log('B4', `🎲 Hiệu ứng random: ${tfTag(opts)}`);
        try {
            const {output: out} = await transformVideo(this.env.ffmpeg, file, opts, {
                onChild: p => this.child = p,
                onProgress: pct => setStep(4, 'running', `video ${v.id} — xử lý ffmpeg ${pct}%`),
                onLog: msg => log('B4', msg),
            });
            setStep(4, 'ok', path.basename(out));
            logOk('B4', `🎬 Đã xử lý ${path.basename(out)}`);
            return out;
        } catch (err) {
            if (!this.running) return null;
            this.stats.failed++;
            this.#emitStats();
            setStep(4, 'error', `video ${v.id} xử lý lỗi — tìm video khác`);
            logError('B4', `ffmpeg lỗi ${v.id}: ${err.message}`);
            await this.#notify(`❌ B4 xử lý video lỗi
ID: ${v.id}
${err.message}`);
            return null;
        } finally {
            this.child = null;
            fs.rmSync(file, {force: true});
        }
    }

    // B5 TikTok → B6 Facebook (đăng dù TikTok lỗi) → B7 thông báo & xoá file
    async #upload(file, v) {
        const tiktok = this.cfg.tiktokEnabled
            ? await this.#post(5, 'TikTok', v, () => uploadToTiktok(this.ctx, file, this.cfg.caption ?? ''))
            : (setStep(5, 'ok', 'bỏ qua (đã tắt)'), logWarn('B5', 'Bỏ qua đăng TikTok (đã tắt trong cấu hình)'), false);
        const facebook = this.cfg.fbEnabled && this.running
            && await this.#post(6, 'Facebook', v, () => uploadToFacebook(this.ctx, file, this.cfg.fbHashtags || this.cfg.caption));
        fs.rmSync(file, {force: true});
        logOk('B7', `🗑️ Đã xóa ${path.basename(file)}`);
        if (!tiktok && !facebook) return false;

        this.stats.uploaded++;
        this.lastPostAt = Date.now();
        this.#emitStats();
        setStep(7, 'ok', `xong video ${v.id}`);
        return true;
    }

    async #post(step, name, v, fn) {
        setStep(step, 'running', `video ${v.id}`);
        try {
            await fn();
        } catch (err) {
            this.stats.failed++;
            this.#emitStats();
            setStep(step, 'error', err.message);
            logError(`B${step}`, `Đăng ${name} lỗi ${v.id}: ${err.message}`);
            await this.#notify(`❌ B${step} đăng ${name} thất bại
ID: ${v.id}
Lỗi: ${err.message}`);
            return false;
        }
        setStep(step, 'ok', `video ${v.id}`);
        await this.#notify(`✅ Đăng ${name} thành công
ID Pinterest: ${v.id}`);
        return true;
    }

    async #notify(text) {
        try {
            if (await sendTelegram(this.cfg, text)) log('TELEGRAM', '📨 Đã gửi thông báo');
        } catch (err) {
            logWarn('TELEGRAM', err.message);
        }
    }

    async #waitSlot() {
        // "Chờ (phút)" = khoảng cách tối thiểu với video trước; khung nào bị đẩy quá giờ kết thúc thì bỏ
        const slot = pickSlot(this.slots, Math.max(Date.now(), this.lastPostAt + this.delayMs), this.lastSlot);
        this.lastSlot = slot.start;
        log('RUN', `🗓️ Hẹn crawl & đăng lúc ${fmtTime(slot.at)}`);
        await this.#waitUntil(slot.at, `chờ tới ${fmtTime(slot.at)}`);
    }

    async #wait() {
        if (!this.delayMs) return;
        log('RUN', `⏳ Chờ ${this.delayMs / 60_000} phút...`);
        await this.#waitUntil(Date.now() + this.delayMs, 'chờ');
    }

    async #waitUntil(end, label) {
        while (this.running && Date.now() < end) {
            setStep(0, 'wait', `${label} (còn ${Math.ceil((end - Date.now()) / 60_000)} phút)`);
            await new Promise(r => setTimeout(r, 1000));
        }
    }

    #emitStats() {
        bus.emit('stats', {...this.stats, total: this.ids.size});
    }
}
