import { value, increment } from './18-live-dependency.mjs';
export function main() {
  increment();
  return value;
}
