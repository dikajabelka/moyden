#!/usr/bin/env python3
"""
Сборка библиотеки картинок «Мой день».
На Windows запускайте двойным щелчком по «Собрать.cmd».

Что делает:
 1. Разбирает папку «новые»: по имени файла находит слово в словаре,
    JPG → WebP, PNG → PNG, 512 точек, и кладёт в images/<категория>/.
 2. Проверяет картинки в images/ (сжатие, формат).
 3. Пишет catalog.json (для приложения) и catalog.js (для сайта).
 4. Пишет план.html — что уже есть и чего не хватает.

Имя файла в «новые»:  <слово> [девочка|мальчик|без людей] [фото] [2|3…]
   чистить зубы девочка.jpg      чистить зубы мальчик 2.png
   магазин.jpg                   гулять девочка фото.jpg
Тот же файл ещё раз (то же слово и вариант) — ЗАМЕНЯЕТ картинку, адрес не меняется.
С цифрой 2, 3… — добавляет ещё один вариант.
"""
import csv
import html
import io
import json
import re
import shutil
import sys
import unicodedata
from datetime import date, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # для встроенного Python
import prepare

ROOT = Path(__file__).resolve().parent
IMAGES = ROOT / "images"
INBOX = ROOT / "новые"
BACKUP = ROOT / "_оригиналы"
DICT = ROOT / "словарь.csv"
CATALOG = ROOT / "catalog.json"
CATALOG_JS = ROOT / "catalog.js"
PLAN = ROOT / "план.html"
REPORT = ROOT / "отчёт.json"
META = ROOT / "картинки.csv"      # правки из админки: слово / вариант / стиль для конкретного файла
META_HEAD = ["файл", "слово", "вариант", "стиль"]
REPLACE_DIR = "_заменить"

DICT_HEAD = ["категория", "слово", "варианты", "теги", "комментарий"]
VARIANTS = ["девочка", "мальчик", "без людей"]
STAMP = datetime.now().strftime("%Y-%m-%d_%H-%M")

report = {"added": [], "replaced": [], "new_words": [], "left": [], "warn": []}


# ---------------------------------------------------------------- тексты
def nfc(s):
    return unicodedata.normalize("NFC", s)


def norm(s):
    """для сравнения: регистр, ё=е, _ и - как пробел"""
    s = nfc(s).lower().replace("ё", "е")
    return re.sub(r"[\s_\-]+", " ", s).strip()


def parse_name(stem):
    """'чистить_зубы-девочка-фото-2' -> ('чистить зубы', 'девочка', 'фото', 2)"""
    raw = re.sub(r"[\s_\-]+", " ", nfc(stem).lower()).strip().split(" ")
    tokens = [t.replace("ё", "е") for t in raw]
    variant, style, n = "", "рисунок", 1
    while len(tokens) > 1:
        t = tokens[-1]
        if t.isdigit() and n == 1:
            n = int(t)
        elif t == "фото":
            style = "фото"
        elif t == "рисунок":
            pass
        elif t in ("девочка", "мальчик") and not variant:
            variant = t
        elif len(tokens) > 2 and tokens[-2:] == ["без", "людей"] and not variant:
            variant = "без людей"
            tokens.pop(); raw.pop()
        else:
            break
        tokens.pop(); raw.pop()
    return " ".join(raw), variant, style, n


# ---------------------------------------------------------------- словарь
def read_dict():
    if not DICT.exists():
        return []
    data = DICT.read_bytes()
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = data.decode("cp1251")        # Excel иногда сохраняет так
    first = text.splitlines()[0] if text else ""
    delim = ";" if first.count(";") >= max(first.count(","), first.count("\t")) else \
            ("\t" if first.count("\t") > first.count(",") else ",")
    rows = []
    for r in csv.reader(io.StringIO(text), delimiter=delim):
        if not r or not any(c.strip() for c in r):
            continue
        if norm(r[0]) == "категория":
            continue
        r = [nfc(c.strip()) for c in r] + [""] * 5
        rows.append(dict(zip(DICT_HEAD, r[:5])))
    return rows


def write_dict(rows):
    with DICT.open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f, delimiter=";")
        w.writerow(DICT_HEAD)
        for r in rows:
            w.writerow([r.get(k, "") for k in DICT_HEAD])


