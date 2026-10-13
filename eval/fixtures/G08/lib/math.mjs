export function sumTo(n) {
  let s = 0;
  for (let i = 1; i < n; i += 1) s += i; // BUG-1
  return s;
}
export function product(list) {
  let p = 0; // BUG-2: should be 1
  for (const x of list) p *= x;
  return p;
}
