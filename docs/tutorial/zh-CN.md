# Sakk 教程：安装、设上限、看拦截、控制台、急停、卸载、网关

[English](en.md) | **简体中文**

本教程从本地仓库副本装上 Sakk，一路走到干净卸载，大约 15 分钟；最后（第 12 步）通过网关把花费上限放到你自己的应用前面。下面每条命令都在
macOS 上用 Sakk 0.4.1、在一个一次性的主目录里真跑过，输出照抄那次运行。路径缩写成
`~`，控制台令牌换成 `<tok>`；你看到的日期、时区和金额会不一样。

> 这次运行是从仓库副本安装的（第 2 步），所以输出和你正在读的代码完全对应。想装已发布的包，
> 用 `npm install -g @sakk-dev/sakk` 代替第 2 步。要在自己电脑上真装，跳过第 1 步，照 README 的
> [安装](../../README.zh-CN.md#安装)一节做：那里讲了 `--user`（所有 Claude Code 会话，而不只一个项目）
> 和守卫需要的 Claude Code 版本。

## 0. 准备

- Node 20 或更高版本，macOS 或 Linux（暂不支持 Windows）。
- git，以及一份 Sakk 仓库的副本。
- 想让守门真正保护会话，需要 Claude Code。教程本身不启动 Claude Code，而是把 Claude
  Code 会发给钩子的同样内容直接喂给钩子。

## 1. 用一个一次性主目录（推荐）

Sakk 的状态放在 `~/.sakk`，并读取 Claude Code 在 `~/.claude/projects` 下的日志。想试用又不碰这两处，
就只在当前终端里把 `HOME` 指向一个空目录：

```bash
unset CLAUDE_CONFIG_DIR SAKK_HOME SAKK_LEDGER_PATH   # so nothing points back at your real files
export HOME="$(mktemp -d)"
export PATH="$HOME/.npm-global/bin:$PATH"
mkdir -p ~/work/demo && cd ~/work/demo && git init -q .
```

试完关掉这个终端，试验就没了。

## 2. 从仓库副本打包并安装

在你的仓库副本里运行：

```bash
mkdir -p ~/pack
npm pack --ignore-scripts --pack-destination ~/pack
npm install -g --prefix ~/.npm-global ~/pack/sakk-*.tgz
sakk --version
```

```text
sakk-dev-sakk-0.4.1.tgz

added 1 package in 159ms
0.4.1
```

- 先 `mkdir -p ~/pack`，因为 npm 11 不会自己建 `--pack-destination` 指定的文件夹，没有它
  `npm pack` 会以 `ENOENT` 停下。
- 在 git 仓库副本里一定要带 `--ignore-scripts`：不带的话，`npm pack` 会跑项目的
  `prepare` 脚本，把这份副本的 git 钩子指向贡献者检查（`core.hooksPath`）。只是试用 Sakk 用不到这些。
- `--prefix ~/.npm-global` 让安装留在一次性主目录里。正常全局安装就去掉它（以及第 1 步里那行 `PATH`）。
- `npm install -g <仓库副本路径>` 也能装，但 npm 是链接这个文件夹而不是复制，守门跑的就是
  agent 可能正在改的那个文件夹里的代码。打出来的包是一份拷贝，优先用它。

## 3. 给项目加上守门

```bash
cd ~/work/demo
sakk guard install claude-code
sakk doctor
```

```text
claude-code: guard added to ~/work/demo/.claude/settings.json
! claude-code: this Claude Code is too old for onFailure (needs 2.1.295+), so the guard is installed FAIL-OPEN — if the hook ever fails to start, the tool call proceeds UNGUARDED. Upgrade Claude Code and reinstall for a fail-closed guard; sakk doctor flags this.
next: sakk doctor — it checks the hook really fires
```

```text
✓ node — Node 25.8.2 (20 or later required)
✓ policy — ~/.npm-global/lib/node_modules/@sakk-dev/sakk/policies/guard-default.json — 17 rules, sha256 77d0fc7022df…
✓ decision log — ~/.sakk/decisions.jsonl is writable
✓ claude-code (project) — ~/work/demo/.claude/settings.json: a forced push is denied
! claude-code start folder — Claude Code loads ~/work/demo/.claude/settings.json only for sessions started in ~/work/demo; a session started in a parent folder skips it — add --user, or managed settings, if you start sessions elsewhere
! cursor — not installed (sakk guard install cursor to add it)
! codex — not installed (sakk guard install codex to add it)
! claude-code fail-open — the installed Claude Code hook has no onFailure: block — it was installed on a Claude Code older than 2.1.295, so if the hook ever fails to start the tool call proceeds UNGUARDED; upgrade Claude Code and run sakk guard install claude-code again for a fail-closed guard
```

两条命令都以 0 退出。这次运行的机器上 Claude Code 低于 2.1.295，所以守门写入时没有
`onFailure: block`，两条命令都明说了。Claude Code 更新后，守门会按「钩子起不来就拦下」写入，这条警告就消失。
`sakk guard install cursor` 和 `sakk guard install codex` 给这两个 agent 加同样的守门。

## 4. 在 agent 动手前先问守门

`sakk try` 显示守门会怎么判一条命令，命令本身不会执行。

```bash
sakk try 'git push --force origin main'
```

```text
deny             git.destructive  (rule shell-destructive)
→ deny
Sakk: git.destructive is denied by rule shell-destructive (~/.npm-global/lib/node_modules/@sakk-dev/sakk/policies/guard-default.json). A person changes the policy. If this is wrong, tell the person you work for and stop; do not route around it.
policy ~/.npm-global/lib/node_modules/@sakk-dev/sakk/policies/guard-default.json (sha256 77d0fc7022df…)
```

## 5. 设每日花费上限

```bash
sakk cap set 5
sakk spend
```

```text
cap set: $5/day in ~/.sakk/config.json — the hook denies paid calls once today's spend from local logs reaches it
spend 2026-11-02 (Asia/Dubai, from local logs): $0 of $5 cap
```

「一天」按本机时区算；用 `--zone` 换别的时区，例如 `sakk cap set 5 --zone Europe/Berlin`。
设上限或调低上限不用确认；调高、取消上限或挪动它的「一天」需要人确认（第 7 步）。

## 6. 亲眼看一次拦截

花费从 Claude Code 自己的日志文件里读。想不花钱就看到上限生效，就在一次性主目录里写一份含两次大调用的样例日志。
**不要在真实主目录里这样做**：Sakk 算过的花费当天一直算数，事后删日志也不会退。

```bash
mkdir -p ~/.claude/projects/-work-demo
NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
cat > ~/.claude/projects/-work-demo/session.jsonl <<EOF
{"type":"assistant","timestamp":"$NOW","requestId":"req_a","message":{"id":"msg_req_a","model":"claude-sonnet-4-5","usage":{"input_tokens":900000,"output_tokens":120000}}}
{"type":"assistant","timestamp":"$NOW","requestId":"req_b","message":{"id":"msg_req_b","model":"claude-opus-4-5","usage":{"input_tokens":200000,"output_tokens":40000}}}
EOF
sakk spend
```

```text
spend 2026-11-02 (Asia/Dubai, from local logs): $6.5 of $5 cap
  claude-sonnet-4-5  $4.5
  claude-opus-4-5  $2
```

再把 Claude Code 在工具调用前发出的那段 JSON 交给钩子：

```bash
echo '{"hook_event_name":"PreToolUse","cwd":"'"$PWD"'","session_id":"s1","tool_use_id":"t1","tool_name":"Bash","tool_input":{"command":"npm test"}}' \
  | sakk hook --agent claude-code
```

```text
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Sakk: shell.run refused — SPEND_CAP_REACHED: $6.50 ≥ $5.00 today (2026-11-02, Asia/Dubai, from local logs) — a person raises it with sakk cap set <usd>; it resets at midnight. If this is wrong, tell the person you work for and stop; do not route around it."}}
```

真实会话里，Claude Code 读到这个回答就不会运行 `npm test`，并把原因告诉 agent。
在午夜之前、或有人调高上限之前，每次受守门的调用都会这样被拒。

如果日志里出现价格表没有的模型，Sakk 不去猜它的价格。这时上限当天会以 `PRICE_UNKNOWN` 拒绝，
因为它没法证明花费还在上限以内。怎么补价格见 FAQ。

## 7. 调高或取消上限要人来做

```bash
sakk cap set 10
```

在终端里，Sakk 会要你再敲一个词：

```text
This raises the daily cap from $5 to $10.
An agent must not make this change, so a person confirms it here. Type 10 to go ahead:
```

敲的不是 `10`，就什么都不改：

```text
HUMAN_CONFIRMATION_REQUIRED: the answer was not 10; nothing changed
```

没有终端时（agent 的工具调用、脚本），它直接拒绝并以 2 退出：

```text
HUMAN_CONFIRMATION_REQUIRED: This raises the daily cap from $5 to $10 — a person confirms this at a terminal, and this run has none; nothing changed
```

`sakk cap off` 同理，要敲的词是 `off`。agent 想运行 `sakk cap` 命令、或往 `~/.sakk` 写东西，守门也会拒绝。

## 8. JSON 格式的花费，以及价格表

```bash
sakk spend --json
```

```text
{
 "day": "2026-11-02",
 "zone": "Asia/Dubai",
 "cap_usd": 5,
 "spend_usd": 6.5,
 "calls": 2,
 "future": 0,
 "backdated": 0,
 "by_model": {
  "claude-sonnet-4-5": 4.5,
  "claude-opus-4-5": 2
 },
 "unpriced": {},
 "unreadable": 0,
 "source": "from local logs"
}
```

```bash
sakk prices
```

```text
prices: 170 model(s) from ~/.npm-global/lib/node_modules/@sakk-dev/sakk/prices/snapshot.json
  provenance (as recorded in the table): https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json, at commit 34c10829b1f2aba5ee44887a413bac12d77e2bc0, sha256 7989a84f15ba56025650ed850c1b1a262d95a42680746d7ec5b1c956dd012121, fetched 2026-10-28, LiteLLM (MIT, (c) Berri AI)
  claude-haiku-4-5-20251001  in 0.000001 / out 0.000005
  claude-haiku-4-5  in 0.000001 / out 0.000005
  claude-sonnet-4-5  in 0.000003 / out 0.000015
  …
```

单价是每个 token 多少美元。这张表由 LiteLLM 公开的价格清单生成；`provenance` 那一行照抄
`prices/snapshot.json` 里 `source` 一段记的内容：它取自哪个网址、哪次提交、SHA-256 和日期。

## 9. 控制台

```bash
sakk ui --port 8790
```

```text
Sakk console: http://127.0.0.1:8790/?t=<tok>  (read-only; Ctrl+C to stop)
```

在浏览器里打开打印出来的地址。控制台显示今天的花费和上限，以及守门最近的判定，比如第 6 步那次拒绝。
它只监听 127.0.0.1，每个请求都要带地址里的令牌：这次运行里，不带令牌的请求得到 HTTP 403。
把这个地址当密码看待，不要贴到任何地方。

不带 `--port` 时，控制台自己挑一个空闲端口。端口被占用时它会说明并以 2 退出：

```text
UI_PORT_IN_USE: port 8790 is already in use — choose another --port
```

控制台是只读的。只有在已有账本（第 10 步）、并用 `sakk ui --allow-halt` 启动时，它的
Emergency stop（急停）按钮才能用，按下后要敲 STOP 确认。控制台从不解除急停，解除要在终端里做（第 10 步）。
按 Ctrl+C 关掉控制台。

如果你按第 12 步跑了网关，控制台也会读它的状态。网关拿不到 Sakk 的回答时，页面顶部出现一条红色横条，
说调用正在不计量地放行（deny 模式下是被拒绝），并写明放行了几次、最多多少钱。故障过去后有一条提示写明那段时间；
网关的健康检查不回应时，也有它自己的红色横条。

### 可选：用户名和密码

在你自己的机器上，带令牌的地址就够了。想改用用户名和密码登录，在终端里设置：

```bash
sakk ui --set-password
```

```text
Console username: oncall
Password (15 or more characters, not shown):
The same password again:
Console sign-in set for oncall (~/.sakk/console-login.json, owner-only). Restart sakk ui for it to take effect.
```

没有终端时（agent 的工具调用、脚本），它拒绝并以 2 退出：

```text
UI_PASSWORD_NEEDS_TTY: set the password at a terminal: sakk ui --set-password asks for it and does not echo it
```

重启控制台，它会说登录已开启：

```text
Sakk console: http://127.0.0.1:8790/?t=<tok>  (read-only; Ctrl+C to stop)
Sign-in is on: http://127.0.0.1:8790/ asks for the username and password; the address above works too. sakk ui --clear-password turns it off.
```

用密码登录只能查看控制台；Emergency stop 仍然需要 `--allow-halt` 和带令牌的地址。会话空闲 30 分钟或满
8 小时就结束；15 分钟内输错五次后，登录会一直拒绝，直到那 15 分钟过去。想回到只用令牌地址：

```bash
sakk ui --clear-password
```

```text
Console sign-in removed (~/.sakk/console-login.json). Restart sakk ui: it is token-only again.
```

什么都没设时再运行一次，它会说 `No console sign-in was set; sakk ui is token-only.`

## 10. 急停与解除

急停就是总开关：不管上限是多少，每一次受守门的新工具调用都会被拒（读项目里的文件仍然放行）。急停记在花费账本里，
所以先建账本。这里的 `--cap` 是账本自己的预算，给那些通过 Sakk 记账的 agent 代码用，和第 5 步的每日上限是两回事。

```bash
sakk init --cap 20 --by oncall
sakk halt --by oncall --reason "runaway loop"
sakk status
```

```text
ledger created: ~/.sakk/sakk-ledger.json
hook wired: a halt on this ledger now stops the guarded agent (~/.sakk/config.json)
cap: $20 — reserve before you spawn; reaching the cap refuses.
```

```text
HALTED all spending by oncall: every new reservation now refuses. Refusals are logged to sakk-alerts.jsonl beside the ledger.
```

```text
ledger      ~/.sakk/sakk-ledger.json
cap         $20
settled     $0
outstanding $0
committed   $0  (remaining $20, max reservable $0)
entries     0 (reserved 0, settled 0, reconciliation 0)
updated     2026-11-02T18:22:54.965Z
⛔ HALTED by oncall at 2026-11-02T18:22:55.031Z — runaway loop (all new spending refused)
```

急停期间 `sakk status` 以 4 退出。钩子现在按急停拒绝：

```text
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Sakk: shell.run refused — halted (global) by oncall at 2026-11-02T18:22:55.031Z — runaway loop; a person resumes with: sakk resume --by <name>. If this is wrong, tell the person you work for and stop; do not route around it."}}
```

`--by` 是你自己敲的名字。Sakk 原样记下，不核验你是谁。用 `--agent <id>` 只停一个 agent，不停全部。

解除急停要人在终端里运行 `sakk resume`：

```bash
sakk resume --by oncall
```

```text
This lifts the halt on all spending (~/.sakk/sakk-ledger.json).
An agent must not make this change, so a person confirms it here. Type resume to go ahead:
```

敲 `resume`。没有终端时它以 `HUMAN_CONFIRMATION_REQUIRED` 拒绝并以 2 退出；agent 想运行它，守门也会拒绝。

## 11. 卸载

**先**拆守门，再删包。否则设置文件里的钩子还指向一个已经不存在的文件。

```bash
cd ~/work/demo
sakk guard uninstall claude-code
```

```text
This removes the guard from ~/work/demo/.claude/settings.json.
An agent must not make this change, so a person confirms it here. Type claude-code to go ahead:
```

敲 `claude-code`。然后删包，愿意的话把 Sakk 的状态也删掉：

```bash
npm uninstall -g --prefix ~/.npm-global @sakk-dev/sakk   # drop --prefix for a normal global install
rm -rf ~/.sakk                                 # config, decision log, spend index, ledger
```

如果用的是第 1 步的一次性主目录，关掉终端就行。

## 12. 你自己的应用：走网关

第 3 到 10 步把守门放在编程 agent 前面。你自己的应用（任何语言）走另一扇门：Sakk
的花费闸门跑在 LiteLLM 代理里，应用只改它的 OpenAI 接口地址。这一步从一个新的一次性主目录开始（第 1、2
步），不发任何付费调用：唯一发出的那个请求可能花得比上限多，Sakk 在它到达任何模型商之前就拒了。

网关记账用的是账本，所以先建一个。账本的上限是账本自己的；第 5 步的每日上限是另一个上限，管的是编程 agent
的日志。然后要网关文件。没装 LiteLLM 时，Sakk 会直说，一个文件都不写：

```bash
sakk init --cap 5
sakk gateway init
```

```text
ledger created: ~/.sakk/sakk-ledger.json
hook wired: a halt on this ledger now stops the guarded agent (~/.sakk/config.json)
cap: $5 — reserve before you spawn; reaching the cap refuses.
GATEWAY_LITELLM_NOT_FOUND: no executable named litellm on PATH; nothing was written.
Install the pinned LiteLLM proxy from a hash-locked file, then run this again
(add --litellm "$PWD/.venv/bin/litellm" when the venv is not on PATH):
  printf 'litellm[proxy]==1.106.2\n' > req.in
  uv venv --python 3.12 .venv
  uv pip compile req.in --generate-hashes --exclude-newer 2026-10-21T11:00:00Z -o req.lock
  uv pip install --require-hashes -r req.lock
Do not install LiteLLM 1.82.7, 1.82.8 or 1.107.0: those releases were compromised.
Details: ~/.npm-global/lib/node_modules/@sakk-dev/sakk/integrations/litellm/README.md
```

它以 1 退出。按它打印的步骤装 LiteLLM（需要 `uv`，会下载 LiteLLM 和它的依赖），再带上 `litellm`
的路径跑一次。下面这次运行用的是这样装好的 LiteLLM 1.106.2，写作 `<venv>`：

```bash
sakk gateway init --litellm "$PWD/.venv/bin/litellm"
```

```text
wrote the gateway files in ~/.sakk/gateway:
  sakk_gateway.py  the Sakk callback LiteLLM loads
  config.yaml      models and prices (USD per token); keys are os.environ/ references
  start.sh         starts LiteLLM on 127.0.0.1:4000 with SAKK_BIN, SAKK_LEDGER and SAKK_GATEWAY_CONFIG set
ledger:  ~/.sakk/sakk-ledger.json
litellm: <venv>/bin/litellm (found; its version was not checked — the gateway is tested with 1.106.2)

Start it with the keys in your environment (never in these files):
  LITELLM_MASTER_KEY=<a long random key> DEEPSEEK_API_KEY=<your key> '~/.sakk/gateway/start.sh'

Then change one line in your app, and send LITELLM_MASTER_KEY as its API key:
OPENAI_BASE_URL=http://127.0.0.1:4000/v1

Refusals, prices and limits: ~/.npm-global/lib/node_modules/@sakk-dev/sakk/integrations/litellm/README.md
```

Sakk 打印的 `start.sh` 是带引号的完整路径，这里缩写成了 `~`。再跑一次会以 `GATEWAY_FILES_EXIST`
拒绝，除非加 `--force`。三个文件里都没有密钥；没有你的应用要发的那把密钥，`start.sh` 不会启动代理：

```bash
~/.sakk/gateway/start.sh
```

```text
~/.sakk/gateway/start.sh: line 8: LITELLM_MASTER_KEY: set LITELLM_MASTER_KEY to the key your app will send; this script does not start a proxy without one
```

带上主密钥和模型商密钥启动。真用时模型商密钥是你自己的，用它发的调用由 DeepSeek
计费；这里用的是假值，因为下面的请求根本到不了 DeepSeek：

```bash
export LITELLM_MASTER_KEY=sk-tutorial-0000   # use a long random key; your app sends it as its API key
export DEEPSEEK_API_KEY=not-a-real-key
~/.sakk/gateway/start.sh > ~/proxy.log 2>&1 &
```

大约 5 秒后代理在 `http://127.0.0.1:4000/health/liveliness` 上应答。现在要一个最多 20,000,000
个 token 的回复。按 `config.yaml` 里 `deepseek-chat` 的输出价（每个 token $0.00000042），最坏情况是
$8.40，超过 $5 的上限：

```bash
curl -s -i http://127.0.0.1:4000/v1/chat/completions \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" -H "Content-Type: application/json" \
  -d '{"model":"deepseek-chat","max_tokens":20000000,"messages":[{"role":"user","content":"hi"}]}'
```

```text
HTTP/1.1 402 Payment Required
x-litellm-response-cost: 0
...
{"error":{"message":"BUDGET_EXCEEDED: settled + outstanding + this estimate reaches the cap — refused (the cap is a wall, not a target)","type":"invalid_request_error","param":null,"code":"402","provider_specific_fields":{"error":{"code":"BUDGET_EXCEEDED","message":"BUDGET_EXCEEDED: settled + outstanding + this estimate reaches the cap — refused (the cap is a wall, not a target)","estimatedMaxUsd":8.400184}}}}
```

其余响应头省略了。最坏情况还算上了提示词（每字节按一个 token）和一点余量，所以是
$8.400184。什么都没预留，什么都没花：

```bash
sakk status
```

```text
ledger      ~/.sakk/sakk-ledger.json
cap         $5
settled     $0
outstanding $0
committed   $0  (remaining $5, max reservable $4.999999)
entries     0 (reserved 0, settled 0, reconciliation 0)
updated     2026-11-02T20:18:53.889Z
gateway     no outage recorded (mode allow)
```

`gateway` 这一行是网关自己的报告。网关从账本拿不到答复时，默认放行这次调用，并且明说：`~/proxy.log`
里一行 WARNING、响应上一个 `x-sakk-status: unmetered` 头、`sakk ui` 里一条红色横幅，这里也会多一行故障记录。这样放行的调用不进账本，也不受上限约束。想改成拒绝，就用
`SAKK_ON_UNAVAILABLE=deny` 启动网关。

让应用用 `OPENAI_BASE_URL=http://127.0.0.1:4000/v1` 指向网关，并把 `LITELLM_MASTER_KEY`
当作它的 API 密钥发出；README 里有 Python、Node 和 curl 的同一个调用。用 `kill %1` 停掉代理。第 11 步的
`rm -rf ~/.sakk` 也会删掉 `~/.sakk/gateway`。

## 退出码

| 退出码 | 含义                                                                                                                  |
| ------ | --------------------------------------------------------------------------------------------------------------------- |
| 0      | 正常                                                                                                                  |
| 1      | 账本错误（例如 `sakk init` 之前的 `LEDGER_MISSING`），或 `sakk gateway init` 拒绝（例如 `GATEWAY_LITELLM_NOT_FOUND`） |
| 2      | 用法错误，或因为没有人确认而拒绝的改动                                                                                |
| 3      | 需要对账（`sakk status`）                                                                                             |
| 4      | 急停中（`sakk status`；优先于 3）                                                                                     |

下一步：[FAQ](../FAQ.zh-CN.md) 讲钩子自己出错时会怎样、数据放在哪里、花费怎么算。
