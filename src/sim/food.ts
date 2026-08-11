// Carrion — the only discrete food item. Created when an organism dies;
// decays and disappears after a while so a long-running dish can't
// quietly accumulate an unbounded amount of it.

import { Vec2 } from './types.js';

export const CARRION_DECAY_TICKS = 500;
export const MAX_CARRION = 400;

export interface Carrion extends Vec2 {
  id: number;
  energy: number;
  age: number;
  radius: number;
}

let nextFoodId = 1;

/** For World.deserialize(): bump past the highest carrion id in a resumed
 *  save. Carrion ids don't need to be preserved exactly (nothing else
 *  references them by id), but they still can't collide with fresh ones. */
export function setNextFoodId(n: number): void {
  nextFoodId = n;
}

export function spawnCarrion(x: number, y: number, energy: number): Carrion {
  return {
    id: nextFoodId++,
    x,
    y,
    energy,
    age: 0,
    radius: Math.min(8, 1.5 + Math.sqrt(energy) * 0.5),
  };
}
