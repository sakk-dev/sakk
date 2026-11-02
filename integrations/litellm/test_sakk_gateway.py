"""End-to-end tests: OpenAI SDK -> LiteLLM proxy + Sakk gate -> local mock provider.

Run with the Python that has the pinned LiteLLM installed:
    python -m unittest integrations/litellm/test_sakk_gateway.py -v

Costs nothing: every provider is the local mock. Everything lives in a temp
directory, so the real ~/.sakk is never touched.
"""

from __future__ import annotations

import asyncio
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

    def __init__(self, cap: str = "1", extra_env: dict | None = None):
        self.tmp = Path(tempfile.mkdtemp(prefix="sakk-gw-"))
        self.home = self.tmp / "home"
        self.home.mkdir()
        self.ledger = self.tmp / "ledger.json"
        self.status_file = Path(str(self.ledger) + ".gateway.json")
        self.extra_env = extra_env or {}
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
            **self.extra_env,
        }

    def flaky_node(self) -> Path:
        """A stand-in for `node` that the tests can make die at once or hang.

        It execs the real node, so the PID it records is the live sakk mcp child.
        """
        w = self.tmp / "flaky-node.sh"
        w.write_text(
            "#!/bin/sh\n"
            f"echo $$ > '{self.tmp}/sakk.pid'\n"
            f"if [ -e '{self.tmp}/down' ]; then exit 3; fi\n"
            f"if [ -e '{self.tmp}/hang' ]; then exec sleep 30; fi\n"
            'exec node "$@"\n',
            encoding="utf-8",
        )
        w.chmod(0o755)
        # Run it once now (F-239). macOS checks a freshly written script on its
        # first run, which took 0.3-1.0 s here: longer than the 1 s SAKK_TIMEOUT_S
        # these tests use, so the gateway's first spawn timed out and that call
        # went through as an outage. The second run takes about 25 ms.
        subprocess.run([str(w), "-e", "0"], check=True, timeout=30, capture_output=True)
        (self.tmp / "sakk.pid").unlink(missing_ok=True)
        return w

    def gateway_status(self) -> dict:
        return json.loads(self.status_file.read_text(encoding="utf-8"))

    def log_events(self, event: str) -> list[dict]:
        self.gw_log.flush()
        out = []
        for line in (self.tmp / "gateway.log").read_text(encoding="utf-8", errors="replace").splitlines():
            if f'"event": "{event}"' in line:
                out.append(json.loads(line[line.index("{"):]))
        return out

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

    def test_k_a_metered_call_carries_no_unmetered_header(self):
        before = self.s.status()
        raw = self.s.client.chat.completions.with_raw_response.create(
            model="mock-ok",
            messages=[{"role": "user", "content": "hi"}],
            extra_body={"metadata": {"sakk_unmetered": True}},  # a client forging the marker
        )
        self.assertIsNone(raw.headers.get("x-sakk-status"))
        st = wait_settled(self.s, before["n"] + 1)
        self.assertAlmostEqual(st["settled_usd"] - before["settled_usd"], 11 * P_IN + 7 * P_OUT, places=9)

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


def raw_chat(stack: Stack, model: str, **kw):
    return stack.client.chat.completions.with_raw_response.create(
        model=model, messages=[{"role": "user", "content": "hi"}], **kw
    )


