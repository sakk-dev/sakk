// 变异体[empty]:去掉空串防线——parseIntSafe('') 会错误地返回 0。
// Agent 的测试套必须因「空串」测试而变红,否则=该边界无覆盖。
export const parseIntSafe = (s) => {
  const n = Number(s);
  return Number.isInteger(n) ? n : null;
};
