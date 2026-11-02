# Run the gateway as a service

Two templates keep the Sakk gateway (the LiteLLM proxy with
`sakk_gateway.py` loaded) running after a crash or a reboot:

| File                               | Service manager      | Restarts                                     |
| ---------------------------------- | -------------------- | -------------------------------------------- |
| `io.github.sakk-dev.gateway.plist` | launchd (macOS)      | `KeepAlive` true, at most once per 10 s      |
| `sakk-gateway.service`             | systemd user (Linux) | `Restart=always`, 5 s apart (`RestartSec=5`) |

Both start at login (`RunAtLoad`, `WantedBy=default.target`) and bind
127.0.0.1 port 4000 only. Do not change the host to `0.0.0.0`: anyone who
reaches the port and has the master key spends your budget.

Before you start, set the gateway up once as
[the integration README](../README.md) says: a virtual environment with
LiteLLM installed from the hash lock, `config.yaml` next to `sakk_gateway.py`,
and a ledger made with `sakk init`. Run the commands below from
`integrations/litellm/`, the folder that holds `config.yaml`.

## Placeholders

Every capital name between double underscores in a template must be
replaced with an absolute path or value. launchd does not expand `~` and
starts agents with `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, so node is named by
its full path.

| Placeholder               | Replace with                                         | In    |
| ------------------------- | ---------------------------------------------------- | ----- |
| `__LITELLM__`             | the `litellm` executable in that virtual environment | both  |
| `__SAKK_GATEWAY_CONFIG__` | the proxy's `config.yaml` (prices are read from it)  | both  |
| `__NODE__`                | the node executable that runs Sakk (`SAKK_NODE`)     | both  |
| `__SAKK_BIN__`            | sakk's `bin/sakk.mjs`                                | both  |
| `__SAKK_LEDGER__`         | the ledger file                                      | both  |
| `__LITELLM_MASTER_KEY__`  | the key clients send instead of a provider key       | plist |
| `__LOG_DIR__`             | a folder for the gateway's output and error logs     | plist |

## macOS (launchd)

Install. Change the two `/abs/path` values and the master key first:

```bash
mkdir -p ~/Library/LaunchAgents ~/Library/Logs/sakk-gateway
sed -e "s|__LITELLM__|$PWD/.venv/bin/litellm|" \
    -e "s|__SAKK_GATEWAY_CONFIG__|$PWD/config.yaml|" \
    -e "s|__NODE__|$(command -v node)|" \
    -e "s|__SAKK_BIN__|/abs/path/to/sakk/bin/sakk.mjs|" \
    -e "s|__SAKK_LEDGER__|/abs/path/ledger.json|" \
    -e "s|__LITELLM_MASTER_KEY__|sk-choose-a-long-random-key|" \
    -e "s|__LOG_DIR__|$HOME/Library/Logs/sakk-gateway|" \
    service/io.github.sakk-dev.gateway.plist \
    > ~/Library/LaunchAgents/io.github.sakk-dev.gateway.plist
chmod 600 ~/Library/LaunchAgents/io.github.sakk-dev.gateway.plist
```

Open `~/Library/LaunchAgents/io.github.sakk-dev.gateway.plist` in an editor
and add one `<key>`/`<string>` pair per provider key under
`EnvironmentVariables`, for example `DEEPSEEK_API_KEY`. Editing the file keeps
the keys out of your shell history. Then check the file and load it:

```bash
plutil -lint ~/Library/LaunchAgents/io.github.sakk-dev.gateway.plist
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/io.github.sakk-dev.gateway.plist
```

Check that it is running:

```bash
launchctl print gui/$UID/io.github.sakk-dev.gateway | grep -E 'state|pid|last exit'
curl -fsS http://127.0.0.1:4000/health/liveliness
tail -n 50 ~/Library/Logs/sakk-gateway/gateway.err.log
```

`state = running` and an answer from the health URL mean the gateway is up.
After you change `config.yaml` or a key, restart it with
`launchctl kickstart -k gui/$UID/io.github.sakk-dev.gateway`.

Uninstall:

```bash
launchctl bootout gui/$UID ~/Library/LaunchAgents/io.github.sakk-dev.gateway.plist
rm ~/Library/LaunchAgents/io.github.sakk-dev.gateway.plist
```

## Linux (systemd user service)

Install. Change the two `/abs/path` values first:

```bash
mkdir -p ~/.config/systemd/user ~/.config/sakk-gateway
sed -e "s|__LITELLM__|$PWD/.venv/bin/litellm|" \
    -e "s|__SAKK_GATEWAY_CONFIG__|$PWD/config.yaml|" \
    -e "s|__NODE__|$(command -v node)|" \
    -e "s|__SAKK_BIN__|/abs/path/to/sakk/bin/sakk.mjs|" \
    -e "s|__SAKK_LEDGER__|/abs/path/ledger.json|" \
    service/sakk-gateway.service \
    > ~/.config/systemd/user/sakk-gateway.service
install -m 600 /dev/null ~/.config/sakk-gateway/secrets.env
```

Open `~/.config/sakk-gateway/secrets.env` in an editor and write one
`NAME=value` line each for `LITELLM_MASTER_KEY` and every provider key, for
example `DEEPSEEK_API_KEY`. The unit does not start while that file is
missing. Then check the unit and start it:

```bash
systemd-analyze --user verify ~/.config/systemd/user/sakk-gateway.service
systemctl --user daemon-reload
systemctl --user enable --now sakk-gateway.service
loginctl enable-linger "$USER"
```

A user service stops when you log out. `loginctl enable-linger` keeps it
running without a login session and starts it at boot; skip it on a desktop
you are always logged in to.

Check that it is running:

```bash
systemctl --user status sakk-gateway.service
curl -fsS http://127.0.0.1:4000/health/liveliness
journalctl --user -u sakk-gateway.service -n 50
```

`active (running)` and an answer from the health URL mean the gateway is up.
After you change `config.yaml` or a key, restart it with
`systemctl --user restart sakk-gateway.service`.

Uninstall:

```bash
systemctl --user disable --now sakk-gateway.service
rm ~/.config/systemd/user/sakk-gateway.service
systemctl --user daemon-reload
```

## What a restart does not fix

A restart brings the proxy back; it does not fix what stopped it. If
`SAKK_BIN`, `SAKK_LEDGER` or `SAKK_GATEWAY_CONFIG` is missing, the plugin
refuses to start and the service manager keeps retrying at the interval
above: read the error log. `test/gateway-service.test.mjs` checks both
templates against the variables `sakk_gateway.py` reads.
