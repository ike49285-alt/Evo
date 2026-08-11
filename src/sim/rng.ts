// Seeded PRNG (mulberry32) so a run is reproducible from a single seed —
// same seed in, same evolutionary history out. Deliberately not
// `Math.random()`: headless balance/perf runs need to be replayable.

export class Rng {
  private state: number;

  constructor(seed: number) {
    // Ensure a non-zero 32-bit state.
    this.state = seed >>> 0 || 0xdeadbeef;
  }

  /** Next float in [0, 1). */
  next(): number {
    this.state |= 0;
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Float in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  /** True with probability `p` (0..1). */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Uniform pick from a non-empty array. */
  pick<T>(arr: readonly T[]): T {
    return arr[this.int(0, arr.length - 1)];
  }

  /** Standard normal sample via Box-Muller, scaled by `stdDev`. */
  gaussian(stdDev: number): number {
    const u1 = Math.max(this.next(), 1e-12);
    const u2 = this.next();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(Math.PI * 2 * u2) * stdDev;
  }
}
