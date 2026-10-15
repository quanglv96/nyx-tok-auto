"""
Tải video từ link m3u8 (HLS) hoặc link Pinterest / pinimg và lưu thành file .mp4.

Cài đặt (NTT Auto tự làm việc này trong virtualenv riêng khi khởi động):
    pip install -U yt-dlp imageio-ffmpeg
    # imageio-ffmpeg kèm sẵn ffmpeg.exe; nếu không cài thì cần ffmpeg trong PATH

Dùng độc lập:
    python downloader.py <url> <save_path> [filename]
"""
import os
import sys
import time

import yt_dlp
from yt_dlp.utils import DownloadError

sys.stdout.reconfigure(encoding="utf-8")

_last_print = 0.0


def _ffmpeg_location():
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None  # fallback: ffmpeg trong PATH


def _progress(d):
    global _last_print
    if d["status"] == "downloading":
        now = time.time()
        if now - _last_print < 1:
            return
        _last_print = now
        total = d.get("total_bytes") or d.get("total_bytes_estimate")
        done = d.get("downloaded_bytes") or 0
        pct = f"{done * 100 / total:5.1f}%" if total else f"{done / 1048576:.1f}MB"
        speed = (d.get("_speed_str") or "?").strip()
        eta = (d.get("_eta_str") or "?").strip()
        print(f"PROGRESS {pct} | {speed} | ETA {eta}", flush=True)
    elif d["status"] == "finished":
        print("PROGRESS 100% | đang gộp luồng bằng ffmpeg...", flush=True)


def download_video(url, save_path, filename=None):
    """Tải video chất lượng cao nhất về save_path. Trả về đường dẫn .mp4 hoặc None nếu lỗi."""
    os.makedirs(save_path, exist_ok=True)
    name = os.path.splitext(filename)[0] if filename else time.strftime("video_%Y%m%d_%H%M%S")
    output = os.path.join(save_path, name + ".mp4")

    opts = {
        "format": "bestvideo*+bestaudio/best",
        "merge_output_format": "mp4",
        "postprocessors": [{"key": "FFmpegVideoRemuxer", "preferedformat": "mp4"}],
        "outtmpl": os.path.join(save_path, name + ".%(ext)s"),
        "http_headers": {"Referer": "https://www.pinterest.com/"},
        "progress_hooks": [_progress],
        "retries": 10,
        "fragment_retries": 10,
        "socket_timeout": 30,
        "noplaylist": True,
        "overwrites": True,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
    }
    ffmpeg = _ffmpeg_location()
    if ffmpeg:
        opts["ffmpeg_location"] = ffmpeg

    try:
        print(f"Bắt đầu tải: {url}", flush=True)
        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl.download([url])
        if not os.path.isfile(output):
            raise FileNotFoundError(f"không thấy file đầu ra {output}")
        print(f"Hoàn tất: {output} ({os.path.getsize(output) / 1048576:.2f} MB)", flush=True)
        return output
    except DownloadError as e:
        print(f"Lỗi tải (mạng/nguồn): {e}", flush=True)
    except Exception as e:
        print(f"Lỗi không xác định: {e}", flush=True)
    return None


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(2)
    result = download_video(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None)
    if result:
        print(f"SAVED:{result}", flush=True)
    sys.exit(0 if result else 1)
