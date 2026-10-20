"""Bước 5: sinh .ass (ô che sub cũ + sub mới, cùng thời gian hiển thị) rồi burn."""
import logging
import math
from functools import lru_cache
from pathlib import Path

from video import FFMPEG, run_with_progress

log = logging.getLogger(__name__)


def ass_time(t):
    cs = int(round(t * 100))
    return f"{cs // 360000}:{cs // 6000 % 60:02d}:{cs // 100 % 60:02d}.{cs % 100:02d}"


def ass_escape(text):
    return text.replace("\\", "\\\\").replace("{", "(").replace("}", ")").replace("\n", "\\N")


def ass_color(rgb, opacity):
    """'1a1a1a', 0.85 → ('&H1A1A1A&', '&H26&'): ASS đảo thứ tự BGR, alpha 0 = đặc."""
    r, g, b = rgb[0:2], rgb[2:4], rgb[4:6]
    return f"&H{b}{g}{r}&".upper(), f"&H{round((1 - opacity) * 255):02X}&"


def pad_box(b, pad, W, H):
    x, y, w, h = b
    x1, y1 = max(x - pad, 0), max(y - pad, 0)
    x2, y2 = min(x + w + pad, W), min(y + h + pad, H)
    return [x1, y1, x2 - x1, y2 - y1]


@lru_cache
def _font(name, size):
    try:
        from PIL import ImageFont
    except ImportError:
        return None
    for f in (f"{name.lower()}bd.ttf", f"{name.lower()}.ttf", name):  # style Default là Bold → thử bản đậm trước
        try:
            return ImageFont.truetype(f, size)
        except OSError:
            pass
    return None


def text_width(line, size, font):
    f = _font(font, size)
    # ponytail: không tìm thấy font → ước lượng 0.6 cỡ chữ/ký tự
    return f.getlength(line) if f else len(line) * size * 0.6


def text_box(s, text, W, H, rc, size):
    """Ước lượng khung chữ dịch sau khi libass xuống dòng (rộng tối đa = khung trừ lề 5% mỗi bên)."""
    maxw = W * 0.9
    widths = [text_width(l, size, rc["font"]) + 2 * rc["outline"] for l in text.split("\n")]
    lines = sum(max(math.ceil(w / maxw), 1) for w in widths)
    tw, th = min(max(widths), maxw), lines * size + 2 * rc["outline"]
    if rc["position"] == "bbox" and s.get("bbox"):
        x, y, w, h = s["bbox"]
        cx, bottom = x + w / 2, y + h
    else:
        cx, bottom = W / 2, H - int(H * 0.06)
    return [int(cx - tw / 2), int(bottom - th), math.ceil(tw), math.ceil(th)]


def union_box(a, b):
    x1, y1 = min(a[0], b[0]), min(a[1], b[1])
    return [x1, y1, max(a[0] + a[2], b[0] + b[2]) - x1, max(a[1] + a[3], b[1] + b[3]) - y1]


def font_size(W, H, rc):
    return max(int(min(W, H) * rc["font_size_ratio"]), 12)


def covers(segments, translations, W, H, rc):
    """→ [(box, t0, t1)]: ô che phủ sub cũ + khung chữ dịch (nếu có)."""
    size, ext, out = font_size(W, H, rc), rc["cover_extend"], []
    for s in segments:
        if not s.get("bbox"):
            continue
        box = s["bbox"] if translations is None else union_box(s["bbox"], text_box(s, translations[s["index"]], W, H, rc, size))
        # OCR lấy mẫu thưa (extract.fps) → mốc thật của sub lệch tới 1 bước mẫu; che dư mỗi đầu để không lộ chữ cũ
        out.append((pad_box(box, rc["cover_pad"], W, H), max(s["start"] - ext, 0), s["end"] + ext))
    return merge_overlaps(out)


def intersects(a, b):
    return a[0] <= b[0] + b[2] and b[0] <= a[0] + a[2] and a[1] <= b[1] + b[3] and b[1] <= a[1] + a[3]


def merge_overlaps(items):
    """2 ô che chồng nhau cả thời gian lẫn vị trí (do che dư 2 đầu) → khúc chồng dùng 1 ô gộp, khỏi 2 lớp đè nhau."""
    out = []
    for box, t0, t1 in sorted(items, key=lambda c: c[1]):
        j = next((k for k in range(len(out) - 1, -1, -1) if out[k][2] > t0 and intersects(out[k][0], box)), None)
        if j is None:
            out.append((box, t0, t1))
            continue
        pb, p0, p1 = out.pop(j)
        if t0 > p0:
            out.append((pb, p0, t0))
        out.append((union_box(pb, box), t0, min(p1, t1)))
        if p1 > t1:
            out.append((pb, t1, p1))
        elif t1 > p1:
            out.append((box, p1, t1))
    return out


