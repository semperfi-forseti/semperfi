from __future__ import annotations

import hashlib
import io
import json
from datetime import UTC, datetime
from textwrap import wrap


def canonical_hash(document: dict) -> str:
    return hashlib.sha256(json.dumps(document, sort_keys=True, ensure_ascii=False, default=str).encode()).hexdigest()


def build_pdf_bytes(title: str, report_body: dict, manifest: dict) -> bytes:
    try:
        from reportlab.lib.pagesizes import A4
        from reportlab.pdfgen import canvas
    except ImportError as exc:
        raise RuntimeError("Dependência reportlab ausente para geração de PDF.") from exc
    output = io.BytesIO()
    pdf = canvas.Canvas(output, pagesize=A4)
    width, height = A4
    y = height - 52
    pdf.setTitle(title)
    pdf.setFont("Helvetica-Bold", 16)
    pdf.drawString(48, y, title[:100]); y -= 28
    pdf.setFont("Helvetica", 8)
    pdf.drawString(48, y, f"SEMPER-FI • versão gerada em {datetime.now(UTC).isoformat()}"); y -= 20
    blocks = [("Objeto", report_body.get("object")), ("Finalidade", report_body.get("purpose")), ("Metodologia", report_body.get("methodology")), ("Conclusão técnica", report_body.get("technical_conclusion")), ("Limitações", report_body.get("limitations")), ("Manifesto", manifest)]
    for heading, content in blocks:
        if content in (None, "", [], {}):
            continue
        pdf.setFont("Helvetica-Bold", 11)
        pdf.drawString(48, y, heading); y -= 15
        pdf.setFont("Helvetica", 8)
        for line in wrap(json.dumps(content, ensure_ascii=False, default=str) if isinstance(content, (dict, list)) else str(content), 118):
            if y < 48:
                pdf.showPage(); y = height - 52; pdf.setFont("Helvetica", 8)
            pdf.drawString(48, y, line); y -= 11
        y -= 9
    pdf.save()
    return output.getvalue()
