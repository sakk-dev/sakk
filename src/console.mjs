// SPDX-License-Identifier: AGPL-3.0-only
//
// `sakk ui` — a local, read-only console (open-source v1, M4; specs/console/).
// It listens on loopback only, gates every request on a fresh 128-bit token,
// and shows only what M1–M3 recorded, through the same functions the CLI uses
// (contract #3). The one write is stopping an agent, behind --allow-halt.
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { openSync, fstatSync, readSync, closeSync, existsSync } from 'node:fs';
import { userInfo, homedir } from 'node:os';
import { join } from 'node:path';

import { sakkHome, readConfig, repoRootOf, choosePolicy, evaluate, normalize } from './hook.mjs';
import { loadPrices } from './prices.mjs';
import { daySpend, systemZone, dayOf, SpendError } from './spend.mjs';
import { doctor } from './guard-install.mjs';
import { halt, LedgerError } from './ledger.mjs';

export class ConsoleError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'ConsoleError';
  }
}

// A decision line is bounded (M1 caps every context string), so the last page
// of the log lives in a bounded tail: a 5 GB file is never loaded whole.
export const TAIL_BYTES = 1024 * 1024; // read at most this from the end
export const PAGE_LINES = 500; // show at most this many, newest first
export const MAX_QUERY = 8 * 1024; // a request line over this is refused (input-space)
const TOKEN_BYTES = 16; // 128-bit

const token = () => randomBytes(TOKEN_BYTES).toString('hex');

/** Constant-time token check; a missing or wrong-length token still compares. */
export function tokenOk(given, want) {
  const b = Buffer.from(want);
  if (typeof given !== 'string' || Buffer.byteLength(given) !== b.length) {
    timingSafeEqual(b, b); // keep the timing flat on the reject path
    return false;
  }
  return timingSafeEqual(Buffer.from(given), b);
}

const hostOk = (host, port) => host === `127.0.0.1:${port}` || host === `localhost:${port}`;
const originOk = (origin, port) =>
  origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;

