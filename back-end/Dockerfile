FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends file libimage-exiftool-perl qpdf ffmpeg tesseract-ocr clamav && rm -rf /var/lib/apt/lists/*
COPY pyproject.toml README.md ./
COPY app ./app
RUN pip install --upgrade pip && pip install .
COPY . .
RUN useradd --create-home --uid 10001 semperfi && mkdir -p /tmp/semperfi-evidence && chown -R semperfi:semperfi /app /tmp/semperfi-evidence
USER semperfi
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
