// Crawler Xiaohongshu / RedNote (B1–B3): mở trang tìm kiếm, chọn ngẫu nhiên 1 thẻ video, click và bắt API feed lấy master_url
import {log, logWarn, setStep} from '../logger.js';

const FEED_API = '/api/sns/web/v1/feed';
const SEARCH_API = '/api/sns/web/v1/search/notes';
const SCANNING = 'đang tìm thẻ video & bắt API feed';
// Timeout từng bước (ms)
const T = {goto: 60_000, search: 30_000, cards: 30_000, click: 15_000, feed: 30_000};

export const name = 'Xiaohongshu';
export const match = url => /(^|\.)(rednote|xiaohongshu)\.com$/i.test(new URL(url).hostname);

// B5: data.items[0].note_card.video.media.stream.h264[0].master_url — không có thì tìm sâu master_url trong note_card
export function extractVideoUrl(json) {
    const card = json?.data?.items?.[0]?.note_card;
    const h264 = card?.video?.media?.stream?.h264?.[0]?.master_url;
    if (h264) return h264;
    const find = node => {
        if (!node || typeof node !== 'object') return null;
        if (typeof node.master_url === 'string' && node.master_url) return node.master_url;
        for (const v of Object.values(node)) { const u = find(v); if (u) return u; }
        return null;
    };
    return find(card);
}

// B2: thẻ video = a.cover có .play-icon; id lấy từ href="/search_result/<id>?..."
const videoIds = page => page.$$eval('a.cover', as => as
    .filter(a => a.querySelector('.play-icon'))
    .map(a => a.getAttribute('href')?.match(/\/search_result\/([0-9a-f]+)/i)?.[1])
    .filter(Boolean));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitApi = (page, api, timeout) => page.waitForResponse(r => r.url().includes(api), {timeout});

// B4: click thẻ → chờ API feed → lấy master_url. Lỗi thì ném kèm lý do để log
async function openNote(page, id) {
    const feed = waitApi(page, FEED_API, T.feed);
    feed.catch(() => {});
    await page.click(`a.cover[href^="/search_result/${id}"]`, {timeout: T.click});
    log('B4', `⏳ Chờ API feed của ${id} (tối đa ${T.feed / 1000}s)`);
    const res = await feed.catch(() => { throw new Error(`quá ${T.feed / 1000}s không thấy API feed`); });
    const json = await res.json().catch(() => { throw new Error(`API feed HTTP ${res.status()} không phải JSON`); });
    if (json?.success === false || (json?.code && json.code !== 0)) throw new Error(`API feed lỗi code=${json.code} msg=${json.msg ?? ''}`);
    const url = extractVideoUrl(json);
    if (!url) throw new Error(`API feed không có master_url (type=${json?.data?.items?.[0]?.note_card?.type ?? '?'})`);
    return url;
}

// Đóng popup note để quay lại lưới; nếu đã chuyển trang thì back
async function closeNote(page) {
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(800);
    if (!await page.$('a.cover')) await page.goBack({waitUntil: 'domcontentloaded', timeout: T.goto}).catch(() => {});
}

// Cùng giao diện với pinterest.js: async generator → {id, url}; bên gọi `break` là đóng tab
export async function* crawl(ctx, url, {isRunning, isKnown = () => false, maxScrolls = 20}) {
    setStep(1, 'running', url);
    const page = await ctx.newPage();
    const seen = new Set();
    try {
        log('B1', `🌐 ${url}`);
        const search = waitApi(page, SEARCH_API, T.search);
        search.catch(() => {});
        await page.goto(url, {waitUntil: 'domcontentloaded', timeout: T.goto});
        log('B1', `⏳ Chờ API tìm kiếm (tối đa ${T.search / 1000}s)`);
        await search.then(() => log('B1', '✔ Đã load API tìm kiếm'),
            () => logWarn('B1', `Quá ${T.search / 1000}s không thấy API ${SEARCH_API} — vẫn thử đọc thẻ trên trang`));
        await page.waitForSelector('a.cover', {timeout: T.cards}).catch(() => {
            throw new Error(`Quá ${T.cards / 1000}s không thấy thẻ bài nào — chưa đăng nhập / bị captcha?`);
        });
        setStep(1, 'ok', url);

        let emptyScrolls = 0;
        while (isRunning()) {
            setStep(2, 'running', SCANNING);
            const fresh = [...new Set(await videoIds(page))].filter(id => !seen.has(id) && !isKnown(id));
            if (!fresh.length) {
                if (emptyScrolls++ >= maxScrolls) {
                    logWarn('B2', `Cuộn ${maxScrolls} lần không thấy video mới (${seen.size} video đã xét) — sang URL khác`);
                    return;
                }
                log('B2', `↓ Không có thẻ video mới — cuộn (${emptyScrolls}/${maxScrolls}), chờ API tìm kiếm`);
                const more = waitApi(page, SEARCH_API, T.search);
                more.catch(() => {});
                await page.bringToFront().catch(() => {});
                await page.mouse.wheel(0, 1200 + Math.random() * 1000);
                await Promise.race([more, sleep(5000)]).catch(() => {});
                await sleep(1000); // chờ Vue vẽ thẻ mới
                continue;
            }
            emptyScrolls = 0;

            // B3: video ngẫu nhiên
            const id = fresh[Math.floor(Math.random() * fresh.length)];
            seen.add(id);
            log('B3', `🎲 Chọn ${id} (${fresh.length} thẻ video mới trên trang)`);
            await sleep(1000 + Math.random() * 2000);
            let videoUrl = null;
            try {
                videoUrl = await openNote(page, id);
            } catch (err) {
                logWarn('B4', `${id}: ${err.message} — thử video khác`);
            }
            await closeNote(page);
            if (!videoUrl) continue;

            log('B3', `🎬 Video mới ${id}`);
            setStep(3, 'ok', `video ${id}`);
            yield {id, url: videoUrl};
        }
    } finally {
        await page.close().catch(() => {});
    }
}
