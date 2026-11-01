# Sakk 常见问题

[English](FAQ.md) | **简体中文**

大家最先问的问题，简短作答。[教程](tutorial/zh-CN.md)里有每条命令和它的真实输出。

## Sakk 的钩子自己出错了会怎样？

要看钩子是怎么装的，以及 Claude Code 的版本。

- **作为插件加载**（`claude --plugin-dir`）：`.claude-plugin/plugin.json` 里的钩子写了
  `"onFailure": "block"`、匹配 `"*"`（所有工具）和 10 秒超时。钩子跑不起来时，Claude Code
  拦下这次工具调用，而不是放它过去。
- **用 `sakk guard install claude-code` 安装**：只有 Claude Code 2.1.295 或更高版本（第一个认识这个键的版本），
  Sakk 才写入 `onFailure: block`。在更老的 Claude Code 上，它按「出错放行」安装守门，并明说这一点，
  `sakk doctor` 也会一直提示：之后钩子一旦起不来，工具调用就在没有守门的情况下继续。升级 Claude Code
  后重新安装一次，就得到「出错拦下」的守门。
- **两样都没装**：Claude Code 没有 Sakk 钩子可调，agent 的工具调用就没有任何检查。

钩子能运行、但读不到自己的策略、配置或当天花费时，它拒绝这次调用而不是放行。只有读项目里的文件仍然放行，
这样 agent 还能看到自己的代码。

## Sakk 和微软的 Agent Governance Toolkit 有什么区别？

