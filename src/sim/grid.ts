/**
 * Uniform spatial hash grid. This is the one structural change that makes
 * "consistent performance" possible: every neighbor-style query in the sim
 * (nearest food, nearest threat, nearest mate, eating/predation contact)
 * used to be a linear scan over *every* other entity — O(n) per entity,
 * O(n²) per tick. With entities bucketed by position, a query only has to
 * look at the handful of buckets actually near it, so tick cost tracks
 * local density instead of total population. A dish with 300 virtunisms
 * spread out costs about the same per tick as one with 30; only clustering
 * (which is naturally bounded — colonies cap out, predation thins clumps)
 * drives the cost up, not raw population.
 *
 * Rebuilt fresh every tick (cheap — O(n) inserts) rather than maintained
 * incrementally, which sidesteps a whole class of bugs from stale buckets
 * after movement.
 */
export interface GridPoint {
  x: number;
  y: number;
}

export class SpatialGrid<T extends GridPoint> {
  private readonly cellSize: number;
  private readonly buckets = new Map<string, T[]>();

  constructor(cellSize: number) {
    this.cellSize = Math.max(1, cellSize);
  }

  private keyOf(cx: number, cy: number): string {
    return `${cx},${cy}`;
  }

  clear(): void {
    this.buckets.clear();
  }

  insert(item: T): void {
    const cx = Math.floor(item.x / this.cellSize);
    const cy = Math.floor(item.y / this.cellSize);
    const key = this.keyOf(cx, cy);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = [];
      this.buckets.set(key, bucket);
    }
    bucket.push(item);
  }

  rebuild(items: readonly T[]): void {
    this.clear();
    for (const item of items) this.insert(item);
  }

  /** Every item in the buckets covering a (x,y) ± radius square — a
   * candidate set the caller still needs to distance-check, since a square
   * of buckets isn't a circle. Cheap and simple beats exact-and-fiddly. */
  queryRadius(x: number, y: number, radius: number, out: T[] = []): T[] {
    const minCx = Math.floor((x - radius) / this.cellSize);
    const maxCx = Math.floor((x + radius) / this.cellSize);
    const minCy = Math.floor((y - radius) / this.cellSize);
    const maxCy = Math.floor((y + radius) / this.cellSize);
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        const bucket = this.buckets.get(this.keyOf(cx, cy));
        if (bucket) for (const item of bucket) out.push(item);
      }
    }
    return out;
  }
}
