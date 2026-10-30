"""End-to-end tests: OpenAI SDK -> LiteLLM proxy + Sakk gate -> local mock provider.

Run with the Python that has the pinned LiteLLM installed:
    python -m unittest integrations/litellm/test_sakk_gateway.py -v

Costs nothing: every provider is the local mock. Everything lives in a temp
directory, so the real ~/.sakk is never touched.
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

import openai

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
SAKK_BIN = REPO / "bin" / "sakk.mjs"
MASTER_KEY = "sk-gateway-test-not-a-real-key"
P_IN, P_OUT = 0.000001, 0.000002  # per token, for every priced mock model


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_http(url: str, seconds: float) -> None:
    deadline = time.time() + seconds
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1):
                return
        except Exception:
            time.sleep(0.3)
    raise RuntimeError(f"{url} did not come up within {seconds}s")


def get_json(url: str):
    with urllib.request.urlopen(url, timeout=5) as r:
        return json.loads(r.read())


def config_yaml(mock_port: int, timeout_s: float) -> str:
    base = f"http://127.0.0.1:{mock_port}/v1"

    def model(name: str, upstream: str, price: tuple[float, float] | None) -> str:
        cost = (
            f"\n      input_cost_per_token: {price[0]:.12f}\n      output_cost_per_token: {price[1]:.12f}"
            if price
            else ""
        )
        return (
            f"  - model_name: {name}\n"
            f"    litellm_params:\n"
            f"      model: openai/{upstream}\n"
            f"      api_base: {base}\n"
            f"      api_key: mock-provider-key\n"
            f"      max_retries: 0\n"
            f"      timeout: {timeout_s}{cost}\n"
        )

    priced = (P_IN, P_OUT)
    return (
        "model_list:\n"
        + model("mock-ok", "mock-ok", priced)
        + model("mock-500", "mock-500", priced)
        + model("mock-slow", "mock-slow", priced)
        + model("mock-over", "mock-over", priced)
        + model("mock-pricey", "mock-ok", (0.01, 0.01))
        + model("mock-noprice", "mock-ok", None)
        + "litellm_settings:\n"
        "  callbacks: sakk_gateway.handler\n"
        "  num_retries: 0\n"
        f"  request_timeout: {timeout_s}\n"
        "router_settings:\n"
        "  num_retries: 0\n"
        "general_settings:\n"
        f"  master_key: {MASTER_KEY}\n"
    )


class Stack:
    """A temp HOME, a fresh ledger, the mock provider and the gateway."""

    def __init__(self, cap: str = "1"):
        self.tmp = Path(tempfile.mkdtemp(prefix="sakk-gw-"))
        self.home = self.tmp / "home"
        self.home.mkdir()
        self.ledger = self.tmp / "ledger.json"
        self.procs: list[subprocess.Popen] = []
        self.base_env = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": str(self.home),
            "SAKK_HOME": str(self.home / ".sakk"),
        }
        self.sakk("init", "--cap", cap, "--ledger", str(self.ledger), "--by", "gateway-test")

    def sakk(self, *args: str, check: bool = True) -> subprocess.CompletedProcess:
        return subprocess.run(
            ["node", str(SAKK_BIN), *args],
            env=self.base_env,
            capture_output=True,
            text=True,
            check=check,
            timeout=30,
        )

    def status(self) -> dict:
        r = self.sakk("status", "--ledger", str(self.ledger), "--json", check=False)
        doc = json.loads(r.stdout)
        doc["_exit"] = r.returncode
        doc["n"] = sum(doc["entries"].values())
        return doc

    def start_mock(self) -> None:
        self.mock_port = free_port()
        p = subprocess.Popen(
            [sys.executable, str(HERE / "mock_provider.py"), str(self.mock_port)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        self.procs.append(p)
        wait_http(f"http://127.0.0.1:{self.mock_port}/hits", 15)

    def gateway_env(self, gw_dir: Path) -> dict:
        return {
            **self.base_env,
            "LITELLM_LOCAL_MODEL_COST_MAP": "True",
            "SAKK_BIN": str(SAKK_BIN),
            "SAKK_LEDGER": str(self.ledger),
            "SAKK_GATEWAY_CONFIG": str(gw_dir / "config.yaml"),
            "SAKK_DEFAULT_MAX_TOKENS": "100",
            "SAKK_LATE_SETTLE_S": "0.5",
        }

    def write_gateway(self, timeout_s: float = 1.5) -> Path:
        gw = self.tmp / "gw"
        gw.mkdir(exist_ok=True)
        shutil.copy(HERE / "sakk_gateway.py", gw / "sakk_gateway.py")
        (gw / "config.yaml").write_text(config_yaml(self.mock_port, timeout_s), encoding="utf-8")
        return gw

    def litellm_argv(self, gw: Path, port: int) -> list[str]:
        exe = Path(sys.executable).parent / "litellm"
        return [str(exe), "--config", str(gw / "config.yaml"), "--host", "127.0.0.1", "--port", str(port)]

    def start_gateway(self) -> None:
        gw = self.write_gateway()
        self.port = free_port()
        self.gw_log = open(self.tmp / "gateway.log", "w")
        p = subprocess.Popen(
            self.litellm_argv(gw, self.port),
            env=self.gateway_env(gw),
            cwd=gw,
            stdout=self.gw_log,
            stderr=subprocess.STDOUT,
        )
        self.procs.append(p)
        wait_http(f"http://127.0.0.1:{self.port}/health/liveliness", 90)
        self.client = openai.OpenAI(
            api_key=MASTER_KEY, base_url=f"http://127.0.0.1:{self.port}/v1", max_retries=0, timeout=20
        )

    def hits(self) -> dict:
        return get_json(f"http://127.0.0.1:{self.mock_port}/hits")

    def last(self) -> dict:
        return get_json(f"http://127.0.0.1:{self.mock_port}/last")

    def stop(self) -> None:
        for p in self.procs:
            p.kill()
            p.wait(timeout=10)
        shutil.rmtree(self.tmp, ignore_errors=True)


def wait_settled(stack: Stack, expect_entries: int, seconds: float = 10) -> dict:
    """Settling runs after the response is sent; wait until nothing is outstanding."""
    deadline = time.time() + seconds
    st = stack.status()
    while time.time() < deadline:
        st = stack.status()
        if st["n"] == expect_entries and st.get("outstanding_usd") == 0:
            return st
        time.sleep(0.2)
    return st


def chat(stack: Stack, model: str, **kw):
    return stack.client.chat.completions.create(
        model=model, messages=[{"role": "user", "content": "hi"}], **kw
    )


class GatewayTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.s = Stack(cap="1")
        cls.s.start_mock()
        cls.s.start_gateway()

    @classmethod
    def tearDownClass(cls):
        cls.s.stop()

    def entries(self) -> int:
        return self.s.status()["n"]

    def test_a_ok_call_settles_the_exact_cost(self):
        before = self.s.status()
        r = chat(self.s, "mock-ok", metadata={"sakk_call_id": "gw-forged"})
        self.assertEqual(r.choices[0].message.content, "hello")
        st = wait_settled(self.s, before["n"] + 1)
        self.assertEqual(st["outstanding_usd"], 0)
        self.assertAlmostEqual(st["settled_usd"] - before["settled_usd"], 11 * P_IN + 7 * P_OUT, places=9)
        sent = self.s.last()
        self.assertEqual(sent.get("max_tokens"), 100, "the gateway injects max_tokens so the worst case is bounded")
        self.assertNotIn("metadata", sent, "gateway bookkeeping must not reach the provider")

    def test_b_stream_settles_from_the_final_usage_chunk(self):
        before = self.s.status()
        text = "".join(
            (c.choices[0].delta.content or "") if c.choices else ""
            for c in chat(self.s, "mock-ok", stream=True, max_tokens=50)
        )
        self.assertEqual(text, "hello")
        self.assertTrue(self.s.last().get("stream_options", {}).get("include_usage"))
        st = wait_settled(self.s, before["n"] + 1)
        self.assertAlmostEqual(st["settled_usd"] - before["settled_usd"], 11 * P_IN + 7 * P_OUT, places=9)

    def test_c_over_the_cap_is_refused_before_the_provider(self):
        before_hits = self.s.hits().get("mock-ok", 0)
        before = self.entries()
        with self.assertRaises(openai.APIStatusError) as cm:
            chat(self.s, "mock-pricey", max_tokens=1000)
        self.assertEqual(cm.exception.status_code, 402)
        self.assertIn("estimatedMaxUsd", json.dumps(cm.exception.body))
        self.assertEqual(self.s.hits().get("mock-ok", 0), before_hits, "a refused call never reaches the provider")
        self.assertEqual(self.entries(), before)

    def test_d_provider_error_settles_zero(self):
        before = self.s.status()
        with self.assertRaises(openai.APIStatusError) as cm:
            chat(self.s, "mock-500")
        self.assertEqual(cm.exception.status_code, 500)
        self.assertEqual(self.s.hits().get("mock-500"), 1, "no retries: one provider hit")
        st = wait_settled(self.s, before["n"] + 1)
        self.assertEqual(st["outstanding_usd"], 0)
        self.assertAlmostEqual(st["settled_usd"], before["settled_usd"], places=9)

    def test_e_timeout_settles_the_worst_case(self):
        before = self.s.status()
        with self.assertRaises(openai.APIStatusError):
            chat(self.s, "mock-slow", max_tokens=10)
        self.assertEqual(self.s.hits().get("mock-slow"), 1, "no retries: one provider hit")
        st = wait_settled(self.s, before["n"] + 1)
        self.assertEqual(st["outstanding_usd"], 0)
        self.assertGreater(st["settled_usd"] - before["settled_usd"], (10 + 64) * P_OUT)

    def test_f_unpriced_model_is_refused(self):
        before = self.entries()
        with self.assertRaises(openai.APIStatusError) as cm:
            chat(self.s, "mock-noprice")
        self.assertEqual(cm.exception.status_code, 403)
        self.assertIn("SAKK_NO_PRICE", json.dumps(cm.exception.body))
        self.assertEqual(self.entries(), before)

    def test_g_non_text_content_is_refused(self):
        before = self.entries()
        with self.assertRaises(openai.APIStatusError) as cm:
            self.s.client.chat.completions.create(
                model="mock-ok",
                messages=[{"role": "user", "content": [
                    {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}}
                ]}],
            )
        self.assertEqual(cm.exception.status_code, 403)
        self.assertEqual(self.entries(), before)

    def test_h_unmetered_route_is_refused(self):
        before = self.entries()
        with self.assertRaises(openai.APIStatusError) as cm:
            self.s.client.embeddings.create(model="mock-ok", input="hi")
        self.assertEqual(cm.exception.status_code, 403)
        self.assertIn("SAKK_UNMETERED", json.dumps(cm.exception.body))
        self.assertEqual(self.entries(), before)

    def test_i_provider_fields_reach_the_provider(self):
        # a production content app sends MiniMax's reasoning_split this way; the gate must not drop it.
        before = self.s.status()
        chat(self.s, "mock-ok", max_tokens=20, extra_body={"reasoning_split": True})
        wait_settled(self.s, before["n"] + 1)
        self.assertIs(self.s.last().get("reasoning_split"), True)

    def test_j_plain_http_client_is_gated_the_same_way(self):
        # No SDK: the same JSON any language's HTTP client sends (Java, PHP, Go, curl).
        before = self.s.status()
        body = json.dumps({"model": "mock-ok", "max_tokens": 20, "messages": [{"role": "user", "content": "hi"}]})
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.s.port}/v1/chat/completions",
            data=body.encode(),
            headers={"Authorization": f"Bearer {MASTER_KEY}", "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=20) as r:
            self.assertEqual(json.loads(r.read())["choices"][0]["message"]["content"], "hello")
        st = wait_settled(self.s, before["n"] + 1)
        self.assertAlmostEqual(st["settled_usd"] - before["settled_usd"], 11 * P_IN + 7 * P_OUT, places=9)

        too_big = json.dumps({"model": "mock-pricey", "max_tokens": 2000, "messages": [{"role": "user", "content": "hi"}]})
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.s.port}/v1/chat/completions",
            data=too_big.encode(),
            headers={"Authorization": f"Bearer {MASTER_KEY}", "Content-Type": "application/json"},
        )
        with self.assertRaises(urllib.error.HTTPError) as cm:
            urllib.request.urlopen(req, timeout=20)
        self.assertEqual(cm.exception.code, 402)
        self.assertIn("BUDGET_EXCEEDED", cm.exception.read().decode())

    def test_z_overrun_halts_the_ledger_and_refuses_the_next_call(self):
        # Runs last: it halts the shared ledger on purpose.
        chat(self.s, "mock-over", max_tokens=5)
        deadline = time.time() + 10
        st = self.s.status()
        while time.time() < deadline and not st.get("reconciliation_required"):
            time.sleep(0.2)
            st = self.s.status()
        self.assertTrue(st.get("reconciliation_required"), "a cost above the reservation must halt the ledger")
        with self.assertRaises(openai.APIStatusError) as cm:
            chat(self.s, "mock-ok")
        self.assertEqual(cm.exception.status_code, 402)


class StartupTest(unittest.TestCase):
    def test_gateway_refuses_to_start_without_the_ledger(self):
        s = Stack()
        try:
            s.start_mock()
            gw = s.write_gateway()
            env = s.gateway_env(gw)
            del env["SAKK_LEDGER"]
            port = free_port()
            r = subprocess.run(
                s.litellm_argv(gw, port), env=env, cwd=gw, capture_output=True, text=True, timeout=90
            )
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("SAKK_LEDGER is not set", r.stdout + r.stderr)
        finally:
            s.stop()


if __name__ == "__main__":
    unittest.main()
