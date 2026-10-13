// Mutant [whitespace]: inputs with surrounding whitespace are rejected — parseIntSafe('  7 ') wrongly returns null.
export const parseIntSafe = (s) => {
  if (String(s) !== String(s).trim()) return null;
  const n = Number(s);
  return Number.isInteger(n) && String(s).trim() !== '' ? n : null;
};
