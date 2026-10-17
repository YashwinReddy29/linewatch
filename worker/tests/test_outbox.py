"""Outbox delivery against a real local HTTP server that can be told to fail."""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from linewatch.outbox import Outbox, Outcome, replay
from linewatch.sink import HttpSender, classify

TOKEN = "worker-token-0123456789"


class FakeWebApp:
    """Stores incidents by id like the real web app (201 new, 200 duplicate)."""

    def __init__(self) -> None:
        self.stored: dict[str, dict] = {}
        self.posts = 0
        self.fail_next: list[int] = []  # statuses to answer with before behaving
        self.request_ids: list[str] = []
        app = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args) -> None:
                pass

            def do_POST(self) -> None:
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                app.posts += 1
                app.request_ids.append(self.headers.get("X-Request-ID", ""))
                if self.headers.get("Authorization") != f"Bearer {TOKEN}":
                    status = 401
                elif app.fail_next:
                    status = app.fail_next.pop(0)
                elif body["id"] in app.stored:
                    status = 200
                else:
                    app.stored[body["id"]] = body
                    status = 201
                self.send_response(status)
                self.send_header("Content-Length", "2")
                self.end_headers()
                self.wfile.write(b"{}")

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.server.shutdown()


@pytest.fixture
def web():
    app = FakeWebApp()
    yield app
    app.close()


def payload(n: int) -> dict:
    return {"id": f"00000000-0000-4000-8000-{n:012d}", "trackerId": n}


def drain(outbox: Outbox, limit: int = 50) -> list[Outcome]:
    outcomes = []
    while (o := outbox.process_one()) is not None and len(outcomes) < limit:
        outcomes.append(o)
    return outcomes


def test_classify_statuses():
    assert classify(201) is Outcome.DELIVERED
    assert classify(200) is Outcome.DELIVERED
    for status in (408, 429, 500, 502, 503):
        assert classify(status) is Outcome.RETRY
    for status in (400, 401, 403, 404, 413, 422):
        assert classify(status) is Outcome.DEAD


def test_put_is_durable_and_ordered(tmp_path, web):
    box = Outbox(tmp_path, HttpSender(web.url, TOKEN))
    for n in range(5):
        box.put(payload(n))
    assert box.pending_count() == 5
    assert not list(box.pending_dir.glob(".*.tmp")), "no temp files left behind"
    assert drain(box) == [Outcome.DELIVERED] * 5
    assert list(web.stored) == [payload(n)["id"] for n in range(5)], "delivered oldest first"
    assert box.pending_count() == 0


def test_sends_incident_id_as_request_id(tmp_path, web):
    box = Outbox(tmp_path, HttpSender(web.url, TOKEN))
    box.put(payload(1))
    drain(box)
    assert web.request_ids == [payload(1)["id"]]


def test_transient_failure_keeps_the_file_until_it_succeeds(tmp_path, web):
    web.fail_next = [503, 500]
    box = Outbox(tmp_path, HttpSender(web.url, TOKEN))
    box.put(payload(1))
    assert box.process_one() is Outcome.RETRY
    assert box.process_one() is Outcome.RETRY
    assert box.pending_count() == 1
    assert box.process_one() is Outcome.DELIVERED
    assert box.pending_count() == 0
    assert len(web.stored) == 1


def test_web_app_down_then_back(tmp_path):
    box = Outbox(tmp_path, HttpSender("http://127.0.0.1:9", TOKEN, timeout=(0.5, 0.5)))  # nothing listens
    box.put(payload(1))
    assert box.process_one() is Outcome.RETRY
    assert box.pending_count() == 1
    web = FakeWebApp()
    try:
        box2 = Outbox(tmp_path, HttpSender(web.url, TOKEN))  # restarted worker, same folder
        assert drain(box2) == [Outcome.DELIVERED]
        assert len(web.stored) == 1
    finally:
        web.close()


def test_lost_response_resend_is_a_duplicate_not_a_second_incident(tmp_path, web):
    """The web app stored it but the worker never saw the answer: resending is safe."""
    box = Outbox(tmp_path, HttpSender(web.url, TOKEN))
    box.put(payload(1))
    web.stored[payload(1)["id"]] = payload(1)  # first attempt landed; its response was lost
    assert box.process_one() is Outcome.DELIVERED
    assert len(web.stored) == 1


def test_permanent_rejection_goes_to_dead_letters_and_can_be_replayed(tmp_path, web):
    box = Outbox(tmp_path, HttpSender(web.url, "wrong-token-000000000"))
    box.put(payload(1))
    box.put(payload(2))
    assert drain(box) == [Outcome.DEAD, Outcome.DEAD], "a bad token can't succeed by retrying"
    assert box.pending_count() == 0
    errors = sorted(box.dead_dir.glob("*.error.txt"))
    assert len(errors) == 2 and "HTTP 401" in errors[0].read_text()

    assert replay(tmp_path) == 2
    fixed = Outbox(tmp_path, HttpSender(web.url, TOKEN))
    assert drain(fixed) == [Outcome.DELIVERED, Outcome.DELIVERED]
    assert len(web.stored) == 2
    assert not list(box.dead_dir.iterdir())


def test_unreadable_file_is_dead_lettered_not_retried_forever(tmp_path, web):
    box = Outbox(tmp_path, HttpSender(web.url, TOKEN))
    (box.pending_dir / "00000000000000000001_broken.json").write_text("{not json")
    box.put(payload(2))
    assert drain(box) == [Outcome.DEAD, Outcome.DELIVERED]


def test_background_sender_and_drain(tmp_path, web):
    box = Outbox(tmp_path, HttpSender(web.url, TOKEN), base_backoff=0.05)
    web.fail_next = [503]
    box.start()
    for n in range(10):
        box.put(payload(n))
    assert box.drain(timeout=10) == 0
    assert len(web.stored) == 10
    assert web.posts == 11  # one retry


def test_drain_timeout_leaves_files_on_disk(tmp_path):
    box = Outbox(tmp_path, HttpSender("http://127.0.0.1:9", TOKEN, timeout=(0.2, 0.2)), base_backoff=0.05)
    box.start()
    box.put(payload(1))
    assert box.drain(timeout=0.5) == 1
    assert box.pending_count() == 1, "kept for the next start"
