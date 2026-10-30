"""A local OpenAI-compatible provider for the gateway tests. Costs nothing.

Models (the request's "model" field):
  mock-ok    answers with usage 11 prompt / 7 completion tokens
  mock-500   answers HTTP 500
  mock-slow  sleeps past the gateway's timeout
  mock-over  reports more completion tokens than max_tokens allows

GET /hits returns {model: count}; GET /last returns the last request body.
"""

from __future__ import annotations

import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HITS: dict[str, int] = {}
LAST: dict = {}
LOCK = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # keep test output quiet
        pass

    def _json(self, status: int, obj) -> None:
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        with LOCK:
            if self.path == "/hits":
                return self._json(200, HITS)
            if self.path == "/last":
                return self._json(200, LAST)
        self._json(404, {"error": "not found"})

    def do_POST(self):
        length = int(self.headers.get("content-length", "0"))
        req = json.loads(self.rfile.read(length) or b"{}")
        model = str(req.get("model", ""))
        with LOCK:
            HITS[model] = HITS.get(model, 0) + 1
            LAST.clear()
            LAST.update(req)
        if not self.path.endswith("/chat/completions"):
            return self._json(404, {"error": {"message": "only chat completions"}})
        if model == "mock-500":
            return self._json(500, {"error": {"message": "mock provider failure", "type": "server_error"}})
        if model == "mock-slow":
            time.sleep(5)
        completion = 7
        if model == "mock-over":
            completion = int(req.get("max_tokens") or 0) + 100000
        usage = {"prompt_tokens": 11, "completion_tokens": completion, "total_tokens": 11 + completion}
        base = {"id": "chatcmpl-mock", "created": int(time.time()), "model": model}
        if req.get("stream"):
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.end_headers()
            chunks = [
                {**base, "object": "chat.completion.chunk",
                 "choices": [{"index": 0, "delta": {"role": "assistant", "content": "hello"}, "finish_reason": None}]},
                {**base, "object": "chat.completion.chunk",
                 "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]},
            ]
            if (req.get("stream_options") or {}).get("include_usage"):
                chunks.append({**base, "object": "chat.completion.chunk", "choices": [], "usage": usage})
            for c in chunks:
                self.wfile.write(f"data: {json.dumps(c)}\n\n".encode())
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
            return
        self._json(200, {
            **base,
            "object": "chat.completion",
            "choices": [{"index": 0, "message": {"role": "assistant", "content": "hello"}, "finish_reason": "stop"}],
            "usage": usage,
        })


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), Handler)
    print("ready", flush=True)
    server.serve_forever()
