// B5: Đăng video lên TikTok Studio — port từ fb-crawler/src/core/social/tiktok/Tiktokuploadvideo.js
// Chrome profile phải đã đăng nhập TikTok sẵn (nút "Mở Chrome đăng nhập" trên dashboard).
import {log, logOk, logWarn} from './logger.js';

const TAG = 'B5';
const UPLOAD_URL = 'https://www.tiktok.com/tiktokstudio/upload?from=creator_center';
const UPLOAD_TIMEOUT_MS = 300_000;
const CHECK_TIMEOUT_MS = 300_000;
const POST_CONFIRM_TIMEOUT_MS = 60_000;
const MAX_UPLOAD_RETRY = 3;

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function uploadToTiktok(ctx, filePath, caption) {
    const page = await ctx.newPage();
    try {
        log(TAG, '🌐 Mở TikTok Studio upload');
        await page.goto(UPLOAD_URL, {waitUntil: 'domcontentloaded', timeout: 60_000});
        await sleep(4000);
        if (page.url().includes('/login')) {
            throw new Error('Chrome profile chưa đăng nhập TikTok — bấm "Mở Chrome đăng nhập" trên dashboard');
        }
        await dropVideoWithRetry(page, filePath);
        await dismissTutorialTooltip(page);
        await fillCaption(page, caption);
        await scrollDown(page, 2);
        await waitForVideoCheck(page);
        await clickPostAndConfirm(page);
    } finally {
        await page.close().catch(() => {});
    }
}

async function dropVideoWithRetry(page, filePath) {
    for (let attempt = 1; attempt <= MAX_UPLOAD_RETRY; attempt++) {
        try {
            if (attempt > 1) {
                logWarn(TAG, `Thử lại upload lần ${attempt}/${MAX_UPLOAD_RETRY} — reload trang`);
                await page.reload({waitUntil: 'domcontentloaded', timeout: 30_000});
                await sleep(4000);
            }
            const input = page.locator('input[type="file"]').first();
            await input.waitFor({state: 'attached', timeout: 30_000});
            await input.setInputFiles(filePath);
            log(TAG, '📤 Đã chọn file, chờ upload...');
            await waitForUploadSuccess(page);
            return;
        } catch (err) {
            if (attempt >= MAX_UPLOAD_RETRY) throw new Error(`Upload thất bại sau ${MAX_UPLOAD_RETRY} lần: ${err.message}`);
            logWarn(TAG, `Upload lần ${attempt} lỗi: ${err.message}`);
            await sleep(5000 * attempt);
        }
    }
}

async function waitForUploadSuccess(page) {
    const start = Date.now();
    while (Date.now() - start < UPLOAD_TIMEOUT_MS) {
        const s = await page.evaluate(() => {
            if (document.querySelector('.info-status.success, .info-body [data-icon="CheckCircleFill"]')) return 'ok';
            for (const el of document.querySelectorAll('[class*="info-status"]')) {
                if (/Đã tải lên|Uploaded/i.test(el.textContent)) return 'ok';
            }
            const err = document.querySelector('.info-status.error, [class*="upload-error"], [class*="error-status"]');
            return err ? `error:${err.textContent?.trim()}` : 'pending';
        });
        if (s === 'ok') return logOk(TAG, `Upload xong (${Math.round((Date.now() - start) / 1000)}s)`);
        if (s.startsWith('error:')) throw new Error(`TikTok báo lỗi upload: ${s.slice(6)}`);
        await sleep(3000);
    }
    throw new Error(`Upload quá ${UPLOAD_TIMEOUT_MS / 1000}s`);
}

async function dismissTutorialTooltip(page) {
    const btn = page.locator('.tutorial-tooltip__footer button').first();
    if (await btn.isVisible().catch(() => false)) {
        await btn.click().catch(() => {});
        log(TAG, 'Đã tắt tooltip hướng dẫn');
        await sleep(500);
    }
}

