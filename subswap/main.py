"""Thay phụ đề tiếng Trung bằng phụ đề đã dịch.

  python main.py extract video.mp4 [--roi x,y,w,h | --roi auto] [--fps 4]
  python main.py translate video.mp4 [--mode auto|manual]
  python main.py render video.mp4 [--no-cover]
  python main.py run video.mp4            # tất cả các bước, resume chỗ đã xong
  python main.py cover video.mp4          # chỉ che sub cũ, không chèn sub mới → nosub.mp4 (không có sub: thoát mã 3)
  python main.py watch D:\\crawl\\downloads
  python main.py debug video.mp4 [-n 6]   # ảnh preview ROI + bbox
"""
import argparse
import json
import logging
import sys
import time
from pathlib import Path

import yaml
from tqdm import tqdm

import ocr as ocrmod
import render as rendermod
import translate as tr
import video as vid

HERE = Path(__file__).parent
log = logging.getLogger("subswap")


NO_SUB = 3  # mã thoát của `cover` khi video không có sub


class Waiting(Exception):
    """Pipeline dừng chờ người dịch trả translated.txt."""


def load_config(path):
    cfg = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
    cfg["work_dir"] = (HERE / cfg["work_dir"]).resolve()
    cfg["log_file"] = (HERE / cfg["log_file"]).resolve()
    return cfg


def setup_logging(log_file):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    log_file.parent.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s",
                        handlers=[logging.FileHandler(log_file, encoding="utf-8"), logging.StreamHandler()])
    logging.getLogger("ppocr").setLevel(logging.WARNING)


class Job:
    """Thư mục làm việc + state.json của 1 video."""

    def __init__(self, video, cfg):
        self.video = Path(video).resolve()
        self.cfg = cfg
        self.dir = cfg["work_dir"] / self.video.stem
        self.dir.mkdir(parents=True, exist_ok=True)
        self.state_path = self.dir / "state.json"
        self.state = json.loads(self.state_path.read_text(encoding="utf-8")) if self.state_path.exists() else {"done": []}

    def save(self):
        self.state["video"] = str(self.video)
        self.state_path.write_text(json.dumps(self.state, ensure_ascii=False, indent=2), encoding="utf-8")

    def done(self, step):
        return step in self.state["done"]

    def mark(self, step, **info):
        if step not in self.state["done"]:
            self.state["done"].append(step)
        self.state.update(info)
        self.save()

    def reset_from(self, step):
        order = ["extract", "translate", "render"]
        self.state["done"] = [s for s in self.state["done"] if order.index(s) < order.index(step)]
        self.save()

    @property
    def segments_path(self):
        return self.dir / "segments.json"

    def segments(self):
        return json.loads(self.segments_path.read_text(encoding="utf-8"))["segments"]


# ---------- Bước 0–3 ----------

def step_extract(job, roi_arg=None, fps=None):
    ec, oc = job.cfg["extract"], job.cfg["ocr"]
    meta = vid.probe(job.video)
    log.info("[%s] %dx%d, %.1fs, softsub=%s", job.video.name, meta["width"], meta["height"], meta["duration"], meta["softsub"])

    if meta["softsub"]:
        segs = vid.extract_softsub(job.video, job.dir / "source.srt")
        roi = None
    else:
        fps = fps or ec["fps"]
        roi = resolve_roi(job, meta, roi_arg if roi_arg is not None else ec["roi"])
        segs = []
        for i, r in enumerate(roi):  # mỗi dải (tiêu đề, sub thoại...) là 1 track sub riêng, chạy song song theo thời gian
            segs += ocr_video(job, meta, r, fps, ec, oc, f"_{i}" if len(roi) > 1 else "")
        segs.sort(key=lambda s: (s["start"], s["bbox"][1] if s["bbox"] else 0))
        for i, s in enumerate(segs, 1):
            s["index"] = i

    job.segments_path.write_text(json.dumps({"video": job.video.name, "segments": segs}, ensure_ascii=False, indent=1), encoding="utf-8")
    tr.write_to_translate(segs, job.dir / "to_translate.txt")
    job.mark("extract", meta=meta, roi=roi)
    log.info("[%s] %d đoạn sub → %s", job.video.name, len(segs), job.dir / "to_translate.txt")