def row_cats(row):
    """«режим, гигиена» -> ['режим', 'гигиена']; первая — основная"""
    out = []
    for c in re.split(r"[,;]", row.get("категория", "")):
        c = nfc(c.strip().lower())
        if c and c not in out:
            out.append(c)
    return out


def read_meta():
    meta = {}
    if not META.exists():
        return meta
    text = META.read_bytes().decode("utf-8-sig", errors="replace")
    for r in csv.reader(io.StringIO(text), delimiter=";"):
        if not r or norm(r[0]) == "файл":
            continue
        r = [nfc(c.strip()) for c in r] + [""] * 4
        meta[r[0]] = dict(zip(META_HEAD, r[:4]))
    return meta


def write_meta(meta):
    rows = [m for m in meta.values() if m.get("слово") or m.get("вариант") or m.get("стиль")]
    if not rows:
        if META.exists():
            META.unlink()
        return
    with META.open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f, delimiter=";")
        w.writerow(META_HEAD)
        for m in sorted(rows, key=lambda m: m["файл"]):
            w.writerow([m.get(k, "") for k in META_HEAD])


def row_variants(row):
    vs = [norm(v) for v in row.get("варианты", "").split(",")]
    return [v for v in VARIANTS if norm(v) in vs] or ["девочка", "мальчик"]


def only_no_people(row):
    return row_variants(row) == ["без людей"]


def row_tags(row):
    out = []
    for t in re.split(r"[,;]", row.get("теги", "")):
        t = nfc(t.strip().lower())
        if t and t not in out:
            out.append(t)
    return out


def slug(row, variant, style, n):
    parts = [re.sub(r"\s+", "_", row["слово"].strip().lower())]
    if variant and not (variant == "без людей" and only_no_people(row)):
        parts.append(variant.replace(" ", "_"))
    if style == "фото":
        parts.append("фото")
    if n > 1:
        parts.append(str(n))
    return "-".join(parts)


# ---------------------------------------------------------------- файлы
def backup(path: Path, sub: str):
    dst = BACKUP / sub / STAMP / path.name
    dst.parent.mkdir(parents=True, exist_ok=True)
    k = 1
    while dst.exists():
        dst = dst.with_name(f"{path.stem}({k}){path.suffix}"); k += 1
    shutil.copy2(path, dst)


def write_image(src: Path, target_noext: Path, keep_ext=None):
    """src -> target(.png|.webp|.svg). keep_ext — при замене сохранить прежний формат (= прежний адрес)."""
    ext = src.suffix.lower()
    if keep_ext == ".svg" and ext != ".svg":
        report["warn"].append(f"{target_noext.name}: была SVG, заменили на {ext} — адрес картинки изменился")
        keep_ext = None
    if ext == ".svg" and keep_ext not in (None, ".svg"):
        report["warn"].append(f"{target_noext.name}: заменили на SVG — адрес картинки изменился")
        keep_ext = None
    if ext == ".svg":
        text = prepare.clean_svg(src.read_text(encoding="utf-8", errors="replace"))
        report["warn"].extend(prepare.svg_warnings(src.name, text))
        dst = target_noext.with_suffix(".svg")
        data = text.encode("utf-8")
    else:
        if prepare.Image is None:
            report["warn"].append(f"{src.name}: не могу обработать — не установлен Pillow")
            return None
        data, new_ext, size, orig, limit = prepare.convert(src.read_bytes(), ext, keep_ext)
        dst = target_noext.with_suffix(new_ext)
        if len(data) > limit:
            report["warn"].append(f"{dst.name}: {prepare.kb(len(data))} даже после сжатия — упростите картинку")
        if max(orig) < 256:
            report["warn"].append(f"{src.name}: всего {orig[0]}×{orig[1]} точек — на печати будет мутно")
    # старые версии с тем же именем (другое расширение) — убрать, чтобы не было двойников
    for old in target_noext.parent.glob(target_noext.name + ".*"):
        if old.suffix.lower() in prepare.RASTER | {".svg"} and old != src:
            backup(old, "замены")
            old.unlink()
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_bytes(data)
    return dst


