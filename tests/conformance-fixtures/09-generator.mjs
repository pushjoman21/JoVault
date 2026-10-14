export function main() {
  function* sequence() {
    yield 1;
    yield 2;
  }
  let sum = 0;
  for (const value of sequence()) sum += value;
  return sum;
}
