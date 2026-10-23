import json
import os
import shutil
import sys

import pymupdf

BASE14 = {
    "helv": "helv", "helvetica": "helv", "arial": "helv",
    "times": "tiro", "timesnewroman": "tiro", "tiro": "tiro",
    "courier": "cour", "couriernew": "cour", "cour": "cour",
}


def color_to_rgb(value):
    if isinstance(value, (list, tuple)):
        return tuple(value)
    value = (value or "#000000").lstrip("#")
    return tuple(int(value[i:i + 2], 16) / 255 for i in (0, 2, 4))


def int_to_rgb(value):
    return ((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255


def font_key(name):
    return "".join(ch for ch in (name or "").lower().split("-")[0] if ch.isalpha())


STYLED = {
    "helv": ("helv", "hebo", "heit", "hebi"),
    "tiro": ("tiro", "tibo", "tiit", "tibi"),
    "cour": ("cour", "cobo", "coit", "cobi"),
}


def pick_font(name, flags=0):
    key = font_key(name)
    family = "helv"
    for token, code in BASE14.items():
        if token in key:
            family = code
            break
    lowered = (name or "").lower()
    bold = bool(flags & 16) or "bold" in lowered or "black" in lowered
    italic = bool(flags & 2) or "italic" in lowered or "oblique" in lowered
    return STYLED[family][(1 if bold else 0) + (2 if italic else 0)]


def is_standard_font(name):
    key = font_key(name)
    return any(token in key for token in BASE14)


def rect_of(r):
    return pymupdf.Rect(r["x0"], r["y0"], r["x1"], r["y1"])


def editable_page(doc, number):
    page = doc[number]
    if page.rotation:
        raise ValueError("La página está girada; devuélvala a 0° para editar su contenido")
    return page


def save(doc, out, src=None):
    if src and os.path.abspath(src) == os.path.abspath(out):
        tmp = out + ".tmp"
        doc.save(tmp, garbage=3, deflate=True)
        doc.close()
        shutil.move(tmp, out)
    else:
        doc.save(out, garbage=3, deflate=True)
        doc.close()


def open_doc(path):
    doc = pymupdf.open(path)
    if doc.needs_pass:
        raise ValueError("El documento está protegido con contraseña")
    return doc


def cmd_info(a):
    doc = open_doc(a["src"])
    pages = [{"w": p.rect.width, "h": p.rect.height, "rotation": p.rotation} for p in doc]
    scanned = sum(1 for p in doc if not p.get_text("text").strip() and p.get_images())
    result = {"pages": pages, "scannedPages": scanned, "hasForm": doc.is_form_pdf}
    doc.close()
    return result


def cmd_merge(a):
    out = pymupdf.open()
    for path in a["inputs"]:
        src = open_doc(path)
        out.insert_pdf(src)
        src.close()
    save(out, a["out"])
    return {}


def cmd_delete_pages(a):
    doc = open_doc(a["src"])
    if len(set(a["pages"])) >= len(doc):
        raise ValueError("No se pueden eliminar todas las páginas")
    doc.delete_pages(sorted(set(a["pages"])))
    save(doc, a["out"], a["src"])
    return {}


def cmd_rotate(a):
    doc = open_doc(a["src"])
    for i in a["pages"]:
        page = doc[i]
        page.set_rotation((page.rotation + a["angle"]) % 360)
    save(doc, a["out"], a["src"])
    return {}


def cmd_reorder(a):
    doc = open_doc(a["src"])
    doc.select(a["order"])
    save(doc, a["out"], a["src"])
    return {}


def cmd_extract(a):
    doc = open_doc(a["src"])
    doc.select(sorted(set(a["pages"])))
    save(doc, a["out"])
    return {}


def cmd_split(a):
    doc = open_doc(a["src"])
    os.makedirs(a["outdir"], exist_ok=True)
    stem = os.path.splitext(os.path.basename(a["src"]))[0]
    ranges = a.get("ranges") or [[i, i] for i in range(len(doc))]
    files = []
    for start, end in ranges:
        part = pymupdf.open()
        part.insert_pdf(doc, from_page=start, to_page=end)
        path = os.path.join(a["outdir"], f"{stem}_{start + 1}-{end + 1}.pdf")
        part.save(path, garbage=3, deflate=True)
        part.close()
        files.append(path)
    doc.close()
    return {"files": files}


def cmd_words(a):
    doc = open_doc(a["src"])
    page = doc[a["page"]]
    words = [
        {"x0": w[0], "y0": w[1], "x1": w[2], "y1": w[3], "text": w[4], "block": w[5], "line": w[6]}
        for w in page.get_text("words")
    ]
    doc.close()
    return {"words": words}


def cmd_search(a):
    doc = open_doc(a["src"])
    hits = []
    for number, page in enumerate(doc):
        for rect in page.search_for(a["query"]):
            hits.append({"page": number, "x0": rect.x0, "y0": rect.y0, "x1": rect.x1, "y1": rect.y1})
    doc.close()
    return {"hits": hits}


def cmd_add_text(a):
    doc = open_doc(a["src"])
    page = editable_page(doc, a["page"])
    font = pick_font(a.get("font"))
    size = a.get("size", 12)
    color = color_to_rgb(a.get("color"))
    lines = a["text"].splitlines() or [""]
    x = a["x"] + 1.5
    first_baseline = a["y"] + 0.5 + size * 0.945
    for i, line in enumerate(lines):
        page.insert_text(pymupdf.Point(x, first_baseline + i * size * 1.2), line, fontname=font, fontsize=size, color=color)
    width = max(pymupdf.get_text_length(line, fontname=font, fontsize=size) for line in lines)
    warnings = []
    if x + width > page.rect.x1 or first_baseline + (len(lines) - 1) * size * 1.2 > page.rect.y1:
        warnings.append("El texto sobrepasa el borde de la página")
    save(doc, a["out"], a["src"])
    return {"warnings": warnings}


def cmd_add_image(a):
    doc = open_doc(a["src"])
    page = editable_page(doc, a["page"])
    page.insert_image(rect_of(a["rect"]), filename=a["image"], keep_proportion=a.get("keepProportion", True))
    save(doc, a["out"], a["src"])
    return {}


def cmd_highlight(a):
    doc = open_doc(a["src"])
    page = editable_page(doc, a["page"])
    for r in a["rects"]:
        annot = page.add_highlight_annot(rect_of(r))
        if a.get("color"):
            annot.set_colors(stroke=color_to_rgb(a["color"]))
            annot.update()
    save(doc, a["out"], a["src"])
    return {}


def cmd_note(a):
    doc = open_doc(a["src"])
    editable_page(doc, a["page"]).add_text_annot(pymupdf.Point(a["x"], a["y"]), a["text"])
    save(doc, a["out"], a["src"])
    return {}


def cmd_draw(a):
    doc = open_doc(a["src"])
    page = editable_page(doc, a["page"])
    for stroke in a["strokes"]:
        points = [pymupdf.Point(p[0], p[1]) for p in stroke]
        if len(points) > 1:
            annot = page.add_polyline_annot(points)
            annot.set_colors(stroke=color_to_rgb(a.get("color")))
            annot.set_border(width=a.get("width", 2))
            annot.update()
    save(doc, a["out"], a["src"])
    return {}


_OFFSETS = {}


def baseline_offset(font, size, lineheight):
    key = (font, round(size, 2), round(lineheight, 3))
    if key not in _OFFSETS:
        tmp = pymupdf.open()
        sheet = tmp.new_page(width=400, height=400)
        sheet.insert_textbox(pymupdf.Rect(20, 20, 380, 380), "Hg", fontname=font, fontsize=size, lineheight=lineheight)
        chars = sheet.get_text("rawdict")["blocks"][0]["lines"][0]["spans"][0]["chars"]
        _OFFSETS[key] = chars[0]["origin"][1] - 20
        tmp.close()
    return _OFFSETS[key]


def place_text(page, rect, text, font, size, color, align, lineheight, baseline, grow_to):
    for factor in (1, 0.92, 0.85, 0.78, 0.7):
        s = size * factor
        top = baseline - baseline_offset(font, s, lineheight)
        base_bottom = rect.y1 + s * 0.3
        bottom = base_bottom
        step = s * lineheight
        while True:
            box = pymupdf.Rect(rect.x0, top, rect.x1, bottom)
            if page.insert_textbox(box, text, fontname=font, fontsize=s, color=color, align=align, lineheight=lineheight) >= 0:
                return s, int(round((bottom - base_bottom) / step)), factor < 1
            if bottom + step > grow_to:
                break
            bottom += step
    return None


def place_justified_line(page, box, text, font, size, color, baseline):
    words = text.split()
    widths = [pymupdf.get_text_length(w, fontname=font, fontsize=size) for w in words]
    natural = sum(widths) + pymupdf.get_text_length(" ", fontname=font, fontsize=size) * (len(words) - 1)
    shrunk = False
    if natural > box.width:
        fitted = size * box.width / natural
        if fitted < size * 0.7:
            return None
        size, shrunk = fitted, True
        widths = [pymupdf.get_text_length(w, fontname=font, fontsize=size) for w in words]
    gap = (box.width - sum(widths)) / (len(words) - 1)
    x = box.x0
    for word, width in zip(words, widths):
        page.insert_text(pymupdf.Point(x, baseline), word, fontname=font, fontsize=size, color=color)
        x += width + gap
    return size, 0, shrunk


def find_block(page, x, y):
    point = pymupdf.Point(x, y)
    for block in page.get_text("dict")["blocks"]:
        if block["type"] == 0 and block["lines"] and (pymupdf.Rect(block["bbox"]) + (-2, -2, 2, 2)).contains(point):
            return block
    return None


def line_text(line):
    return "".join(span["text"] for span in line["spans"]).strip()


def block_text(block):
    return " ".join(" ".join(line_text(line).split()) for line in block["lines"] if line_text(line))


def block_style(block):
    weight = {}
    for line in block["lines"]:
        for span in line["spans"]:
            key = (span["font"], span["flags"], round(span["size"], 1), span["color"])
            weight[key] = weight.get(key, 0) + len(span["text"].strip())
    ranked = sorted(weight.items(), key=lambda item: -item[1])
    font, flags, size, color = ranked[0][0]
    return {"font": font, "flags": flags, "size": size, "color": color, "mixed": len(ranked) > 1}


def detect_align(block, page):
    lines = block["lines"]
    if len(lines) >= 2:
        rights = [line["bbox"][2] for line in lines[:-1]]
        if max(rights) - min(rights) <= 3:
            return 3
        centers = [(line["bbox"][0] + line["bbox"][2]) / 2 for line in lines]
        return 1 if max(centers) - min(centers) <= 3 else 0
    box = lines[0]["bbox"]
    return 1 if abs((box[0] + box[2]) / 2 - page.rect.width / 2) <= 3 else 0


def block_lineheight(block, size):
    origins = [line["spans"][0]["origin"][1] for line in block["lines"] if line["spans"]]
    gaps = sorted(b - a for a, b in zip(origins, origins[1:]) if b - a > 0)
    return gaps[len(gaps) // 2] / size if gaps else 1.2


def cmd_block_at(a):
    doc = open_doc(a["src"])
    page = doc[a["page"]]
    block = find_block(page, a["x"], a["y"])
    if not block:
        doc.close()
        raise ValueError("No hay un párrafo editable ahí. Si es un escaneo, use «Reconocer texto (OCR)»")
    style = block_style(block)
    box = block["bbox"]
    result = {
        "block": {
            "x0": box[0], "y0": box[1], "x1": box[2], "y1": box[3],
            "text": block_text(block), "size": style["size"], "lines": len(block["lines"]),
            "mixed": style["mixed"],
        }
    }
    doc.close()
    return result


def cmd_paragraph(a):
    doc = open_doc(a["src"])
    page = editable_page(doc, a["page"])
    block = find_block(page, a["x"], a["y"])
    if not block:
        raise ValueError("No hay un párrafo editable ahí")
    style = block_style(block)
    size = a.get("size") or style["size"]
    font = pick_font(style["font"], style["flags"])
    color = color_to_rgb(a["color"]) if a.get("color") else int_to_rgb(style["color"])
    align = detect_align(block, page)
    lineheight = block_lineheight(block, style["size"])
    first = block["lines"][0]["spans"][0]
    baseline = first["origin"][1]
    rect = pymupdf.Rect(block["bbox"])
    warnings = []
    if not is_standard_font(style["font"]):
        warnings.append(f"La fuente original «{style['font']}» no está disponible; se usó una fuente estándar equivalente")
    if style["mixed"]:
        warnings.append("El párrafo tenía varios estilos (negrita, tamaños o colores); el texto nuevo usa el estilo principal")
    inner = pymupdf.Rect(rect.x0 + 0.3, rect.y0 + 0.3, rect.x1 - 0.3, rect.y1 - 0.3)
    page.add_redact_annot(inner, fill=False)
    page.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE, graphics=pymupdf.PDF_REDACT_LINE_ART_NONE)
    placed = place_text(page, rect, a["text"], font, size, color, align, lineheight, baseline, page.rect.y1 - 36)
    if not placed:
        raise ValueError("El texto nuevo no cabe en la página con este formato")
    used, grew, shrunk = placed
    if grew > 0:
        warnings.append(f"El párrafo creció {grew} línea(s) hacia abajo; revise que no tape contenido")
    if shrunk:
        warnings.append(f"El párrafo no cabía y se redujo el tamaño a {used:.1f} pt")
    save(doc, a["out"], a["src"])
    return {"warnings": warnings}


def collect_chars(page, area):
    chars = []
    for block in page.get_text("rawdict", clip=area)["blocks"]:
        for line in block.get("lines", []):
            for span in line["spans"]:
                for ch in span["chars"]:
                    box = pymupdf.Rect(ch["bbox"])
                    center = pymupdf.Point((box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2)
                    if ch["c"].strip() and area.contains(center):
                        chars.append((ch, span))
    return chars


def cmd_recolor(a):
    doc = open_doc(a["src"])
    page = editable_page(doc, a["page"])
    chars = collect_chars(page, rect_of(a["rect"]))
    if not chars:
        raise ValueError("No hay texto editable en la selección (¿es un escaneo? use OCR)")
    color = color_to_rgb(a["color"])
    target = pymupdf.Rect(chars[0][0]["bbox"])
    for ch, _ in chars[1:]:
        target |= pymupdf.Rect(ch["bbox"])
    page.add_redact_annot(pymupdf.Rect(target.x0 + 0.3, target.y0 + 0.3, target.x1 - 0.3, target.y1 - 0.3), fill=False)
    page.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE, graphics=pymupdf.PDF_REDACT_LINE_ART_NONE)
    for ch, span in chars:
        font = pick_font(span["font"], span["flags"])
        page.insert_text(pymupdf.Point(*ch["origin"]), ch["c"], fontname=font, fontsize=span["size"], color=color)
    warnings = []
    if any(not is_standard_font(span["font"]) for _, span in chars):
        warnings.append("La fuente original no está disponible; el texto pintado usa una fuente estándar equivalente")
    save(doc, a["out"], a["src"])
    return {"warnings": warnings}


def line_chars(page, line_box):
    box = pymupdf.Rect(line_box)
    found = []
    for block in page.get_text("rawdict")["blocks"]:
        for line in block.get("lines", []):
            if all(abs(u - v) < 0.6 for u, v in zip(line["bbox"], box)):
                for span in line["spans"]:
                    for ch in span["chars"]:
                        found.append((ch, span))
    return found


def plan_reflow(page, block, chars, origin, text, font, size, target):
    if not block:
        return None
    probe = pymupdf.Point(origin[0] + 1, origin[1] - 2)
    line = next((ln for ln in block["lines"] if pymupdf.Rect(ln["bbox"]).contains(probe)), None)
    align = detect_align(block, page)
    if not line or align not in (0, 1):
        return None
    left, right = target.x0 - 0.3, target.x1 + 0.3
    everything = line_chars(page, line["bbox"])
    if not everything:
        return None
    before = [c for c in everything if c[0]["bbox"][2] <= left + 0.5 and c[0]["c"].strip()]
    after = [c for c in everything if c[0]["bbox"][0] >= right - 0.5 and c[0]["c"].strip()]
    delta = pymupdf.get_text_length(text, fontname=font, fontsize=size) - (right - left)
    line_left, line_right = line["bbox"][0], line["bbox"][2]
    margin = 36
    if align == 0:
        limit = max(page.rect.x1 - margin, block["bbox"][2])
        end = max([c[0]["bbox"][2] for c in after], default=left + (right - left)) + delta
        if delta > 0 and max(end, origin[0] + pymupdf.get_text_length(text, fontname=font, fontsize=size)) > limit + 0.5:
            return None
        shift_before, shift_after = 0.0, delta
    else:
        shift_before, shift_after = -delta / 2, delta / 2
        if line_left + shift_before < 20 or line_right + shift_after > page.rect.x1 - 20:
            return None
    return {"line": line, "before": before, "after": after, "sb": shift_before, "sa": shift_after, "everything": everything}


def draw_moved(page, items, dx):
    for ch, span in items:
        font = pick_font(span["font"], span["flags"])
        page.insert_text(pymupdf.Point(ch["origin"][0] + dx, ch["origin"][1]), ch["c"], fontname=font, fontsize=span["size"], color=int_to_rgb(span["color"]))


def cmd_replace_text(a):
    doc = open_doc(a["src"])
    page = editable_page(doc, a["page"])
    area = rect_of(a["rect"])
    chars = collect_chars(page, area)
    if not chars:
        raise ValueError("No hay texto editable en la selección (¿es un escaneo? use OCR)")
    first_char, ref = chars[0]
    size = a.get("size") or ref["size"]
    color = color_to_rgb(a["color"]) if a.get("color") else int_to_rgb(ref["color"])
    font_name = a.get("font") or ref["font"]
    font = pick_font(font_name, ref["flags"] if not a.get("font") else 0)
    warnings = []
    if not is_standard_font(font_name):
        warnings.append(f"La fuente original «{font_name}» no está disponible; se usó una fuente estándar equivalente")
    target = pymupdf.Rect(chars[0][0]["bbox"])
    for ch, _ in chars[1:]:
        target |= pymupdf.Rect(ch["bbox"])
    target = pymupdf.Rect(target.x0 + 0.3, target.y0 + 0.3, target.x1 - 0.3, target.y1 - 0.3)
    origin = first_char["origin"]
    block = find_block(page, origin[0] + 1, origin[1] - 2)
    plan = plan_reflow(page, block, chars, origin, a["new"], font, size, target) if a.get("fit") and not a.get("noReflow") else None
    if plan:
        whole = pymupdf.Rect(plan["everything"][0][0]["bbox"])
        for ch, _ in plan["everything"][1:]:
            whole |= pymupdf.Rect(ch["bbox"])
        page.add_redact_annot(pymupdf.Rect(whole.x0 + 0.3, whole.y0 + 0.3, whole.x1 - 0.3, whole.y1 - 0.3), fill=False)
        page.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE, graphics=pymupdf.PDF_REDACT_LINE_ART_NONE)
        draw_moved(page, plan["before"], plan["sb"])
        page.insert_text(pymupdf.Point(origin[0] + plan["sb"], origin[1]), a["new"], fontname=font, fontsize=size, color=color)
        draw_moved(page, plan["after"], plan["sa"])
        if abs(plan["sa"] - plan["sb"]) > 0.5:
            warnings.append("El resto de la línea se desplazó para dar espacio al texto nuevo")
        save(doc, a["out"], a["src"])
        return {"warnings": warnings}
    page.add_redact_annot(target, fill=False)
    page.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE, graphics=pymupdf.PDF_REDACT_LINE_ART_NONE)
    needed = pymupdf.get_text_length(a["new"], fontname=font, fontsize=size)
    limit = page.rect.x1 - 36
    for w in page.get_text("words"):
        same_line = min(w[3], target.y1) - max(w[1], target.y0) > target.height * 0.5
        if same_line and w[0] >= target.x1 - 0.5 and w[0] - 2 < limit:
            limit = w[0] - 2
    available = max(limit - target.x0, target.width)
    if needed > available:
        if a.get("fit"):
            fitted = size * available / needed
            size = max(fitted, size * 0.7)
            if fitted < size:
                warnings.append("El texto nuevo es demasiado largo: se redujo al 70 % y puede invadir contenido vecino")
            else:
                warnings.append("El texto nuevo se redujo de tamaño para caber en el espacio disponible")
        else:
            warnings.append(f"El texto nuevo es {needed - available:.0f} pt más ancho que el espacio disponible y puede invadir contenido vecino")
    placed = None
    if block and len(a["new"].split()) > 1:
        line = next((ln for ln in block["lines"] if pymupdf.Rect(ln["bbox"]).contains(pymupdf.Point(origin[0] + 1, origin[1] - 2))), None)
        selected = sum(len(ch["c"].strip()) for ch, _ in chars)
        total = len("".join(line_text(line).split())) if line else 0
        if line and selected >= total and line is not block["lines"][-1] and detect_align(block, page) == 3:
            box = pymupdf.Rect(line["bbox"])
            placed = place_justified_line(page, box, a["new"], font, size, color, origin[1])
            if placed:
                size = placed[0]
                if placed[2]:
                    warnings.append("El texto nuevo se redujo para conservar la justificación de la línea")
    if not placed:
        page.insert_text(pymupdf.Point(origin[0], origin[1]), a["new"], fontname=font, fontsize=size, color=color)
    save(doc, a["out"], a["src"])
    return {"warnings": warnings}