# ---------------------------------------------------------------- 1. «новые»
def process_inbox(rows, index):
    INBOX.mkdir(exist_ok=True)
    files = sorted(p for p in INBOX.rglob("*") if p.is_file() and not p.name.startswith("."))
    for f in files:
        ext = f.suffix.lower()
        rel = f.relative_to(INBOX)
        if ext not in prepare.RASTER | {".svg"}:
            if f.name.lower() not in ("desktop.ini", "thumbs.db", "прочтите.txt"):
                report["left"].append(f"{rel} — не картинка (нужны JPG, PNG, WEBP, SVG)")
            continue
        if rel.parts[0] == REPLACE_DIR and len(rel.parts) > 1:      # новые/_заменить/<путь в images>.png
            target = IMAGES / Path(*rel.parts[1:]).with_suffix("")
            old = [q for q in target.parent.glob(target.name + ".*") if q.suffix.lower() in prepare.RASTER | {".svg"}]
            if not old:
                report["left"].append(f"{rel} — заменять нечего: картинки {target.relative_to(IMAGES)} нет")
                continue
            dst = write_image(f, target, old[0].suffix.lower())
            if dst is None:
                continue
            backup(f, "новые"); f.unlink()
            report["replaced"].append(str(dst.relative_to(IMAGES)))
            continue
        word, variant, style, n = parse_name(f.stem)
        row = index.get(norm(word))
        if row is None:
            if len(rel.parts) > 1:                        # новые/спорт/батут.jpg → новое слово
                row = {"категория": nfc(rel.parts[0]).lower(), "слово": word,
                       "варианты": "без людей" if variant == "без людей" else "девочка, мальчик",
                       "теги": "", "комментарий": "добавлено автоматически"}
                rows.append(row); index[norm(word)] = row
                report["new_words"].append(f"{word} → {row['категория']}")
            else:
                report["left"].append(f"{rel} — слова «{word}» нет в словаре. Добавьте строку в "
                                      f"словарь.csv или положите файл в папку-категорию: новые/спорт/{f.name}")
                continue
        if not variant and only_no_people(row):
            variant = "без людей"
        if not variant:
            report["warn"].append(f"{rel}: не указано «девочка» / «мальчик» — картинка добавлена без варианта")
        cat = (row_cats(row) or ["разное"])[0]
        target = IMAGES / cat / slug(row, variant, style, n)
        # существующие картинки не затираем никогда — даём следующий номер (замена — только через _заменить)
        while any(target.parent.glob(target.name + ".*")):
            n += 1
            target = IMAGES / cat / slug(row, variant, style, n)
        dst = write_image(f, target)
        if dst is None:
            continue
        backup(f, "новые")
        f.unlink()
        report["added"].append(str(dst.relative_to(IMAGES)))
    # пустые подпапки убрать
    for d in sorted((p for p in INBOX.rglob("*") if p.is_dir()), reverse=True):
        try:
            d.rmdir()
        except OSError:
            pass


# ---------------------------------------------------------------- 2. images/
def normalize_images():
    for p in sorted(IMAGES.rglob("*")):
        if not p.is_file() or p.name.startswith("."):
            continue
        name = nfc(p.name)
        if name != p.name:
            p = p.rename(p.with_name(name))
        ext = p.suffix.lower()
        if ext == ".svg":
            raw = p.read_text(encoding="utf-8", errors="replace")
            text = prepare.clean_svg(raw)
            if text != raw:
                p.write_text(text, encoding="utf-8")
            report["warn"].extend(prepare.svg_warnings(p.name, text))
        elif ext in prepare.RASTER and prepare.Image is not None:
            limit = prepare.PNG_LIMIT if ext == ".png" else prepare.WEBP_LIMIT
            too_big = p.stat().st_size > limit
            if ext in (".webp", ".png") and not too_big:
                with prepare.Image.open(p) as im:
                    if max(im.size) <= prepare.SIDE:
                        continue
            backup(p, "images")
            dst = write_image(p, p.with_suffix(""))
            if dst and dst != p and p.exists():
                p.unlink()
            print(f"  • приведено: {dst.relative_to(IMAGES)}")