_OCR = None


def get_ocr(cfg):
    global _OCR
    if _OCR is None:
        log.info("Khởi tạo PaddleOCR...")
        _OCR = ocrmod.Ocr(cfg["ocr"]["use_gpu"], cfg["ocr"]["model"])
    return _OCR


def resolve_roi(job, meta, roi):
    """→ list ROI [x,y,w,h]. Nhập tay: "x,y,w,h" hoặc nhiều vùng "x,y,w,h;x,y,w,h"."""
    W, H = meta["width"], meta["height"]
    if roi == "auto":
        # frame mẫu không thấy chữ Hán → chưa chắc không có sub: OCR cả khung, toàn bộ video rồi mới kết luận
        return auto_roi(job, meta) or [[0, 0, W - W % 2, H - H % 2]]
    if not roi:
        return [vid.default_roi(W, H, job.cfg["extract"]["roi_bottom_ratio"])]
    if isinstance(roi, str):
        roi = [[int(v) for v in r.split(",")] for r in roi.split(";")]
    elif isinstance(roi[0], int):
        roi = [roi]
    out = []
    for x, y, w, h in roi:
        if x < 0 or y < 0 or w <= 0 or h <= 0 or x + w > W or y + h > H:
            raise SystemExit(f"ROI {[x, y, w, h]} nằm ngoài khung {W}x{H}")
        out.append([x, y, w - w % 2, h - h % 2])
    return out


def auto_roi(job, meta):
    import cv2
    ocr = get_ocr(job.cfg)
    oc = job.cfg["ocr"]
    frames = vid.sample_full_frames(job.video, job.dir / "roi_samples", job.cfg["extract"]["auto_roi_samples"], meta["duration"])
    boxes = [[b for _, _, b in ocrmod.keep_han(ocr.read(cv2.imread(str(f))), oc["min_confidence"])]
             for f in tqdm(frames, desc="Dò ROI", unit="frame")]
    roi = vid.detect_roi(boxes, meta["width"], meta["height"])
    log.info("ROI tự dò: %s (%d box chữ Hán)", roi, sum(map(len, boxes)))
    return roi


def ocr_video(job, meta, roi, fps, ec, oc, tag=""):
    import cv2
    import numpy as np
    with tqdm(total=round(meta["duration"], 1), desc="Cắt frame", unit="s") as bar:
        files = vid.extract_frames(job.video, job.dir / f"frames{tag}", fps, roi, meta["duration"], bar)
    ocr = get_ocr(job.cfg)
    frames, prev_small, prev_lines, skipped = [], None, [], 0
    for i, f in enumerate(tqdm(files, desc="OCR", unit="frame")):
        img = cv2.imread(str(f))
        small = cv2.resize(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), (160, max(int(160 * img.shape[0] / img.shape[1]), 8))).astype(np.int16)
        if prev_small is not None and np.abs(small - prev_small).mean() < ec["dedup_diff"]:
            lines = prev_lines
            skipped += 1
        else:
            lines = ocrmod.keep_han(ocr.read(ocrmod.preprocess(img, ec["preprocess"])), oc["min_confidence"])
            # tọa độ crop → tọa độ khung gốc
            lines = [(t, c, [b[0] + roi[0], b[1] + roi[1], b[2], b[3]]) for t, c, b in lines]
        prev_small, prev_lines = small, lines
        frames.append(ocrmod.frame_entry(i / fps, lines))
    log.info("OCR %d frame vùng %s, bỏ qua %d frame trùng", len(files), roi, skipped)
    (job.dir / f"ocr_frames{tag}.json").write_text(json.dumps(frames, ensure_ascii=False), encoding="utf-8")
    return ocrmod.build_segments(frames, fps, oc["similarity"], oc["max_gap_frames"], oc["min_duration"], oc["min_height_ratio"])


