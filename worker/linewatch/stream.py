"""Tiny HTTP server for the browser.

GET /stream.mjpg  annotated live view (MJPEG; the web app proxies it behind its login)
GET /frame.jpg    latest raw frame (the zone editor draws on this)
GET /health       liveness + JSON status for the console (always 200 while the process runs)
GET /ready        200 only while frames are being processed, else 503
GET /metrics      Prometheus metrics

Only the web app and a metrics scraper are meant to reach this port: it is not published
by docker-compose.yml.
"""

from __future__ import annotations

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import cv2
import numpy as np
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest

from .metrics import REGISTRY


class FrameHub:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._annotated: bytes | None = None
        self._raw: bytes | None = None
        self._seq = 0
        self.status: dict = {"state": "starting", "message": "Starting worker"}

    def publish(self, raw: np.ndarray, annotated: np.ndarray) -> None:
        ok_a, buf_a = cv2.imencode(".jpg", annotated, [cv2.IMWRITE_JPEG_QUALITY, 80])
        ok_r, buf_r = cv2.imencode(".jpg", raw, [cv2.IMWRITE_JPEG_QUALITY, 85])
        with self._lock:
            if ok_a:
                self._annotated = buf_a.tobytes()
            if ok_r:
                self._raw = buf_r.tobytes()
            self._seq += 1

    def latest(self, raw: bool = False) -> tuple[int, bytes | None]:
        with self._lock:
            return self._seq, (self._raw if raw else self._annotated)

    def set_status(self, state: str, message: str, **extra) -> None:
        self.status = {"state": state, "message": message, "updated_at": time.time(), **extra}


def _handler_for(hub: FrameHub):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args) -> None:  # keep the console readable
            pass

        def _cors(self) -> None:  # no CORS: browsers reach the stream through the web app only
            self.send_header("Cache-Control", "no-store")

        def _send(self, status: int, content_type: str, body: bytes) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self._cors()
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:
            path = self.path.split("?")[0]
            if path == "/health":
                self._send(200, "application/json", json.dumps(hub.status).encode())
            elif path == "/ready":
                running = hub.status.get("state") == "running"
                self._send(200 if running else 503, "application/json", json.dumps(hub.status).encode())
            elif path == "/metrics":
                self._send(200, CONTENT_TYPE_LATEST, generate_latest(REGISTRY))
            elif path == "/frame.jpg":
                _, jpg = hub.latest(raw=True)
                if jpg is None:
                    self.send_response(503)
                    self._cors()
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header("Content-Type", "image/jpeg")
                self._cors()
                self.end_headers()
                self.wfile.write(jpg)
            elif path == "/stream.mjpg":
                self.send_response(200)
                self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
                self._cors()
                self.end_headers()
                last_seq = -1
                try:
                    while True:
                        seq, jpg = hub.latest()
                        if jpg is None or seq == last_seq:
                            time.sleep(0.03)
                            continue
                        last_seq = seq
                        self.wfile.write(b"--frame\r\nContent-Type: image/jpeg\r\n")
                        self.wfile.write(f"Content-Length: {len(jpg)}\r\n\r\n".encode())
                        self.wfile.write(jpg + b"\r\n")
                except (BrokenPipeError, ConnectionResetError):
                    pass
            else:
                self.send_response(404)
                self.end_headers()

    return Handler


def start_stream_server(hub: FrameHub, port: int) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer(("0.0.0.0", port), _handler_for(hub))
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True, name="stream").start()
    return server