# ---------------------------------------------------------------- 3. каталог
def build_catalog(rows, index, meta):
    items, seen, cats = [], set(), set()
    exts = {".webp", ".png", ".svg"} | (set() if prepare.Image else {".jpg", ".jpeg"})
    files = sorted((p for p in IMAGES.rglob("*") if p.is_file() and p.suffix.lower() in exts),
                   key=lambda p: norm(str(p.relative_to(IMAGES))))
    for p in files:
        rel = p.relative_to(IMAGES)
        folder = nfc(rel.parts[0]) if len(rel.parts) > 1 else ""
        word, variant, style, n = parse_name(p.stem)
        m = meta.get("images/" + nfc(rel.as_posix()))
        if m:                                             # правки из админки главнее имени файла
            m["_used"] = True
            if m.get("слово"):
                word = m["слово"]
            if m.get("вариант"):
                variant = "" if m["вариант"] == "-" else m["вариант"]
            if m.get("стиль"):
                style = m["стиль"]
        row = index.get(norm(word))
        if row is None:
            row = {"категория": folder, "слово": word,
                   "варианты": variant or "девочка, мальчик", "теги": "",
                   "комментарий": "добавлено автоматически"}
            rows.append(row); index[norm(word)] = row
            report["new_words"].append(f"{word} → {folder}")
        if not variant and only_no_people(row) and not (m and m.get("вариант") == "-"):
            variant = "без людей"
        categories = row_cats(row) or ([folder] if folder else [])
        category = categories[0] if categories else ""
        rel_id = folder
        item_id = (f"{rel_id}_{nfc(p.stem)}" if rel_id else nfc(p.stem)).lower()   # id = адрес, не меняется
        if item_id in seen:
            report["warn"].append(f"{rel}: повтор id «{item_id}» — есть файл с тем же именем, но другим расширением")
            continue
        seen.add(item_id)
        cats.update(categories)
        w = row["слово"].strip()
        item = {
            "id": item_id,
            "title": w[:1].upper() + w[1:],
            "category": category,
            "categories": categories,
            "file": "images/" + nfc(rel.as_posix()),
            "bytes": p.stat().st_size,
            "tags": row_tags(row),
            "word": w.lower(),
            "variant": variant,
            "style": style,
            "n": n,
        }
        if p.suffix.lower() != ".svg" and prepare.Image is not None:
            try:
                with prepare.Image.open(p) as im:
                    item["w"], item["h"] = im.size
            except Exception:
                report["warn"].append(f"{rel}: файл повреждён")
        items.append(item)
    return items, sorted(cats)


# ---------------------------------------------------------------- 4. план
def build_plan(rows, items):
    have = {}
    for i in items:
        have.setdefault(norm(i["word"]), []).append(i)
    by_cat = {}
    for r in rows:
        by_cat.setdefault((row_cats(r) or ["разное"])[0], []).append(r)
    need_total = done_total = 0
    parts = []
    for cat, rs in by_cat.items():
        trs = []
        for r in rs:
            its = have.get(norm(r["слово"]), [])
            got = {i["variant"] or "без варианта" for i in its}
            cells = []
            for v in VARIANTS:
                if v in row_variants(r):
                    need_total += 1
                    ok = v in got
                    done_total += ok
                    cells.append(f'<td class="{"ok" if ok else "no"}">{"✓" if ok else "—"}</td>')
                else:
                    cells.append('<td class="na"></td>')
            extra = len(its) - len([v for v in VARIANTS if v in got])
            trs.append(f'<tr><td>{html.escape(r["слово"])}</td>{"".join(cells)}'
                       f'<td class="x">{"+" + str(extra) if extra > 0 else ""}</td></tr>')
        parts.append(f'<h2>{html.escape(cat.capitalize())}</h2><table><tr><th>слово</th>'
                     f'<th>девочка</th><th>мальчик</th><th>без людей</th><th>доп.</th></tr>'
                     + "".join(trs) + "</table>")
    pct = round(100 * done_total / need_total) if need_total else 0
    PLAN.write_text(f"""<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>План картинок</title>
<style>body{{font:15px/1.5 Segoe UI,Roboto,Arial,sans-serif;max-width:760px;margin:0 auto;padding:20px;color:#1F2937;background:#F6F7FB}}
h1{{margin:0}}h2{{margin:26px 0 8px}}table{{width:100%;border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden}}
td,th{{padding:6px 10px;border-bottom:1px solid #EEE;text-align:center}}td:first-child,th:first-child{{text-align:left}}
th{{font-size:13px;color:#6B7280;font-weight:600}}.ok{{color:#10B981;font-weight:700}}.no{{color:#E74C3C}}.na{{background:#FAFAFC}}
.x{{color:#6C5CE7}}.bar{{height:14px;background:#E6E8F0;border-radius:8px;overflow:hidden;margin:10px 0}}
.bar div{{height:100%;background:#6C5CE7;width:{pct}%}}</style></head><body>
<h1>План картинок</h1><p>Нарисовано {done_total} из {need_total} нужных вариантов ({pct}%) ·
картинок всего: {len(items)} · собрано {datetime.now():%d.%m.%Y %H:%M}</p><div class="bar"><div></div></div>
<p style="color:#6B7280">✓ есть · — нужно нарисовать · пусто — не нужно. Какие варианты нужны, задаётся в словарь.csv, колонка «варианты».</p>
{"".join(parts)}</body></html>""", encoding="utf-8")
    return done_total, need_total


