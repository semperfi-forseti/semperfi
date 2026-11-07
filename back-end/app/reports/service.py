from __future__ import annotations

import hashlib
import io
import json
from datetime import UTC, datetime


def canonical_hash(document: dict) -> str:
    return hashlib.sha256(json.dumps(document, sort_keys=True, ensure_ascii=False, default=str).encode()).hexdigest()


def build_pdf_bytes(title: str, report_body: dict, manifest: dict) -> bytes:
    try:
        from reportlab.lib.pagesizes import A4
        from reportlab.pdfbase.pdfmetrics import stringWidth
        from reportlab.pdfgen import canvas
    except ImportError as exc:
        raise RuntimeError("Dependência reportlab ausente para geração de PDF.") from exc
    output = io.BytesIO()
    pdf = canvas.Canvas(output, pagesize=A4)
    width, height = A4
    text_width = width - 96
    y = height - 52
    pdf.setTitle(title)

    def lines(text: str, font: str, size: int):
        # Character counts do not bound printed width (e.g. WWW vs. iii).
        # Measure words and also split long hashes, URLs or uninterrupted input.
        for paragraph in text.splitlines() or [""]:
            current = ""
            for word in paragraph.split():
                candidate = f"{current} {word}" if current else word
                if stringWidth(candidate, font, size) <= text_width:
                    current = candidate
                    continue
                if current:
                    yield current
                    current = ""
                while stringWidth(word, font, size) > text_width:
                    low, high = 1, len(word)
                    while low < high:
                        mid = (low + high + 1) // 2
                        if stringWidth(word[:mid], font, size) <= text_width:
                            low = mid
                        else:
                            high = mid - 1
                    yield word[:low]
                    word = word[low:]
                current = word
            yield current

    def footer():
        pdf.saveState()
        pdf.setFont("Helvetica", 8)
        pdf.drawRightString(width - 48, 25, f"Página {pdf.getPageNumber()}")
        pdf.restoreState()

    def ensure_space(points: int):
        nonlocal y
        if y - points < 48:
            footer()
            pdf.showPage()
            y = height - 52

    def write(text: str, font: str, size: int, leading: int):
        nonlocal y
        for line in lines(text, font, size):
            ensure_space(leading)
            pdf.setFont(font, size)
            pdf.drawString(48, y, line)
            y -= leading

    write(title, "Helvetica-Bold", 16, 20)
    y -= 8
    write(f"SEMPER-FI • versão gerada em {datetime.now(UTC).isoformat()}", "Helvetica", 8, 11)
    y -= 9
    blocks = [("Objeto", report_body.get("object")), ("Finalidade", report_body.get("purpose")), ("Metodologia", report_body.get("methodology")), ("Conclusão técnica", report_body.get("technical_conclusion")), ("Limitações", report_body.get("limitations")), ("Manifesto", manifest)]
    blocks[5:5] = [(label, report_body.get(key)) for key, label in (
        ("investigation", "Investigação"), ("entities", "Entidades"), ("relations", "Vínculos entre entidades"), ("findings", "Achados registrados"),
        ("collections", "Coletas e proveniência"), ("evidence", "Evidências"))]
    for heading, content in blocks:
        if content in (None, "", [], {}):
            continue
        # Keep a section heading with at least its first content line.
        ensure_space(26)
        write(heading, "Helvetica-Bold", 11, 15)
        write(json.dumps(content, ensure_ascii=False, default=str) if isinstance(content, (dict, list)) else str(content), "Helvetica", 8, 11)
        y -= 9
    footer()
    pdf.save()
    return output.getvalue()