两者解决的问题不同。微软的 Agent Governance Toolkit（`microsoft/agent-governance-toolkit`，MIT 协议，
公开预览中）是给自己搭建 agent 的团队用的运行时治理工具包：用 YAML、OPA Rego 或 Cedar 写策略并执行，
零信任身份、沙箱和可靠性功能，提供多种语言的 SDK，针对 OWASP Agentic Top 10
（[I Programmer，2026](https://www.i-programmer.info/news/105-artificial-intelligence/18796-microsoft-releases-open-source-agent-governance-toolkit-.html)，
2026-11-01 核对）。

Sakk 守的是你已经在用的编程 agent，比如 Claude Code，通过它们自带的钩子接入，不改 agent 本身。
它加上从 agent 本地日志读出的每日花费上限、密钥守门和急停开关，所有东西都留在你的机器上。
如果你在给 agent 框架做集成，去看那个工具包；如果你想今天就给笔记本上的编程 agent 加一道守门，
这正是 Sakk 的用途。[compare.md](compare.md) 把 Sakk 和其他工具放在一起比较。

## Sakk 的数据放在哪里？

在你自己的机器上，都是普通文件：

| 位置                             | 内容                                                    |
| -------------------------------- | ------------------------------------------------------- |
| `~/.sakk/config.json`            | 每日上限、它的时区、账本路径                            |
| `~/.sakk/decisions.jsonl`        | 每次守门判定一行                                        |
| `~/.sakk/spend/`                 | 花费索引（`files.json`、`baseline.json`、每天一个文件） |
| `~/.sakk/sakk-ledger.json`       | 花费账本和急停状态，`sakk init` 之后才有                |
| `~/.sakk/sakk-alerts.jsonl`      | 急停期间的拒绝记录                                      |
| `~/.sakk/prices.json`            | 你自己的价格表，只有你加了才有                          |
| 项目里的 `.claude/settings.json` | `sakk guard install claude-code` 加的钩子条目           |

Sakk 读取 Claude Code 在 `~/.claude/projects` 下的日志（设置了 `CLAUDE_CONFIG_DIR` 时读它下面的），
从不修改。设置 `SAKK_HOME` 可以把 Sakk 自己的文件放到 `~/.sakk` 以外的地方。守门发现密钥时只记指纹，
从不记密钥本身。

## Sakk 会把我的数据发到别处吗？

不会。Sakk 没有遥测、没有账号，也没有我们的服务器可连；你安装的代码不发出任何网络请求。
唯一在网络上监听的是你自己用 `sakk ui` 启动的控制台：它只绑定 127.0.0.1，地址里没有令牌的请求一律拒绝（HTTP 403）。

## 能配合 Cursor 或 Codex 用吗？

守门可以：`sakk guard install cursor` 和 `sakk guard install codex` 加上同样的钩子，所以策略、
密钥守门和急停对这两个 agent 同样生效。花费数字暂时不包括它们：`sakk spend` 只读 Claude Code 的日志。
每次受守门的调用仍会检查上限，但通过 Cursor 或 Codex 花掉的 token 不在总数里。

## 运行它要花多少钱？

不花钱。Sakk 免费、开源，在本机 Node 上运行，没有运行时依赖、不要账号、没有要付费的服务，
自己也不调用任何模型。每次受守门的工具调用会为钩子起一个很短的 Node 进程，所以每次调用在本机有一点点延迟。

## 花费是怎么算的？

从你的本地日志算出来，是估算值：

1. Sakk 读取 Claude Code 日志里每条 assistant 消息的 token 用量。每次调用只算一次，按消息 id 和请求 id
   去重，同一份日志读两遍也不会翻倍。
2. 用价格表乘以 token 数。随 Sakk 发布的价格表 `prices/snapshot.json` 从 LiteLLM 公开的价格清单裁剪而来
   （MIT 协议，Berri AI 出品）；其中的 `source` 一段记着网址、提交、SHA-256 和抓取日期（0.3.0 版是 2026-10-28）。
   `sakk prices` 显示正在使用的表。
3. 「一天」按你的时区算，或按你用 `sakk cap set <usd> --zone <IANA>` 设的时区。日期写在未来的日志行，
   或者过了那一天才第一次看到的日志行，都算在 Sakk 看到它的那一天。

它不是你的账单：套餐价、折扣以及没写进本地日志的用量都不在里面。已经算过的花费当天一直算数，
日志被改或被删也不会退。

价格表里没有的模型，Sakk 从不去猜。这时上限以 `PRICE_UNKNOWN` 拒绝，因为它没法证明花费还在上限以内。
要补价格，把 `prices/snapshot.json` 复制成 `~/.sakk/prices.json`，再在里面加上这个模型。这个文件整张替换
随包的价格表，而不是在它上面追加，所以一定要从副本开始改。

## 「急停」（halt）做什么？

`sakk halt --by <name>` 是总开关。不管上限是多少，它拒绝每一次受守门的新工具调用；读项目里的文件仍然放行。
用 `--agent <id>` 只停一个 agent，不停全部。急停记在花费账本里，所以要先运行一次 `sakk init`；
通过账本记账的代码也会被拒（`LEDGER_HALTED`、`AGENT_HALTED`）。

`--by` 是你自己敲的名字；Sakk 原样记下，不核验你是谁。急停期间 `sakk status` 会显示它并以 4 退出。
只有人在终端里才能解除：`sakk resume --by <name>` 要你敲 `resume`，agent 想运行它会被守门拒绝，
控制台也从不解除急停。

## Sakk 用什么许可证？

Apache-2.0。见仓库里的 LICENSE 和 NOTICE 文件。

## 怎么参与贡献？

先读 `CONTRIBUTING.md`。贡献采用开发者原创声明（[DCO](https://developercertificate.org/)）：
每个提交用 `git commit -s` 加一行 sign-off，表示你有权按本项目的许可证提交这份代码。每个行为改动都要带测试；
提 pull request 前先跑 `npm test`。

## 有企业版吗？

敬请期待。企业版不属于开源项目，这个仓库里没有它的任何部分；按监管要求整理的检查包等功能已从开源核心挪出，
留给企业版。这个仓库里的一切都是开源版。

## 控制台有登录吗？

有一个基础的，而且是可选的。默认情况下控制台靠 `sakk ui` 打印的地址里的随机令牌保护，而且只监听 127.0.0.1，所以请把这个地址当密码看待。
`sakk ui --set-password` 会在终端里问你一个用户名和一个密码（15 个字符或更长）；重启 `sakk ui` 之后，
`http://127.0.0.1:<port>/` 会要求输入它们，带令牌的地址照样能用。用密码登录只能查看控制台，不能叫停智能体：
叫停仍然需要 `--allow-halt` 和带令牌的地址。会话空闲 30 分钟或满 8 小时就结束，15 分钟内输错五次后，登录会一直拒绝，直到那 15 分钟过去。
`sakk ui --clear-password` 关掉它。单点登录（SSO）、团队账号和具名审批人不在开源版里。
