export class SpatialGrid {
    constructor(cellSize, width, height) {
        /** The grid's OWN copy of the items, not the caller's array.
         *
         * That distinction is load-bearing and cost a real bug to learn. Buckets
         * hold indices, so an aliased array that the caller then mutates leaves
         * every index past the mutation pointing at the wrong item or off the
         * end. `carrionGrid` is rebuilt from `World.meatFood`, which shrinks
         * during the same tick as carrion is eaten — the old reference-holding
         * Map version was immune to that, and an index-based one is not. Copying
         * into a buffer the grid owns costs one O(n) pass that rebuild was doing
         * anyway. */
        this.items = [];
        this.cellSize = Math.max(1, cellSize);
        // One margin bucket on each side, so a point sitting exactly on (or
        // slightly past) a world edge still lands in a real bucket instead of
        // needing a bounds test in the hot loop.
        this.cols = Math.max(1, Math.ceil(width / this.cellSize)) + 2;
        this.rows = Math.max(1, Math.ceil(height / this.cellSize)) + 2;
        this.head = new Int32Array(this.cols * this.rows).fill(-1);
        this.next = new Int32Array(0);
    }
    bucketOf(x, y) {
        const cx = Math.min(this.cols - 1, Math.max(0, Math.floor(x / this.cellSize) + 1));
        const cy = Math.min(this.rows - 1, Math.max(0, Math.floor(y / this.cellSize) + 1));
        return cy * this.cols + cx;
    }
    rebuild(items) {
        const n = items.length;
        if (this.next.length < n) {
            // Doubling, so a growing population doesn't reallocate every tick.
            this.next = new Int32Array(Math.max(64, n * 2));
        }
        // Copy into the grid's own buffer (see `items` above), reusing its
        // capacity rather than allocating a fresh array each tick.
        for (let i = 0; i < n; i++)
            this.items[i] = items[i];
        if (this.items.length > n)
            this.items.length = n;
        this.head.fill(-1);
        // Inserted back to front so each bucket's list comes out in the
        // original array order. Several callers (mate choice, predation)
        // iterate candidates and take the first match, and preserving order
        // keeps those deterministic across this refactor.
        for (let i = n - 1; i >= 0; i--) {
            const b = this.bucketOf(items[i].x, items[i].y);
            this.next[i] = this.head[b];
            this.head[b] = i;
        }
    }
    /** Every item in the buckets covering (x,y) ± radius — a candidate set the
     * caller still needs to distance-check, since a square of buckets isn't a
     * circle. Cheap and simple beats exact-and-fiddly.
     *
     * `out` is truncated and refilled rather than replaced: pass a scratch
     * array you keep between calls and this allocates nothing at all. */
    queryRadius(x, y, radius, out = []) {
        out.length = 0;
        const minCx = Math.min(this.cols - 1, Math.max(0, Math.floor((x - radius) / this.cellSize) + 1));
        const maxCx = Math.min(this.cols - 1, Math.max(0, Math.floor((x + radius) / this.cellSize) + 1));
        const minCy = Math.min(this.rows - 1, Math.max(0, Math.floor((y - radius) / this.cellSize) + 1));
        const maxCy = Math.min(this.rows - 1, Math.max(0, Math.floor((y + radius) / this.cellSize) + 1));
        const items = this.items;
        const head = this.head;
        const next = this.next;
        const cols = this.cols;
        // Column-outer, row-inner, matching the Map version's iteration order
        // exactly. Row-major would be marginally friendlier to the cache, but
        // candidate ORDER is load-bearing here — mate choice and predation both
        // scan candidates and take the first match, so a different traversal
        // would silently change which partner or which prey a given cell picks
        // and send an identically-seeded run down a different history. Keeping
        // the order makes this refactor provably behaviour-identical, which is
        // worth more than the cache line.
        for (let cx = minCx; cx <= maxCx; cx++) {
            for (let cy = minCy; cy <= maxCy; cy++) {
                for (let i = head[cy * cols + cx]; i !== -1; i = next[i])
                    out.push(items[i]);
            }
        }
        return out;
    }
}
