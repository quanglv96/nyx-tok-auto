# subswap — thay phụ đề tiếng Trung bằng phụ đề đã dịch

```
video ─► [0] ffmpeg -i: softsub? ──có──► trích .srt ─────────────┐
              │ không (hardsub)                                │
              ▼                                                ▼
         [1] ffmpeg cắt frame vùng ROI (4 fps) ─► [2] PaddleOCR ─► gom đoạn ─► [3] segments.json + to_translate.txt
                                                                                   │
                     [4] manual: chờ translated.txt  /  auto: Claude API ◄─────────┘
                                                                                   │
                     [5] sub.ass = ô che sub cũ (bbox, đúng thời gian từng câu) + sub mới → burn ─► output.mp4
```

## Cài đặt (Windows)

1. **FFmpeg**: `winget install Gyan.FFmpeg` (hoặc tải bản *full_build* từ gyan.dev, giải nén, thêm thư mục `bin` vào PATH). Kiểm tra: `ffmpeg -version`. Có thể chỉ định ffmpeg khác qua biến môi trường `FFMPEG`.
2. **Python 3.10–3.12**: paddlepaddle chưa hỗ trợ 3.13+. `winget install Python.Python.3.11`.
3. Môi trường + thư viện:
   ```powershell
   cd subswap
   py -3.11 -m venv .venv
   .venv\Scripts\activate
   pip install -r requirements.txt
   ```
   **GPU NVIDIA** (tùy chọn): gỡ `paddlepaddle`, cài bản GPU theo hướng dẫn tại paddlepaddle.org.cn (chọn đúng CUDA), ví dụ
   `pip install paddlepaddle-gpu==3.3.1 -i https://www.paddlepaddle.org.cn/packages/stable/cu126/`, rồi đặt `ocr.use_gpu: true` trong `config.yaml`.
4. Lần chạy đầu PaddleOCR tự tải model (~100 MB) về `%USERPROFILE%\.paddlex\official_models`.
5. Dịch tự động: `copy .env.example .env` rồi điền `ANTHROPIC_API_KEY`.

## Dùng

```powershell
python main.py extract video.mp4                 # bước 0–3 → work\video\to_translate.txt
python main.py extract video.mp4 --roi auto      # tự dò vùng sub, được nhiều vùng (tiêu đề + thoại)
python main.py extract video.mp4 --roi "0,1400,1080,400;0,100,1080,300"   # 1 hoặc nhiều vùng
python main.py debug video.mp4                   # ảnh work\video\debug\*.jpg: xanh = ROI, đỏ = bbox sub
python main.py translate video.mp4 --mode auto   # hoặc tự đặt work\video\translated.txt rồi chạy --mode manual
python main.py render video.mp4                  # --no-cover: không vẽ ô che
python main.py cover video.mp4                   # chỉ che sub cũ → workideo
osub.mp4
python main.py run video.mp4                     # cả chuỗi, bỏ qua bước đã xong (state.json)
python main.py watch D:\crawl\downloads --mode auto
```

Mã thoát: `0` xong, `1` lỗi bản dịch, `2` đang chờ `translated.txt`, `3` (`cover`) video không có sub, không render.

**Định dạng file dịch**: mỗi dòng `index|bản dịch`, UTF‑8. Thiếu, thừa hoặc trùng index, hay dòng rỗng đều bị báo lỗi kèm danh sách index.

**Chạy lại**: `extract` / `translate` khi gọi riêng luôn làm lại (và đánh dấu các bước sau là chưa xong). `run` / `watch` chỉ làm các bước chưa xong. Muốn làm lại từ đầu thì xóa `work\<tên_video>`.

## Thư mục làm việc

```
work/<tên_video>/
  frames/            frame ROI đã cắt (jpg)
  ocr_frames.json    kết quả OCR từng frame (để soi khi gom đoạn sai)
  segments.json      {video, segments:[{index,start,end,text,bbox}]}
  to_translate.txt   index|text
  translated.txt     index|bản dịch
  sub.ass, filter.txt
  output.mp4
  state.json         các bước đã xong, meta video, ROI
work/subswap.log
```

## Tích hợp NTT Auto

App lưu video vào `<dataDir>/videos` và **xóa file sau khi đăng**. Có hai cách:
- `watch` một thư mục riêng mà bạn copy video vào, rồi lấy `work\*\output.mp4` đi đăng; hoặc
- tắt đăng tự động, để `watch <dataDir>\videos` chạy xong mới đăng.

`watch` chỉ xử lý file có kích thước + mtime không đổi ≥ `watch.stable_seconds`. File lỗi được thử lại tối đa 3 lần (đếm trong `state.json`).

## Tinh chỉnh (`config.yaml`)

| Vấn đề | Chỉnh |
|---|---|
| Bỏ sót sub / sub nằm chỗ khác | `debug`, rồi `--roi x,y,w,h` hoặc `--roi auto` |
| Một câu bị tách thành nhiều đoạn | giảm `ocr.similarity` (0.7), tăng `max_gap_frames` |
| Hai câu liền nhau bị gộp | tăng `ocr.similarity` (0.9), tăng `extract.fps` |
| Lẫn watermark / chữ nền | tăng `min_height_ratio`, thu hẹp ROI |
| Mất sub có cỡ chữ nhỏ hơn hẳn | `min_height_ratio: 0` |
| OCR chậm | `ocr.model: tiny`, giảm `fps` xuống 3 |
| OCR sai chữ | `ocr.model: medium` (chậm hơn ~5 lần trên CPU), thử `preprocess: none` |
| Ô che hở chữ cũ | tăng `cover_pad`, `cover_opacity: 1` |

## Kiểm tra

`python test_logic.py`: gom đoạn, validate bản dịch, thứ tự dòng OCR, filter che (không cần video/model).
