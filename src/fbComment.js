// FEAT-003: comment link affiliate vào reels đã đăng trên page Facebook (Chrome profile đã đăng nhập).
// Class Facebook là động → tìm theo href /reel/<id>, role và aria-label.
import fs from 'fs';
import path from 'path';
import {log, logOk, logWarn, logError} from './logger.js';

const TAG = 'FBCMT';
const DEFAULT_COUNT = [2, 5];
const DEFAULT_TPL = '{name} 👉 {link}';
const NEW_SIZE = 10;      // "mới" = 10 reel đầu trang
const NEW_RATIO = 0.7;    // ~70% mới / 30% cũ
const STEP_DELAY_MS = 4000;
const HISTORY_FILE = 'commented_reels.json';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const reelId = href => /\/reel\/(\d+)/.exec(href ?? '')?.[1] ?? null;
const sample = (arr, k, rand) => {
    const a = [...arr], out = [];
    while (out.length < k && a.length) out.push(a.splice(Math.floor(rand() * a.length), 1)[0]);
    return out;
};

// "2-5" → [2, 5]; "5-2" → [2, 5]; "3" → [3, 3]; sai → mặc định 2-5
export function parseCount(str) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(String(str ?? ''));
    const a = m && +m[1], b = m && (m[2] ? +m[2] : a);
    if (!a || !b) return [...DEFAULT_COUNT];
    return [Math.min(a, b), Math.max(a, b)];
}

// Thu thập id reel theo thứ tự trên trang (mới → cũ); cuộn tối đa maxScrolls lần, đủ `need` thì dừng sớm
export async function collectReels(page, need, maxScrolls = 3, waitMs = 2500) {
    const ids = [];
    for (let i = 0; ; i++) {
        for (const href of await page.$$eval('a[href*="/reel/"]', as => as.map(a => a.getAttribute('href')))) {
            const id = reelId(href);
            if (id && !ids.includes(id)) ids.push(id);
        }
        if (ids.length >= need || i >= maxScrolls) return ids;
        await page.mouse.wheel(0, 4000);
        await sleep(waitMs);
    }
}

const leftProducts = (id, products, history) => products.filter(p => !(history[id] ?? []).includes(p.link));

// Chọn n reel khả dụng (còn SP chưa comment), ~70% từ nhóm mới, nhóm nào thiếu thì bù từ nhóm kia
export function pickReels(reels, n, history, products, newRatio = NEW_RATIO, newSize = NEW_SIZE, rand = Math.random) {
    const ok = id => leftProducts(id, products, history).length > 0;
    const fresh = reels.slice(0, newSize).filter(ok);
    const old = reels.slice(newSize).filter(ok);
    n = Math.min(n, fresh.length + old.length);
    const nOld = Math.min(old.length, n - Math.min(fresh.length, Math.round(n * newRatio)));
    return [...sample(fresh, n - nOld, rand), ...sample(old, nOld, rand)];
}

// SP ngẫu nhiên chưa comment vào reel; trong cùng lượt ưu tiên SP chưa dùng
export function pickProduct(id, products, history, usedInRun = new Set(), rand = Math.random) {
    const left = leftProducts(id, products, history);
    const unused = left.filter(p => !usedInRun.has(p.link));
    const pool = unused.length ? unused : left;
    return pool.length ? pool[Math.floor(rand() * pool.length)] : null;
}

// Mẫu thiếu {link} thì nối link vào cuối
export function buildComment(tpl, item) {
    const t = tpl || DEFAULT_TPL;
    const text = t.replace(/\{name\}/g, () => item.name).replace(/\{link\}/g, () => item.link).trim();
    return t.includes('{link}') ? text : `${text} ${item.link}`.trim();
}

const historyFile = dataDir => path.join(dataDir, HISTORY_FILE);

// {"<reelId>": ["<link SP>", ...]}; hỏng → rỗng
export function loadHistory(dataDir) {
    const file = historyFile(dataDir);
    if (!fs.existsSync(file)) return {};
    try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (data && typeof data === 'object' && !Array.isArray(data)) return data;
    } catch {}
    logWarn(TAG, `${HISTORY_FILE} hỏng — coi như chưa comment reel nào`);
    return {};
}

export function saveHistory(dataDir, history) {
    const file = historyFile(dataDir);
    fs.mkdirSync(dataDir, {recursive: true});
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(history, null, 2));
    fs.renameSync(`${file}.tmp`, file);
}

