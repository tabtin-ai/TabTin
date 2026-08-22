"""Deterministic, log-redacted OpenAI-compatible server for local E2E only."""

from __future__ import annotations

import json
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Lock
from urllib.parse import parse_qs, urlsplit


MARKER = os.environ.get("MOCK_RESPONSE_MARKER", "LOCAL_MODEL_E2E")
PORT = int(os.environ.get("MOCK_PORT", "8080"))
_lock = Lock()
_calls = 0
_safe_events: list[dict[str, object]] = []
_default_mode = "success"


class Handler(BaseHTTPRequestHandler):
    server_version = "TabTinLocalMock/1"

    def log_message(self, *_args) -> None:
        return

    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        path = urlsplit(self.path).path
        if path == "/health":
            self._json(200, {"status": "ok", "marker": MARKER})
            return
        if path == "/test/stats":
            with _lock:
                calls = _calls
                events = list(_safe_events)
            self._json(200, {"calls": calls, "events": events, "marker": MARKER})
            return
        self._json(404, {"error": "not-found"})

    def do_POST(self) -> None:  # noqa: N802
        global _calls, _default_mode
        parsed_url = urlsplit(self.path)
        if parsed_url.path == "/test/reset":
            with _lock:
                _calls = 0
                _safe_events.clear()
                _default_mode = "success"
            self._json(200, {"calls": 0})
            return
        if parsed_url.path.startswith("/test/mode/"):
            requested_mode = parsed_url.path.rsplit("/", 1)[-1]
            if requested_mode not in {"success", "429", "500", "malformed", "delayed"}:
                self._json(400, {"error": "unsupported-mode"})
                return
            with _lock:
                _default_mode = requested_mode
            self._json(200, {"mode": requested_mode})
            return
        if parsed_url.path != "/v1/chat/completions":
            self._json(404, {"error": "not-found"})
            return
        length = min(int(self.headers.get("content-length", "0") or "0"), 1_048_576)
        try:
            request = json.loads(self.rfile.read(length) or b"{}")
        except (TypeError, ValueError):
            self._json(400, {"error": {"code": "invalid-json", "message": "invalid request"}})
            return

        authorization = self.headers.get("authorization", "")
        model = request.get("model")
        mode = (
            self.headers.get("x-local-e2e-mode")
            or parse_qs(parsed_url.query).get("mode", [""])[0]
            or request.get("mock_mode")
            or _default_mode
        )
        request_id = self.headers.get("x-request-id", "")
        with _lock:
            _calls += 1
            call_number = _calls
            _safe_events.append(
                {
                    "call": call_number,
                    "model": model if isinstance(model, str) else "invalid",
                    "mode": mode if isinstance(mode, str) else "invalid",
                    "request_id": request_id if isinstance(request_id, str) else "",
                }
            )

        if not authorization.startswith("Bearer ") or len(authorization) <= len("Bearer "):
            self._json(401, {"error": {"code": "missing-auth", "message": "authorization required"}})
            return
        if model != "local-e2e-chat-20260806":
            self._json(400, {"error": {"code": "unexpected-model", "message": "unexpected model"}})
            return
        if mode == "429":
            self._json(429, {"error": {"code": "rate_limit", "message": "local deterministic limit"}})
            return
        if mode == "500":
            self._json(500, {"error": {"code": "upstream_error", "message": "local deterministic error"}})
            return
        if mode == "delayed":
            time.sleep(1.0)
        if mode == "malformed":
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.end_headers()
            self.wfile.write(b"data: {malformed-json}\n\n")
            self.wfile.flush()
            return

        response_id = f"local-e2e-{MARKER.lower()}-{call_number}"
        chunks = [
            {
                "id": response_id,
                "object": "chat.completion.chunk",
                "choices": [{"index": 0, "delta": {"role": "assistant", "content": MARKER}, "finish_reason": None}],
            },
            {
                "id": response_id,
                "object": "chat.completion.chunk",
                "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
            },
            {
                "id": response_id,
                "object": "chat.completion.chunk",
                "choices": [],
                "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
            },
        ]
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("cache-control", "no-cache")
        self.end_headers()
        for chunk in chunks:
            payload = json.dumps(chunk, sort_keys=True, separators=(",", ":")).encode()
            self.wfile.write(b"data: " + payload + b"\n\n")
            self.wfile.flush()
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
