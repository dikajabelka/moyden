"""
Обработка картинок для библиотеки «Мой день» (вызывается из build.py).

  • JPG (и WEBP) → WebP, 512 точек по длинной стороне, до 60 КБ;
  • PNG (и GIF, BMP, TIFF) → PNG, 512 точек, до 50 КБ
    (если тяжелее — палитра 256 цветов, прозрачность сохраняется);
  • SVG остаётся SVG: убираются комментарии и мусор, предупреждение если > 5 КБ.
"""
import io
import re

SIDE = 512
WEBP_LIMIT = 60 * 1024
PNG_LIMIT = 50 * 1024
TO_WEBP = {".jpg", ".jpeg", ".webp"}
SVG_LIMIT = 5 * 1024
RASTER = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tif", ".tiff"}

try:
    from PIL import Image, ImageOps
except ImportError:
    Image = None


def kb(n):
    return f"{n / 1024:.0f} КБ" if n >= 1024 else f"{n} Б"


def to_webp(src_bytes):
    """Возвращает (webp_bytes, (w, h), исходный_размер)."""
    with Image.open(io.BytesIO(src_bytes)) as im:
        im = ImageOps.exif_transpose(im)          # фото с телефона — правильный поворот
        orig = im.size
        if im.mode not in ("RGB", "RGBA"):
            im = im.convert("RGBA" if ("transparency" in im.info or im.mode in ("LA", "P", "PA")) else "RGB")
        if im.mode == "RGBA" and im.getchannel("A").getextrema()[0] == 255:
            im = im.convert("RGB")                # прозрачности на деле нет
        im.thumbnail((SIDE, SIDE), Image.LANCZOS)
        data = b""
        for q in (86, 80, 74, 68, 60, 52):
            buf = io.BytesIO()
            im.save(buf, "WEBP", quality=q, method=4)
            data = buf.getvalue()
            if len(data) <= WEBP_LIMIT:
                break
        return data, im.size, orig


def clean_svg(text):
    s = re.sub(r"<\?xml[^>]*\?>", "", text)
    s = re.sub(r"<!--.*?-->", "", s, flags=re.S)
    s = re.sub(r"<!DOCTYPE[^>]*>", "", s, flags=re.I)
    s = re.sub(r"<metadata.*?</metadata>", "", s, flags=re.S)
    s = re.sub(r"<sodipodi:namedview.*?(/>|</sodipodi:namedview>)", "", s, flags=re.S)
    return re.sub(r">\s+<", "><", s).strip()


def svg_warnings(name, text):
    w = []
    if "<image" in text and "base64" in text:
        w.append(f"{name}: внутри SVG вшита растровая картинка — лучше сохранить как PNG/JPG")
    size = len(text.encode())
    if size > SVG_LIMIT:
        w.append(f"{name}: SVG {kb(size)} (норма до 5 КБ) — упростите рисунок")
    return w


def to_png(src_bytes):
    """Возвращает (png_bytes, (w, h), исходный_размер)."""
    with Image.open(io.BytesIO(src_bytes)) as im:
        im = ImageOps.exif_transpose(im)
        orig = im.size
        if im.mode not in ("RGB", "RGBA"):
            im = im.convert("RGBA")
        im.thumbnail((SIDE, SIDE), Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, "PNG", optimize=True)
        data = buf.getvalue()
        if len(data) > PNG_LIMIT:
            buf = io.BytesIO()
            im.convert("RGBA").quantize(256, method=Image.Quantize.FASTOCTREE).save(buf, "PNG", optimize=True)
            if buf.tell() < len(data):
                data = buf.getvalue()
        return data, im.size, orig


def convert(src_bytes, ext, keep_ext=None):
    """-> (данные, новое_расширение, (w,h), исходный_размер, лимит).
    keep_ext='.png'/'.webp' — принудительно этот формат (при замене картинки адрес не меняется)."""
    if keep_ext == ".webp" or (keep_ext is None and ext.lower() in TO_WEBP):
        d, size, orig = to_webp(src_bytes)
        return d, ".webp", size, orig, WEBP_LIMIT
    d, size, orig = to_png(src_bytes)
    return d, ".png", size, orig, PNG_LIMIT
