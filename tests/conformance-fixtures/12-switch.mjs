export function main() {
  let value = 1;
  switch (value) {
    case 1:
      value += 2;
    default:
      value += 3;
  }
  return value;
}
