let nextFoodId = 1;
export function createFood(x, y, energy, bornTick) {
    return {
        id: nextFoodId++,
        x,
        y,
        energy,
        radius: 7,
        bornTick,
    };
}
export function getNextFoodId() {
    return nextFoodId;
}
export function setNextFoodId(n) {
    nextFoodId = n;
}
