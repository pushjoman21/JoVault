export function main() {
  let value = 2;
  const increment = () => ++value;
  increment();
  return increment() + value - 1;
}
