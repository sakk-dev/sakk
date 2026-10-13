// 变异体[whitespace]:拒收带空白输入——parseIntSafe('  7 ') 会错误地返回 null。
export const parseIntSafe = (s) => {
  if (String(s) !== String(s).trim()) return null;
  const n = Number(s);
  return Number.isInteger(n) && String(s).trim() !== '' ? n : null;
};
