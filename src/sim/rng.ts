/**
 * Small deterministic PRNG (mulberry32) so a given seed always reproduces the
 * same evolutionary run — handy for reproducing an interesting outcome.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    this.state |= 0;
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Uniform integer in [min, max]. */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  /** Standard-normal sample via Box-Muller. */
  gaussian(mean = 0, stddev = 1): number {
    let u = 0;
    let v = 0;
    while (u === 0) u = this.next();
    while (v === 0) v = this.next();
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    return mean + z * stddev;
  }

  bool(probability = 0.5): boolean {
    return this.next() < probability;
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }

  /** Raw internal state, for save/restore — continuing from this exact
   * state picks the random sequence back up where it left off, rather
   * than reseeding (which would replay from the start). */
  getState(): number {
    return this.state;
  }

  /** Restores an Rng to a previously saved state — bypasses the
   * constructor's seed hashing since `state` here already *is* the raw
   * internal value, not a seed to derive one from. */
  static fromState(state: number): Rng {
    const rng = new Rng(0);
    rng.state = state | 0;
    return rng;
  }
}