async function fillCaption(page, caption) {
    const editor = page.locator('[data-e2e="caption_container"] .public-DraftEditor-content');
    await editor.waitFor({state: 'visible', timeout: 15_000});
    await editor.click();
    await sleep(400);
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    await sleep(300);
    if (!caption) return;
    for (const ch of caption) await page.keyboard.type(ch, {delay: 30 + Math.random() * 50});
    await sleep(800);
    logOk(TAG, `Caption: ${caption.slice(0, 60)}`);
}

async function scrollDown(page, times) {
    const vp = page.viewportSize() ?? {width: 1520, height: 800};
    await page.mouse.click(vp.width / 2, vp.height / 2);
    for (let i = 0; i < times; i++) {
        await page.mouse.wheel(0, 500);
        await sleep(500);
        await page.keyboard.press('PageDown');
        await sleep(500);
    }
}

async function waitForVideoCheck(page) {
    const start = Date.now();
    while (Date.now() - start < CHECK_TIMEOUT_MS) {
        const s = await page.evaluate(() => {
            for (const state of ['checking', 'success', 'error', 'warn', 'ready']) {
                const el = document.querySelector(`.status-result.status-${state}[data-show="true"]`);
                if (el) return {state, text: el.querySelector('.status-tip')?.textContent?.trim()};
            }
            return {state: 'not_found'};
        });
        if (s.state === 'error') throw new Error(`TikTok kiểm tra video lỗi: ${s.text}`);
        if (s.state === 'warn') return logWarn(TAG, `Kiểm tra video cảnh báo: ${s.text} — vẫn đăng`);
        if (s.state !== 'checking') return log(TAG, `Kiểm tra video: ${s.state}`);
        await sleep(3000);
    }
    logWarn(TAG, 'Kiểm tra video quá lâu — vẫn đăng');
}

// Xác nhận thành công = rời trang /upload (redirect về Studio/profile) hoặc toast thành công
async function clickPostAndConfirm(page) {
    const btn = page.locator('[data-e2e="post_video_button"]');
    await btn.waitFor({state: 'visible', timeout: 15_000});
    await page.waitForFunction(() => {
        const b = document.querySelector('[data-e2e="post_video_button"]');
        return b && b.getAttribute('data-disabled') !== 'true'
            && b.getAttribute('data-loading') !== 'true'
            && b.getAttribute('aria-disabled') !== 'true';
    }, null, {timeout: 60_000});

    const box = await btn.boundingBox();
    if (!box) throw new Error('Không lấy được vị trí nút Đăng');
    const x = box.x + box.width * (0.4 + Math.random() * 0.2);
    const y = box.y + box.height * (0.4 + Math.random() * 0.2);
    await page.mouse.move(x, y, {steps: 15});
    await sleep(150 + Math.random() * 150);
    await page.mouse.click(x, y);
    log(TAG, '🖱️ Đã bấm Đăng, chờ xác nhận...');

    const deadline = Date.now() + POST_CONFIRM_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (!page.url().includes('/upload')) {
            await sleep(5000); // cho TikTok xử lý phía server
            return logOk(TAG, `Đăng thành công → ${page.url()}`);
        }
        if (await page.locator('[class*="success-toast"], [class*="post-success"]').count().catch(() => 0)) {
            return logOk(TAG, 'Đăng thành công (toast)');
        }
        // Popup "Đăng ngay" khi TikTok hỏi lại
        const postNow = page.getByRole('button', {name: /Đăng ngay|Post now/i});
        if (await postNow.isVisible().catch(() => false)) {
            await postNow.click().catch(() => {});
            log(TAG, 'Bấm "Đăng ngay" trên popup xác nhận');
        }
        await sleep(2000);
    }
    throw new Error(`Không xác nhận được đăng thành công sau ${POST_CONFIRM_TIMEOUT_MS / 1000}s`);
}
