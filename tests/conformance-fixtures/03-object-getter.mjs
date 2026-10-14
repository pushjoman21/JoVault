export function main() {
  const object = {
    value: 2,
    get next() {
      return this.value + 1;
    },
  };
  return object.next;
}
