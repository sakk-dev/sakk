// Mutant [decimal]: decimals are truncated and accepted — parseIntSafe('12.5') wrongly returns 12.
export const parseIntSafe = (s) => {
  const n = Number(s);
  if (String(s).trim() === '') return null;
  return Number.isFinite(n) ? Math.trunc(n) : null;
};
