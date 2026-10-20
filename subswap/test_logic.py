"""Kiểm tra logic thuần (không cần video/OCR): python test_logic.py"""
import tempfile
from pathlib import Path

from ocr import build_segments, frame_entry
from render import ass_color, ass_time, blur_filter, build_ass, covers
from translate import TranslationError, parse_pipe_file, validate

B = [100, 500, 300, 50]


def f(t, text, bbox=B):
    return {"t": t, "text": text, "conf": 0.95, "bbox": bbox if text else None}


def test_segments():
    fps = 4
    seq = (["A你好世界"] * 8 + [""] * 1 + ["A你好世界"] * 4      # gap 1 frame → vẫn 1 đoạn
           + ["B今天很好"] * 6 + ["X错"] + ["B今天很好"] * 6    # 1 frame OCR lỗi kẹp giữa → gộp
           + [""] * 6 + ["C再见"] * 1)                          # đoạn 250ms lẻ loi → bỏ
    frames = [f(i / fps, t) for i, t in enumerate(seq)]
    frames.append(f(len(seq) / fps, "水印", [10, 10, 40, 15]))   # watermark nhỏ → bỏ
    segs = build_segments(frames, fps)
    assert [s["text"] for s in segs] == ["A你好世界", "B今天很好"], segs
    assert segs[0]["start"] == 0 and segs[0]["end"] == 13 / fps
    assert segs[1]["start"] == 13 / fps and segs[1]["end"] == 26 / fps
    assert [s["index"] for s in segs] == [1, 2] and segs[0]["bbox"] == B


def test_frame_entry_order():
    lines = [("一道菜", 0.9, [300, 101, 100, 50]), ("今天我们来做", 0.9, [100, 99, 200, 50]), ("第二行", 0.9, [150, 160, 150, 50])]
    e = frame_entry(0, lines)
    assert e["text"] == "今天我们来做一道菜 第二行", e
    assert e["bbox"] == [100, 99, 300, 111]


def test_validate():
    segs = [{"index": i} for i in (1, 2, 3)]
    validate({1: "a", 2: "b", 3: "c"}, segs)
    try:
        validate({1: "a", 3: " ", 4: "x"}, segs)
        raise AssertionError("phải lỗi")
    except TranslationError as e:
        assert "thiếu 1 index: 2" in str(e) and "thừa 1 index: 4" in str(e) and "rỗng: 3" in str(e), e
    p = Path(tempfile.mkdtemp()) / "t.txt"
    p.write_text("﻿1|Xin chào | bạn\n\n2|Tạm biệt\n", encoding="utf-8")
    assert parse_pipe_file(p) == {1: "Xin chào | bạn", 2: "Tạm biệt"}
    p.write_text("1|a\n1|b\nabc\n", encoding="utf-8")
    try:
        parse_pipe_file(p)
        raise AssertionError("phải lỗi")
    except TranslationError as e:
        assert "lặp" in str(e) and "dòng 3" in str(e)


