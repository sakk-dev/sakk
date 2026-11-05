"""Sakk spend gate for the LiteLLM proxy.

Every chat call through the proxy reserves its worst-case cost with Sakk
before the provider is called, and settles the real cost afterwards.
Anything the gate cannot price is refused, never let through.

When Sakk itself cannot answer (it will not start, crashed, hung past the
timeout, or replied garbage) the default is to let the call through,
unmetered and loudly: a WARNING log line, an `x-sakk-status: unmetered`
response header, and an outage record in the status file that the console
and `sakk status` show. Calls let through this way are not in the ledger
and not capped. SAKK_ON_UNAVAILABLE=deny refuses them with 503 instead.
A deliberate refusal from Sakk (over the cap, halted, needs
reconciliation) stays a refusal in both modes.

One LiteLLM worker process is assumed: the status file is guarded by an
in-process lock, so several workers would overwrite each other's counts.
Status writes take that lock and fsync on the event-loop thread, so a slow
disk stalls every call in this worker while an outage opens, counts or ends.

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
    SAKK_TIMEOUT_S           how long one ledger call may take (5)
    SAKK_BREAKER_S           after a reserve outage, how long reserves skip the ledger (10; 0 = never)
    SAKK_RESERVATION_TTL_S   age at which this gateway's unsettled reservations settle at their worst case (3600)
    SAKK_ON_UNAVAILABLE      allow (default) or deny, when Sakk cannot answer
    SAKK_GATEWAY_STATUS      status file (default: <SAKK_LEDGER>.gateway.json, folder links resolved)

A reservation whose settle never arrives (the proxy crashed, a settle failed
twice, the event never fired) would stay outstanding for ever: its worst case
counts against the cap either way, but it also holds one of the ledger's
outstanding slots (LEDGER_FULL) and keeps the books from sealing. Once it is
older than SAKK_RESERVATION_TTL_S, a background sweep settles it at the worst
case it reserved, with a WARNING `sakk_reservation_expired` line (F-242). Only
entries this gateway made (agent litellm-gateway) are swept. With several
gateways on one ledger, one may sweep another's long call; that call's own
settle then refuses with SETTLE_MISMATCH and an alert, and the books keep the
worst case: over-recorded, never under.
"""

from __future__ import annotations

import asyncio
import errno
import json
import logging
import math
import os
import threading
import time
import uuid
from datetime import datetime, timezone
from decimal import ROUND_CEILING, Decimal
from typing import Any, Callable

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
# A ledger call that has not answered in this long is an outage. It must be
# longer than the ledger's own lock wait (about 2 s of spinning in
# src/ledger.mjs, then LEDGER_LOCK_UNAVAILABLE): at 2 s a busy but healthy
# ledger read as down (F-243). Queued calls do not each wait it out: the
# breaker below fails them at once.
DEFAULT_TIMEOUT_S = 5.0
# After a reserve outage, reserves skip the ledger this long and take the
# outage path at once (allow: unmetered and counted; deny: 503), instead of
# queueing behind one another for a timeout each.
DEFAULT_BREAKER_S = 10.0
# A gateway reservation still unsettled after this long settles at its
# reserved worst case (F-242). The sweep runs at most this often, and settles
# at most this many entries per run.
DEFAULT_RESERVATION_TTL_S = 3600.0
SWEEP_EVERY_S = 60.0
SWEEP_MAX = 50
OUTAGE_MODES = ("allow", "deny")
STATUS_VERSION = 1
REASON_MAX = 200
# Request fields that become prompt tokens.
PROMPT_FIELDS = ("messages", "tools", "functions", "tool_choice", "response_format", "system")


class SakkUnavailable(Exception):
    """The ledger could not be reached or answered something unreadable."""


class _BreakerOpen(SakkUnavailable):
    """A reserve not sent because the ledger failed one moments ago; it takes the outage path."""


class _NotSent(Exception):
    """A request that never fully reached `sakk mcp`; the only failure that is sent again."""


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