def cover_event(box, t0, t1, rc):
    """Lớp màu của ô che vẽ bằng ASS (\\p1), cùng thời gian với lớp mờ trong blur_filter."""
    x, y, w, h = box
    c, a = ass_color(rc["cover_color"], rc["cover_opacity"])
    fade = rc["cover_fade_ms"]
    tags = f"{{\\an7\\pos({x},{y})\\p1\\bord0\\shad0\\1c{c}\\1a{a}" + (f"\\fad({fade},{fade})" if fade else "") + "}"
    return f"Dialogue: 0,{ass_time(t0)},{ass_time(t1)},Default,,0,0,0,,{tags}m 0 0 l {w} 0 {w} {h} 0 {h}{{\\p0}}"


def blur_filter(items, W, H, rc):
    """Kính mờ: làm mờ cả khung 1 lần (ở 1/4 độ phân giải cho nhanh), rồi dán từng vùng ô che theo thời gian.
    → (filter_complex nhận [0:v], nhãn đầu ra) hoặc None."""
    if not rc["cover_blur"] or not items:
        return None
    n = len(items)
    r = max(min(rc["cover_blur"], min(W, H) // 16 - 1), 1)  # chroma yuv420 ở 1/4 khung chỉ còn 1/8 → giới hạn radius
    chain = [f"[0:v]split[base][src];[src]scale={W // 4}:{H // 4},boxblur={r}:2,scale={W}:{H}"
             + (f",split={n}" + "".join(f"[bl{i}]" for i in range(n)) if n > 1 else "[bl0]")]
    cur = "base"
    for i, ((x, y, w, h), t0, t1) in enumerate(items):
        chain.append(f"[bl{i}]crop={w}:{h}:{x}:{y}[c{i}];[{cur}][c{i}]overlay={x}:{y}:enable='between(t,{t0:.3f},{t1:.3f})'[v{i}]")
        cur = f"v{i}"
    return ";".join(chain), cur


def build_ass(segments, translations, width, height, rc, cover_items=()):
    size = font_size(width, height, rc)
    margin = int(height * 0.06)
    head = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,{rc['font']},{size},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,{rc['outline']},{rc['shadow']},2,{int(width * 0.05)},{int(width * 0.05)},{margin},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    events = [cover_event(*c, rc) for c in cover_items]
    for s in segments if translations is not None else ():
        text = ass_escape(translations[s["index"]])
        if rc["position"] == "bbox" and s.get("bbox"):
            x, y, w, h = s["bbox"]
            # neo đáy-giữa của sub mới vào đáy-giữa sub cũ → chữ xuống dòng sẽ mọc lên trên
            text = f"{{\\an2\\pos({x + w // 2},{y + h})}}" + text
        events.append(f"Dialogue: 1,{ass_time(s['start'])},{ass_time(s['end'])},Default,,0,0,0,,{text}")
    return head + "\n".join(events) + "\n"


def render(video, workdir, segments, translations, meta, rc, progress=None, softsub=False, name="output"):
    """translations=None → chỉ che sub cũ. Sub mềm: chỉ bỏ track sub cũ (không map) nên không cần ô che."""
    workdir = Path(workdir)
    W, H = meta["width"], meta["height"]
    items = covers(segments, translations, W, H, rc) if rc["cover"] and not softsub else []
    (workdir / "sub.ass").write_text(build_ass(segments, translations, W, H, rc, items), encoding="utf-8")
    graph, last = blur_filter(items, W, H, rc) or ("", "0:v")
    (workdir / f"{name}.filter.txt").write_text((graph + ";" if graph else "") + f"[{last}]ass=sub.ass[out]", encoding="utf-8")
    out = workdir / f"{name}.mp4"
    tmp = workdir / f"{name}.part.mp4"
    # cwd = workdir để ass=sub.ass khỏi phải escape đường dẫn Windows (D\:...)
    cmd = [FFMPEG, "-y", "-v", "error", "-progress", "pipe:1", "-i", str(Path(video).resolve()),
           "-/filter_complex", f"{name}.filter.txt", "-map", "[out]", "-map", "0:a?",
           "-c:v", "libx264", "-crf", str(rc["crf"]), "-preset", rc["preset"], "-pix_fmt", "yuv420p",
           "-c:a", "copy", "-movflags", "+faststart", tmp.name]
    run_with_progress(cmd, meta["duration"], progress, cwd=workdir)
    tmp.replace(out)
    return out
