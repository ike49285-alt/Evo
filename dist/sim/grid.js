export class SpatialGrid {
    constructor(cellSize) {
        this.buckets = new Map();
        this.cellSize = Math.max(1, cellSize);
    }
    keyOf(cx, cy) {
        return `${cx},${cy}`;
    }
    clear() {
        this.buckets.clear();
    }
    insert(item) {
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
    rebuild(items) {
        this.clear();
        for (const item of items)
            this.insert(item);
    }
    /** Every item in the buckets covering a (x,y) ± radius square — a
     * candidate set the caller still needs to distance-check, since a square
     * of buckets isn't a circle. Cheap and simple beats exact-and-fiddly. */
    queryRadius(x, y, radius, out = []) {
        const minCx = Math.floor((x - radius) / this.cellSize);
        const maxCx = Math.floor((x + radius) / this.cellSize);
        const minCy = Math.floor((y - radius) / this.cellSize);
        const maxCy = Math.floor((y + radius) / this.cellSize);
        for (let cx = minCx; cx <= maxCx; cx++) {
            for (let cy = minCy; cy <= maxCy; cy++) {
                const bucket = this.buckets.get(this.keyOf(cx, cy));
                if (bucket)
                    for (const item of bucket)
                        out.push(item);
            }
        }
        return out;
    }
}