// 1 reel: mở → click ô bình luận → gõ → Enter → đóng
export async function commentReel(page, id, text) {
    const link = page.locator(`a[href*="/reel/${id}"]`).first();
    if (await link.count()) await link.click({timeout: 15_000});
    else await page.goto(`https://www.facebook.com/reel/${id}`, {waitUntil: 'domcontentloaded', timeout: 60_000});
    await sleep(STEP_DELAY_MS);
    await page.locator('[role="textbox"][contenteditable="true"][aria-label^="Bình luận"]').first().click({timeout: 30_000});
    await page.keyboard.type(text, {delay: 40 + Math.random() * 60});
    await sleep(1000);
    await page.keyboard.press('Enter');
    await sleep(STEP_DELAY_MS);
    await page.locator('[role="button"][aria-label="Đóng"]').first().click({timeout: 15_000});
    await sleep(2000);
}

// Lỗi ở 1 reel: đóng reel / mở lại trang reels để làm reel kế
async function recover(page, url, stepMs) {
    await page.keyboard.press('Escape').catch(() => {});
    await page.goto(url, {waitUntil: 'domcontentloaded', timeout: 60_000}).catch(() => {});
    await sleep(stepMs);
}

const betweenReels = () => sleep(5000 + Math.random() * 10_000);

// Một lượt: chọn N reel, mỗi reel 1 SP chưa comment; reel lỗi thì bỏ qua, cuối lượt gửi 1 tin tổng hợp reel lỗi
export async function commentReels(ctx, cfg, links, {
    notify = async () => {}, isRunning = () => true, rand = Math.random,
    collect = collectReels, comment = commentReel, wait = betweenReels, stepMs = STEP_DELAY_MS,
} = {}) {
    const result = {done: [], failed: []};
    if (!links?.length) {
        logWarn(TAG, 'link.update rỗng / chưa có — bỏ qua comment link aff');
        return result;
    }
    const url = cfg.fbProfileUrl;
    const [min, max] = parseCount(cfg.fbCommentCount);
    const n = min + Math.floor(rand() * (max - min + 1));
    const page = await ctx.newPage();
    try {
        log(TAG, `🌐 Mở trang reels: ${url}`);
        await page.goto(url, {waitUntil: 'domcontentloaded', timeout: 60_000});
        await sleep(stepMs);
        if (/login|checkpoint/.test(page.url())) throw new Error('Chrome profile chưa đăng nhập Facebook — bấm "Mở Chrome đăng nhập" trên dashboard');
        const maxScrolls = Math.max(0, Number(cfg.fbCommentMaxScrolls) || 3);
        const reels = await collect(page, NEW_SIZE + max * 2, maxScrolls);
        const history = loadHistory(cfg.dataDir);
        const chosen = pickReels(reels, n, history, links, NEW_RATIO, NEW_SIZE, rand);
        if (!chosen.length) {
            logWarn(TAG, `Không có reel khả dụng (tìm thấy ${reels.length} reel, đã comment hết SP)`);
            return result;
        }
        log(TAG, `🎯 Comment ${chosen.length}/${reels.length} reel`);
        const used = new Set();
        for (const id of chosen) {
            if (!isRunning()) break;
            const item = pickProduct(id, links, history, used, rand);
            try {
                await comment(page, id, buildComment(cfg.fbCommentTemplate, item));
                history[id] = [...history[id] ?? [], item.link];
                saveHistory(cfg.dataDir, history);
                used.add(item.link);
                result.done.push(id);
                logOk(TAG, `💬 Reel ${id}: ${item.name}`);
            } catch (err) {
                result.failed.push({id, error: err.message});
                logError(TAG, `Reel ${id} comment lỗi — bỏ qua: ${err.message}`);
                await recover(page, url, stepMs);
            }
            if (id !== chosen.at(-1) && isRunning()) await wait();
        }
    } finally {
        await page.close().catch(() => {});
    }
    if (result.failed.length) {
        await notify(`❌ Comment link aff lỗi ${result.failed.length}/${result.done.length + result.failed.length} reel\n`
            + result.failed.map(f => `Reel ${f.id}: ${f.error}`).join('\n'));
    }
    logOk(TAG, `Xong lượt comment: ${result.done.length} thành công, ${result.failed.length} lỗi`);
    return result;
}
