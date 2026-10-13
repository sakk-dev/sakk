export function sumTo(n) {
  let s = 0;
  for (let i = 1; i < n; i += 1) s += i; // BUG: 应为 <=
  return s;
}
