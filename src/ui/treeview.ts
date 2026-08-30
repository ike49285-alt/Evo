/**
 * The "Tree of Life" view: draws the ancestry tree World hands it (already
 * pruned down to just the minimal tree connecting currently-alive
 * individuals back to their roots — see World.TreeNode's doc comment) and
 * reports back where each node landed on screen, so main.ts can hit-test a
 * click against it without duplicating the layout math here.
 */

export interface TreeNodeData {
  id: number;
  parentId: number | null;
  birthTick: number;
  hue: number;
  alive: boolean;
  isPlayerDesigned: boolean;
  /** True if this individual is where a new species was founded — its
   * genome measured past the divergence threshold from its old lineage's
   * reference sequence right before it reproduced (see World.checkSpeciation).
   * The edge from its parent gets drawn distinctly, not as an ordinary
   * birth. */
  isSpeciationEvent: boolean;
  /** True if this individual is the first in its lineage to carry isDna —
   * a real RNA->DNA heredity transition (see genome.ts's
   * DNA_TRANSITION_THRESHOLD), drawn with its own distinct marker. */
  isDnaTransition: boolean;
  /** Live individuals in this node's own subtree, including itself if
   * alive — maintained by World, reused here as the weight that decides
   * which clades are worth expanding (see chooseFrontier). */
  liveCount: number;
}

// Canvas can't read CSS custom properties, so the two semantic colors
// from style.css's token system are mirrored here as literals:
// --text-dim (neutral axis/label text) and --accent-2 (genetic/species
// identity — a speciation event is drawn in this color everywhere,
// Species panel included, rather than the diverging individual's own
// hue, so it reads as "the same kind of thing" across the whole UI).
const NEUTRAL = 'rgba(138, 154, 142, 0.8)';
const SPECIATION_COLOR = '#e8a23c';
// A distinct cool teal, deliberately far from the speciation amber — both
// events can in principle land on the same node (a crossover that both
// diverges past the speciation threshold and crosses
// DNA_TRANSITION_THRESHOLD in one birth), so the two markers need to read
// as clearly separate, not blend into one ambiguous color.
const DNA_TRANSITION_COLOR = '#4fc3d9';

export interface TreeNodeScreenPos {
  x: number;
  y: number;
  radius: number; // hit-test radius, already includes a little slack
}

/**
 * Lays out and draws the tree, time flowing left-to-right (x = birth tick,
 * auto-scaled to whatever span is currently retained) with branches spread
 * vertically by a simple DFS leaf-ordering — the same shape as a
 * dendrogram, not a claim about any biological distance metric on the y
 * axis. Returns each node's final screen position/radius for click
 * hit-testing.
 */