# ---------- Bước 4 ----------

def step_translate(job, mode=None):
    tc = job.cfg["translate"]
    mode = mode or tc["mode"]
    segs = job.segments()
    out = job.dir / "translated.txt"
    if not segs:
        out.write_text("", encoding="utf-8")
    elif mode == "auto" and not out.exists():
        with tqdm(total=len(segs), desc="Dịch", unit="dòng") as bar:
            res = tr.translate_auto(segs, tc["target_lang"], tc["batch_size"], tc["retries"], bar)
        tr.write_pipe_file(res, out)
    elif not out.exists():
        raise Waiting(f"Chờ bản dịch: gửi {job.dir / 'to_translate.txt'} đi dịch, trả về {out} (định dạng index|bản dịch)")
    tr.validate(tr.parse_pipe_file(out), segs)
    job.mark("translate")
    log.info("[%s] bản dịch hợp lệ (%d dòng)", job.video.name, len(segs))


# ---------- Bước 5 ----------

def step_render(job, no_cover=False):
    rc = dict(job.cfg["render"])
    if no_cover:
        rc["cover"] = False
    segs = job.segments()
    trans = tr.parse_pipe_file(job.dir / "translated.txt")
    tr.validate(trans, segs)
    meta = job.state.get("meta") or vid.probe(job.video)
    with tqdm(total=round(meta["duration"], 1), desc="Render", unit="s") as bar:
        out = rendermod.render(job.video, job.dir, segs, trans, meta, rc, bar, softsub=meta["softsub"])
    job.mark("render")
    log.info("[%s] xong → %s", job.video.name, out)


def step_cover(job, args):
    """Chỉ che sub cũ, không chèn sub mới → nosub.mp4. Không tìm thấy sub → trả NO_SUB, không render."""
    if not job.done("extract"):
        step_extract(job, args.roi, args.fps)
    if not job.segments():
        log.info("[%s] không có sub → bỏ qua", job.video.name)
        return NO_SUB
    rc = dict(job.cfg["render"], cover=True)
    meta = job.state["meta"]
    if meta["softsub"]:
        log.info("[%s] sub mềm → chỉ bỏ track sub", job.video.name)
    with tqdm(total=round(meta["duration"], 1), desc="Render", unit="s") as bar:
        out = rendermod.render(job.video, job.dir, job.segments(), None, meta, rc, bar, softsub=meta["softsub"], name="nosub")
    log.info("[%s] xong → %s", job.video.name, out)


def run_all(job, args=None):
    a = vars(args) if args else {}
    if not job.done("extract"):
        step_extract(job, a.get("roi"), a.get("fps"))
    if not job.done("translate"):
        step_translate(job, a.get("mode"))
    if not job.done("render"):
        step_render(job, a.get("no_cover"))


# ---------- Bước 6 ----------

def watch(folder, cfg, mode=None):
    wc = cfg["watch"]
    folder = Path(folder)
    seen = {}  # path → (size, mtime, lần đầu thấy ổn định)
    pending = set()  # job đang chờ bản dịch thủ công
    log.info("Theo dõi %s (Ctrl+C để dừng)", folder)
    while True:
        now = time.time()
        for f in folder.iterdir():
            if f.suffix.lower() not in wc["extensions"] or f.name.endswith(".part.mp4"):
                continue
            st = f.stat()
            key = (st.st_size, st.st_mtime)
            if seen.get(f, (None,))[:2] != key:
                seen[f] = (*key, now)
                continue
            if now - seen[f][2] < wc["stable_seconds"] or f in pending:
                continue
            job = Job(f, cfg)
            if job.done("render") or job.state.get("errors", 0) >= 3:  # lỗi 3 lần → thôi không thử nữa
                continue
            process(job, mode, pending)
        for f in list(pending):  # thử lại job đang chờ dịch khi translated.txt xuất hiện
            job = Job(f, cfg)
            if (job.dir / "translated.txt").exists():
                pending.discard(f)
                process(job, mode, pending)
        time.sleep(wc["poll_seconds"])