class OutageAllowTest(unittest.TestCase):
    """SAKK_ON_UNAVAILABLE unset: the default must be allow. Tests run in order."""

    @classmethod
    def setUpClass(cls):
        cls.s = Stack(cap="1")
        cls.s.extra_env = {"SAKK_NODE": str(cls.s.flaky_node()), "SAKK_TIMEOUT_S": "1"}
        cls.s.start_mock()
        cls.s.start_gateway()

    @classmethod
    def tearDownClass(cls):
        cls.s.stop()

    def flag(self, name: str, on: bool) -> None:
        p = self.s.tmp / name
        if on:
            p.touch()
        elif p.exists():
            p.unlink()

    def pid(self) -> int:
        return int((self.s.tmp / "sakk.pid").read_text().strip())

    def kill_sakk(self) -> int:
        """SIGKILL the live sakk mcp child and wait until the gateway has reaped it.

        The down and hang flags only reach a process the wrapper starts next, so a
        test that wants an outage must first get rid of the one already running.
        """
        old = self.pid()
        os.kill(old, 9)
        deadline = time.time() + 5
        while time.time() < deadline:
            try:
                os.kill(old, 0)
                time.sleep(0.1)
            except ProcessLookupError:
                break
        return old

    def test_o1_a_dead_sakk_process_is_respawned_and_the_next_call_is_metered(self):
        before = self.s.status()
        first = raw_chat(self.s, "mock-ok", max_tokens=20)
        self.assertIsNone(first.headers.get("x-sakk-status"), "the first call is metered (F-239)")
        wait_settled(self.s, before["n"] + 1)
        old = self.kill_sakk()
        raw = raw_chat(self.s, "mock-ok", max_tokens=20)
        self.assertIsNone(raw.headers.get("x-sakk-status"), "a respawned Sakk meters the call")
        st = wait_settled(self.s, before["n"] + 2)
        self.assertEqual(st["n"], before["n"] + 2)
        self.assertNotEqual(self.pid(), old, "a new sakk mcp process was started")
        self.assertIsNone(self.s.gateway_status()["outage"])

    def test_o2_sakk_down_lets_the_call_through_loudly(self):
        self.flag("down", True)
        self.kill_sakk()  # the child o1 respawned would otherwise meter this call
        before = self.s.status()
        hits = self.s.hits().get("mock-ok", 0)
        raw = raw_chat(self.s, "mock-ok", max_tokens=20)
        self.assertEqual(raw.parse().choices[0].message.content, "hello")
        self.assertEqual(raw.headers.get("x-sakk-status"), "unmetered")
        self.assertEqual(self.s.hits().get("mock-ok", 0), hits + 1, "the provider was called")
        time.sleep(0.5)
        # `sakk status` runs the real node, not the flaky wrapper: the flag stays set.
        after = self.s.status()
        self.assertEqual(after["n"], before["n"], "an outage call is not in the ledger")
        self.assertAlmostEqual(after["settled_usd"], before["settled_usd"], places=9)
        events = self.s.log_events("sakk_unavailable_allowed")
        self.assertEqual(len(events), 1)
        ev = events[0]
        self.assertEqual(ev["model"], "mock-ok")
        self.assertEqual(ev["allowed_calls"], 1)
        self.assertGreater(ev["est_max_usd"], (20 + 64) * P_OUT)
        doc = self.s.gateway_status()
        self.assertEqual(doc["version"], 1)
        self.assertEqual(doc["mode"], "allow")
        o = doc["outage"]
        self.assertEqual(o["allowed_calls"], 1)
        self.assertAlmostEqual(o["est_max_unrecorded_usd"], ev["est_max_usd"], places=9)
        self.assertEqual(o["since"], ev["outage_since"])
        self.assertIn("sakk_reserve", o["last_reason"])

    def test_o3_a_streamed_call_let_through_carries_the_header(self):
        raw = raw_chat(self.s, "mock-ok", stream=True, max_tokens=20)
        self.assertEqual(raw.headers.get("x-sakk-status"), "unmetered")
        text = "".join((c.choices[0].delta.content or "") if c.choices else "" for c in raw.parse())
        self.assertEqual(text, "hello")
        self.assertEqual(self.s.gateway_status()["outage"]["allowed_calls"], 2)

    def test_o4_refusals_stay_refusals_during_an_outage(self):
        hits = self.s.hits()
        with self.assertRaises(openai.APIStatusError) as cm:
            chat(self.s, "mock-noprice")
        self.assertEqual(cm.exception.status_code, 403)
        self.assertIn("SAKK_NO_PRICE", json.dumps(cm.exception.body))
        with self.assertRaises(openai.APIStatusError) as cm:
            chat(self.s, "mock-ok", max_tokens=0)
        self.assertEqual(cm.exception.status_code, 400)
        self.assertIn("SAKK_BAD_REQUEST", json.dumps(cm.exception.body))
        self.assertEqual(self.s.hits(), hits, "a refused call never reaches the provider")
        self.assertEqual(self.s.gateway_status()["outage"]["allowed_calls"], 2)

    def test_o5_a_hung_sakk_times_out_and_the_call_goes_through(self):
        self.flag("down", False)
        self.flag("hang", True)
        raw = raw_chat(self.s, "mock-ok", max_tokens=20)
        self.assertEqual(raw.headers.get("x-sakk-status"), "unmetered")
        o = self.s.gateway_status()["outage"]
        self.assertEqual(o["allowed_calls"], 3)
        self.assertIn("TimeoutError", o["last_reason"])

    def test_o6_recovery_moves_the_outage_to_last_outage(self):
        self.flag("hang", False)
        before = self.s.status()
        since = self.s.gateway_status()["outage"]["since"]
        raw = raw_chat(self.s, "mock-ok", max_tokens=20)
        self.assertIsNone(raw.headers.get("x-sakk-status"))
        wait_settled(self.s, before["n"] + 1)
        doc = self.s.gateway_status()
        self.assertIsNone(doc["outage"])
        last = doc["last_outage"]
        self.assertEqual(last["since"], since)
        self.assertEqual(last["allowed_calls"], 3)
        self.assertGreaterEqual(last["ended_at"], since)
        self.assertEqual(len(self.s.log_events("sakk_outage_ended")), 1)

    def test_o7_budget_exceeded_is_still_402_in_allow_mode(self):
        hits = self.s.hits().get("mock-ok", 0)
        with self.assertRaises(openai.APIStatusError) as cm:
            chat(self.s, "mock-pricey", max_tokens=1000)
        self.assertEqual(cm.exception.status_code, 402)
        self.assertIn("BUDGET_EXCEEDED", json.dumps(cm.exception.body))
        self.assertEqual(self.s.hits().get("mock-ok", 0), hits)
        self.assertIsNone(self.s.gateway_status()["outage"], "a refusal is an answer, not an outage")


