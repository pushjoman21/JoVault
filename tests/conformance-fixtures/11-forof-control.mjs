export function main() {
  let sum = 0;
  for (const value of [1, 2, 3, 4]) {
    if (value === 2) continue;
    if (value === 4) break;
    sum += value;
  }
  return sum;
}