# ---------------------------------------------------------------- main
def main():
    IMAGES.mkdir(exist_ok=True)
    if prepare.Image is None:
        print("! Не установлен Pillow — картинки не будут переводиться в WebP.\n"
              "  Удалите папку _python и запустите Собрать.cmd ещё раз.\n")
    rows = read_dict()
    index = {}
    for r in rows:
        k = norm(r["слово"])
        if k in index:
            report["warn"].append(f"словарь: слово «{r['слово']}» записано дважды")
        index.setdefault(k, r)

    print("1) Папка «новые»")
    process_inbox(rows, index)
    print("2) Проверка images/")
    normalize_images()
    print("3) Каталог")
    meta = read_meta()
    items, cats = build_catalog(rows, index, meta)
    for k in [k for k, m in meta.items() if not m.get("_used")]:
        report["warn"].append(f"картинки.csv: {k} — такого файла нет, строка убрана")
        del meta[k]
    for m in meta.values():
        m.pop("_used", None)
    write_meta(meta)
    write_dict(rows)

    old = {}
    if CATALOG.exists():
        try:
            old = json.loads(CATALOG.read_text("utf-8"))
        except Exception:
            pass
    updated = old.get("updated") if old.get("items") == items else date.today().isoformat()
    catalog = {
        "version": 1,
        "name": "Картинки «Мой день»",
        "count": len(items),
        "updated": updated or date.today().isoformat(),
        "words": len({i["word"] for i in items}),
        "categories": cats,
        "variants": VARIANTS,
        "items": items,
    }
    CATALOG.write_text(json.dumps(catalog, ensure_ascii=False, indent=1), encoding="utf-8")
    CATALOG_JS.write_text("window.CATALOG=" + json.dumps(catalog, ensure_ascii=False,
                          separators=(",", ":")) + ";\n", encoding="utf-8")
    gone = {i["id"] for i in old.get("items", [])} - {i["id"] for i in items}
    if gone:
        report["warn"].append(f"из каталога пропали ({len(gone)}): {', '.join(sorted(gone)[:8])}"
                              + (" …" if len(gone) > 8 else "") + " — их адреса больше не работают")
    done, need = build_plan(rows, items)

    # ---- отчёт (его показывает админка)
    REPORT.write_text(json.dumps({
        "time": datetime.now().isoformat(timespec="seconds"),
        "count": len(items), "words": catalog["words"], "plan": [done, need],
        **report}, ensure_ascii=False, indent=1), encoding="utf-8")
    print()
    def block(title, lst, mark="•"):
        if lst:
            print(f"{title} ({len(lst)}):")
            for x in lst[:40]:
                print(f"   {mark} {x}")
            if len(lst) > 40:
                print(f"   … и ещё {len(lst) - 40}")
    block("Добавлено", report["added"])
    block("Заменено (адрес прежний)", report["replaced"])
    block("Новые слова в словаре", report["new_words"])
    block("ОСТАЛИСЬ в папке «новые»", report["left"], "!")
    block("Предупреждения", report["warn"], "!")
    total = sum(i["bytes"] for i in items)
    print(f"\nИтого: {len(items)} картинок, {catalog['words']} слов, {len(cats)} категорий, "
          f"{total / 1024 / 1024:.1f} МБ. План: {done} из {need} вариантов.")
    print("Что ещё нарисовать — откройте план.html")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"\nОШИБКА: {e}\nПришлите этот текст в чат — разберёмся.")
        raise
