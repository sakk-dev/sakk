# Codex hook payloads — from the documentation, not yet recorded

Built on 2026-10-22 from Codex's hook documentation (learn.chatgpt.com/docs/hooks,
read 2026-10-21): common input fields (`session_id`, `transcript_path`, `cwd`,
`hook_event_name`, `model`) plus the `PreToolUse` fields (`turn_id`,
`tool_name`, `tool_use_id`, `tool_input`). `Bash` and `apply_patch` carry
their text in `tool_input.command`; the Bash command is wrapped in
`bash -lc '…'`, the form Codex sends since 2026-04 (rsyslog 9d384cf).
`expect` is the answer the test requires. Replace these with payloads
recorded from a running Codex (open-source v1, M1 task 1).
