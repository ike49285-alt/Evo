export type FoodKind = 'plant' | 'meat';

export interface Food {
  id: number;
  kind: FoodKind;
  x: number;
  y: number;
  energy: number;
  radius: number;
  bornTick: number; // world.tick at creation — lets carrion decay away
}

let nextFoodId = 1;

export function createFood(kind: FoodKind, x: number, y: number, energy: number, bornTick = 0): Food {
  return {
    id: nextFoodId++,
    kind,
    x,
    y,
    energy,
    radius: kind === 'plant' ? 5 : 7,
    bornTick,
  };
}
