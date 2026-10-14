import { createHash, randomBytes } from 'node:crypto';
import type { RandomSource } from './format.js';
export class SecureRandom implements RandomSource {
  private buffer = new Uint8Array();
  private cursor = 0;
  byte(): number {
    if (this.cursor === this.buffer.length) {
      this.buffer = new Uint8Array(randomBytes(256));
      this.cursor = 0;
    }
    return this.buffer[this.cursor++]!;
  }
}
/** Deterministic fixtures/build variants only. Never use this class for nonces or tokens. */
export class SeededRandom implements RandomSource {
  private counter = 0;
  private buffer = new Uint8Array();
  private cursor = 0;
  constructor(private readonly seed: string) {}
  byte(): number {
    if (this.cursor === this.buffer.length) {
      this.buffer = new Uint8Array(
        createHash('sha256')
          .update('jovm-test-rng-v1\0' + this.seed + '\0' + this.counter++)
          .digest(),
      );
      this.cursor = 0;
    }
    return this.buffer[this.cursor++]!;
  }
}
