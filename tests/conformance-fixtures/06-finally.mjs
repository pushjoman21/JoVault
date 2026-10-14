export function main() {
  let value = 1;
  try {
    throw 3;
  } catch (error) {
    value += error;
  } finally {
    value += 3;
  }
  return value;
}
