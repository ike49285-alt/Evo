/**
 * The "Tree of Life" view: draws the ancestry tree World hands it (already
 * pruned down to just the minimal tree connecting currently-alive
 * individuals back to their roots — see World.TreeNode's doc comment) and
 * reports back where each node landed on screen, so main.ts can hit-test a
 * click against it without duplicating the layout math here.
 */
/**
 * Lays out and draws the tree, time flowing left-to-right (x = birth tick,
 * auto-scaled to whatever span is currently retained) with branches spread
 * vertically by a simple DFS leaf-ordering — the same shape as a
 * dendrogram, not a claim about any biological distance metric on the y
 * axis. Returns each node's final screen position/radius for click
 * hit-testing.
 */
export function drawTree(canvas, nodes, opts) {
    const positions = new Map();
    const ctx = canvas.getContext('2d');
    if (!ctx)
        return positions;
    const cssWidth = Math.max(1, Math.round(canvas.clientWidth));
    const cssHeight = Math.max(1, Math.round(canvas.clientHeight));
    if (canvas.width !== cssWidth)
        canvas.width = cssWidth;
    if (canvas.height !== cssHeight)
        canvas.height = cssHeight;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    if (nodes.size === 0) {
        ctx.fillStyle = 'rgba(160, 175, 200, 0.6)';
        ctx.font = '12px sans-serif';
        ctx.fillText('No living lineage yet.', 12, h / 2);
        return positions;
    }
    // Children lists, built locally (World only hands over the flat node
    // data, not its internal children arrays) — cheap, this map is small.
    const children = new Map();
    const roots = [];
    for (const node of nodes.values()) {
        if (node.parentId === null || !nodes.has(node.parentId)) {
            roots.push(node.id);
        }
        else {
            const list = children.get(node.parentId);
            if (list)
                list.push(node.id);
            else
                children.set(node.parentId, [node.id]);
        }
    }
    const childrenOf = (id) => children.get(id) ?? [];
    roots.sort((a, b) => a - b);
    for (const list of children.values())
        list.sort((a, b) => a - b);
    // DFS assigns each leaf the next free y-slot; an internal node's slot is
    // the average of its children's, same recipe as a standard dendrogram.
    let nextSlot = 0;
    const slot = new Map();
    const visitStack = [];
    for (let i = roots.length - 1; i >= 0; i--)
        visitStack.push({ id: roots[i], phase: 'enter' });
    while (visitStack.length) {
        const frame = visitStack.pop();
        const kids = childrenOf(frame.id);
        if (frame.phase === 'enter') {
            if (kids.length === 0) {
                slot.set(frame.id, nextSlot++);
            }
            else {
                visitStack.push({ id: frame.id, phase: 'exit' });
                for (let i = kids.length - 1; i >= 0; i--)
                    visitStack.push({ id: kids[i], phase: 'enter' });
            }
        }
        else {
            const avg = kids.reduce((sum, k) => sum + (slot.get(k) ?? 0), 0) / kids.length;
            slot.set(frame.id, avg);
        }
    }
    const slotCount = Math.max(1, nextSlot);
    let minTick = Infinity;
    let maxTick = -Infinity;
    for (const node of nodes.values()) {
        if (node.birthTick < minTick)
            minTick = node.birthTick;
        if (node.birthTick > maxTick)
            maxTick = node.birthTick;
    }
    if (minTick === maxTick) {
        minTick -= 1;
        maxTick += 1;
    }
    const padL = 14;
    const padR = 20;
    const padTB = 16;
    const xOf = (tick) => padL + ((tick - minTick) / (maxTick - minTick)) * (w - padL - padR);
    const yOf = (s) => (slotCount <= 1 ? h / 2 : padTB + (s / (slotCount - 1)) * (h - padTB * 2));
    for (const node of nodes.values()) {
        const s = slot.get(node.id) ?? 0;
        positions.set(node.id, { x: xOf(node.birthTick), y: yOf(s), radius: 7 });
    }
    // Ancestor path of the selected node, for the highlighted-line pass.
    const highlightIds = new Set();
    if (opts.selectedId !== null && nodes.has(opts.selectedId)) {
        let cur = opts.selectedId;
        while (cur !== null) {
            highlightIds.add(cur);
            const n = nodes.get(cur);
            cur = n ? n.parentId : null;
        }
    }
    // Connector lines first, so node markers sit on top.
    for (const node of nodes.values()) {
        if (node.parentId === null)
            continue;
        const p = positions.get(node.parentId);
        const c = positions.get(node.id);
        if (!p || !c)
            continue;
        const onPath = highlightIds.has(node.id) && highlightIds.has(node.parentId);
        ctx.strokeStyle = onPath ? 'rgba(255, 255, 255, 0.85)' : 'rgba(150, 165, 190, 0.3)';
        ctx.lineWidth = onPath ? 2 : 1;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        // A short horizontal-then-diagonal elbow reads a lot more like a
        // pedigree chart than a straight diagonal smear once branches are
        // dense.
        ctx.lineTo(p.x + (c.x - p.x) * 0.4, p.y);
        ctx.lineTo(c.x, c.y);
        ctx.stroke();
    }
    for (const node of nodes.values()) {
        const p = positions.get(node.id);
        if (!p)
            continue;
        const isSelected = node.id === opts.selectedId;
        const r = isSelected ? 5 : 3.2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fillStyle = `hsl(${node.hue}, 65%, ${node.alive ? 55 : 32}%)`;
        ctx.globalAlpha = node.alive ? 0.95 : 0.55;
        ctx.fill();
        ctx.globalAlpha = 1;
        if (node.isPlayerDesigned) {
            ctx.strokeStyle = 'rgba(255,255,255,0.85)';
            ctx.lineWidth = 1;
            ctx.stroke();
        }
        if (isSelected) {
            ctx.strokeStyle = 'rgba(255,255,255,0.95)';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(p.x, p.y, r + 3, 0, Math.PI * 2);
            ctx.stroke();
        }
    }
    ctx.fillStyle = 'rgba(160, 175, 200, 0.8)';
    ctx.font = '10px sans-serif';
    ctx.fillText('time (tick) →', padL, h - 4);
    return positions;
}
/** Finds the nearest node to a click point, within its hit-test radius. */
export function hitTestTree(positions, x, y) {
    let best = null;
    let bestD = Infinity;
    for (const [id, p] of positions) {
        const d = Math.hypot(p.x - x, p.y - y);
        if (d <= p.radius + 4 && d < bestD) {
            bestD = d;
            best = id;
        }
    }
    return best;
}
