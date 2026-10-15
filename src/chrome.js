import fs from 'fs';
import path from 'path';
import {chromium} from 'playwright';

export function findChrome(cfg) {
    const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
    return [cfg.chromePath, ...roots.map(r => path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'))]
        .find(p => p && fs.existsSync(p));
}

// Chấp nhận cả "...\User Data\Profile 1" → user-data-dir = "...\User Data" + --profile-directory
function resolveProfile(dir) {
    const base = path.basename(dir);
    return /^(Default|Profile \d+)$/.test(base)
        ? {userDataDir: path.dirname(dir), args: [`--profile-directory=${base}`]}
        : {userDataDir: dir, args: []};
}

export async function openChrome(cfg) {
    const executablePath = findChrome(cfg);
    if (!executablePath) throw new Error('Không tìm thấy Google Chrome — cài Chrome hoặc nhập đường dẫn chrome.exe');

    const {userDataDir, args} = resolveProfile(cfg.chromeProfileDir || path.join(cfg.dataDir, 'chrome-profile'));
    // Chrome 136+ chặn automation trên "User Data" mặc định, và nó luôn bị Chrome đang mở khoá
    const defaultDir = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data');
    if (defaultDir && path.resolve(userDataDir).toLowerCase() === defaultDir.toLowerCase())
        throw new Error('Không dùng được profile Chrome mặc định (User Data) — để trống ô "Chrome profile" hoặc chọn thư mục riêng, rồi bấm "Mở Chrome đăng nhập"');
    fs.mkdirSync(userDataDir, {recursive: true});

    try {
        return await chromium.launchPersistentContext(userDataDir, {
            executablePath,
            headless: false,
            viewport: null,
            locale: 'vi-VN',
            chromiumSandbox: true,
            ignoreDefaultArgs: ['--enable-automation'],
            args: ['--start-maximized', '--disable-blink-features=AutomationControlled', ...args],
        });
    } catch (e) {
        if (/existing browser session|already in use/i.test(e.message))
            throw new Error(`Profile Chrome đang được mở ở cửa sổ khác — đóng Chrome đang dùng "${userDataDir}" rồi thử lại`);
        throw e;
    }
}
