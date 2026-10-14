export function main() {
  const [first, ...rest] = [1, ...[2, 3]];
  return first + rest[0] + rest[1];
}
