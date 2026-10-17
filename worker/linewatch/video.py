"""Video input that behaves like a live camera.

A video file read in a tight loop plays at whatever speed inference allows.
To keep the "live" view honest, file sources skip frames to stay in step
with the wall clock, the way a real camera feed would drop frames on a
slow machine.
"""

from __future__ import annotations

import time

import cv2
import numpy as np


class VideoSource:
    def __init__(self, source: str, loop: bool = True, max_width: int = 1280, stride: int = 0) -> None:
        self.source = source
        self.loop = loop
        # stride > 0: read every stride-th frame of a file, ignoring the wall clock. Every run of the
        # same clip then sees the same frames, which is what an evaluation pass needs.
        self.stride = stride
        self.max_width = max_width
        self.is_file = not (source.isdigit() or "://" in source)
        self._cap: cv2.VideoCapture | None = None
        self._open()

    def _open(self) -> None:
        target = int(self.source) if self.source.isdigit() else self.source
        self._cap = cv2.VideoCapture(target)
        if not self._cap.isOpened():
            raise RuntimeError(f"Could not open video source: {self.source}")
        fps = self._cap.get(cv2.CAP_PROP_FPS)
        self.fps = fps if fps and fps > 1 else 25.0
        self._started = time.monotonic()
        self._index = 0

    def _resize(self, frame: np.ndarray) -> np.ndarray:
        h, w = frame.shape[:2]
        if w <= self.max_width:
            return frame
        scale = self.max_width / w
        return cv2.resize(frame, (self.max_width, int(h * scale)), interpolation=cv2.INTER_AREA)

    def read(self) -> np.ndarray | None:
        assert self._cap is not None
        if self.is_file and self.stride > 0:
            for _ in range(self.stride - 1 if self._index else 0):
                if not self._cap.grab():
                    return self._restart_or_end()
                self._index += 1
        elif self.is_file:
            target = int((time.monotonic() - self._started) * self.fps)
            while self._index < target:
                if not self._cap.grab():
                    return self._restart_or_end()
                self._index += 1
        ok, frame = self._cap.read()
        if not ok:
            return self._restart_or_end()
        self._index += 1
        return self._resize(frame)

    def _restart_or_end(self) -> np.ndarray | None:
        if not (self.is_file and self.loop):
            return None
        self.release()
        self._open()
        ok, frame = self._cap.read()  # type: ignore[union-attr]
        self._index = 1
        return self._resize(frame) if ok else None

    def release(self) -> None:
        if self._cap is not None:
            self._cap.release()
            self._cap = None