def cmd_redact(a):
    doc = open_doc(a["src"])
    page = editable_page(doc, a["page"])
    for r in a["rects"]:
        page.add_redact_annot(rect_of(r), fill=(0, 0, 0))
    page.apply_redactions()
    save(doc, a["out"], a["src"])
    return {}


def cmd_fields(a):
    doc = open_doc(a["src"])
    fields = []
    for number, page in enumerate(doc):
        for w in page.widgets():
            fields.append({
                "page": number, "name": w.field_name, "type": w.field_type_string,
                "value": w.field_value, "choices": w.choice_values,
            })
    doc.close()
    return {"fields": fields}


def cmd_fill(a):
    doc = open_doc(a["src"])
    values = a["values"]
    for page in doc:
        for w in page.widgets():
            if w.field_name in values:
                w.field_value = values[w.field_name]
                w.update()
    save(doc, a["out"], a["src"])
    return {}


def bundled_tessdata():
    here = os.path.dirname(os.path.abspath(sys.executable if getattr(sys, "frozen", False) else __file__))
    for folder in (os.path.join(here, "..", "tessdata"), os.path.join(here, "tessdata"), os.path.join(here, "..", "..", "tessdata")):
        folder = os.path.normpath(folder)
        if os.path.isfile(os.path.join(folder, "spa.traineddata")):
            return folder
    return None


