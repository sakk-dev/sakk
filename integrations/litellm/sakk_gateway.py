"""Sakk spend gate for the LiteLLM proxy.

Every chat call through the proxy reserves its worst-case cost with Sakk
before the provider is called, and settles the real cost afterwards.
Anything the gate cannot price or meter is refused, never let through.

Load it from the proxy config, with this file next to config.yaml:

    litellm_settings:
      callbacks: sakk_gateway.handler

Required environment:
    SAKK_BIN             path to sakk's bin/sakk.mjs
    SAKK_LEDGER          absolute path of the ledger file
    SAKK_GATEWAY_CONFIG  the proxy's config.yaml (prices are read from it)
Optional:
    SAKK_NODE                node executable (default: node)
    SAKK_DEFAULT_MAX_TOKENS  max_tokens injected when a request has none (2048)
    SAKK_TIMEOUT_S           how long one ledger call may take (10)
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import uuid
from decimal import ROUND_CEILING, Decimal
from typing import Any

import yaml
from fastapi import HTTPException
from litellm.integrations.custom_logger import CustomLogger

log = logging.getLogger("sakk_gateway")

AGENT = "litellm-gateway"
# The proxy's route type for /chat/completions. Every other route
# (embeddings, images, audio, responses, pass-through) is refused until it
# has its own cost model: unmetered spend is the failure Sakk exists to stop.
METERED_CALL_TYPES = frozenset({"acompletion", "completion"})
# Text sent for chat formatting, roles and tool framing on top of the raw
# message bytes; output margin for stop sequences and provider rounding.
INPUT_OVERHEAD_TOKENS = 512
OUTPUT_MARGIN_TOKENS = 64
# How long a proxy-side failure waits for the provider-call log event.
LATE_SETTLE_S = float(os.environ.get("SAKK_LATE_SETTLE_S", "2"))
# Request fields that become prompt tokens.
PROMPT_FIELDS = ("messages", "tools", "functions", "tool_choice", "response_format", "system")


class SakkUnavailable(Exception):
    """The ledger could not be reached or answered something unreadable."""


class SakkRefused(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


def _required_env(name: str) -> str:
    value = os.environ.get(name, "")
    if not value:
        raise RuntimeError(f"sakk_gateway: {name} is not set; the gateway refuses to start without it")
    return value


def _round_up_usd(x: float) -> float:
    """Round up to a millionth of a dollar, never down, never zero."""
    d = Decimal(repr(x)).quantize(Decimal("0.000001"), rounding=ROUND_CEILING)
    return max(float(d), 0.000001)


def load_prices(config_path: str) -> dict[str, tuple[float, float]]:
    """Per-token (input, output) prices by model name, from the proxy config.

    A model with several deployments takes the highest price of each kind.
    A model where any deployment lacks a price, or a wildcard model, gets no
    entry, so calls to it are refused.
    """
    with open(config_path, encoding="utf-8") as f:
        doc = yaml.safe_load(f) or {}
    seen: dict[str, list[tuple[float, float] | None]] = {}
    for dep in doc.get("model_list") or []:
        name = str(dep.get("model_name", ""))
        params = dep.get("litellm_params") or {}
        p_in = params.get("input_cost_per_token")
        p_out = params.get("output_cost_per_token")
        ok = (
            isinstance(p_in, (int, float))
            and isinstance(p_out, (int, float))
            and not isinstance(p_in, bool)
            and not isinstance(p_out, bool)
            and math.isfinite(p_in)
            and math.isfinite(p_out)
            and p_in > 0
            and p_out > 0
        )
        seen.setdefault(name, []).append((float(p_in), float(p_out)) if ok else None)
    prices: dict[str, tuple[float, float]] = {}
    for name, deps in seen.items():
        if not name or "*" in name or any(d is None for d in deps):
            continue
        prices[name] = (max(d[0] for d in deps), max(d[1] for d in deps))
    return prices


class SakkClient:
    """One long-lived `sakk mcp` process, one request at a time."""

    def __init__(self, node: str, bin_path: str, ledger: str, timeout_s: float):
        self._argv = [node, bin_path, "mcp", "--ledger", ledger]
        self._timeout = timeout_s
        self._proc: asyncio.subprocess.Process | None = None
        self._lock = asyncio.Lock()
        self._next_id = 0

    def _kill(self) -> None:
        if self._proc is not None and self._proc.returncode is None:
            try:
                self._proc.kill()
            except ProcessLookupError:
                pass
        self._proc = None

    async def _send(self, msg: dict[str, Any]) -> None:
        assert self._proc is not None and self._proc.stdin is not None
        self._proc.stdin.write((json.dumps(msg) + "\n").encode())
        await self._proc.stdin.drain()

    async def _rpc(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        self._next_id += 1
        rid = self._next_id
        await self._send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
        assert self._proc is not None and self._proc.stdout is not None
        while True:
            line = await self._proc.stdout.readline()
            if not line:
                raise SakkUnavailable("sakk mcp closed its output")
            msg = json.loads(line)
            if msg.get("id") != rid:
                continue  # a notification, not our answer
            if "error" in msg:
                raise SakkUnavailable(f"sakk mcp protocol error: {msg['error']}")
            return msg["result"]

    async def _start(self) -> None:
        self._proc = await asyncio.create_subprocess_exec(
            *self._argv,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            limit=2 * 1024 * 1024,
        )
        await self._rpc(
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "sakk-litellm-gateway", "version": "0.1.0"},
            },
        )
        await self._send({"jsonrpc": "2.0", "method": "notifications/initialized"})

    async def call(self, tool: str, args: dict[str, Any]) -> dict[str, Any]:
        async with self._lock:
            try:
                if self._proc is None or self._proc.returncode is not None:
                    await asyncio.wait_for(self._start(), self._timeout)
                result = await asyncio.wait_for(
                    self._rpc("tools/call", {"name": tool, "arguments": args}), self._timeout
                )
                body = json.loads(result["content"][0]["text"])
            except Exception as e:  # any doubt about the ledger is an outage
                self._kill()
                raise SakkUnavailable(f"{tool}: {type(e).__name__}: {e}") from e
        if result.get("isError"):
            raise SakkRefused(str(body.get("code", "REFUSED")), str(body.get("message", "")))
        return body

    def close(self) -> None:
        self._kill()


def worst_case_usd(data: dict[str, Any], price: tuple[float, float], max_out: int) -> float:
    prompt = {k: data[k] for k in PROMPT_FIELDS if k in data}
    in_bytes = len(json.dumps(prompt, ensure_ascii=False, default=str).encode("utf-8"))
    n = data.get("n") or 1
    if not isinstance(n, int) or isinstance(n, bool) or n < 1:
        raise ValueError("n must be a positive integer")
    cost = (in_bytes + INPUT_OVERHEAD_TOKENS) * price[0] + (max_out + OUTPUT_MARGIN_TOKENS) * n * price[1]
    return _round_up_usd(cost)


def _non_text_part(messages: Any) -> bool:
    """True when any message carries a part the byte count cannot price."""
    if not isinstance(messages, list):
        return True
    for m in messages:
        if not isinstance(m, dict):
            return True
        content = m.get("content")
        if content is None or isinstance(content, str):
            continue
        if not isinstance(content, list):
            return True
        for part in content:
            if not isinstance(part, dict) or part.get("type") != "text":
                return True
    return False


def _refuse(status: int, code: str, message: str, **extra: Any) -> HTTPException:
    return HTTPException(status_code=status, detail={"error": {"code": code, "message": message, **extra}})


def _settled_cost(usage: Any, price: tuple[float, float]) -> float | None:
    if not isinstance(usage, dict):
        return None
    p, c = usage.get("prompt_tokens"), usage.get("completion_tokens")
    if not isinstance(p, int) or not isinstance(c, int) or p < 0 or c < 0:
        return None
    return p * price[0] + c * price[1]


def _provider_answered(exc: Any) -> bool:
    """True only when the provider returned an HTTP error, so nothing was billed.

    Timeouts and lost connections may have been billed: those settle the
    reserved worst case instead.
    """
    if exc is None or isinstance(exc, HTTPException):
        return False
    name = type(exc).__name__
    if name in {"Timeout", "APITimeoutError", "APIConnectionError", "ServiceUnavailableError"}:
        return False
    status = getattr(exc, "status_code", None)
    return isinstance(status, int) and 400 <= status < 600 and status != 408


class SakkGate(CustomLogger):
    def __init__(self) -> None:
        super().__init__()
        self._config_path = _required_env("SAKK_GATEWAY_CONFIG")
        self.prices = load_prices(self._config_path)
        log.warning("sakk_gateway: priced models: %s", ", ".join(sorted(self.prices)) or "(none)")
        self.default_max_tokens = int(os.environ.get("SAKK_DEFAULT_MAX_TOKENS", "2048"))
        self.client = SakkClient(
            os.environ.get("SAKK_NODE", "node"),
            _required_env("SAKK_BIN"),
            _required_env("SAKK_LEDGER"),
            float(os.environ.get("SAKK_TIMEOUT_S", "10")),
        )
        # sakk callId -> what settling it needs. Popped exactly once.
        self.pending: dict[str, dict[str, Any]] = {}

    # ---- before the provider ------------------------------------------------

    async def async_pre_call_hook(self, user_api_key_dict, cache, data, call_type):
        md = data.get("metadata")
        if not isinstance(md, dict):
            md = {}
            data["metadata"] = md
        md.pop("sakk_call_id", None)  # only this hook may set it

        if call_type not in METERED_CALL_TYPES:
            raise _refuse(403, "SAKK_UNMETERED", f"route type {call_type!r} has no cost model in the Sakk gateway")
        model = data.get("model")
        price = self.prices.get(model) if isinstance(model, str) else None
        if price is None:
            raise _refuse(403, "SAKK_NO_PRICE", f"model {model!r} has no price in the gateway config")
        if _non_text_part(data.get("messages")):
            raise _refuse(403, "SAKK_UNMETERED", "only text message parts can be priced before the call")

        caps = [data[k] for k in ("max_tokens", "max_completion_tokens") if data.get(k) is not None]
        if any(not isinstance(v, int) or isinstance(v, bool) or v < 1 for v in caps):
            raise _refuse(400, "SAKK_BAD_REQUEST", "max_tokens must be a positive integer")
        if not caps:
            data["max_tokens"] = self.default_max_tokens
            caps = [self.default_max_tokens]
        if data.get("stream"):
            opts = data.get("stream_options")
            data["stream_options"] = {**(opts if isinstance(opts, dict) else {}), "include_usage": True}

        try:
            worst = worst_case_usd(data, price, max(caps))
        except ValueError as e:
            raise _refuse(400, "SAKK_BAD_REQUEST", str(e))

        cid = "gw-" + uuid.uuid4().hex
        try:
            await self.client.call(
                "sakk_reserve",
                {"callId": cid, "estimatedMaxUsd": worst, "agent": AGENT, "action": f"chat:{model}"},
            )
        except SakkRefused as e:
            raise _refuse(402, e.code, e.message, estimatedMaxUsd=worst)
        except SakkUnavailable as e:
            log.error("sakk reserve failed: %s", e)
            raise _refuse(503, "SAKK_UNAVAILABLE", "the spend ledger is unreachable; no call was made")
        self.pending[cid] = {"price": price, "worst": worst, "model": model}
        md["sakk_call_id"] = cid
        return data

    # ---- after the provider -------------------------------------------------

    async def _settle(self, cid: str | None, actual: float, why: str) -> None:
        if not cid:
            return
        rec = self.pending.pop(cid, None)
        if rec is None:
            return  # already settled, or not ours
        last: Exception | None = None
        for _ in range(2):  # settle is idempotent per callId, so one retry is safe
            try:
                await self.client.call("sakk_settle", {"callId": cid, "actualUsd": actual})
                log.info("sakk settled %s %s $%.6f (%s)", cid, rec["model"], actual, why)
                return
            except SakkRefused as e:
                log.error("sakk refused settling %s: %s", cid, e)
                return
            except SakkUnavailable as e:
                last = e
        log.error("sakk settle failed for %s, the reservation stays held: %s", cid, last)

    @staticmethod
    def _cid_from_kwargs(kwargs: dict[str, Any]) -> str | None:
        for md in (
            (kwargs.get("litellm_params") or {}).get("metadata"),
            kwargs.get("metadata"),
        ):
            if isinstance(md, dict) and isinstance(md.get("sakk_call_id"), str):
                return md["sakk_call_id"]
        return None

    async def async_log_success_event(self, kwargs, response_obj, start_time, end_time):
        cid = self._cid_from_kwargs(kwargs)
        rec = self.pending.get(cid) if cid else None
        if rec is None:
            return
        slo = kwargs.get("standard_logging_object") or {}
        usage = None
        if isinstance(slo, dict) and isinstance(slo.get("prompt_tokens"), int):
            usage = {"prompt_tokens": slo.get("prompt_tokens"), "completion_tokens": slo.get("completion_tokens")}
        if usage is None:
            raw = getattr(response_obj, "usage", None)
            usage = raw.model_dump() if hasattr(raw, "model_dump") else raw
        cost = _settled_cost(usage, rec["price"])
        if cost is None:
            await self._settle(cid, rec["worst"], "no usage reported, settled the worst case")
        else:
            # Never clamped: a cost above the reservation must halt the ledger.
            await self._settle(cid, cost, "usage")

    async def async_log_failure_event(self, kwargs, response_obj, start_time, end_time):
        cid = self._cid_from_kwargs(kwargs)
        rec = self.pending.get(cid) if cid else None
        if rec is None:
            return
        exc = kwargs.get("exception")
        if _provider_answered(exc) and not kwargs.get("stream"):
            await self._settle(cid, 0.0, f"provider error {getattr(exc, 'status_code', '?')}")
        else:
            await self._settle(cid, rec["worst"], f"unknown outcome ({type(exc).__name__})")

    async def async_post_call_failure_hook(self, request_data, original_exception, user_api_key_dict, traceback_str=None):
        # The proxy can fail a request after the provider billed it (a later
        # hook raising, for one), so this path never settles below the worst
        # case. It only catches reservations the provider-call log events
        # missed, after giving them time to land.
        md = request_data.get("metadata") if isinstance(request_data, dict) else None
        cid = md.get("sakk_call_id") if isinstance(md, dict) else None
        if cid and cid in self.pending:
            asyncio.get_running_loop().create_task(self._late_settle(cid, type(original_exception).__name__))

    async def _late_settle(self, cid: str, why: str) -> None:
        await asyncio.sleep(LATE_SETTLE_S)
        rec = self.pending.get(cid)
        if rec is not None:
            await self._settle(cid, rec["worst"], f"request failed in the proxy ({why})")


handler = SakkGate()
