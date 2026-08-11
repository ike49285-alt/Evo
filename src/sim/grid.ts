// Spatial hash grid — the core perf primitive. Every neighbor-style query
// in the sim (nearest food, nearest threat, nearest mate, eat/predation
// contact) is bucketed by position and rebuilt fresh every tick, so a
// query only touches nearby buckets instead of scanning the whole
// population. Keeps tick cost tracking local density, not total population.

import { Vec2 } from './types.js';

export interface GridEntry extends Vec2 {
  id: number;
}

export class SpatialGrid<T extends GridEntry> {
  private cellSize: number;
  private buckets: Map<string, T[]> = new Map();

  constructor(cellSize: number) {
    this.cellSize = cellSize;
  }

  private key(cx: number, cy: number): string {
    return cx + ',' + cy;
  }

  private cellOf(v: Vec2): [number, number] {
    return [Math.floor(v.x / this.cellSize), Math.floor(v.y / this.cellSize)];
  }

  clear(): void {
    this.buckets.clear();
  }

  insert(entry: T): void {
    const [cx, cy] = this.cellOf(entry);
    const k = this.key(cx, cy);
    let bucket = this.buckets.get(k);
    if (!bucket) {
      bucket = [];
      this.buckets.set(k, bucket);
    }
    bucket.push(entry);
  }

  rebuild(entries: Iterable<T>): void {
    this.clear();
    for (const e of entries) this.insert(e);
  }

  /** All entries within `radius` of `center`, unfiltered by exact distance
   *  (returns the covering cells' contents — caller does the precise
   *  distance check, since that's needed anyway for direction/ranking). */
  queryRadius(center: Vec2, radius: number, out: T[] = []): T[] {
    const minCx = Math.floor((center.x - radius) / this.cellSize);
    const maxCx = Math.floor((center.x + radius) / this.cellSize);
    const minCy = Math.floor((center.y - radius) / this.cellSize);
    const maxCy = Math.floor((center.y + radius) / this.cellSize);
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        const bucket = this.buckets.get(this.key(cx, cy));
        if (bucket) for (const e of bucket) out.push(e);
      }
    }
    return out;
  }
}
