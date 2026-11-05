// FEAT-003: danh sách link affiliate (tên SP + link Shopee) crawl từ Beacons → <dataDir>/link.update
// Khởi động app: chưa có file / file hỏng / cũ hơn 24h thì crawl lại; lỗi hoặc 0 link thì giữ file cũ.
import fs from 'fs';
import path from 'path';
import {chromium} from 'playwright';
import {findChrome} from './chrome.js';
import {log, logOk, logWarn, logError} from './logger.js';

const TAG = 'AFF';
const BEACONS_URL = 'https://beacons.ai/pinmeow';
const FILE = 'link.update';
const DAY_MS = 86_400_000;

const ENT = {amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' '};
const decode = s => s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e) => ENT[e]).trim();

export const linksFile = dataDir => path.join(dataDir, FILE);

// Mỗi nút link (thẻ <a> MUI Button) → {link: href, name: text .text-sm-normal}; thiếu href/name thì bỏ, trùng link thì bỏ
export function parseBeacons(html) {
    const out = [];
    const seen = new Set();
    for (const [a] of String(html ?? '').matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/gi)) {
        if (!/^<a\b[^>]*class="[^"]*\bMuiButton-root\b/i.test(a)) continue;
        const link = decode(/^<a\b[^>]*\bhref="([^"]*)"/i.exec(a)?.[1] ?? '');
        const name = decode(/class="[^"]*\btext-sm-normal\b[^"]*"[^>]*>([^<]*)</i.exec(a)?.[1] ?? '');
        if (!/^https?:\/\//i.test(link) || !name || seen.has(link)) continue;
        seen.add(link);
        out.push({link, name});
    }
    return out;
}

const readFile = file => {
    try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        return Array.isArray(data?.items) ? data : null;
    } catch {
        return null;
    }
};

// Chưa có / hỏng / rỗng / cũ hơn 24h → cần crawl lại
export function needRefresh(file, now = Date.now()) {
    const data = readFile(file);
    return !data?.items.length || !(now - Date.parse(data.updatedAt) < DAY_MS);
}

export const loadLinks = dataDir => readFile(linksFile(dataDir))?.items ?? [];

// Crawl Beacons bằng ctx (Playwright BrowserContext) → ghi link.update. Lỗi / 0 link: giữ file cũ, trả null.
export async function refreshLinks(ctx, dataDir, url = BEACONS_URL) {
    let page;
    try {
        page = await ctx.newPage();
        log(TAG, `🌐 Mở ${url}`);
        await page.goto(url, {waitUntil: 'domcontentloaded', timeout: 60_000});
        await page.waitForSelector('a .text-sm-normal', {timeout: 30_000}).catch(() => {});
        const items = parseBeacons(await page.content());
        if (!items.length) throw new Error('không tìm thấy link sản phẩm nào');
        fs.mkdirSync(dataDir, {recursive: true});
        const file = linksFile(dataDir);
        fs.writeFileSync(`${file}.tmp`, JSON.stringify({updatedAt: new Date().toISOString(), items}, null, 2));
        fs.renameSync(`${file}.tmp`, file); // ghi file tạm rồi đổi tên → tắt giữa chừng không hỏng file cũ
        logOk(TAG, `🔗 Đã cập nhật ${items.length} link affiliate → ${file}`);
        return items;
    } catch (err) {
        logError(TAG, `Crawl link affiliate lỗi (giữ file cũ): ${err.message}`);
        return null;
    } finally {
        await page?.close().catch(() => {});
    }
}

// Gọi lúc khởi động (chạy nền): Chrome headless riêng, không đụng Chrome profile của pipeline
export async function refreshOnStartup(cfg) {
    if (!needRefresh(linksFile(cfg.dataDir))) return log(TAG, '🔗 link.update còn mới (<24h) — không crawl lại');
    const executablePath = findChrome(cfg);
    if (!executablePath) return logWarn(TAG, 'Không tìm thấy Chrome — bỏ qua cập nhật link affiliate');
    let browser;
    try {
        browser = await chromium.launch({executablePath, headless: true});
        await refreshLinks(await browser.newContext({locale: 'vi-VN'}), cfg.dataDir);
    } catch (err) {
        logError(TAG, `Không mở được Chrome để crawl link affiliate: ${err.message}`);
    } finally {
        await browser?.close().catch(() => {});
    }
}
