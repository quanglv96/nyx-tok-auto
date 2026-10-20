"""Bước 3–4: xuất file dịch, đọc/validate bản dịch, dịch tự động bằng Claude."""
import json
import logging
import os

log = logging.getLogger(__name__)


class TranslationError(ValueError):
    pass


def write_to_translate(segments, path):
    with open(path, "w", encoding="utf-8") as f:
        for s in segments:
            f.write(f"{s['index']}|{s['text'].replace(chr(10), ' ')}\n")


def parse_pipe_file(path):
    """index|text mỗi dòng → {index: text}. Lỗi định dạng / trùng index báo kèm số dòng."""
    out, errors = {}, []
    with open(path, encoding="utf-8-sig") as f:
        for n, line in enumerate(f, 1):
            line = line.rstrip("\r\n")
            if not line.strip():
                continue
            idx, sep, text = line.partition("|")
            if not sep or not idx.strip().isdigit():
                errors.append(f"dòng {n}: sai định dạng 'index|bản dịch': {line[:60]!r}")
                continue
            i = int(idx)
            if i in out:
                errors.append(f"dòng {n}: index {i} bị lặp")
            out[i] = text.strip()
    if errors:
        raise TranslationError(f"{path}:\n  " + "\n  ".join(errors))
    return out


def validate(translations, segments):
    want = {s["index"] for s in segments}
    have = set(translations)
    problems = []
    if missing := sorted(want - have):
        problems.append(f"thiếu {len(missing)} index: {_short(missing)}")
    if extra := sorted(have - want):
        problems.append(f"thừa {len(extra)} index: {_short(extra)}")
    if empty := sorted(i for i in want & have if not translations[i].strip()):
        problems.append(f"{len(empty)} dòng rỗng: {_short(empty)}")
    if problems:
        raise TranslationError("Bản dịch không khớp segments.json: " + "; ".join(problems))


def _short(xs):
    return ", ".join(map(str, xs[:20])) + (" ..." if len(xs) > 20 else "")


SCHEMA = {
    "type": "object",
    "properties": {"items": {"type": "array", "items": {
        "type": "object",
        "properties": {"index": {"type": "integer"}, "text": {"type": "string"}},
        "required": ["index", "text"], "additionalProperties": False}}},
    "required": ["items"], "additionalProperties": False,
}


def translate_auto(segments, target_lang="tiếng Việt", batch_size=50, retries=3, progress=None):
    import anthropic
    client = anthropic.Anthropic()  # ANTHROPIC_API_KEY từ .env / môi trường
    model = os.getenv("LLM_MODEL", "claude-opus-5-5")
    system = (f"Bạn dịch phụ đề video ngắn từ tiếng Trung sang {target_lang}, tự nhiên, ngắn gọn như phụ đề. "
              "Mỗi phần tử đầu vào là 1 câu sub độc lập kèm index. Trả về đúng từng index đã nhận, "
              "không gộp, không tách, không bỏ dòng, không thêm dòng. Text OCR có thể sai vài chữ — đoán theo ngữ cảnh.")
    result = {}
    for start in range(0, len(segments), batch_size):
        batch = segments[start:start + batch_size]
        want = {s["index"] for s in batch}
        payload = json.dumps([{"index": s["index"], "text": s["text"]} for s in batch], ensure_ascii=False)
        for attempt in range(1, retries + 1):
            try:
                resp = client.beta.messages.create(
                    model=model, max_tokens=16000, system=system,
                    betas=["server-side-fallback-2026-07-01"], fallbacks="default",
                    output_config={"effort": "low", "format": {"type": "json_schema", "schema": SCHEMA}},
                    messages=[{"role": "user", "content": payload}],
                )
                if resp.stop_reason in ("refusal", "max_tokens"):
                    raise TranslationError(f"stop_reason={resp.stop_reason}")
                text = next(b.text for b in resp.content if b.type == "text")
                got = {it["index"]: it["text"] for it in json.loads(text)["items"]}
                validate(got, batch)
                result.update(got)
                break
            except anthropic.AuthenticationError:
                raise TranslationError("Claude API key sai hoặc đã bị thu hồi — kiểm tra lại key ở console.anthropic.com → API Keys")
            except anthropic.BadRequestError as e:
                if "credit balance" in str(e):
                    raise TranslationError("Tài khoản Claude hết credit — nạp tại console.anthropic.com → Plans & Billing")
                raise TranslationError(f"Claude API từ chối request: {e.message}")
            except (TranslationError, json.JSONDecodeError, StopIteration, anthropic.APIConnectionError,
                    anthropic.RateLimitError, anthropic.InternalServerError) as e:
                log.warning("Batch %d-%d lần %d lỗi: %s", min(want), max(want), attempt, e)
                if attempt == retries:
                    raise TranslationError(f"Dịch batch index {min(want)}-{max(want)} thất bại sau {retries} lần: {e}")
        if progress:
            progress.update(len(batch))
    return result


def write_pipe_file(translations, path):
    with open(path, "w", encoding="utf-8") as f:
        for i in sorted(translations):
            f.write(f"{i}|{translations[i]}\n")