def test_render_helpers():
    assert ass_time(3661.256) == "1:01:01.26"
    assert ass_color("1a2b3c", 0.85) == ("&H3C2B1A&", "&H26&")
    rc = {"font": "Arial", "font_size_ratio": 0.045, "outline": 3, "shadow": 1, "position": "bbox", "cover_pad": 8,
          "cover_color": "000000", "cover_opacity": 1, "cover_fade_ms": 100, "cover_extend": 0.25, "cover_blur": 10}
    segs = [{"index": 1, "start": 1, "end": 2, "bbox": [101, 500, 300, 51]}, {"index": 2, "start": 3, "end": 4, "bbox": None}]
    tr = {1: "Xin chào", 2: "Hẹn gặp"}
    items = covers(segs, tr, 720, 1280, rc)
    # đoạn có bbox: 1 ô che, che dư 0.25s mỗi đầu; đoạn không bbox: không che
    assert items == [([93, 492, 316, 67], 0.75, 2.25)], items
    ev = [l for l in build_ass(segs, tr, 720, 1280, rc, items).splitlines() if l.startswith("Dialogue")]
    assert len(ev) == 3 and ev[0].startswith("Dialogue: 0,0:00:00.75,0:00:02.25")
    assert r"\pos(93,492)" in ev[0] and "m 0 0 l 316 0 316 67 0 67" in ev[0] and r"\fad(100,100)" in ev[0]
    assert ev[1].startswith("Dialogue: 1,0:00:01.00,0:00:02.00") and ev[1].endswith("Xin chào")
    # kính mờ: dán vùng mờ đúng box + thời gian của ô che
    graph, last = blur_filter(items, 720, 1280, rc)
    assert "crop=316:67:93:492" in graph and "overlay=93:492:enable='between(t,0.750,2.250)'" in graph and last == "v0"
    assert blur_filter(items, 720, 1280, dict(rc, cover_blur=0)) is None and blur_filter([], 720, 1280, rc) is None
    # 2 câu liền nhau: che dư làm 2 ô chồng thời gian → khúc chồng thành 1 ô gộp, không còn 2 ô đè nhau
    near = [{"index": 1, "start": 1, "end": 2, "bbox": [100, 500, 300, 50]}, {"index": 2, "start": 2, "end": 3, "bbox": [50, 502, 400, 50]},
            {"index": 3, "start": 2, "end": 3, "bbox": [100, 100, 300, 50]}]  # đoạn 3: vùng khác (tiêu đề) → giữ riêng
    m = covers(near, None, 720, 1280, dict(rc, cover_pad=0))
    assert sorted(m) == sorted([([100, 500, 300, 50], 0.75, 1.75), ([100, 100, 300, 50], 1.75, 3.25),
                                            ([50, 500, 400, 52], 1.75, 2.25), ([50, 502, 400, 50], 2.25, 3.25)]), m
    # ô che nới theo câu dịch dài hơn sub cũ, không vượt khung
    (x, y, w, h), _, _ = covers(segs, {1: "Một câu dịch rất dài hơn hẳn câu gốc tiếng Trung", 2: "b"}, 720, 1280, rc)[0]
    assert 316 < w and x >= 0 and x + w <= 720, (x, w)
    # chỉ che: đúng bbox cũ, không có chữ
    only = covers(segs, None, 720, 1280, rc)
    assert only == items and [l for l in build_ass(segs, None, 720, 1280, rc, only).splitlines() if l.startswith("Dialogue")] == ev[:1]


def test_parse_probe():
    from video import parse_probe
    out = """Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'a.mp4':
  Duration: 00:01:02.50, start: 0.000000, bitrate: 2000 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 1920x1080 [SAR 1:1 DAR 16:9], 30 fps (default)
      Side data:
        displaymatrix: rotation of -90.00 degrees
  Stream #0:1[0x2](und): Audio: aac (LC), 44100 Hz, stereo, fltp, 128 kb/s
  Stream #0:2[0x3](chi): Subtitle: mov_text (tx3g / 0x67337874), 0 kb/s"""
    assert parse_probe(out) == {"width": 1080, "height": 1920, "fps": 30.0, "duration": 62.5, "softsub": True}
    out2 = out.replace("        displaymatrix: rotation of -90.00 degrees\n", "").replace("mov_text", "hdmv_pgs_subtitle")
    assert parse_probe(out2) == {"width": 1920, "height": 1080, "fps": 30.0, "duration": 62.5, "softsub": False}


def test_detect_roi():
    from video import detect_roi
    title, sub, stray = [216, 117, 280, 60], [150, 810, 440, 45], [300, 600, 100, 100]
    frames = [[title, sub]] * 10 + [[title]] * 4 + [[title, stray]]   # chữ lạc 1 frame → bỏ
    rois = detect_roi(frames, 720, 1280)
    assert len(rois) == 2 and rois[0][1] <= 117 <= 177 <= sum(rois[0][1::2]) and rois[1][1] <= 810 <= 855 <= sum(rois[1][1::2]), rois
    assert detect_roi([[], []], 720, 1280) == []


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("OK", name)