def _outage_mode() -> str:
    value = os.environ.get("SAKK_ON_UNAVAILABLE")
    if value is None:
        return "allow"
    if value not in OUTAGE_MODES:
        raise RuntimeError(
            f"sakk_gateway: SAKK_ON_UNAVAILABLE must be allow or deny, not {value!r}; the gateway refuses to start"
        )
    return value


def _timeout_s() -> float:
    raw = os.environ.get("SAKK_TIMEOUT_S")
    if raw is None:
        return DEFAULT_TIMEOUT_S
    try:
        value = float(raw)
    except ValueError:
        value = math.nan
    # A zero timeout would turn every call into an outage, and in allow mode
    # into an unmetered call.
    if not math.isfinite(value) or value <= 0:
        raise RuntimeError(
            f"sakk_gateway: SAKK_TIMEOUT_S must be a positive number of seconds, not {raw!r}; "
            "the gateway refuses to start"
        )
    return value


def _seconds_env(name: str, default: float, zero_ok: bool) -> float:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        value = float(raw)
    except ValueError:
        value = math.nan
    if not math.isfinite(value) or value < 0 or (value == 0 and not zero_ok):
        need = "zero or a positive number" if zero_ok else "a positive number"
        raise RuntimeError(f"sakk_gateway: {name} must be {need} of seconds, not {raw!r}; the gateway refuses to start")
    return value


def _breaker_s() -> float:
    # 0 turns the breaker off: every reserve tries the ledger and waits out the timeout.
    return _seconds_env("SAKK_BREAKER_S", DEFAULT_BREAKER_S, zero_ok=True)


def _reservation_ttl_s() -> float:
    # No "never": a reservation nobody settles stays outstanding for ever (F-242).
    return _seconds_env("SAKK_RESERVATION_TTL_S", DEFAULT_RESERVATION_TTL_S, zero_ok=False)


def _expired_reservation(e: Any, cutoff: float) -> tuple[str, float] | None:
    """(callId, worst case) for a reservation this gateway made before `cutoff`, else None.

    The ledger file is read as data anyone could have written: an entry with a
    field of the wrong type, or an unreadable time, is left alone.
    """
    if not isinstance(e, dict) or e.get("status") != "RESERVED" or e.get("agentId") != AGENT:
        return None
    cid, usd, at = e.get("callId"), e.get("estimatedMaxUsd"), e.get("createdAt")
    if not isinstance(cid, str) or not cid or not isinstance(at, str):
        return None
    if not isinstance(usd, (int, float)) or isinstance(usd, bool) or not math.isfinite(usd) or usd < 0:
        return None
    try:
        created = datetime.fromisoformat(at.replace("Z", "+00:00"))
    except ValueError:
        return None
    if created.tzinfo is None or created.timestamp() > cutoff:
        return None
    return cid, float(usd)


def _read_json(path: str) -> Any:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def status_path_for(ledger: str) -> str:
    """Where the gateway records outages; `sakk status` and the console derive the same path.

    The ledger's folder with every link resolved, the ledger's file name, then
    ".gateway.json": the same rule as gatewayStatusPathFor in
    src/gateway-status.mjs, so a relative SAKK_LEDGER or one through a linked
    folder still names the file the readers look at.
    """
    override = os.environ.get("SAKK_GATEWAY_STATUS")
    if override:
        return override
    absolute = os.path.abspath(ledger)
    folder = os.path.realpath(os.path.dirname(absolute))
    return os.path.join(folder, os.path.basename(absolute)) + ".gateway.json"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _valid_outage(o: Any) -> bool:
    if not isinstance(o, dict) or not isinstance(o.get("since"), str):
        return False
    n, usd = o.get("allowed_calls"), o.get("est_max_unrecorded_usd")
    return (
        isinstance(n, int)
        and not isinstance(n, bool)
        and n >= 0
        and isinstance(usd, (int, float))
        and not isinstance(usd, bool)
        and math.isfinite(usd)
        and usd >= 0
    )