def process(job, mode, pending):
    try:
        run_all(job, argparse.Namespace(mode=mode))
    except Waiting as w:
        log.info("[%s] %s", job.video.name, w)
        pending.add(job.video)
    except Exception:
        log.exception("[%s] lỗi, bỏ qua", job.video.name)
        job.state["errors"] = job.state.get("errors", 0) + 1
        job.save()


# ---------- Debug ----------

def debug_preview(job, n):
    import cv2
    meta = job.state.get("meta") or vid.probe(job.video)
    rois = job.state.get("roi") or [vid.default_roi(meta["width"], meta["height"], job.cfg["extract"]["roi_bottom_ratio"])]
    rois = [rois] if isinstance(rois[0], int) else rois
    segs = job.segments() if job.segments_path.exists() else []
    picks = [((s["start"] + s["end"]) / 2, s) for s in segs[:: max(len(segs) // n, 1)][:n]] or \
            [(meta["duration"] * (i + 0.5) / n, None) for i in range(n)]
    out = job.dir / "debug"
    out.mkdir(exist_ok=True)
    for old in out.glob("*.jpg"):
        old.unlink()
    for i, (t, s) in enumerate(picks):
        p = out / f"{i:02d}_{t:.2f}s.jpg"
        vid.run([vid.FFMPEG, "-y", "-v", "error", "-ss", f"{t:.3f}", "-i", job.video, "-frames:v", "1", p])
        img = cv2.imread(str(p))
        for x, y, w, h in rois:
            cv2.rectangle(img, (x, y), (x + w, y + h), (0, 255, 0), 3)
        if s and s.get("bbox"):
            x, y, w, h = s["bbox"]
            cv2.rectangle(img, (x, y), (x + w, y + h), (0, 0, 255), 3)
            cv2.putText(img, f"#{s['index']}", (x, max(y - 10, 20)), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (0, 0, 255), 3)
        cv2.imwrite(str(p), img)
    log.info("Ảnh debug (xanh = ROI, đỏ = bbox đoạn sub) → %s", out)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", default=HERE / "config.yaml")
    ap.add_argument("--work-dir", help="ghi đè work_dir trong config")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("extract", "translate", "render", "run", "cover", "debug"):
        p = sub.add_parser(name)
        p.add_argument("video")
        if name in ("extract", "run", "cover"):
            p.add_argument("--roi", help="x,y,w,h hoặc auto")
            p.add_argument("--fps", type=float)
        if name in ("translate", "run"):
            p.add_argument("--mode", choices=["manual", "auto"])
        if name in ("render", "run"):
            p.add_argument("--no-cover", action="store_true", help="không vẽ ô che sub cũ")
        if name == "debug":
            p.add_argument("-n", type=int, default=6)
    p = sub.add_parser("watch")
    p.add_argument("folder")
    p.add_argument("--mode", choices=["manual", "auto"])
    args = ap.parse_args(argv)

    cfg = load_config(args.config)
    if args.work_dir:
        cfg["work_dir"] = Path(args.work_dir).resolve()
        cfg["log_file"] = cfg["work_dir"] / "subswap.log"
    setup_logging(cfg["log_file"])
    try:
        from dotenv import load_dotenv
        load_dotenv(HERE / ".env")
    except ImportError:
        pass

    try:
        if args.cmd == "watch":
            return watch(args.folder, cfg, args.mode)
        job = Job(args.video, cfg)
        if args.cmd == "extract":
            job.reset_from("extract"); step_extract(job, args.roi, args.fps)
        elif args.cmd == "translate":
            job.reset_from("translate"); step_translate(job, args.mode)
        elif args.cmd == "render":
            step_render(job, args.no_cover)
        elif args.cmd == "run":
            run_all(job, args)
        elif args.cmd == "cover":
            return step_cover(job, args)
        elif args.cmd == "debug":
            debug_preview(job, args.n)
    except Waiting as w:
        log.info(str(w)); return 2
    except tr.TranslationError as e:
        log.error(str(e)); return 1
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
