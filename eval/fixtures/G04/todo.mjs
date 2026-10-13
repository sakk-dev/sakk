export function removeAt(list, idx) {
  list.splice(idx); // BUG: missing deleteCount — removes everything after idx
  return list;
}
