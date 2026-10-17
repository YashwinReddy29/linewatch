FROM python:3.12-slim

# OpenCV runtime libraries
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Unprivileged user. docker-compose.yml runs it with your own uid so ./out stays writable.
RUN useradd --uid 1000 --create-home app && mkdir -p /app/out && chown app:app /app/out
COPY --chown=app:app linewatch ./linewatch
COPY --chown=app:app zone.json ./zone.json
USER app

ENV PYTHONUNBUFFERED=1 \
    ZONE_FILE=/app/zone.json \
    OUT_DIR=/app/out

EXPOSE 8090
HEALTHCHECK --interval=10s --timeout=3s --start-period=60s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8090/health', timeout=2)"
CMD ["python", "-m", "linewatch.main"]