class GatewayStatus:
    """The gateway's own record of Sakk outages, kept in one small JSON file.

    Written whole each time (temp file, fsync, rename, mode 0600). A write
    that fails is logged and never fails the call it describes.
    """

    def __init__(self, path: str, mode: str):
        self.path = path
        self.mode = mode
        self._lock = threading.Lock()
        self.outage: dict[str, Any] | None = None
        self.last_outage: dict[str, Any] | None = None
        self._load()
        with self._lock:
            self._write_locked()

    def _load(self) -> None:
        try:
            with open(self.path, encoding="utf-8") as f:
                doc = json.load(f)
        except FileNotFoundError:
            return
        except Exception as e:
            log.error("sakk_gateway: status file %s is unreadable, starting a fresh one: %s", self.path, e)
            return
        if not isinstance(doc, dict) or doc.get("version") != STATUS_VERSION:
            log.error("sakk_gateway: status file %s has an unknown shape, starting a fresh one", self.path)
            return
        # An outage still open when the gateway last stopped keeps counting.
        if _valid_outage(doc.get("outage")):
            self.outage = dict(doc["outage"])
        if _valid_outage(doc.get("last_outage")):
            self.last_outage = dict(doc["last_outage"])

    def _write_locked(self) -> None:
        doc = {
            "version": STATUS_VERSION,
            "updatedAt": _now_iso(),
            "mode": self.mode,
            "outage": self.outage,
            "last_outage": self.last_outage,
        }
        tmp = f"{self.path}.{os.getpid()}.{uuid.uuid4().hex[:8]}.tmp"
        try:
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(doc, f)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, self.path)
        except Exception as e:
            log.error("sakk_gateway: could not write the status file %s: %s", self.path, e)
            try:
                os.unlink(tmp)
            except OSError:
                pass

    def outage_seen(self, reason: str, worst: float, allowed: bool) -> dict[str, Any]:
        with self._lock:
            now = _now_iso()
            if self.outage is None:
                self.outage = {
                    "since": now,
                    "allowed_calls": 0,
                    "est_max_unrecorded_usd": 0.0,
                    "last_reason": "",
                    "last_at": now,
                }
            o = self.outage
            if allowed:
                o["allowed_calls"] += 1
                o["est_max_unrecorded_usd"] = round(o["est_max_unrecorded_usd"] + worst, 6)
            o["last_reason"] = reason[:REASON_MAX]
            o["last_at"] = now
            snap = dict(o)
            self._write_locked()
        return snap

    def answered(self) -> dict[str, Any] | None:
        """Sakk answered a reserve: close the open outage, if any."""
        if self.outage is None:
            return None
        with self._lock:
            if self.outage is None:
                return None
            ended = {**self.outage, "ended_at": _now_iso()}
            self.last_outage = ended
            self.outage = None
            self._write_locked()
        return ended


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
        try:
            await self._send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
        except OSError as e:
            # The pipe was already closed, so the request's closing newline never
            # reached Sakk and it cannot have acted on it.
            if isinstance(e, (BrokenPipeError, ConnectionResetError)) or e.errno == errno.EPIPE:
                raise _NotSent(f"{type(e).__name__}: {e}") from e
            raise
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

    async def call(
        self, tool: str, args: dict[str, Any], gate: Callable[[], None] | None = None
    ) -> dict[str, Any]:
        # gate raises to skip the ledger. It is asked again once the lock is
        # held, so a call that queued behind a failing one does not then wait
        # out its own timeout (F-243).
        if gate is not None:
            gate()
        async with self._lock:
            if gate is not None:
                gate()
            for _ in range(2):  # the second pass is always a fresh process: _kill clears _proc
                fresh = self._proc is None or self._proc.returncode is not None
                try:
                    if fresh:
                        await asyncio.wait_for(self._start(), self._timeout)
                    result = await asyncio.wait_for(
                        self._rpc("tools/call", {"name": tool, "arguments": args}), self._timeout
                    )
                    body = json.loads(result["content"][0]["text"])
                    break
                except Exception as e:  # any doubt about the ledger is an outage
                    self._kill()
                    # Sent again only when the request never reached a process that
                    # was already running (it died since the last call). Anything
                    # else is an outage at once: a fresh process failing, a hang, or
                    # a reply lost after the request was written, because the same
                    # callId sent twice is refused as a duplicate when the first one
                    # landed (Stripe's rule for calls that are not idempotent).
                    if fresh or not isinstance(e, _NotSent):
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
        self.on_unavailable = _outage_mode()
        self.breaker_s = _breaker_s()
        self.reservation_ttl_s = _reservation_ttl_s()
        self.ledger = _required_env("SAKK_LEDGER")
        self.client = SakkClient(
            os.environ.get("SAKK_NODE", "node"),
            _required_env("SAKK_BIN"),
            self.ledger,
            _timeout_s(),
        )
        self.status = GatewayStatus(status_path_for(self.ledger), self.on_unavailable)
        log.warning(
            "sakk_gateway: when Sakk cannot answer: %s (status file %s)", self.on_unavailable, self.status.path
        )
        # sakk callId -> what settling it needs. Popped exactly once.
        self.pending: dict[str, dict[str, Any]] = {}
        # callIds a settle is in flight for: the sweep leaves them alone.
        self._settling: set[str] = set()
        # event-loop time until which reserves take the outage path unsent
        self._breaker_until = -math.inf
        self._next_sweep = -math.inf
        self._sweep_task: asyncio.Task | None = None
        self._settled_since_read: set[str] | None = None

    def _breaker_gate(self) -> None:
        if asyncio.get_running_loop().time() < self._breaker_until:
            raise _BreakerOpen(f"breaker open: a reserve failed within the last {self.breaker_s:g}s, not sent")

    # ---- before the provider ------------------------------------------------

    async def async_pre_call_hook(self, user_api_key_dict, cache, data, call_type):
        md = data.get("metadata")
        if not isinstance(md, dict):
            md = {}
            data["metadata"] = md
        md.pop("sakk_call_id", None)  # only this hook may set these
        md.pop("sakk_unmetered", None)

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

        self._maybe_sweep()
        cid = "gw-" + uuid.uuid4().hex
        try:
            await self.client.call(
                "sakk_reserve",
                {"callId": cid, "estimatedMaxUsd": worst, "agent": AGENT, "action": f"chat:{model}"},
                gate=self._breaker_gate,
            )
        except SakkRefused as e:
            self._sakk_answered()  # a refusal is an answer: Sakk is back
            raise _refuse(402, e.code, e.message, estimatedMaxUsd=worst)
        except SakkUnavailable as e:
            if not isinstance(e, _BreakerOpen) and self.breaker_s > 0:
                self._breaker_until = asyncio.get_running_loop().time() + self.breaker_s
            reason = str(e)[:REASON_MAX]
            if self.on_unavailable == "deny":
                self.status.outage_seen(reason, worst, allowed=False)
                log.error("sakk reserve failed: %s", reason)
                raise _refuse(503, "SAKK_UNAVAILABLE", "the spend ledger is unreachable; no call was made")
            snap = self.status.outage_seen(reason, worst, allowed=True)
            log.warning(
                "%s",
                json.dumps(
                    {
                        "event": "sakk_unavailable_allowed",
                        "model": model,
                        "est_max_usd": worst,
                        "reason": reason,
                        "outage_since": snap["since"],
                        "allowed_calls": snap["allowed_calls"],
                    }
                ),
            )
            # No call id and no pending entry: the settle hooks skip this call.
            md["sakk_unmetered"] = True
            return data
        self._sakk_answered()
        self.pending[cid] = {"price": price, "worst": worst, "model": model}
        md["sakk_call_id"] = cid
        return data

    def _sakk_answered(self) -> None:
        """Sakk answered a reserve, with a reservation or a refusal: end an open outage."""
        self._breaker_until = -math.inf
        ended = self.status.answered()
        if ended is not None:
            log.warning("%s", json.dumps({"event": "sakk_outage_ended", **ended}))

    # ---- reservations nobody settled (F-242) -------------------------------

    def _maybe_sweep(self) -> None:
        """Start a sweep in the background if one is due and none is running."""
        if self._sweep_task is not None and not self._sweep_task.done():
            return
        loop = asyncio.get_running_loop()
        if loop.time() < self._next_sweep:
            return
        self._next_sweep = loop.time() + SWEEP_EVERY_S
        self._sweep_task = loop.create_task(self._sweep_expired())

    async def _sweep_expired(self) -> int:
        """Settle this gateway's reservations older than the TTL at their worst case.

        Returns how many settles it sent. At most SWEEP_MAX per run; the rest
        wait for the next run. Settles bypass the breaker, like every settle.
        """
        # settles this process finishes after the read below: the file read
        # still shows them RESERVED, and a second settle would only refuse
        self._settled_since_read = set()
        try:
            return await self._sweep_run()
        finally:
            self._settled_since_read = None

    async def _sweep_run(self) -> int:
        try:
            doc = await asyncio.to_thread(_read_json, self.ledger)
            entries = doc["entries"]
            if not isinstance(entries, list):
                raise ValueError("entries is not a list")
        except Exception as e:
            log.error("sakk_gateway: could not read the ledger to expire old reservations: %s", e)
            return 0
        cutoff = time.time() - self.reservation_ttl_s
        sent = 0
        for e in entries:
            if sent >= SWEEP_MAX:
                break
            hit = _expired_reservation(e, cutoff)
            if hit is None or hit[0] in self._settling or hit[0] in (self._settled_since_read or ()):
                continue
            cid, usd = hit
            # one of ours still waiting for its provider: this settle replaces its own
            self.pending.pop(cid, None)
            sent += 1
            try:
                await self.client.call("sakk_settle", {"callId": cid, "actualUsd": usd})
            except SakkRefused as err:
                log.error("sakk refused expiring %s: %s", cid, err)
                continue
            except SakkUnavailable as err:
                log.error("sakk settle failed expiring %s, the sweep stops until the next run: %s", cid, err)
                return sent
            log.warning(
                "%s",
                json.dumps(
                    {
                        "event": "sakk_reservation_expired",
                        "callId": cid,
                        "settled_usd": usd,
                        "created_at": e.get("createdAt"),
                        "ttl_s": self.reservation_ttl_s,
                    }
                ),
            )
        return sent

    # ---- after the provider -------------------------------------------------

    async def async_post_call_response_headers_hook(
        self, data, user_api_key_dict, response, request_headers=None, litellm_call_info=None
    ):
        md = data.get("metadata") if isinstance(data, dict) else None
        if isinstance(md, dict) and md.get("sakk_unmetered") is True:
            return {"x-sakk-status": "unmetered"}
        return None

    async def _settle(self, cid: str | None, actual: float, why: str) -> None:
        if not cid:
            return
        rec = self.pending.pop(cid, None)
        if rec is None:
            return  # already settled, or not ours
        self._settling.add(cid)
        try:
            last: Exception | None = None
            for _ in range(2):  # settle is idempotent per callId, so one retry is safe
                try:
                    # no gate: a settle releases cap, so it is sent even while reserves are not
                    await self.client.call("sakk_settle", {"callId": cid, "actualUsd": actual})
                    log.info("sakk settled %s %s $%.6f (%s)", cid, rec["model"], actual, why)
                    return
                except SakkRefused as e:
                    log.error("sakk refused settling %s: %s", cid, e)
                    return
                except SakkUnavailable as e:
                    last = e
            log.error(
                "sakk settle failed for %s, the reservation stays held until it expires (%gs): %s",
                cid,
                self.reservation_ttl_s,
                last,
            )
        finally:
            self._settling.discard(cid)
            if self._settled_since_read is not None:
                self._settled_since_read.add(cid)

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
