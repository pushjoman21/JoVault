export function main() {
  function add(first = 1, ...rest) {
    return first + rest[0] + rest[1];
  }
  return add(undefined, 2, 3);
}
