export function main() {
  const map = new Map([['key', 2]]);
  const set = new Set([1, 1, 2]);
  return map.get('key') + set.size;
}
