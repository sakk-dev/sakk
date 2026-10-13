export const parseIntSafe = (s) => {
  const n = Number(s);
  return Number.isInteger(n) && String(s).trim() !== '' ? n : null;
};
