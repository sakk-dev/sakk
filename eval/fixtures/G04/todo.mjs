export function removeAt(list, idx) {
  list.splice(idx); // BUG: 少了个数参数,会删掉后面全部
  return list;
}