class OutageDenyTest(unittest.TestCase):
    def test_d1_deny_mode_answers_503_and_the_provider_sees_nothing(self):
        s = Stack(cap="1")
        try:
            s.extra_env = {"SAKK_NODE": str(s.flaky_node()), "SAKK_TIMEOUT_S": "1", "SAKK_ON_UNAVAILABLE": "deny"}
            (s.tmp / "down").touch()
            s.start_mock()
            s.start_gateway()
            with self.assertRaises(openai.APIStatusError) as cm:
                raw_chat(s, "mock-ok", max_tokens=20)
            self.assertEqual(cm.exception.status_code, 503)
            self.assertIn("SAKK_UNAVAILABLE", json.dumps(cm.exception.body))
            self.assertIsNone(cm.exception.response.headers.get("x-sakk-status"))
            self.assertEqual(s.hits().get("mock-ok", 0), 0)
            doc = s.gateway_status()
            self.assertEqual(doc["mode"], "deny")
            self.assertEqual(doc["outage"]["allowed_calls"], 0)
            self.assertEqual(s.log_events("sakk_unavailable_allowed"), [])
        finally:
            s.stop()


class StatusUnitTest(unittest.TestCase):
    """The gateway module loaded in this process, with a stand-in ledger client."""

    def load(self, **env: str):
        import importlib.util

        tmp = Path(tempfile.mkdtemp(prefix="sakk-gw-unit-"))
        self.addCleanup(shutil.rmtree, tmp, True)
        cfg = tmp / "config.yaml"
        cfg.write_text(config_yaml(1, 1.0), encoding="utf-8")
        full = {
            "SAKK_BIN": str(SAKK_BIN),
            "SAKK_LEDGER": str(tmp / "ledger.json"),
            "SAKK_GATEWAY_CONFIG": str(cfg),
            **env,
        }
        saved = {k: os.environ.get(k) for k in [*full, "SAKK_TIMEOUT_S", "SAKK_ON_UNAVAILABLE", "SAKK_GATEWAY_STATUS"]}
        for k in ("SAKK_TIMEOUT_S", "SAKK_ON_UNAVAILABLE", "SAKK_GATEWAY_STATUS"):
            os.environ.pop(k, None)
        os.environ.update(full)

        def restore():
            for k, v in saved.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v

        self.addCleanup(restore)
        spec = importlib.util.spec_from_file_location(f"sakk_gateway_unit_{len(os.listdir(tmp.parent))}", HERE / "sakk_gateway.py")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod, tmp

    def test_u1_default_ledger_timeout_is_two_seconds(self):
        mod, _ = self.load()
        self.assertEqual(mod.handler.client._timeout, 2.0)
        for bad in ("0", "-1", "nan", "inf", "soon"):
            os.environ["SAKK_TIMEOUT_S"] = bad
            with self.assertRaises(RuntimeError, msg=bad):
                mod._timeout_s()
        os.environ["SAKK_TIMEOUT_S"] = "7.5"
        self.assertEqual(mod._timeout_s(), 7.5)

    def test_u2_status_file_is_atomic_and_private(self):
        mod, tmp = self.load()
        st = mod.handler.status
        # the temp folder may sit behind a link (/var -> /private/var on macOS)
        self.assertEqual(st.path, os.path.join(os.path.realpath(tmp), "ledger.json") + ".gateway.json")
        self.assertEqual(os.stat(st.path).st_mode & 0o777, 0o600)
        doc = json.loads(Path(st.path).read_text())
        self.assertEqual(set(doc), {"version", "updatedAt", "mode", "outage", "last_outage"})
        self.assertEqual((doc["version"], doc["mode"], doc["outage"], doc["last_outage"]), (1, "allow", None, None))
        st.outage_seen("sakk_reserve: BrokenPipeError: x" * 20, 0.25, allowed=True)
        st.outage_seen("again", 0.5, allowed=True)
        o = json.loads(Path(st.path).read_text())["outage"]
        self.assertEqual(set(o), {"since", "allowed_calls", "est_max_unrecorded_usd", "last_reason", "last_at"})
        self.assertEqual((o["allowed_calls"], o["est_max_unrecorded_usd"], o["last_reason"]), (2, 0.75, "again"))
        st.answered()
        doc = json.loads(Path(st.path).read_text())
        self.assertIsNone(doc["outage"])
        self.assertEqual(set(doc["last_outage"]), {*o, "ended_at"})
        self.assertEqual(os.stat(st.path).st_mode & 0o777, 0o600)
        self.assertEqual([p.name for p in tmp.iterdir() if p.name.endswith(".tmp")], [])
        # A restart during an outage keeps counting it.
        st.outage_seen("down", 0.1, allowed=True)
        again = mod.GatewayStatus(st.path, "allow")
        self.assertEqual(again.outage["allowed_calls"], 1)
        self.assertEqual(again.last_outage["allowed_calls"], 2)

    def test_u3_a_status_write_failure_logs_error_and_never_raises(self):
        mod, tmp = self.load()
        st = mod.handler.status
        good = Path(st.path).read_text()
        real_replace = mod.os.replace

        def broken_replace(a, b):
            raise OSError("disk full")

        mod.os.replace = broken_replace
        try:
            with self.assertLogs("sakk_gateway", level="ERROR") as logs:
                snap = st.outage_seen("down", 0.25, allowed=True)
        finally:
            mod.os.replace = real_replace
        self.assertEqual(snap["allowed_calls"], 1)
        self.assertIn("could not write the status file", "\n".join(logs.output))
        self.assertEqual(Path(st.path).read_text(), good, "a failed write leaves the last good file whole")
        self.assertEqual([p.name for p in tmp.iterdir() if p.name.endswith(".tmp")], [])
        st.path = str(tmp / "missing-dir" / "status.json")
        with self.assertLogs("sakk_gateway", level="ERROR"):
            st.outage_seen("down", 0.25, allowed=True)

    def test_u4_a_client_cannot_mark_its_own_call_unmetered(self):
        mod, _ = self.load()

        class Answers:
            async def call(self, tool, args):
                return {"ok": True}

        mod.handler.client = Answers()
        data = {"model": "mock-ok", "messages": [{"role": "user", "content": "hi"}], "metadata": {"sakk_unmetered": True}}
        out = asyncio.run(mod.handler.async_pre_call_hook(None, None, data, "acompletion"))
        self.assertNotIn("sakk_unmetered", out["metadata"])
        self.assertTrue(out["metadata"]["sakk_call_id"].startswith("gw-"))
        self.assertIsNone(asyncio.run(mod.handler.async_post_call_response_headers_hook(out, None, None)))

    def test_u5_in_allow_mode_a_refusal_stays_a_refusal_and_an_outage_logs_a_warning(self):
        mod, _ = self.load()

        class Refuses:
            async def call(self, tool, args):
                raise mod.SakkRefused("LEDGER_HALTED", "halted")

        class Down:
            async def call(self, tool, args):
                raise mod.SakkUnavailable("sakk_reserve: BrokenPipeError: gone")

        def req():
            return {"model": "mock-ok", "messages": [{"role": "user", "content": "hi"}]}

        mod.handler.client = Refuses()
        with self.assertRaises(mod.HTTPException) as cm:
            asyncio.run(mod.handler.async_pre_call_hook(None, None, req(), "acompletion"))
        self.assertEqual(cm.exception.status_code, 402)
        self.assertIsNone(mod.handler.status.outage)

        mod.handler.client = Down()
        with self.assertLogs("sakk_gateway", level="WARNING") as logs:
            out = asyncio.run(mod.handler.async_pre_call_hook(None, None, req(), "acompletion"))
        line = [r for r in logs.records if "sakk_unavailable_allowed" in r.getMessage()]
        self.assertEqual([r.levelname for r in line], ["WARNING"])
        self.assertNotIn("sakk_call_id", out["metadata"])
        self.assertEqual(mod.handler.pending, {}, "nothing for the settle hooks to settle")
        self.assertEqual(
            asyncio.run(mod.handler.async_post_call_response_headers_hook(out, None, None)),
            {"x-sakk-status": "unmetered"},
        )

    def test_u6_a_refusal_after_an_outage_ends_the_outage(self):
        # Opens its own outage first, so it never leans on another test's state.
        mod, _ = self.load()

        class DownThenOverTheCap:
            calls = 0

            async def call(self, tool, args):
                DownThenOverTheCap.calls += 1
                if DownThenOverTheCap.calls == 1:
                    raise mod.SakkUnavailable("sakk_reserve: BrokenPipeError: gone")
                raise mod.SakkRefused("BUDGET_EXCEEDED", "over the cap")

        def req():
            return {"model": "mock-ok", "messages": [{"role": "user", "content": "hi"}]}

        mod.handler.client = DownThenOverTheCap()
        st = mod.handler.status
        with self.assertLogs("sakk_gateway", level="WARNING"):
            asyncio.run(mod.handler.async_pre_call_hook(None, None, req(), "acompletion"))
        self.assertEqual(st.outage["allowed_calls"], 1, "the outage this test opened")
        self.assertIsNone(st.last_outage)

        with self.assertLogs("sakk_gateway", level="WARNING") as logs:
            with self.assertRaises(mod.HTTPException) as cm:
                asyncio.run(mod.handler.async_pre_call_hook(None, None, req(), "acompletion"))
        self.assertEqual(cm.exception.status_code, 402)
        self.assertIn("BUDGET_EXCEEDED", json.dumps(cm.exception.detail))
        self.assertIsNone(st.outage, "a refusal is Sakk answering: the outage is over")
        self.assertEqual(st.last_outage["allowed_calls"], 1)
        self.assertIn("ended_at", st.last_outage)
        ended = [r for r in logs.records if "sakk_outage_ended" in r.getMessage()]
        self.assertEqual([r.levelname for r in ended], ["WARNING"])
        on_disk = json.loads(Path(st.path).read_text())
        self.assertIsNone(on_disk["outage"])
        self.assertEqual(on_disk["last_outage"]["allowed_calls"], 1)

    def test_u7_the_status_path_is_the_one_sakk_status_reads(self):
        # The same shapes as the gatewayStatusPathFor test in test/gateway-status.test.mjs.
        mod, _ = self.load()
        s = Stack(cap="1")
        self.addCleanup(s.stop)
        linked = s.tmp / "linked"
        linked.symlink_to(s.tmp, target_is_directory=True)
        canonical = os.path.join(os.path.realpath(s.tmp), "ledger.json") + ".gateway.json"
        shapes = [
            str(s.ledger),
            os.path.relpath(s.ledger),
            str(linked / "ledger.json"),
            os.path.relpath(linked / "ledger.json"),
        ]
        for p in shapes:
            self.assertEqual(mod.status_path_for(p), canonical, p)
        st = mod.GatewayStatus(mod.status_path_for(str(linked / "ledger.json")), "allow")
        st.outage_seen("sakk_reserve: BrokenPipeError: gone", 0.25, allowed=True)
        for p in shapes:
            doc = json.loads(s.sakk("status", "--json", "--ledger", p, check=False).stdout)
            self.assertEqual(doc["gateway"]["path"], canonical, p)
            self.assertEqual(doc["gateway"]["outage"]["allowed_calls"], 1, p)


