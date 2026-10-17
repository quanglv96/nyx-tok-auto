import {app} from 'electron';
import fs from 'fs';
import path from 'path';

// userData/config.json chỉ giữ dataDir; mọi cấu hình khác nằm ở <dataDir>/.env
const pointerFile = () => path.join(app.getPath('userData'), 'config.json');
const envFile = dataDir => path.join(dataDir, '.env');
const envKey = k => k.replace(/[A-Z]/g, '_$&').toUpperCase(); // videosPerUrl → VIDEOS_PER_URL

const defaults = () => ({
    dataDir: path.join(app.getPath('documents'), 'NTT Auto'),
    pinterestEnabled: true,
    searchUrls: 'https://www.pinterest.com/search/videos/?q=mèo+cute&rs=content_type_filter&filter_location=1\nhttps://www.pinterest.com/search/pins/?q=m%C3%A8o+h%C3%A0i%20h%C6%B0%E1%BB%9Bc&rs=typed', // URL Pinterest (giữ tên cũ để không mất cấu hình)
    xhsEnabled: true,
    xhsUrls: '',           // URL Xiaohongshu / RedNote, mỗi dòng 1 URL
    chromePath: '',        // trống = tự tìm chrome.exe
    chromeProfileDir: '',  // trống = <dataDir>/chrome-profile
    caption: '#meo #cute #fyp',
    tiktokEnabled: true,   // tắt để test riêng Facebook
    fbEnabled: true,       // đăng thước phim Facebook (sau TikTok nếu bật, dù TikTok lỗi)
    fbHashtags: '',        // trống = dùng hashtag trong caption
    videosPerUrl: 3,
    delayMinutes: 15,
    maxScrolls: 20,
    autoStart: true,       // khởi động cùng Windows
    autoRun: false,        // mở app là tự bấm Bắt đầu
    scheduleEnabled: true,
    scheduleTimes: '05:00-06:00, 12:00-13:00, 20:00-21:00', // tick theo giờ trên UI, mỗi khung 1 video
    humanEnabled: true,    // lúc chờ thỉnh thoảng lướt TikTok/Facebook như người thật (src/human.js)
    humanTiktok: true,     // được lướt TikTok (độc lập với tích chọn đăng)
    humanFacebook: true,   // được lướt Facebook
    humanXhs: false,       // được lướt Xiaohongshu (RedNote)
    humanLikeRate: 10,     // % video/post được like, tối đa 3 like / phiên
    humanTimes: '08:00-09:00, 11:00-12:00, 15:00-16:00, 21:00-22:00', // tick theo giờ trên UI, mỗi khung 1 phiên
    humanMinutes: '3-12',  // thời lượng mỗi phiên (phút)
    // Xử lý video bằng ffmpeg — các tuỳ chọn kết hợp tự do (xem src/transform.js)
    tfRandom: true,        // mỗi video random ≥1 hiệu ứng trong các ô đã tick (không tick = tất cả)
    tfRotate: false,
    tfColor: false,
    tfFps: false,
    tfAudio: false,
    tfPip: false,          // reaction đè góc trên phải — kết hợp được với mọi tuỳ chọn khác
    reactionPath: '',      // PiP: file reaction hoặc thư mục (chọn ngẫu nhiên)
    telegramToken: '',
    telegramAdmin: '',     // chat id hoặc username (admin phải /start bot trước)
});

const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };

// Giá trị ghi dạng JSON (chuỗi có ngoặc kép, giữ được xuống dòng); sửa tay không ngoặc vẫn đọc được
function readEnv(dataDir, keys) {
    let text = '';
    try { text = fs.readFileSync(envFile(dataDir), 'utf8'); } catch { return {}; }
    const byEnv = Object.fromEntries(keys.map(k => [envKey(k), k]));
    const cfg = {};
    for (const line of text.split(/\r?\n/)) {
        const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
        if (!m || !byEnv[m[1]]) continue;
        try { cfg[byEnv[m[1]]] = JSON.parse(m[2]); } catch { cfg[byEnv[m[1]]] = m[2]; }
    }
    return cfg;
}

export function loadConfig() {
    const def = defaults();
    const pointer = readJson(pointerFile()); // config.json cũ (đủ trường) vẫn được dùng làm nền → tự chuyển sang .env khi lưu
    const dataDir = pointer.dataDir || def.dataDir;
    return {...def, ...pointer, ...readEnv(dataDir, Object.keys(def)), dataDir};
}

export function saveConfig(cfg) {
    const {dataDir, ...rest} = {...loadConfig(), ...cfg};
    fs.mkdirSync(dataDir, {recursive: true});
    fs.writeFileSync(envFile(dataDir), Object.entries(rest).map(([k, v]) => `${envKey(k)}=${JSON.stringify(v)}`).join('\n') + '\n');
    fs.writeFileSync(pointerFile(), JSON.stringify({dataDir}, null, 2));
}
