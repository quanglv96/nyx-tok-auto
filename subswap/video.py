"""Bước 0–1: đọc thông tin video, trích softsub, cắt frame vùng sub, tự dò ROI."""
import logging
import os
import re
import subprocess
from pathlib import Path

log = logging.getLogger(__name__)
TEXT_SUB_CODECS = {"subrip", "ass", "ssa", "mov_text", "webvtt", "text"}
FFMPEG = os.getenv("FFMPEG") or "ffmpeg"  # app NTT Auto truyền ffmpeg của imageio-ffmpeg (không kèm ffprobe)


def run(cmd, **kw):
    log.debug("RUN %s", " ".join(map(str, cmd)))
    r = subprocess.run(list(map(str, cmd)), capture_output=True, text=True, encoding="utf-8", errors="replace", **kw)
    if r.returncode:
        raise RuntimeError(f"{cmd[0]} lỗi ({r.returncode}): {r.stderr[-2000:]}")
    return r.stdout


def probe(video):
    """Đọc từ log `ffmpeg -i` thay vì ffprobe (bản ffmpeg của app không có ffprobe)."""
    out = subprocess.run([FFMPEG, "-hide_banner", "-i", str(video)], capture_output=True, text=True,
                         encoding="utf-8", errors="replace").stderr
    return parse_probe(out)


def parse_probe(out):
    v = re.search(r"Stream #\S+.*?: Video: .*?, (\d{2,5})x(\d{2,5})", out)
    if not v:
        raise RuntimeError(f"Không đọc được luồng video:\n{out[-1500:]}")
    w, h = int(v.group(1)), int(v.group(2))
    # video điện thoại quay dọc: lưu ngang + metadata xoay, ffmpeg tự xoay khi decode → đổi w/h
    rot = re.search(r"rotation of (-?[\d.]+) degrees|rotate\s*:\s*(-?\d+)", out)
    if rot and round(abs(float(rot.group(1) or rot.group(2)))) % 180 == 90:
        w, h = h, w
    d = re.search(r"Duration: (\d+):(\d+):([\d.]+)", out)
    subs = re.findall(r"Stream #\S+.*?: Subtitle: (\w+)", out)
    fps = re.search(r"Stream #\S+.*?: Video: .*?, ([\d.]+) (?:fps|tbr)", out)
    return {
        "width": w, "height": h, "fps": float(fps.group(1)) if fps else 30.0,
        "duration": int(d.group(1)) * 3600 + int(d.group(2)) * 60 + float(d.group(3)) if d else 0.0,
        # sub dạng ảnh (PGS/DVD) không ra .srt được → coi như hardsub
        "softsub": any(c in TEXT_SUB_CODECS for c in subs),
    }


def extract_softsub(video, out_srt):
    run([FFMPEG, "-y", "-v", "error", "-i", video, "-map", "0:s:0", out_srt])
    return parse_srt(Path(out_srt).read_text(encoding="utf-8", errors="replace"))


def parse_srt(text):
    def sec(t):
        h, m, s = t.replace(",", ".").split(":")
        return int(h) * 3600 + int(m) * 60 + float(s)
    segs = []
    for block in re.split(r"\n\s*\n", text.strip()):
        lines = block.strip().splitlines()
        tl = next((i for i, l in enumerate(lines) if "-->" in l), None)
        if tl is None:
            continue
        a, b = (x.strip().split()[0] for x in lines[tl].split("-->"))
        body = " ".join(re.sub(r"<[^>]+>|\{[^}]*\}", "", l).strip() for l in lines[tl + 1:]).strip()
        if body:
            segs.append({"index": len(segs) + 1, "start": round(sec(a), 3), "end": round(sec(b), 3), "text": body, "bbox": None})
    return segs


def default_roi(width, height, ratio):
    h = int(height * ratio)
    return [0, height - h, width, h]


def extract_frames(video, frames_dir, fps, roi, duration=0, progress=None):
    """Cắt frame vùng ROI ra jpg. Frame thứ i (từ 0) ứng với thời điểm i/fps."""
    x, y, w, h = roi
    frames_dir = Path(frames_dir)
    frames_dir.mkdir(parents=True, exist_ok=True)
    for f in frames_dir.glob("*.jpg"):
        f.unlink()
    cmd = [FFMPEG, "-y", "-v", "error", "-progress", "pipe:1", "-i", video,
           "-vf", f"fps={fps},crop={w}:{h}:{x}:{y}", "-q:v", "2", frames_dir / "%06d.jpg"]
    run_with_progress(cmd, duration, progress)
    return sorted(frames_dir.glob("*.jpg"))


def run_with_progress(cmd, duration, progress, cwd=None):
    p = subprocess.Popen(list(map(str, cmd)), cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    done = 0.0
    for line in p.stdout:
        k, _, v = line.strip().partition("=")
        if k == "out_time_us" and v.isdigit() and duration and progress:
            t = min(int(v) / 1e6, duration)
            progress.update(t - done)
            done = t
    err = p.stderr.read()
    if p.wait():
        raise RuntimeError(f"ffmpeg lỗi: {err[-2000:]}")
    if progress and duration:
        progress.update(max(duration - done, 0))


def sample_full_frames(video, out_dir, n, duration):
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    for f in out_dir.glob("*.jpg"):
        f.unlink()
    rate = n / max(duration, 1)
    run([FFMPEG, "-y", "-v", "error", "-i", video, "-vf", f"fps={rate}", "-frames:v", n, "-q:v", "2", out_dir / "%04d.jpg"])
    return sorted(out_dir.glob("*.jpg"))


def detect_roi(frame_boxes, width, height, pad_ratio=0.02, min_share=0.3):
    """frame_boxes: [[bbox chữ Hán] mỗi frame mẫu]. → list ROI (dải ngang full chiều rộng), mỗi dải là nơi chữ
    xuất hiện ở ≥ min_share số frame mẫu (vd. tiêu đề cố định phía trên + sub thoại phía dưới)."""
    step = height * 0.05
    bins = {}  # bin tâm y → [box]
    hits = {}  # bin → số frame có chữ ở bin đó
    for boxes in frame_boxes:
        ks = set()
        for b in boxes:
            k = int((b[1] + b[3] / 2) // step)
            bins.setdefault(k, []).append(b)
            ks.add(k)
        for k in ks:
            hits[k] = hits.get(k, 0) + 1
    if not hits:
        return []
    need = max(2, min_share * len(frame_boxes)) if len(frame_boxes) > 2 else 1
    # gộp bin kề nhau (dòng chữ 2 hàng có tâm rơi vào 2 bin) trước khi đếm frame
    keep = sorted(k for k in hits if hits[k] + hits.get(k - 1, 0) + hits.get(k + 1, 0) >= need)
    groups = []
    for k in keep:
        if groups and k - groups[-1][-1] <= 2:
            groups[-1].append(k)
        else:
            groups.append([k])
    pad = int(height * pad_ratio)
    rois = []
    for g in groups:
        band = [b for k in g for b in bins[k]]
        top = max(min(b[1] for b in band) - pad, 0)
        bottom = min(max(b[1] + b[3] for b in band) + pad, height)
        if rois and top <= rois[-1][1] + rois[-1][3]:  # chồng nhau → gộp
            top = rois.pop()[1]
        top -= top % 2
        rois.append([0, top, width, (bottom - top) // 2 * 2])
    return rois
