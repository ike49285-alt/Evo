/**
 * Carrion — the only discrete food item in the dish. There's no ambient
 * "plant food" resource: chloroplast organelles draw energy directly from
 * sunlight (see Virtunism.metabolize), and everything else has to be eaten
 * alive (predation) or scavenged here, from whatever died.
 */
export interface Food {
  id: number;
  x: number;
  y: number;
  energy: number;
  radius: number;
  bornTick: number; // world.tick at creation — lets carrion decay away
}

let nextFoodId = 1;

export function createFood(x: number, y: number, energy: number, bornTick: number): Food {
  return {
    id: nextFoodId++,
    x,
    y,
    energy,
    radius: 7,
    bornTick,
  };
}
