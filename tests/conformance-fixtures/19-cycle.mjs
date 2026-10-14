import { readOther } from './19-cycle-dependency.mjs';
export let value = 1;
export function readValue() {
  return value;
}
export function main() {
  return readOther();
}