def locate_tesseract():
    data = bundled_tessdata()
    if data:
        os.environ["TESSDATA_PREFIX"] = data
        return True
    if shutil.which("tesseract"):
        return True
    candidates = [
        os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs", "Tesseract-OCR"),
        os.path.join(os.environ.get("ProgramFiles", ""), "Tesseract-OCR"),
        "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin",
    ]
    for folder in candidates:
        for name in ("tesseract.exe", "tesseract"):
            if folder and os.path.isfile(os.path.join(folder, name)):
                os.environ["PATH"] = folder + os.pathsep + os.environ.get("PATH", "")
                tessdata = os.path.join(folder, "tessdata")
                if os.path.isdir(tessdata) and not os.environ.get("TESSDATA_PREFIX"):
                    os.environ["TESSDATA_PREFIX"] = tessdata
                return True
    return False


def cmd_ocr(a):
    if not locate_tesseract():
        raise ValueError("No se encontraron los datos de reconocimiento de texto (tessdata)")
    doc = open_doc(a["src"])
    out = pymupdf.open()
    for number, page in enumerate(doc):
        if page.get_text("text").strip():
            out.insert_pdf(doc, from_page=number, to_page=number)
            continue
        data = page.get_pixmap(dpi=a.get("dpi", 300)).pdfocr_tobytes(language=a.get("lang", "spa"))
        part = pymupdf.open("pdf", data)
        out.insert_pdf(part)
        part.close()
    doc.close()
    save(out, a["out"])
    return {}


def cmd_copy(a):
    shutil.copyfile(a["src"], a["out"])
    return {}


def cmd_version(a):
    return {"pymupdf": pymupdf.__version__}


COMMANDS = {name[4:]: fn for name, fn in list(globals().items()) if name.startswith("cmd_")}


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stdin.reconfigure(encoding="utf-8")
    name = sys.argv[1]
    args = json.loads(sys.stdin.read() or "{}")
    try:
        result = COMMANDS[name](args)
        print(json.dumps({"ok": True, **result}))
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}))


if __name__ == "__main__":
    main()
