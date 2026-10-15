# NTT Auto

Electron app: crawl video Pinterest → tải bằng yt-dlp/ffmpeg → đăng TikTok Studio bằng Playwright (Chrome thật) → báo Telegram `[TIKTOK]`.

## Luồng
| Bước | Việc                                                                                                                              |
|---|-----------------------------------------------------------------------------------------------------------------------------------|
| B1 | Mở lần lượt từng URL Pinterest trong cấu hình                                                                                     |
| B2 | Bắt các request `.../logo/resource/ApiCResource/create/` (đọc cả response và request body)                                         |
| B3 | Lấy `options.events[].event_data.videoUrl` + `object_id_str`, bỏ id đã có trong `crawled_ids.txt`                                 |
| B4 | `src/python/downloader.py` (yt-dlp + ffmpeg, best quality, gộp HLS → .mp4). Lỗi → quay lại B3 lấy video khác, id lỗi vẫn được lưu |
| B4b | `src/transform.js` — ffmpeg biến đổi video, các tuỳ chọn kết hợp tự do (xoay+zoom, màu, FPS, audio pitch + bố cục gốc / split-screen / PiP reaction), xuất 1080x1920 libx264 CRF 20 + AAC. Lỗi → bỏ video, không đăng bản gốc. Thử trước ở tab "Test chỉnh sửa video" (file ra `<thư mục dữ liệu>/test`) |
| B5 | Upload lên `tiktok.com/tiktokstudio/upload` (logic port từ fb-crawler)                                                            |
| B6 | `src/facebook.js` — đăng thước phim qua `business.facebook.com/latest/posts/all_clips` (chạy dù TikTok thành công/thất bại, tắt bằng ô "Đăng thước phim Facebook") |
| B7 | Telegram cho admin kết quả từng nền tảng → xoá file .mp4                                                                          |

## Lịch đăng
Bật "Chỉ đăng trong các khung giờ", nhập ví dụ `08:00-09:00, 12:00-13:00, 20:00-21:30`. Mỗi khung đăng **1 video** vào một phút ngẫu nhiên trong khung (`20:00` = đúng giờ). Video được crawl + tải sẵn, tới giờ hẹn mới đăng; app mở giữa khung thì random trong phần còn lại, hết khung hôm nay thì sang hôm sau.

## Thư mục dữ liệu (chọn trên dashboard)
```
<dataDir>/
  crawled_ids.txt   # mọi id đã xử lý (thành công + lỗi), không bao giờ xoá
  videos/           # video đang chờ đăng (xoá sau khi đăng xong)
  logs/YYYY-MM-DD.log
  chrome-profile/   # profile Chrome mặc định
```

## Môi trường (tự kiểm tra mỗi lần mở app)
1. Python 3.9+ (không có → tự cài Python 3.12 qua `winget`)
2. Virtualenv riêng trong `%APPDATA%/ntt-auto/pyenv`
3. `pip install -U yt-dlp imageio-ffmpeg` (imageio-ffmpeg kèm sẵn ffmpeg.exe)
4. Google Chrome

Chạy downloader độc lập:
```
pip install -U yt-dlp imageio-ffmpeg
python src/python/downloader.py "<url .m3u8 / pinimg / pinterest>" "D:/Videos/Cats" [ten_file]
```

## Lần đầu sử dụng
1. Chọn thư mục dữ liệu, nhập URL Pinterest, Telegram bot token + admin → **Lưu**.
2. **Mở Chrome đăng nhập** → đăng nhập **Pinterest** (chưa đăng nhập thì Pinterest không bắn event video) và **TikTok** → đóng Chrome.
3. Admin Telegram nhắn `/start` cho bot (nếu dùng username thay vì chat id) → **Test Telegram**.
4. **Bắt đầu**.

## Dev / Release
```
npm install
npm start
npm test
```
Release: tăng `version` trong `package.json`, push tag `vX.Y.Z` → GitHub Actions build NSIS và publish lên `quanglv96/nyx-tok-auto`. App đã cài sẽ tự kiểm tra bản mới khi khởi động:
- Chỉ sửa code (`dependencies` + bản Electron giữ nguyên) → chỉ tải `code.tgz` (vài KB) vào `%APPDATA%/NTT Auto/code/<version>`, khởi động lại là chạy bản mới. Python/venv/Chrome profile không bị cài lại.
- Đổi `dependencies` hoặc Electron → tải bộ cài NSIS đầy đủ (electron-updater).
