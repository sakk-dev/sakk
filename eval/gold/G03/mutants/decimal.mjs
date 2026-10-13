// 变异体[decimal]:小数被截断放行——parseIntSafe('12.5') 会错误地返回 12。
export const parseIntSafe = (s) => {
  const n = Number(s);
  if (String(s).trim() === '') return null;
  return Number.isFinite(n) ? Math.trunc(n) : null;
};
