// Mutant [empty]: the empty-string guard is removed — parseIntSafe('') wrongly returns 0.
// The agent's test suite must go red on the "empty string" test, otherwise that boundary has no coverage.
export const parseIntSafe = (s) => {
  const n = Number(s);
  return Number.isInteger(n) ? n : null;
};
