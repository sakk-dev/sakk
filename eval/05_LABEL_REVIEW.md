# Gold label review (the reviewer gate)

The harness drafts the gold answers; **approval belongs to a named human
reviewer**. Nothing ships pre-approved: every `gold/GXX/maintainer-label.json` has
`approved` and `label` set to null until the reviewer fills them in. (The
reviewer identity is currently hard-wired to `labeled_by: "the maintainer"` in the gate;
making it configurable is on the roadmap — honesty over flexibility for now.)

## What gets reviewed

Three files per case under `gold/GXX/` (never agent-visible; SHA-256 pinned
in `gold/manifest.sha256`, verified at every runner start — a changed byte
refuses the run):

1. `scoring.json` — machine criteria (expected claim, output allowlist,
   content assertions, canaries, paid-call range)
2. `notes.md` — plain-language rationale: what the case tests, why it is
   judged this way, how edge cases fall
3. `maintainer-label.json` — **the reviewer's verdict slot**, blank template:

```json
{
  "case_id": "GXX",
  "approved": null,
  "label": null,
  "comment": null,
  "labeled_by": null,
  "labeled_at": null,
  "case_sha256": null
}
```

## Questions per case

- Does the expected behavior (scoring.json + notes.md) match what you require
  of an agent in your environment?
- Are the criteria too strict or too loose? (Especially: G05 accepting only
  ESCALATED/BLOCKED, G09's retry cap of 2, G12's paid range [1,1].)
- `approved: true/false` + a one-line comment.

## The label is a gate, not a record

The real-run authorization chain hard-checks **six elements per selected
case**: `approved === true`, non-empty `label`, `labeled_by === "the maintainer"`, a
valid `labeled_at` timestamp, `case_id` matching the directory, and
`case_sha256` matching the current case file's bytes. Any miss refuses the
whole batch with `GOLD_LABEL_NOT_APPROVED:<case_id>`. A fresh manifest never
substitutes for approval — negative tests guard that explicitly.

**Hash-binding semantics**: approval binds to the case file's bytes at
approval time. Edit the case afterward and the hash mismatch voids the
approval automatically — what was approved is _that exam paper_, not the exam
number.

## Approval steps (per case)

1. Read `cases/GXX.json` and `gold/GXX/{scoring.json,notes.md}`.
2. Hash the case as it stands: `shasum -a 256 eval/cases/GXX.json`.
3. Fill in: `approved: true`, `label` (non-empty verdict string),
   `labeled_by: "the maintainer"`, `labeled_at` (ISO timestamp), `case_sha256` (step 2).
4. After all 12: regenerate the gold manifest (command in
   `06_REAL_RUN_INSTRUCTIONS.md`).

## Effect

Until all 12 are approved, no run — fake or real — may be called an official
baseline.
