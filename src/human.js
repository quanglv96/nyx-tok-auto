// Human action: lúc pipeline đang chờ, thỉnh thoảng lướt TikTok / Facebook / Xiaohongshu như người dùng rảnh rỗi
// (xem video, đọc post, treo máy, thi thoảng like) để tài khoản trông tự nhiên.
import {log, logOk, logWarn} from './logger.js';

const TAG = 'HUMAN';
const MAX_LIKES = 3;               // tối đa like / phiên, dù tỷ lệ like cao
const MARGIN_MS = 2 * 60_000;      // chừa trước giờ crawl/đăng
const rnd = (a, b) => a + Math.random() * (b - a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sec = ms => `${(ms / 1000).toFixed(1)}s`;

// Thời lượng phiên "3-12" (phút) → [3, 12]; "5" = đúng 5 phút
export function parseMinutes(text) {
    const [lo, hi = lo] = String(text ?? '').split('-').map(s => Number(s.trim()));
    if (!(lo > 0 && hi >= lo)) throw new Error(`Thời lượng phiên lướt không hợp lệ: "${text}" (đúng dạng 3-12)`);
    return [lo, hi];
}

// Giờ kết thúc phiên lướt (lo–hi phút), hoặc null nếu thời gian chờ còn quá ngắn
export function pickHumanSession(now, end, [lo, hi] = [3, 12], rand = Math.random) {
    const dur = Math.min(end - now - MARGIN_MS, (lo + rand() * (hi - lo)) * 60_000);
    return dur >= MARGIN_MS ? now + dur : null;
}

export async function humanSession(ctx, site, until, isRunning, likeRate) {
    const page = await ctx.newPage();
    const alive = () => isRunning() && Date.now() < until;
    // chờ nhưng vẫn dừng ngay khi bấm Dừng / hết giờ phiên
    const wait = async ms => {
        const t = Date.now() + ms;
        while (alive() && Date.now() < t) await sleep(Math.min(1000, t - Date.now()));
    };
    let likes = 0;
    const tryLike = async loc => {
        if (likes >= MAX_LIKES) return log(TAG, `🤍 Bỏ qua like: đã đủ ${MAX_LIKES} like/phiên`);
        const roll = Math.random() * 100;
        if (roll >= likeRate) return log(TAG, `🤍 Không like (random ${roll.toFixed(0)} ≥ tỷ lệ ${likeRate}%)`);
        if (await humanClick(page, loc)) log(TAG, `❤️ Like (${++likes}/${MAX_LIKES}) — random ${roll.toFixed(0)} < ${likeRate}%`);
        else log(TAG, '🤍 Không bấm được nút like');
    };
    try {
        log(TAG, `🧍 Lướt ${site} tới ${new Date(until).toLocaleTimeString('vi-VN')}`);
        const browse = {facebook: browseFacebook, xiaohongshu: browseXhs}[site] ?? browseTiktok;
        const n = await browse(page, wait, alive, tryLike);
        logOk(TAG, `Xong phiên ${site}: xem ${n} ${site === 'facebook' ? 'lần cuộn' : 'video'}, ${likes} like`);
    } catch (err) {
        if (isRunning()) logWarn(TAG, `Phiên ${site} lỗi: ${err.message}`);
    } finally {
        await page.close().catch(() => {});
    }
}

// B1 bấm mở comment 1 lần khi vào → lặp: B2 xem 2–10s (thi thoảng treo 30–90s) → B3 random like → B4 lăn chuột / ↓ sang video tiếp
async function browseTiktok(page, wait, alive, tryLike) {
    await page.goto('https://www.tiktok.com/', {waitUntil: 'domcontentloaded', timeout: 60_000});
    const load = rnd(4000, 8000);
    log(TAG, `⏳ Chờ trang tải ${sec(load)}`);
    await wait(load);
    await page.keyboard.press('Escape'); // popup chào / phím tắt nếu có
    const comment = await pickNearCenter(page, 'svg path[d^="M2 21.5c0-10.22"]', {minSize: 32});
    if (comment && await humanClick(page, comment)) log(TAG, '💬 Mở khung comment');
    else log(TAG, '💬 Không thấy nút comment — bỏ qua');
    const judged = new Set(); // src video đã xét like — nút tim bị vẽ lại sau khi like nên không đánh dấu theo nút được
    let n = 0, lastSrc = null;
    while (alive()) {
        const src = await currentVideoSrc(page);
        if (n && src && src === lastSrc) log(TAG, '⚠️ Vẫn là video cũ — lần cuộn trước không sang được video mới');
        lastSrc = src;
        const watch = Math.random() < 0.1 ? rnd(30_000, 90_000) : rnd(2000, 10_000);
        log(TAG, `${watch > 20_000 ? '😴 Treo' : '👀 Xem'} video #${n + 1}: ${sec(watch)}`);
        await wait(watch);
        // mỗi video chỉ random like 1 lần → không bao giờ bấm lại (bỏ like) nếu chưa sang được video mới
        if (src && judged.has(src)) {
            log(TAG, '🤍 Đã xét like video này — bỏ qua');
        } else {
            const heart = await pickNearCenter(page, 'svg path[d^="M24 9.44c3.2-4.03"]', {minSize: 32, once: true});
            if (!heart) log(TAG, '🤍 Không thấy nút tim (hoặc đã xét ở video này)');
            else if (alive()) {
                if (src) judged.add(src);
                await tryLike(heart);
            }
        }
        if (!alive()) break;
        const pause = rnd(1000, 2500);
        if (Math.random() < 0.5) {
            log(TAG, `⬇️ Phím ↓ sang video tiếp, chờ ${sec(pause)}`);
            await page.keyboard.press('ArrowDown');
        } else {
            const {w, h} = await page.evaluate(() => ({w: innerWidth, h: innerHeight}));
            const dy = rnd(300, 600);
            log(TAG, `🖱️ Lăn chuột ${Math.round(dy)}px sang video tiếp, chờ ${sec(pause)}`);
            await page.mouse.move(w * rnd(0.3, 0.45), h * rnd(0.4, 0.6), {steps: 10});
            await page.mouse.wheel(0, dy);
        }
        n++;
        await wait(pause);
    }
    return n;
}

// B1 cuộn feed tìm post có nút Thích → B2 random like (mỗi post 1 lần) → B3 cuộn tiếp
async function browseFacebook(page, wait, alive, tryLike) {
    await page.goto('https://www.facebook.com/', {waitUntil: 'domcontentloaded', timeout: 60_000});
    const load = rnd(4000, 8000);
    log(TAG, `⏳ Chờ trang tải ${sec(load)}`);
    await wait(load);
    if (/login|checkpoint/.test(page.url())) throw new Error('Chrome profile chưa đăng nhập Facebook');
    const {w, h} = await page.evaluate(() => ({w: innerWidth, h: innerHeight}));
    let n = 0;
    while (alive()) {
        await page.mouse.move(w * rnd(0.35, 0.6), h * rnd(0.3, 0.7), {steps: 12}); // chuột lơ lửng trên post
        const dy = rnd(250, 900), read = Math.random() < 0.1 ? rnd(20_000, 60_000) : rnd(2000, 8000);
        log(TAG, `🖱️ Cuộn #${n + 1} ${Math.round(dy)}px, ${read > 15_000 ? '😴 treo' : '👀 đọc'} ${sec(read)}`);
        await page.mouse.wheel(0, dy);
        n++;
        await wait(read);
        const like = await pickNearCenter(page, '[data-ad-rendering-role="like_button"]',
            {minSize: 20, once: true, labels: ['Thích', 'Like']}); // "Gỡ Thích" = đã like → bỏ qua
        if (like && alive()) await tryLike(like);
    }
    return n;
}

// Lặp: B1 click 1 thẻ video ngẫu nhiên đang hiện → xem → B2 random like → B3 bấm X tắt video → B4 cuộn lưới
async function browseXhs(page, wait, alive, tryLike) {
    await page.goto('https://www.xiaohongshu.com/explore', {waitUntil: 'domcontentloaded', timeout: 60_000});
    const load = rnd(4000, 8000);
    log(TAG, `⏳ Chờ trang tải ${sec(load)}`);
    await wait(load);
    if (!await page.waitForSelector('a.cover', {timeout: 30_000}).catch(() => null))
        throw new Error('Không thấy thẻ bài nào — chưa đăng nhập Xiaohongshu / bị captcha?');
    const {w, h} = await page.evaluate(() => ({w: innerWidth, h: innerHeight}));
    let n = 0;
    while (alive()) {
        const card = await pickRandomVideoCard(page);
        if (!card) {
            log(TAG, '↓ Không có thẻ video mới trên màn hình — cuộn');
        } else if (await humanClick(page, card)) {
            const watch = Math.random() < 0.1 ? rnd(30_000, 90_000) : rnd(3000, 12_000);
            log(TAG, `${watch > 20_000 ? '😴 Treo' : '👀 Xem'} video #${++n}: ${sec(watch)}`);
            await wait(watch);
            const like = alive() && await pickNearCenter(page, '.like-lottie', {minSize: 16, once: true, skip: '.like-active'});
            if (like) await tryLike(like);
            else if (alive()) log(TAG, '🤍 Không thấy nút like (hoặc đã like)');
            const close = await pickNearCenter(page, 'svg:has(use[*|href="#close"])', {minSize: 10});
            if (!(close && await humanClick(page, close))) await page.keyboard.press('Escape');
            log(TAG, '✖️ Tắt video');
            await wait(rnd(1000, 2500));
        }
        if (!alive()) break;
        const dy = rnd(300, 900);
        await page.mouse.move(w * rnd(0.3, 0.7), h * rnd(0.3, 0.7), {steps: 12});
        await page.mouse.wheel(0, dy);
        log(TAG, `🖱️ Cuộn ${Math.round(dy)}px`);
        await wait(rnd(1500, 4000));
    }
    return n;
}

// Thẻ video (a.cover có .play-icon) chưa xem, nằm trọn trong màn hình, chọn ngẫu nhiên → locator, hoặc null
async function pickRandomVideoCard(page) {
    const id = Math.random().toString(36).slice(2);
    const found = await page.evaluate(id => {
        const cards = [...document.querySelectorAll('a.cover')].filter(a => {
            if (a.dataset.nttSeen || !a.querySelector('.play-icon')) return false;
            const r = a.getBoundingClientRect();
            return r.height > 50 && r.top >= 0 && r.bottom <= innerHeight;
        });
        const a = cards[Math.floor(Math.random() * cards.length)];
        if (!a) return false;
        a.dataset.nttSeen = '1';
        a.dataset.nttPick = id;
        return true;
    }, id);
    return found ? page.locator(`[data-ntt-pick="${id}"]`) : null;
}

// src của <video> gần giữa màn hình nhất (định danh video đang xem), hoặc null
const currentVideoSrc = page => page.evaluate(() => {
    let best = null, bestD = Infinity;
    for (const v of document.querySelectorAll('video')) {
        const r = v.getBoundingClientRect();
        if (r.height < 100 || r.bottom < 0 || r.top > innerHeight) continue;
        const d = Math.abs(r.top + r.height / 2 - innerHeight / 2);
        if (d < bestD) best = v, bestD = d;
    }
    return best ? best.currentSrc || best.src || null : null;
}).catch(() => null);

// Phần tử (nút bao ngoài `sel`) đang hiển thị, đủ to, gần giữa màn hình nhất → locator, hoặc null
async function pickNearCenter(page, sel, {minSize = 0, once = false, labels = null, skip = null} = {}) {
    const id = Math.random().toString(36).slice(2);
    const found = await page.evaluate(({sel, minSize, once, labels, skip, id}) => {
        let best = null, bestD = Infinity;
        for (const el of document.querySelectorAll(sel)) {
            const t = el.closest('button,[role="button"]') ?? el;
            if (once && t.dataset.nttSeen) continue;
            if (labels && !labels.includes(t.getAttribute('aria-label'))) continue;
            if (skip && t.closest(skip)) continue; // vd đã like
            const r = t.getBoundingClientRect();
            if (r.width < minSize || r.bottom < 0 || r.top > innerHeight) continue;
            const d = Math.abs(r.top + r.height / 2 - innerHeight / 2);
            if (d < bestD) best = t, bestD = d;
        }
        if (!best) return false;
        if (once) best.dataset.nttSeen = '1';
        best.dataset.nttPick = id;
        return true;
    }, {sel, minSize, once, labels, skip, id});
    return found ? page.locator(`[data-ntt-pick="${id}"]`) : null;
}

async function humanClick(page, loc) {
    const box = await loc.boundingBox().catch(() => null);
    if (!box) return false;
    const x = box.x + box.width * rnd(0.3, 0.7), y = box.y + box.height * rnd(0.3, 0.7);
    await page.mouse.move(x, y, {steps: Math.round(rnd(10, 25))});
    await sleep(rnd(150, 400));
    await page.mouse.click(x, y);
    await sleep(rnd(800, 1500));
    return true;
}
