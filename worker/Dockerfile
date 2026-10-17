FROM python:3.12-slim

# OpenCV runtime libraries
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY linewatch ./linewatch
COPY zone.json ./zone.json

ENV PYTHONUNBUFFERED=1 \
    ZONE_FILE=/app/zone.json \
    OUT_DIR=/app/out

EXPOSE 8090
CMD ["python", "-m", "linewatch.main"]
