export function main() {
  const key = Symbol('key');
  const value = { [key]: 4 };
  return value[key];
}