class FakeSakk:
    """Stands in for a running `sakk mcp` child: answers what it is sent, or fails as told."""

    def __init__(self, send_error: Exception | None = None, replies: bool = True, returncode=None):
        self.send_error = send_error
        self.replies = replies
        self.returncode = returncode
        self.sent: list[dict] = []
        self.stdin = self
        self.stdout = self

    def write(self, data: bytes) -> None:
        self.sent.append(json.loads(data))

    async def drain(self) -> None:
        if self.send_error is not None:
            raise self.send_error

    async def readline(self) -> bytes:
        if not self.replies or not self.sent:
            return b""  # closed its output
        req = self.sent[-1]
        text = json.dumps({"ok": True, "callId": req["params"]["arguments"]["callId"]})
        reply = {"jsonrpc": "2.0", "id": req["id"], "result": {"content": [{"type": "text", "text": text}]}}
        return (json.dumps(reply) + "\n").encode()

    def kill(self) -> None:
        self.returncode = -9


class ClientRetryTest(unittest.TestCase):
    """SakkClient.call sends a request again only when it never reached Sakk."""

    load = StatusUnitTest.load

    def client(self, mod, running, spawn):
        c = mod.SakkClient("node", str(SAKK_BIN), "/unused/ledger.json", 1.0)
        c._proc = running
        c.spawned = []

        async def start():
            p = spawn()
            c.spawned.append(p)
            c._proc = p

        c._start = start
        return c

    def mod(self):
        mod, _ = self.load()
        return mod

    def test_r1_a_request_that_never_reached_a_dead_sakk_goes_to_a_fresh_one(self):
        mod = self.mod()
        for err in (BrokenPipeError(32, "Broken pipe"), ConnectionResetError("Connection lost")):
            # died since the last call, not yet reaped: returncode is still None
            dead = FakeSakk(send_error=err)
            c = self.client(mod, dead, FakeSakk)
            body = asyncio.run(c.call("sakk_reserve", {"callId": "gw-1", "estimatedMaxUsd": 0.1}))
            self.assertEqual(body, {"ok": True, "callId": "gw-1"}, repr(err))
            self.assertEqual(len(c.spawned), 1, "one fresh process, one retry")
            self.assertEqual([m["params"]["arguments"]["callId"] for m in c.spawned[0].sent], ["gw-1"])
            self.assertEqual(dead.returncode, -9, "the old process is killed, not reused")

    def test_r2_a_reply_lost_after_the_request_was_written_is_an_outage_not_a_second_reserve(self):
        mod = self.mod()
        written = FakeSakk(replies=False)  # took the request, then closed its output
        c = self.client(mod, written, FakeSakk)
        with self.assertRaises(mod.SakkUnavailable) as cm:
            asyncio.run(c.call("sakk_reserve", {"callId": "gw-2", "estimatedMaxUsd": 0.1}))
        self.assertIn("closed its output", str(cm.exception))
        self.assertEqual(len(written.sent), 1, "sent once")
        self.assertEqual(c.spawned, [], "never sent again: the first reserve may have landed")
        self.assertIsNone(c._proc)

    def test_r3_a_fresh_sakk_that_fails_is_an_outage_at_once(self):
        mod = self.mod()
        for running in (None, FakeSakk(returncode=1)):  # never started, or exited and reaped
            c = self.client(mod, running, lambda: FakeSakk(send_error=BrokenPipeError(32, "Broken pipe")))
            with self.assertRaises(mod.SakkUnavailable) as cm:
                asyncio.run(c.call("sakk_reserve", {"callId": "gw-3", "estimatedMaxUsd": 0.1}))
            self.assertIn("BrokenPipeError", str(cm.exception))
            self.assertEqual(len(c.spawned), 1, "a fresh process failing is not retried")


class StartupTest(unittest.TestCase):
    def test_an_unknown_outage_mode_refuses_to_start(self):
        s = Stack()
        try:
            s.start_mock()
            gw = s.write_gateway()
            env = {**s.gateway_env(gw), "SAKK_ON_UNAVAILABLE": "sometimes"}
            r = subprocess.run(
                s.litellm_argv(gw, free_port()), env=env, cwd=gw, capture_output=True, text=True, timeout=90
            )
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("SAKK_ON_UNAVAILABLE must be allow or deny", r.stdout + r.stderr)
        finally:
            s.stop()

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
