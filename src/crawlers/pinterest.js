// Crawler Pinterest (B1–B3): mở trang tìm kiếm/board, cuộn và bắt request ApiCResource/create để lấy video
import {log, logWarn, setStep} from '../logger.js';

const API = '/resource/ApiCResource/create/';
const SCANNING = 'đang cuộn & bắt API ApiCResource/create';

export const name = 'Pinterest';
export const match = url => /(^|\.)pinterest\.|^pin\.it$/i.test(new URL(url).hostname);

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

// Async generator → {id, url} của từng video mới. Chỉ cuộn khi bên gọi lấy video tiếp (đang tải/đăng thì đứng yên);
// bên gọi `break` là đóng tab. Cuộn `maxScrolls` lần liền không thấy video mới thì kết thúc.
export async function* crawl(ctx, url, {isRunning, isKnown = () => false, maxScrolls = 20}) {
    setStep(1, 'running', url);
    const page = await ctx.newPage();
    const queue = [];
    const seen = new Set();

    // B2: bắt request ở cấp context (cả sendBeacon / service worker, không cần chờ response)
    // Chỉ bắt khi đang cuộn — lúc tải/đăng/chờ thì bỏ qua (Pinterest vẫn bắn beacon ngầm)
    let apiHits = 0, listening = true;
    const onRequest = req => {
        if (!listening || !req.url().includes(API)) return;
        apiHits++;
        const body = req.postData() ?? '';
        for (const v of extractVideos(new URLSearchParams(body).get('data') ?? body)) {
            if (seen.has(v.id)) continue;
            seen.add(v.id);
            if (isKnown(v.id)) continue;
            queue.push(v);
            log('B3', `🎬 Video mới ${v.id}`);
        }
    };
    ctx.on('request', onRequest);

    try {
        log('B1', `🌐 ${url}`);
        await page.goto(url, {waitUntil: 'domcontentloaded', timeout: 60_000});
        setStep(1, 'ok', url);
        setStep(2, 'running', SCANNING);
        let emptyScrolls = 0;
        while (isRunning()) {
            const v = queue.shift();
            if (v) {
                emptyScrolls = 0;
                setStep(3, 'ok', `video ${v.id} (còn ${queue.length} trong hàng chờ)`);
                listening = false;
                yield v;
                listening = true;
                setStep(2, 'running', SCANNING);
                continue;
            }
            if (emptyScrolls++ >= maxScrolls) {
                logWarn('B2', `Cuộn ${maxScrolls} lần không thấy video mới (bắt được ${apiHits} request ApiCResource, ${seen.size} video) — sang URL khác`);
                return;
            }
            await page.bringToFront().catch(() => {});
            await page.mouse.wheel(0, 1200 + Math.random() * 1000);
            await new Promise(r => setTimeout(r, 3000));
        }
    } finally {
        ctx.off('request', onRequest);
        await page.close().catch(() => {});
    }
}
