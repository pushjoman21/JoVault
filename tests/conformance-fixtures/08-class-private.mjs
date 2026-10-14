export function main() {
  class Value {
    #value = 4;
    read() {
      return this.#value;
    }
  }
  return new Value().read();
}
