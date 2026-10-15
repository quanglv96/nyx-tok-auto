// B6: Đăng thước phim lên Facebook qua Meta Business Suite — Chrome profile phải đã đăng nhập Facebook sẵn.
// Class/id của Facebook là động → tìm theo text nút và placeholder.
import {log, logOk} from './logger.js';

const TAG = 'B6';
const CLIPS_URL = 'https://business.facebook.com/latest/posts/all_clips';
const STEP_DELAY_MS = 4000;          // chờ layout load sau mỗi bước
const UPLOAD_TIMEOUT_MS = 300_000;
const SHARE_WAIT_MS = 5 * 60_000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function uploadToFacebook(ctx, filePath, hashtags) {
    const page = await ctx.newPage();
    try {
        // B1
        log(TAG, '🌐 Mở Business Suite → Thước phim');
        await page.goto(CLIPS_URL, {waitUntil: 'domcontentloaded', timeout: 60_000});
        await sleep(STEP_DELAY_MS);
        if (/login|checkpoint/.test(page.url())) {
            throw new Error('Chrome profile chưa đăng nhập Facebook — bấm "Mở Chrome đăng nhập" trên dashboard');
        }

        // B2
        await page.getByText('Tạo thước phim', {exact: true}).first().click({timeout: 30_000});
        await sleep(STEP_DELAY_MS);

        // B3 + B4: "Thêm video" mở hộp chọn file
        const [chooser] = await Promise.all([
            page.waitForEvent('filechooser', {timeout: 30_000}),
            clickButton(page, 'Thêm video'),
        ]);
        await chooser.setFiles(filePath);
        log(TAG, '📤 Đã chọn file, chờ upload...');
        await page.waitForSelector('[role="progressbar"][aria-valuenow="100"]', {timeout: UPLOAD_TIMEOUT_MS});
        logOk(TAG, 'Upload 100%');
        await sleep(STEP_DELAY_MS);

        // B5: nhập từ khoá 1 → Space → từ khoá 2 → Space ... hết thì sang bước 6
        const tags = parseTags(hashtags);
        if (tags.length) {
            // placeholder mất sau từ khoá đầu → chỉ dùng để focus 1 lần, sau đó gõ vào ô đang focus
            await page.locator('input[placeholder^="Thêm từ khóa liên quan"]').click({timeout: 15_000});
            for (const tag of tags) {
                await page.keyboard.type(tag, {delay: 60 + Math.random() * 60});
                await sleep(1000); // chờ Facebook gợi ý
                await page.keyboard.press('Space');
                log(TAG, `Thêm từ khoá: ${tag}`);
                await sleep(1000);
            }
            await sleep(STEP_DELAY_MS);
        }

        // B6, B7
        for (let i = 0; i < 2; i++) {
            await clickButton(page, 'Tiếp');
            await sleep(STEP_DELAY_MS);
        }

        // B8: bấm Chia sẻ, đợi 5 phút cho Facebook xử lý rồi đóng tab
        await clickButton(page, 'Chia sẻ');
        log(TAG, `🖱️ Đã bấm Chia sẻ, đợi ${SHARE_WAIT_MS / 60_000} phút rồi đóng tab...`);
        await sleep(SHARE_WAIT_MS);
        logOk(TAG, 'Đăng Facebook thành công');
    } finally {
        await page.close().catch(() => {});
    }
}

// Hashtag viết liền → tách theo dấu cách / phẩy; có #tag (vd lấy từ caption) thì chỉ lấy các #tag
export function parseTags(text) {
    const words = String(text ?? '').split(/[\s,;]+/).filter(Boolean);
    return words.some(w => w.startsWith('#')) ? words.filter(w => w.startsWith('#')) : words;
}

// Nút cuối cùng đang hiển thị & không bị disable có đúng text (dialog mới luôn nằm sau trong DOM)
async function clickButton(page, name) {
    const btn = page.getByRole('button', {name, exact: true}).filter({visible: true}).last();
    await btn.waitFor({state: 'visible', timeout: 60_000});
    const handle = await btn.elementHandle();
    await page.waitForFunction(el => el.getAttribute('aria-disabled') !== 'true', handle, {timeout: 60_000});
    await btn.click();
    log(TAG, `Bấm "${name}"`);
}
