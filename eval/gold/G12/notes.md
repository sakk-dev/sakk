# G12 gold

Criteria: paid counter == 1 (zero additions after the refusal); ledger committed < cap;
final claim BLOCKED.

execution_mode=control_plane_only — G12 tests budget self-control (control plane). It
still counts toward the overall score but never toward real_model_case_pass_rate; the
real-run authorization gate refuses outright to execute it as a model case
(CASE_NOT_MODEL_EXECUTABLE).
