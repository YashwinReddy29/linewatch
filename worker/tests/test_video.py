import cv2
import numpy as np

from linewatch.video import VideoSource


def make_clip(path, frames=20, fps=25):
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"MJPG"), fps, (64, 48))
    for i in range(frames):
        writer.write(np.full((48, 64, 3), i * 10, dtype=np.uint8))
    writer.release()


def test_stride_reads_every_nth_frame_once(tmp_path):
    clip = tmp_path / "clip.avi"
    make_clip(clip, frames=20)
    source = VideoSource(str(clip), loop=False, stride=5)
    frames = []
    while (frame := source.read()) is not None:
        frames.append(frame)
    # frames 0, 5, 10, 15, then the clip ends
    assert len(frames) == 4
    assert [round(f.mean() / 10) for f in frames] == [0, 5, 10, 15]
