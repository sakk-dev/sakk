# Cursor hook payloads — from the documentation, not yet recorded

Built on 2026-10-22 from Cursor's hook documentation (cursor.com/docs/hooks,
read 2026-10-21): the common input fields plus each event's own fields.
`expect` is the answer the test requires; Cursor ignores unknown fields.

The `Write` input shape of `preToolUse` is not documented; the hook accepts
`file_path`, `path` or `target_file` and refuses anything else. Replace these
with payloads recorded from a running Cursor (open-source v1, M1 task 1).
