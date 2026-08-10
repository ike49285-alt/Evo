let nextFoodId = 1;
export function createFood(kind, x, y, energy, bornTick = 0) {
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