function parseCookie(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/**
 * The last page of the decision log, newest first, read from the end within a
 * byte cap. Returns the parsed entries plus the counters a test asserts on:
 * `scannedBytes` (<= TAIL_BYTES however big the file) and `unreadable`.
 */
export function tailDecisions({ home, limit = PAGE_LINES, cap = TAIL_BYTES }) {
  const path = join(home, 'decisions.jsonl');
  if (!existsSync(path)) return { entries: [], scannedBytes: 0, unreadable: 0, truncated: false };
  let fd;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const start = size > cap ? size - cap : 0;
    const len = size - start;
    const buf = Buffer.alloc(len);
    let read = 0;
    while (read < len) {
      const n = readSync(fd, buf, read, len - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    const text = buf.subarray(0, read).toString('utf8');
    // if we began mid-file, the first line is a fragment of an earlier record
    const lines = text.split('\n');
    if (start > 0) lines.shift();
    let unreadable = 0;
    const entries = [];
    for (const line of lines) {
      if (line === '') continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        unreadable += 1;
      }
    }
    entries.reverse(); // newest first
    return {
      entries: entries.slice(0, limit),
      scannedBytes: read,
      unreadable,
      truncated: start > 0,
    };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The policy the hook would use for `cwd` — the same resolution as `sakk try`. */
export function policyInUse({ cwd, home }) {
  const chosen = choosePolicy({ repoRoot: repoRootOf(cwd), home, keep: false });
  return {
    policyPath: chosen.policyPath,
    policyHash: chosen.loaded?.policyHash ?? null,
    rules: chosen.loaded?.policy?.rules ?? [],
    broken: chosen.unknown ? (chosen.unknown.code ?? 'HOOK_FAILED') : null,
    fallback: chosen.fallback
      ? { from: chosen.fallback.local, savedAt: chosen.fallback.savedAt }
      : null,
  };
}

// --- the data each page shows, from M1-M3's own functions (contract #3) ---

export function overviewData({ home, now = Date.now() }) {
  const config = readConfig(home);
  const { table } = loadPrices({ home });
  const zone = config.timeZone || systemZone();
  const day = dayOf(now, zone);
  let spend;
  try {
    // read-only: the hook maintains the spend index; the console only reads it,
    // so a GET never writes (M4 review). Spend is current whenever a cap is set.
    spend = daySpend({ home, day, table });
  } catch (e) {
    if (!(e instanceof SpendError)) throw e;
    spend = { day, usd: 0, calls: 0, unpriced: {}, unreadable: 0, byModel: {}, error: e.code };
  }
  const recent = tailDecisions({ home, limit: 50 });
  const counts = { allow: 0, deny: 0, require_approval: 0 };
  for (const d of recent.entries) if (d.verdict in counts) counts[d.verdict] += 1;
  return {
    source: 'from local logs', // never billed (F-126 / evidence label)
    day,
    zone,
    cap_usd: config.capUsd ?? null,
    spend_usd: spend.usd,
    calls: spend.calls,
    by_model: spend.byModel,
    unpriced: spend.unpriced,
    unreadable_spend: spend.unreadable,
    recent: recent.entries.slice(0, 20),
    recent_counts: counts,
  };
}

export function secretData({ home }) {
  const tail = tailDecisions({ home, limit: PAGE_LINES });
  const cards = tail.entries
    .filter((d) => d.ruleId === 'secret')
    .map((d) => ({
      at: d.at ?? null,
      agent: d.by ?? null,
      action: d.context?.action ?? null,
      scope: d.context?.scope ?? null,
    }));
  return { note: 'A secret block records the rule and a fingerprint, never the value.', cards };
}

export function pricesData({ home }) {
  const { table, path } = loadPrices({ home });
  const models = Object.entries(table.models ?? table).map(([id, m]) => ({ id, ...m }));
  return { source: path, approximate: Boolean(table.approximate), count: models.length, models };
}

export function tryData({ cwd, home, env = process.env, command }) {
  if (typeof command !== 'string' || command === '')
    throw new ConsoleError('CONSOLE_TRY_EMPTY', 'try needs a command');
  const r = evaluate(
    normalize('claude-code', {
      hook_event_name: 'PreToolUse',
      cwd,
      session_id: 'sakk-ui',
      tool_use_id: `ui-${Date.now()}`,
      tool_name: 'Bash',
      tool_input: { command },
    }),
    { env, log: false }, // read-only: nothing is written
  );
  return {
    verdict: r.verdict,
    reason: r.reason,
    policyPath: r.policyPath,
    policyHash: r.policyHash,
    decisions: r.decisions.map((d) => ({
      action: d.context.action,
      scope: d.context.scope ?? null,
      verdict: d.verdict,
      rule: d.ruleId,
    })),
  };
}

const PAGES = ['overview', 'rules', 'secret', 'agents', 'records', 'prices', 'enterprise'];

/**
 * The console server. Binds 127.0.0.1 only. Resolves once listening with the
 * address, the token and a close(). `port: 0` takes a random free port.
 */
export function startConsole({
  port = 0,
  allowHalt = false,
  cwd = process.cwd(),
  home = sakkHome(),
  ledgerPath = process.env.SAKK_LEDGER_PATH || null,
  env = process.env,
} = {}) {
  const tok = token();
  const state = { forbidden: 0 };
  let bound = port;
  const headers = (nonce) => ({
    // non-HTML responses carry no script/style, so their CSP allows none at all
    'Content-Security-Policy': `default-src 'none'; script-src ${nonce ? `'self' 'nonce-${nonce}'` : "'none'"}; style-src ${nonce ? `'self' 'nonce-${nonce}'` : "'none'"}; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'`,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store', // tokens and log data never land in a shared cache
  });
  const send = (res, status, type, body, extra = {}) => {
    res.writeHead(status, { 'Content-Type': type, ...headers(''), ...extra });
    res.end(body);
  };
  const json = (res, obj, status = 200) =>
    send(res, status, 'application/json; charset=utf-8', JSON.stringify(obj));
  const forbid = (res) => {
    state.forbidden += 1;
    send(res, 403, 'text/plain; charset=utf-8', 'forbidden');
  };

  const server = createServer((req, res) => {
    try {
      // 1. a request line over the cap never reaches a handler
      if (req.url.length > MAX_QUERY) return send(res, 414, 'text/plain', 'request too long');
      const url = new URL(req.url, `http://127.0.0.1:${bound}`);
      // 2. Host must be our loopback address (blocks DNS rebinding)
      if (!hostOk(req.headers.host, bound)) return forbid(res);
      // 2b. a cross-site Origin is refused on EVERY route, GET included, before
      // dispatch — one gate for current and future routes (F-195). An absent
      // Origin (typed URL, curl, same-origin GET) stays allowed; the halt write
      // below still requires the Origin to be present.
      if (req.headers.origin !== undefined && !originOk(req.headers.origin, bound))
        return forbid(res);
      // 3. the token, from the first-load query or the cookie after that
      const fromQuery = url.searchParams.get('t');
      const cookie = parseCookie(req.headers.cookie).sakk_t;
      if (!tokenOk(fromQuery, tok) && !tokenOk(cookie, tok)) return forbid(res);

      const path = url.pathname;
      if (req.method === 'GET' && path === '/') {
        const nonce = randomBytes(16).toString('base64');
        const extra = {};
        // promote a valid query token to a strict, http-only cookie
        if (tokenOk(fromQuery, tok))
          extra['Set-Cookie'] = `sakk_t=${tok}; Path=/; SameSite=Strict; HttpOnly`;
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          ...headers(nonce),
          ...extra,
        });
        return res.end(renderPage(nonce, allowHalt));
      }
      if (req.method === 'GET' && path.startsWith('/api/')) {
        const name = path.slice(5);
        if (name === 'overview') return json(res, overviewData({ home, env }));
        if (name === 'rules') return json(res, policyInUse({ cwd, home }));
        if (name === 'secret') return json(res, secretData({ home }));
        if (name === 'agents')
          return json(res, {
            allowHalt,
            haltReady: Boolean(ledgerPath),
            checks: doctor({ cwd, home: env.HOME || homedir(), env, probe: false }),
          });
        if (name === 'prices') {
          try {
            return json(res, pricesData({ home }));
          } catch (e) {
            return json(res, { error: e.code ?? 'PRICES_UNREADABLE', message: String(e.message) });
          }
        }
        if (name === 'records') {
          const tail = tailDecisions({ home, limit: PAGE_LINES });
          return json(res, {
            source: 'decisions from the hook, spend from local logs',
            truncated: tail.truncated,
            unreadable: tail.unreadable,
            decisions: tail.entries,
          });
        }
        if (name === 'try') {
          try {
            return json(res, tryData({ cwd, home, env, command: url.searchParams.get('cmd') }));
          } catch (e) {
            return json(
              res,
              { error: e.code ?? 'CONSOLE_TRY_FAILED', message: String(e.message) },
              400,
            );
          }
        }
        if (name === 'forbidden') return json(res, { forbidden: state.forbidden });
        return send(res, 404, 'text/plain', 'not found');
      }
      if (req.method === 'POST' && path === '/api/halt') {
        if (!allowHalt) return send(res, 405, 'text/plain', 'read-only: start with --allow-halt');
        // a write needs the Origin and the token header too, not just the cookie
        if (!originOk(req.headers.origin, bound) || !tokenOk(req.headers['x-sakk-token'], tok))
          return forbid(res);
        if (!ledgerPath)
          return json(res, { error: 'CONSOLE_NO_LEDGER', message: 'no ledger configured' }, 409);
        return readBody(req, 4096, (body) => {
          let agentId;
          try {
            agentId = JSON.parse(body || '{}').agent;
          } catch {
            return json(res, { error: 'CONSOLE_BAD_BODY' }, 400);
          }
          if (agentId !== undefined && (typeof agentId !== 'string' || agentId === ''))
            return json(res, { error: 'CONSOLE_BAD_AGENT' }, 400);
          try {
            const by = (userInfo().username || 'console').slice(0, 200);
            const r = halt({ ledgerPath, by, reason: 'self-declared via sakk ui', agentId });
            return json(res, {
              halted: true,
              scope: agentId ?? 'all',
              by,
              note: 'self-declared (the OS account name, not a verified identity)',
              already: Boolean(r.alreadyHalted),
            });
          } catch (e) {
            const code = e instanceof LedgerError ? e.code : 'CONSOLE_HALT_FAILED';
            return json(res, { error: code, message: String(e.message) }, 409);
          }
        });
      }
      return send(res, 404, 'text/plain', 'not found');
    } catch {
      try {
        send(res, 500, 'text/plain', 'error');
      } catch {
        /* response already sent */
      }
    }
  });

  server.listen(port, '127.0.0.1'); // never 0.0.0.0
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', () => {
      bound = server.address().port;
      resolve({
        server,
        port: bound,
        token: tok,
        url: `http://127.0.0.1:${bound}/?t=${tok}`,
        address: server.address().address,
        state,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function readBody(req, cap, cb) {
  let data = '';
  let over = false;
  req.on('data', (c) => {
    data += c;
    if (data.length > cap) {
      over = true;
      req.destroy();
    }
  });
  req.on('end', () => {
    if (!over) cb(data);
  });
}

/**
 * The page: one HTML file, inline script and style under a nonce, no other
 * origin. It fetches /api/* (connect-src 'self') with the strict cookie and
 * renders every value with textContent, so no log string is ever HTML.
 */
export function renderPage(nonce, allowHalt) {
  const nav = PAGES.map((p) => `<button class="nav" data-page="${p}">${navLabel(p)}</button>`).join(
    '',
  );
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sakk console</title>
<style nonce="${nonce}">
:root{--bg:#0f1115;--card:#171a21;--line:#262b36;--fg:#e6e9ef;--mut:#8b93a7;--acc:#5db0a7;--bad:#e5737b;--warn:#d9a441}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--fg)}
header{display:flex;gap:12px;align-items:baseline;padding:14px 18px;border-bottom:1px solid var(--line)}
header b{font-size:15px;letter-spacing:.2px}header .ro{color:var(--acc);font-size:12px}
.wrap{display:flex;min-height:calc(100vh - 51px)}
aside{width:190px;border-right:1px solid var(--line);padding:10px;display:flex;flex-direction:column;gap:4px}
.nav{text-align:left;background:none;border:0;color:var(--mut);padding:8px 10px;border-radius:7px;cursor:pointer;font:inherit}
.nav:hover{background:var(--card);color:var(--fg)}.nav.on{background:var(--card);color:var(--fg)}
main{flex:1;padding:22px 26px;max-width:1000px}
h1{font-size:19px;margin:0 0 4px}.sub{color:var(--mut);margin:0 0 18px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:0 0 14px}
.kpi{font-size:28px;font-weight:600;font-variant-numeric:tabular-nums}
.row{display:flex;gap:10px;flex-wrap:wrap}.row .card{flex:1;min-width:150px}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--mut);font-weight:500;font-size:12px;text-transform:uppercase;letter-spacing:.4px}
.pill{display:inline-block;padding:1px 8px;border-radius:20px;font-size:12px}
.allow{color:var(--acc)}.deny{color:var(--bad)}.require_approval{color:var(--warn)}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
input{background:#0b0d12;border:1px solid var(--line);color:var(--fg);border-radius:7px;padding:7px 9px;width:min(520px,100%)}
button.act{background:var(--acc);color:#07110f;border:0;border-radius:7px;padding:7px 14px;cursor:pointer;font-weight:600;font:inherit}
.label{color:var(--mut);font-size:12px}.src{color:var(--mut);font-size:12px;margin-top:6px}
.empty{color:var(--mut);padding:10px 0}
.cs h2{margin:0 0 8px}.cs p{color:var(--mut);margin:4px 0}
</style>
</head><body>
<header><b>Sakk console</b><span class="ro">read-only${allowHalt ? ' \u00b7 stop enabled' : ''}</span><span class="label" id="forbidden"></span></header>
<div class="wrap">
<aside>${nav}</aside>
<main id="main"><p class="empty">Loading\u2026</p></main>
</div>
<script nonce="${nonce}">
"use strict";
const $=(t,a={},...k)=>{const e=document.createElement(t);for(const[n,v]of Object.entries(a)){if(n==="class")e.className=v;else if(n==="text")e.textContent=v;else e.setAttribute(n,v);}for(const c of k)e.append(c);return e;};
const api=p=>fetch("/api/"+p,{credentials:"same-origin"}).then(r=>r.json());
function esc(v){return v==null?"\u2014":String(v);}
function tableOf(cols,rows,get){if(!rows||!rows.length)return $("p",{class:"empty",text:"Nothing yet."});const t=$("table");const tr=$("tr");for(const c of cols)tr.append($("th",{text:c}));t.append($("thead",{},tr));const tb=$("tbody");for(const r of rows){const x=$("tr");for(const cell of get(r))x.append(typeof cell==="object"&&cell?cell:$("td",{text:esc(cell)}));tb.append(x);}t.append(tb);return t;}
function vpill(v){return $("td",{},$("span",{class:"pill "+v,text:v==="require_approval"?"asked":v}));}
const PAGES={
 overview:async m=>{const d=await api("overview");m.append($("h1",{text:"Overview"}),$("p",{class:"sub",text:"Today's spend and what the agent did recently."}));
  const row=$("div",{class:"row"});
  const c1=$("div",{class:"card"});c1.append($("div",{class:"label",text:"Spend today ("+esc(d.day)+")"}),$("div",{class:"kpi",text:"$"+(d.spend_usd||0).toFixed(4)}),$("div",{class:"src",text:d.source+(d.cap_usd!=null?" \u00b7 cap $"+d.cap_usd:" \u00b7 no cap set")}));
  const c2=$("div",{class:"card"});c2.append($("div",{class:"label",text:"Recent decisions"}),$("div",{class:"kpi",text:(d.recent_counts.allow||0)+" / "+(d.recent_counts.deny||0)+" / "+(d.recent_counts.require_approval||0)}),$("div",{class:"src",text:"allowed / blocked / asked"}));
  row.append(c1,c2);m.append(row);
  const card=$("div",{class:"card"});card.append(tableOf(["When","Agent","Verdict","Action","Scope"],d.recent,r=>[esc(r.at),esc(r.by),vpill(r.verdict),esc(r.context&&r.context.action),esc(r.context&&r.context.scope)]));m.append(card);},
 rules:async m=>{const d=await api("rules");m.append($("h1",{text:"Guard rules"}),$("p",{class:"sub",text:"The policy in use, and a box to try a command (nothing runs)."}));
  const h=$("div",{class:"card"});h.append($("div",{class:"label",text:"Policy"}),$("div",{class:"mono",text:esc(d.policyPath)}),$("div",{class:"src",text:"sha256 "+(d.policyHash?d.policyHash.slice(0,16)+"\u2026":"\u2014")+(d.broken?" \u00b7 BROKEN: "+d.broken:"")}));m.append(h);
  const t=$("div",{class:"card"});const inp=$("input",{type:"text",placeholder:"git push --force","aria-label":"command"});const btn=$("button",{class:"act",text:"Try"});const out=$("div",{});
  btn.addEventListener("click",async()=>{out.textContent="\u2026";const r=await api("try?cmd="+encodeURIComponent(inp.value||""));out.textContent="";if(r.error){out.append($("p",{class:"deny",text:r.error}));return;}out.append($("p",{class:(r.verdict==="allow"?"allow":r.verdict==="deny"?"deny":"require_approval"),text:"\u2192 "+(r.verdict==="require_approval"?"asks you first":r.verdict)}),$("p",{class:"label",text:esc(r.reason)}));});
  inp.addEventListener("keydown",e=>{if(e.key==="Enter")btn.click();});
  t.append($("div",{class:"label",text:"Try a request"}),$("div",{class:"row"},inp,btn),out);m.append(t);
  const rl=$("div",{class:"card"});rl.append(tableOf(["Rule","When","Verdict"],d.rules,r=>[esc(r.id),esc(JSON.stringify(r.when||r.match||{})),esc(r.verdict||r.decision)]));m.append(rl);},
 secret:async m=>{const d=await api("secret");m.append($("h1",{text:"Secret guard"}),$("p",{class:"sub",text:d.note}));
  const c=$("div",{class:"card"});c.append(tableOf(["When","Agent","Action","Scope"],d.cards,r=>[esc(r.at),esc(r.agent),esc(r.action),esc(r.scope)]));m.append(c);},
 agents:async m=>{const d=await api("agents");m.append($("h1",{text:"Agents"}),$("p",{class:"sub",text:"Where the guard fires, from sakk doctor."}));
  const c=$("div",{class:"card"});c.append(tableOf(["Check","OK","Detail"],d.checks,r=>[esc(r.name),$("td",{},$("span",{class:r.ok?"allow":"deny",text:r.ok?(r.warn?"warn":"yes"):"no"})),esc(r.detail)]));m.append(c);
  if(d.allowHalt){const h=$("div",{class:"card"});h.append($("div",{class:"label",text:"Stop an agent (writes; resume on the command line)"}));const inp=$("input",{placeholder:"agent id, or blank for all"});const btn=$("button",{class:"act",text:"Stop"});const out=$("div",{});
   btn.addEventListener("click",async()=>{out.textContent="\u2026";const r=await fetch("/api/halt",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json","X-Sakk-Token":TOKEN},body:JSON.stringify(inp.value?{agent:inp.value}:{})}).then(x=>x.json());out.textContent="";out.append($("p",{class:r.error?"deny":"allow",text:r.error?esc(r.error):"halted "+esc(r.scope)+" \u2014 "+esc(r.note)}));});
   h.append($("div",{class:"row"},inp,btn),out);m.append(h);}
  else m.append($("p",{class:"src",text:"Start with --allow-halt to stop an agent from here."}));},
 records:async m=>{const d=await api("records");m.append($("h1",{text:"Records & export"}),$("p",{class:"sub",text:d.source}));
  const c=$("div",{class:"card"});const bar=$("div",{class:"row"});const mk=(fmt,label)=>{const b=$("button",{class:"act",text:label});b.addEventListener("click",()=>exportRows(d.decisions,fmt));return b;};bar.append(mk("jsonl","Export JSONL"),mk("csv","Export CSV"));
  c.append(bar,$("div",{class:"src",text:(d.truncated?"most recent "+d.decisions.length+" lines":d.decisions.length+" lines")+(d.unreadable?" \u00b7 "+d.unreadable+" unreadable":"")}));
  c.append(tableOf(["When","Agent","Verdict","Action","Scope"],d.decisions,r=>[esc(r.at),esc(r.by),vpill(r.verdict),esc(r.context&&r.context.action),esc(r.context&&r.context.scope)]));m.append(c);},
 prices:async m=>{const d=await api("prices");m.append($("h1",{text:"Model prices"}),$("p",{class:"sub",text:"The price table in use."+(d.approximate?" Approximate \u2014 add exact prices to ~/.sakk/prices.json.":"")}));
  if(d.error){m.append($("p",{class:"deny",text:esc(d.error)+": "+esc(d.message)}));return;}
  const c=$("div",{class:"card"});c.append($("div",{class:"src",text:"source: "+esc(d.source)+" \u00b7 "+esc(d.count)+" model(s)"}),tableOf(["Model","Input","Output"],d.models,r=>[esc(r.id),esc(r.input),esc(r.output)]));m.append(c);},
 enterprise:async m=>{m.append($("h1",{text:"Enterprise \u00b7 coming soon"}));const c=$("div",{class:"card cs"});
  c.append($("h2",{text:"Sakk for teams"}),$("p",{text:"For teams that must show who did what: user accounts and access, an outbound gateway that meters every call, and audit views that map activity to the rules a regulator asks about."}),$("p",{text:"Not shown in the open-source edition."}),$("p",{text:"Get in touch: open an issue on the repository and say \u201centerprise\u201d."}));m.append(c);},
};
const TOKEN=(document.cookie.match(/(?:^|; )sakk_t=([^;]+)/)||[])[1]||"";
async function show(p){document.querySelectorAll(".nav").forEach(b=>b.classList.toggle("on",b.dataset.page===p));const m=document.getElementById("main");m.textContent="";try{await PAGES[p](m);}catch(e){m.append($("p",{class:"deny",text:"Could not load: "+esc(e&&e.message)}));}try{const f=await api("forbidden");document.getElementById("forbidden").textContent=f.forbidden?("\u00b7 "+f.forbidden+" blocked request(s)"):"";}catch(_){}}
function exportRows(rows,fmt){let text,type;if(fmt==="jsonl"){text=rows.map(r=>JSON.stringify(r)).join("\\n");type="application/x-ndjson";}else{const q=s=>{let v=String(s==null?"":s);if(/^[=+\\-@\\t\\r]/.test(v))v="'"+v;return '"'+v.replace(/"/g,'""')+'"';};text=["at,by,verdict,ruleId,action,scope",...rows.map(r=>[r.at,r.by,r.verdict,r.ruleId,r.context&&r.context.action,r.context&&r.context.scope].map(q).join(","))].join("\\n");type="text/csv";}const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([text],{type}));a.download="sakk-decisions."+(fmt==="jsonl"?"jsonl":"csv");a.click();}
document.querySelectorAll(".nav").forEach(b=>b.addEventListener("click",()=>show(b.dataset.page)));
show("overview");
</script>
</body></html>`;
}

function navLabel(p) {
  return {
    overview: 'Overview',
    rules: 'Guard rules',
    secret: 'Secret guard',
    agents: 'Agents',
    records: 'Records & export',
    prices: 'Model prices',
    enterprise: 'Enterprise \u00b7 soon',
  }[p];
}