export function drawTree(
  canvas: HTMLCanvasElement,
  nodes: ReadonlyMap<number, TreeNodeData>,
  opts: { selectedId: number | null },
): Map<number, TreeNodeScreenPos> {
  const positions = new Map<number, TreeNodeScreenPos>();
  const ctx = canvas.getContext('2d');
  if (!ctx) return positions;

  const cssWidth = Math.max(1, Math.round(canvas.clientWidth));
  const cssHeight = Math.max(1, Math.round(canvas.clientHeight));
  if (canvas.width !== cssWidth) canvas.width = cssWidth;
  if (canvas.height !== cssHeight) canvas.height = cssHeight;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (nodes.size === 0) {
    ctx.fillStyle = NEUTRAL;
    ctx.font = '12px sans-serif';
    ctx.fillText('No living lineage yet.', 12, h / 2);
    return positions;
  }

  // Children lists, built locally (World only hands over the flat node
  // data, not its internal children arrays) — cheap, this map is small.
  const children = new Map<number, number[]>();
  const roots: number[] = [];
  for (const node of nodes.values()) {
    if (node.parentId === null || !nodes.has(node.parentId)) {
      roots.push(node.id);
    } else {
      const list = children.get(node.parentId);
      if (list) list.push(node.id);
      else children.set(node.parentId, [node.id]);
    }
  }
  const childrenOf = (id: number): number[] => children.get(id) ?? [];
  roots.sort((a, b) => a - b);
  for (const list of children.values()) list.sort((a, b) => a - b);

  // Declared here rather than beside xOf/yOf below because the collapse
  // budget is sized against the real drawable height.
  const padL = 14;
  // Wider than it used to be: collapsed tips are drawn at the present, i.e.
  // hard against the right edge, so this has to clear the widest of them.
  const padR = 30;
  const padTB = 16;

  // --- collapse the present into a readable number of tips ---------------
  //
  // Drawing one leaf per living individual is what made this view useless at
  // the moment it matters. Measured on a real run: 239 leaves spread over the
  // canvas gives 0.40px per slot against a 3.2px node radius -- ~16x overlap,
  // a solid smear -- while the time axis compounds it, since every living
  // individual was born within one maxAge of now and so crushes into a sliver
  // of width that shrinks as the run lengthens (the median node sits at 76%
  // of the width at 4k ticks, 93% at 16k).
  //
  // So: don't draw every leaf. Walk down from the roots and repeatedly expand
  // whichever frontier node has the most living descendants, until there are
  // enough tips to fill the height and no more. Everything below the frontier
  // collapses into one weighted tip.
  //
  // Budgeting by *leaves* rather than by species is deliberate, and the data
  // decided it: collapsing per species degenerates badly, because a dish that
  // has not speciated has exactly one lineage -- a 14,000-tick run with 163
  // individuals still had a single species, which would have rendered the
  // whole present as one dot. A leaf budget adapts instead: one species alive
  // gives sub-clades of it, fifteen give roughly one tip each.
  const slotHeight = Math.max(1, h - padTB * 2);
  // Enough tips to fill the height at a spacing that clears the node radius,
  // clamped so a tall desktop panel doesn't go back to drawing hundreds.
  // ~13px per slot: enough that a weighted tip can be drawn big enough to
  // compare against its neighbours and still carry its population count,
  // which a tighter budget squeezes out entirely.
  const leafBudget = Math.max(6, Math.min(40, Math.floor(slotHeight / 13)));

  const frontier: number[] = [...roots];
  for (;;) {
    if (frontier.length >= leafBudget) break;
    let bestIdx = -1;
    let bestWeight = -1;
    for (let i = 0; i < frontier.length; i++) {
      if (childrenOf(frontier[i]).length === 0) continue;
      const weight = nodes.get(frontier[i])?.liveCount ?? 0;
      if (weight > bestWeight) {
        bestWeight = weight;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) break; // every frontier node is a real leaf already
    frontier.splice(bestIdx, 1, ...childrenOf(frontier[bestIdx]));
  }
  const frontierSet = new Set(frontier);

  // The drawn tree is the frontier plus every ancestor of it.
  const drawn = new Set<number>(frontierSet);
  for (const id of frontierSet) {
    let cur = nodes.get(id)?.parentId ?? null;
    while (cur !== null && nodes.has(cur) && !drawn.has(cur)) {
      drawn.add(cur);
      cur = nodes.get(cur)?.parentId ?? null;
    }
  }
  const drawnChildrenOf = (id: number): number[] =>
    frontierSet.has(id) ? [] : childrenOf(id).filter((c) => drawn.has(c));

  /** Summarises the clade hanging off a frontier node: the most recently
   * born living descendant, and when it was born.
   *
   * Both halves matter. The id is what a tap should select — landing on
   * something actually alive rather than the often long-dead ancestor the
   * tip is anchored to. The tick is where the tip must be *drawn*: anchoring
   * it at the ancestor's own birth time puts a summary of the living present
   * back in the deep past, which is exactly backwards. Plotting it at its
   * newest member instead puts the fat tips at the right-hand edge, where a
   * phylogram puts its extant taxa. */
  const summaryCache = new Map<number, { repId: number; tick: number }>();
  const summarise = (id: number): { repId: number; tick: number } => {
    const cached = summaryCache.get(id);
    if (cached) return cached;
    const self = nodes.get(id);
    let repId = id;
    let tick = self?.birthTick ?? 0;
    if (self && childrenOf(id).length > 0) {
      let bestId = self.alive ? id : -1;
      let bestTick = self.alive ? self.birthTick : -Infinity;
      const stack = [...childrenOf(id)];
      while (stack.length) {
        const curId = stack.pop() as number;
        const cur = nodes.get(curId);
        if (!cur) continue;
        if (cur.alive && cur.birthTick > bestTick) {
          bestTick = cur.birthTick;
          bestId = curId;
        }
        for (const kid of childrenOf(curId)) stack.push(kid);
      }
      if (bestId !== -1) {
        repId = bestId;
        tick = bestTick;
      }
    }
    const out = { repId, tick };
    summaryCache.set(id, out);
    return out;
  };

  // Positions are keyed by the id a tap should SELECT, so main.ts's
  // hitTestTree -> selectIndividual path needs no knowledge of collapsing.
  const selectableId = new Map<number, number>();
  for (const id of drawn) {
    selectableId.set(id, frontierSet.has(id) && childrenOf(id).length > 0 ? summarise(id).repId : id);
  }

  // DFS assigns each leaf the next free y-slot; an internal node's slot is
  // the average of its children's, same recipe as a standard dendrogram.
  let nextSlot = 0;
  const slot = new Map<number, number>();
  const visitStack: { id: number; phase: 'enter' | 'exit' }[] = [];
  for (let i = roots.length - 1; i >= 0; i--) visitStack.push({ id: roots[i], phase: 'enter' });
  while (visitStack.length) {
    const frame = visitStack.pop()!;
    const kids = drawnChildrenOf(frame.id);
    if (frame.phase === 'enter') {
      if (kids.length === 0) {
        slot.set(frame.id, nextSlot++);
      } else {
        visitStack.push({ id: frame.id, phase: 'exit' });
        for (let i = kids.length - 1; i >= 0; i--) visitStack.push({ id: kids[i], phase: 'enter' });
      }
    } else {
      const avg = kids.reduce((sum, k) => sum + (slot.get(k) ?? 0), 0) / kids.length;
      slot.set(frame.id, avg);
    }
  }
  const slotCount = Math.max(1, nextSlot);

  // Over the drawn nodes only: a collapsed clade's hidden members would
  // otherwise stretch the axis out to a present that has nothing plotted on
  // it, pushing every visible tip back off the right edge.
  /** Where a drawn node sits in time: its own birth, or — for a collapsed
   * tip — the birth of the newest living individual it stands for. */
  const drawnTick = (id: number): number =>
    frontierSet.has(id) && childrenOf(id).length > 0
      ? summarise(id).tick
      : nodes.get(id)?.birthTick ?? 0;

  let minTick = Infinity;
  let maxTick = -Infinity;
  for (const id of drawn) {
    const t = drawnTick(id);
    if (t < minTick) minTick = t;
    if (t > maxTick) maxTick = t;
  }
  if (minTick === maxTick) {
    minTick -= 1;
    maxTick += 1;
  }

  const xOf = (tick: number): number => padL + ((tick - minTick) / (maxTick - minTick)) * (w - padL - padR);
  const yOf = (s: number): number => (slotCount <= 1 ? h / 2 : padTB + (s / (slotCount - 1)) * (h - padTB * 2));

  /** How many living individuals a frontier node stands for — 1 for an
   * ordinary node, the whole clade for a collapsed tip. */
  const tipWeight = (id: number): number =>
    frontierSet.has(id) && childrenOf(id).length > 0 ? Math.max(1, nodes.get(id)?.liveCount ?? 1) : 1;
  /** Collapsed tips grow with the clade they stand for, by sqrt so a 600-strong
   * clade reads as bigger than a 6-strong one without swallowing the panel.
   *
   * Capped by the layout, not just by taste: a tip wider than its own slot
   * collides with its neighbours (two adjacent tips at 11px in an 11px slot
   * overlap outright), and one taller than the top padding clips against the
   * canvas edge. Both were visible before this cap existed. */
  const slotSpacing = slotCount <= 1 ? slotHeight : slotHeight / (slotCount - 1);
  const maxTipRadius = Math.max(3.2, Math.min(11, slotSpacing * 0.45, padTB - 3));
  const tipRadius = (id: number): number => {
    const weight = tipWeight(id);
    return weight <= 1 ? 3.2 : Math.min(maxTipRadius, 3.2 + Math.sqrt(weight) * 0.85);
  };

  /** Where a node's own branch begins — its birth. Distinct from where its
   * marker is drawn, which for a collapsed tip is the present. */
  const originX = (id: number): number => xOf(nodes.get(id)?.birthTick ?? 0);
  const markerX = (id: number): number => xOf(drawnTick(id));
  const rowY = (id: number): number => yOf(slot.get(id) ?? 0);

  for (const id of drawn) {
    if (!nodes.has(id)) continue;
    positions.set(selectableId.get(id) ?? id, {
      x: markerX(id),
      y: rowY(id),
      radius: Math.max(7, tipRadius(id) + 3),
    });
  }

  /** Positions are keyed by selectable id, so every lookup from a node id
   * goes through that mapping. */
  const posOf = (id: number): TreeNodeScreenPos | undefined =>
    positions.get(selectableId.get(id) ?? id);

  /** The drawn node standing for an individual. Usually itself; for one
   * hidden inside a collapsed clade, the tip it was folded into — found by
   * walking up until we reach something actually on screen. That is what
   * keeps selecting a cell in the dish still highlighting its lineage here
   * even when the cell itself is no longer drawn individually. */
  const drawnAnchorFor = (id: number): number | null => {
    let cur: number | null = id;
    while (cur !== null && nodes.has(cur)) {
      if (drawn.has(cur)) return cur;
      cur = nodes.get(cur)?.parentId ?? null;
    }
    return null;
  };

  // Ancestor path of the selected node, for the highlighted-line pass.
  const highlightIds = new Set<number>();
  const selectedAnchor = opts.selectedId !== null ? drawnAnchorFor(opts.selectedId) : null;
  if (selectedAnchor !== null) {
    let cur: number | null = selectedAnchor;
    while (cur !== null) {
      highlightIds.add(cur);
      const n = nodes.get(cur);
      cur = n && n.parentId !== null && drawn.has(n.parentId) ? n.parentId : null;
    }
  }

  // Connector lines first, so node markers sit on top.
  for (const id of drawn) {
    const node = nodes.get(id);
    if (!node || node.parentId === null || !drawn.has(node.parentId)) continue;
    const p = posOf(node.parentId);
    const c = posOf(node.id);
    if (!p || !c) continue;
    const onPath = highlightIds.has(node.id) && highlightIds.has(node.parentId);
    // A speciation edge is a real phylogenetic branch point, not an
    // ordinary parent->child birth — drawn dashed, in the same amber
    // "genetic record" color everywhere in the UI, so it reads as a
    // distinct event even when it's not on the currently-highlighted path.
    // A DNA transition is a real molecular-heredity event, not a branch
    // point (unlike speciation, the lineage identity doesn't change) —
    // drawn solid rather than dashed so the two never read as the same
    // kind of thing, even if a single birth happens to be both.
    if (node.isSpeciationEvent) {
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = onPath ? 'rgba(255, 255, 255, 0.95)' : `${SPECIATION_COLOR}bf`;
      ctx.lineWidth = onPath ? 2.5 : 1.8;
    } else if (node.isDnaTransition) {
      ctx.strokeStyle = onPath ? 'rgba(255, 255, 255, 0.95)' : `${DNA_TRANSITION_COLOR}cc`;
      ctx.lineWidth = onPath ? 2.5 : 2;
    } else {
      ctx.strokeStyle = onPath ? 'rgba(255, 255, 255, 0.85)' : 'rgba(138, 154, 142, 0.3)';
      ctx.lineWidth = onPath ? 2 : 1;
    }
    const childOriginX = originX(node.id);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    // A short horizontal-then-diagonal elbow reads a lot more like a
    // pedigree chart than a straight diagonal smear once branches are
    // dense.
    ctx.lineTo(p.x + (childOriginX - p.x) * 0.4, p.y);
    ctx.lineTo(childOriginX, c.y);
    ctx.stroke();
    if (node.isSpeciationEvent) ctx.setLineDash([]);
  }

  // The clade's own span: from where a collapsed branch began out to the
  // present, where its tip is drawn. This is the segment that keeps time
  // structure visible -- without it every tip sits at the right edge with
  // nothing joining it to its origin, and a forest of founder roots renders
  // as a meaningless pile against the frame.
  for (const id of drawn) {
    const node = nodes.get(id);
    if (!node) continue;
    const from = originX(id);
    const to = markerX(id);
    if (to - from < 1) continue;
    const y = rowY(id);
    ctx.strokeStyle = highlightIds.has(id)
      ? 'rgba(255, 255, 255, 0.85)'
      : `hsl(${node.hue}, 45%, 42%)`;
    ctx.lineWidth = highlightIds.has(id) ? 2 : 1.4;
    ctx.beginPath();
    ctx.moveTo(from, y);
    ctx.lineTo(to, y);
    ctx.stroke();
  }

  for (const id of drawn) {
    const node = nodes.get(id);
    if (!node) continue;
    const p = posOf(id);
    if (!p) continue;
    const weight = tipWeight(id);
    const isCollapsed = weight > 1;
    const isSelected = selectedAnchor === id;
    const r = isCollapsed ? tipRadius(id) : isSelected ? 5 : 3.2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    // A collapsed tip stands for living individuals by definition, so it is
    // always drawn at full living brightness regardless of whether the
    // ancestor it is anchored to happens to be dead.
    const showAlive = node.alive || isCollapsed;
    ctx.fillStyle = `hsl(${node.hue}, 65%, ${showAlive ? 55 : 32}%)`;
    ctx.globalAlpha = showAlive ? 0.95 : 0.55;
    ctx.fill();
    ctx.globalAlpha = 1;
    // A ring makes a tip read as a group rather than one unusually fat
    // individual, and carries the count once there is room for it.
    if (isCollapsed) {
      ctx.strokeStyle = `hsl(${node.hue}, 70%, 78%)`;
      ctx.lineWidth = 1.2;
      ctx.stroke();
      if (r >= 5.6) {
        ctx.fillStyle = 'rgba(10, 15, 13, 0.92)';
        ctx.font = '8px ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(weight), p.x, p.y + 0.5);
        ctx.textAlign = 'start';
        ctx.textBaseline = 'alphabetic';
      }
    }
    if (node.isPlayerDesigned) {
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    if (node.isSpeciationEvent) {
      ctx.setLineDash([2, 2]);
      ctx.strokeStyle = `${SPECIATION_COLOR}e6`;
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r + 2.5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // Solid, at a different radius than the speciation ring, so a birth
    // that's rarely both events still reads as two distinct markers
    // rather than overlapping into one.
    if (node.isDnaTransition) {
      ctx.strokeStyle = `${DNA_TRANSITION_COLOR}e6`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r + 4.5, 0, Math.PI * 2);
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

  ctx.fillStyle = NEUTRAL;
  ctx.font = '10px sans-serif';
  ctx.fillText('time (tick) →', padL, h - 4);

  return positions;
}

/** Finds the nearest node to a click point, within its hit-test radius. */
export function hitTestTree(
  positions: ReadonlyMap<number, TreeNodeScreenPos>,
  x: number,
  y: number,
): number | null {
  let best: number | null = null;
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
