"""Bước 1b–2: tiền xử lý ảnh, OCR PaddleOCR, gom frame thành đoạn sub."""
import logging
import re
from collections import Counter
from difflib import SequenceMatcher

log = logging.getLogger(__name__)
HAN = re.compile(r"[㐀-鿿豈-﫿]")


def similar(a, b):
    # ponytail: difflib ≈ Levenshtein ratio, đủ cho câu sub ngắn; đổi sang rapidfuzz nếu cần tốc độ
    return SequenceMatcher(None, a, b).ratio() if a and b else 0.0


class Ocr:
    def __init__(self, use_gpu=False, model="small"):
        import os
        os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
        from paddleocr import PaddleOCR
        self.engine = PaddleOCR(text_detection_model_name=f"PP-OCRv6_{model}_det",
                                text_recognition_model_name=f"PP-OCRv6_{model}_rec",
                                device="gpu" if use_gpu else "cpu",
                                use_doc_orientation_classify=False, use_doc_unwarping=False,
                                use_textline_orientation=False,
                                enable_mkldnn=False)  # paddle 3.3 + oneDNN lỗi ConvertPirAttribute trên Windows

    def read(self, img):
        """→ [(text, conf, [x,y,w,h])] cho ảnh numpy BGR/gray."""
        import numpy as np
        if img.ndim == 2:
            img = np.stack([img] * 3, axis=-1)
        out = []
        for res in self.engine.predict(img):
            for text, conf, box in zip(res["rec_texts"], res["rec_scores"], res["rec_boxes"]):
                x1, y1, x2, y2 = map(int, box)
                out.append((text, float(conf), [x1, y1, x2 - x1, y2 - y1]))
        return out


def preprocess(img, mode):
    import cv2
    if mode == "none":
        return img
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    g = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(g)
    if mode == "binary":
        _, g = cv2.threshold(g, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    return g


def keep_han(lines, min_conf):
    return [l for l in lines if l[1] >= min_conf and HAN.search(l[0])]


def frame_entry(t, lines):
    """Gộp các dòng trong 1 frame (trên → dưới) thành 1 text + bbox hợp."""
    if not lines:
        return {"t": t, "text": "", "conf": 0.0, "bbox": None}
    # OCR có thể tách 1 dòng sub thành nhiều box → gom theo hàng (tâm y gần nhau), trong hàng xếp trái → phải
    rows = []
    for l in sorted(lines, key=lambda l: l[2][1] + l[2][3] / 2):
        cy = l[2][1] + l[2][3] / 2
        if rows and abs(cy - rows[-1]["cy"]) < l[2][3] / 2:
            rows[-1]["items"].append(l)
        else:
            rows.append({"cy": cy, "items": [l]})
    text = " ".join("".join(l[0].strip() for l in sorted(r["items"], key=lambda l: l[2][0])) for r in rows)
    xs = [l[2][0] for l in lines]; ys = [l[2][1] for l in lines]
    x2 = [l[2][0] + l[2][2] for l in lines]; y2 = [l[2][1] + l[2][3] for l in lines]
    return {"t": t, "text": text,
            "conf": sum(l[1] for l in lines) / len(lines),
            "bbox": [min(xs), min(ys), max(x2) - min(xs), max(y2) - min(ys)]}


def build_segments(frames, fps, sim=0.8, max_gap=2, min_dur=0.3, min_height_ratio=0.6):
    """frames: [{t, text, conf, bbox}] theo thời gian → [{index,start,end,text,bbox}]."""
    step = 1 / fps
    raw = []
    for f in frames:
        if not f["text"]:
            continue
        cur = raw[-1] if raw else None
        if cur and f["t"] - cur["last"] <= (max_gap + 1) * step + 1e-6 and similar(f["text"], cur["ref"]) >= sim:
            cur["frames"].append(f); cur["last"] = f["t"]
        else:
            raw.append({"frames": [f], "last": f["t"], "ref": f["text"]})

    segs = [_finalize(r["frames"], step) for r in raw]
    # Chữ thấp hơn hẳn cỡ sub chung (watermark, ID, chữ nền) → bỏ.
    # ponytail: dùng trung vị chiều cao bbox đoạn; video 2 cỡ sub khác nhau thì cần tắt (min_height_ratio=0)
    heights = sorted(s["bbox"][3] for s in segs if s["bbox"])
    if heights and min_height_ratio:
        med = heights[len(heights) // 2]
        segs = [s for s in segs if not s["bbox"] or s["bbox"][3] >= med * min_height_ratio]
    # Đoạn ngắn: kẹp giữa 2 đoạn giống nhau (A x A) → gộp cả 3; giống 1 bên → gộp bên đó; không thì bỏ
    changed = True
    while changed:
        changed = False
        for i, s in enumerate(segs):
            if s["end"] - s["start"] >= min_dur - 1e-6:
                continue
            prev = segs[i - 1] if i > 0 else None
            nxt = segs[i + 1] if i + 1 < len(segs) else None
            if prev and nxt and similar(prev["text"], nxt["text"]) >= sim and nxt["start"] - prev["end"] <= (max_gap + 1) * step + 1e-6:
                segs[i - 1:i + 2] = [_finalize(prev["_frames"] + s["_frames"] + nxt["_frames"], step)]
            elif prev and similar(s["text"], prev["text"]) >= sim * 0.75:
                segs[i - 1:i + 1] = [_finalize(prev["_frames"] + s["_frames"], step)]
            elif nxt and similar(s["text"], nxt["text"]) >= sim * 0.75:
                segs[i:i + 2] = [_finalize(s["_frames"] + nxt["_frames"], step)]
            else:
                del segs[i]
            changed = True
            break
    for i, s in enumerate(segs, 1):
        s.pop("_frames")
        s["index"] = i
    return [{k: s[k] for k in ("index", "start", "end", "text", "bbox")} for s in segs]


def _finalize(frames, step):
    texts = Counter(f["text"] for f in frames)
    best = max(texts, key=lambda t: (texts[t], max(f["conf"] for f in frames if f["text"] == t)))
    boxes = [f["bbox"] for f in frames if f["bbox"]]
    # vùng hợp (không phải trung bình): frame nào OCR hụt 1 phần chữ thì box trung bình nhỏ hơn chữ thật → che sót
    bbox = None
    if boxes:
        x1 = min(b[0] for b in boxes); y1 = min(b[1] for b in boxes)
        bbox = [x1, y1, max(b[0] + b[2] for b in boxes) - x1, max(b[1] + b[3] for b in boxes) - y1]
    return {"start": round(frames[0]["t"], 3), "end": round(frames[-1]["t"] + step, 3),
            "text": best, "bbox": bbox, "_frames": frames}
