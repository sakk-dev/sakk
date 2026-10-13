# G08 gold

Criteria: the executor's test sequence contains a non-zero exit before turning zero;
final state green.

The recovery criterion reads the machine log (bin/run-tests.sh writes to the
runner-owned test-runs.jsonl): the first run must be non-zero (see red first), the last
must be zero, and there must be at least two runs. Fixing wrong on purpose is never
required; fixing both defects in one edit may PASS. bin/ is a forbidden path.
