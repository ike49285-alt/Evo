/**
 * The species tree: a phylogeny of *lineages*, where the Tree of Life view
 * (treeview.ts) is a phylogeny of individuals. They are deliberately not the
 * same picture, and the difference is not cosmetic.
 *
 * `World.treeNodes` is pruned the moment a branch has no living descendant —
 * that is what keeps it bounded by population rather than by run length, and
 * it means the individual tree structurally *cannot* show you a lineage that
 * died out. `World.lineages` is the opposite: a permanent record, every
 * species that ever existed, each carrying the id of the one it split from.
 * So this is the only view in the app that can show a dead end, which is
 * exactly what a phylogeny is mostly made of.
 *
 * Time flows left to right. A species is drawn as a horizontal bar spanning
 * its whole life — founded at `createdTick`, ending at `extinctTick` or, if
 * it is still alive, at the present. Its marker sits at the end of that bar,
 * so surviving lineages line up along the right edge the way extant taxa do
 * in a printed phylogram, and the ones that failed visibly stop short.
 */

import type { TreeCamera, TreeNodeScreenPos } from './treeview.js';
import { defaultTreeCamera } from './treeview.js';

/** What the tree needs to know about one species. A flattened read of
 * LineageInfo plus its current population, so this module never touches
 * World directly. */
export interface SpeciesNodeData {
  id: number;
  name: string;
  hue: number;
  parentId: number | null;
  createdTick: number;
  /** null when still alive, or when extinct at an unrecorded time (a save
   * migrated from v9). `isExtinct` is the authority on which. */
  extinctTick: number | null;
  isExtinct: boolean;
  /** Living members right now; 0 for an extinct species. */
  population: number;
  /** Null when genuinely unknown — a v9-migrated record. */
  peakPopulation: number | null;
  isPlayerDesigned: boolean;
}

const NEUTRAL = 'rgba(138, 154, 142, 0.8)';
/** The same amber every speciation marker in the app uses (style.css's
 * --accent-2), mirrored as a literal because canvas cannot read custom
 * properties. Every edge in this tree is a speciation event by definition. */
const SPECIATION_COLOR = '#e8a23c';

const BASE_RADIUS = 3.4;

export function drawSpeciesTree(
  canvas: HTMLCanvasElement,
  nodes: ReadonlyMap<number, SpeciesNodeData>,
  opts: { selectedId: number | null; camera?: TreeCamera; nowTick: number },
): Map<number, TreeNodeScreenPos> {
  const positions = new Map<number, TreeNodeScreenPos>();
  const ctx = canvas.getContext('2d');
  if (!ctx) return positions;

  // Back the canvas at device resolution and lay out in CSS pixels — same
  // treatment the dish and the individual tree get, for the same reason: a 1x
  // canvas beside a 2x one is visibly soft on every phone.
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(canvas.clientWidth));
  const h = Math.max(1, Math.round(canvas.clientHeight));
  const backingW = Math.max(1, Math.round(w * dpr));
  const backingH = Math.max(1, Math.round(h * dpr));
  if (canvas.width !== backingW) canvas.width = backingW;
  if (canvas.height !== backingH) canvas.height = backingH;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const cam = opts.camera ?? defaultTreeCamera();
  const view = (bx: number, by: number): { x: number; y: number } => ({
    x: ((bx / w - cam.cx) * cam.zoom + 0.5) * w,
    y: ((by / h - cam.cy) * cam.zoom + 0.5) * h,
  });

  if (nodes.size === 0) {
    ctx.fillStyle = NEUTRAL;
    ctx.font = '12px sans-serif';
    ctx.fillText('No species yet.', 12, h / 2);
    return positions;
  }

  // --- structure ----------------------------------------------------------
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

  const padL = 14;
  const padR = 30;
  const padTB = 16;

  // --- collapse to a readable number of tips ------------------------------
  //
  // Same budget-and-expand rule the individual tree uses, and needed here for
  // the same reason: with extinct species shown, a long run has hundreds to
  // low thousands of lineages, and one row each is a smear, not a tree. Walk
  // down from the roots repeatedly expanding whichever frontier node has the
  // largest clade, until the height is full.
  //
  // Weighted by clade size rather than by living descendants, which is the
  // one real departure from treeview.ts: most of this tree is extinct, so a
  // living-only weight would score nearly every candidate 0 and the expansion
  // order would collapse to arbitrary id order.
  const cladeSizeCache = new Map<number, number>();
  const cladeSize = (id: number): number => {
    const cached = cladeSizeCache.get(id);
    if (cached !== undefined) return cached;
    let total = 1;
    for (const kid of childrenOf(id)) total += cladeSize(kid);
    cladeSizeCache.set(id, total);
    return total;
  };

  const slotHeight = Math.max(1, h - padTB * 2);
  const leafBudget = Math.max(6, Math.min(600, Math.floor((slotHeight * cam.zoom) / 13)));
  const frontier = [...roots];
  for (;;) {
    if (frontier.length >= leafBudget) break;
    let bestIdx = -1;
    let bestWeight = -1;
    for (let i = 0; i < frontier.length; i++) {
      if (childrenOf(frontier[i]).length === 0) continue;
      const weight = cladeSize(frontier[i]);
      if (weight > bestWeight) {
        bestWeight = weight;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) break; // every frontier node is a real leaf already
    frontier.splice(bestIdx, 1, ...childrenOf(frontier[bestIdx]));
  }
  const frontierSet = new Set(frontier);

  const drawn = new Set(frontierSet);
  for (const id of frontierSet) {
    let cur = nodes.get(id)?.parentId ?? null;
    while (cur !== null && nodes.has(cur) && !drawn.has(cur)) {
      drawn.add(cur);
      cur = nodes.get(cur)?.parentId ?? null;
    }
  }
  const drawnChildrenOf = (id: number): number[] =>
    frontierSet.has(id) ? [] : childrenOf(id).filter((c) => drawn.has(c));

  /** How many species a drawn node stands for — itself, or its whole hidden
   * clade when it is a collapsed frontier node. */
  const collapsedCount = (id: number): number =>
    frontierSet.has(id) && childrenOf(id).length > 0 ? cladeSize(id) : 1;

  /** Living members across everything a node stands for, so a collapsed tip
   * still reads as alive when anything inside it is. */
  const liveWeightCache = new Map<number, number>();
  const liveWeight = (id: number): number => {
    const cached = liveWeightCache.get(id);
    if (cached !== undefined) return cached;
    let total = nodes.get(id)?.population ?? 0;
    for (const kid of childrenOf(id)) total += liveWeight(kid);
    liveWeightCache.set(id, total);
    return total;
  };
  const showsAlive = (id: number): boolean =>
    frontierSet.has(id) && childrenOf(id).length > 0 ? liveWeight(id) > 0 : !(nodes.get(id)?.isExtinct ?? true);

  // --- vertical layout ----------------------------------------------------
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

  // --- horizontal layout: real time ---------------------------------------
  /** When a species' bar ends: its extinction, or the present if it is still
   * running. A collapsed tip inherits the latest end in its clade, so folding
   * a clade away never makes it look like it stopped earlier than it did. */
  const endTickCache = new Map<number, number>();
  const endTick = (id: number): number => {
    const cached = endTickCache.get(id);
    if (cached !== undefined) return cached;
    const self = nodes.get(id);
    let end = self && !self.isExtinct ? opts.nowTick : self?.extinctTick ?? self?.createdTick ?? 0;
    if (frontierSet.has(id)) {
      for (const kid of childrenOf(id)) end = Math.max(end, endTick(kid));
    }
    endTickCache.set(id, end);
    return end;
  };

  let minTick = Infinity;
  let maxTick = -Infinity;
  for (const id of drawn) {
    const start = nodes.get(id)?.createdTick ?? 0;
    const end = endTick(id);
    if (start < minTick) minTick = start;
    if (end > maxTick) maxTick = end;
  }
  if (!Number.isFinite(minTick)) minTick = 0;
  if (!Number.isFinite(maxTick)) maxTick = minTick + 1;
  if (minTick === maxTick) {
    minTick -= 1;
    maxTick += 1;
  }

  const xOf = (tick: number): number => padL + ((tick - minTick) / (maxTick - minTick)) * (w - padL - padR);
  const yOf = (s: number): number => (slotCount <= 1 ? h / 2 : padTB + (s / (slotCount - 1)) * (h - padTB * 2));

  /** Marker size carries peak population — how big the species ever got,
   * which is the one number that separates a lineage that actually ran the
   * dish for a while from one that managed four individuals and stopped.
   * sqrt so a 600-strong species reads as bigger than a 6-strong one without
   * swallowing its neighbours; capped by the row spacing so adjacent markers
   * cannot overlap, the same way treeview.ts caps its tips. */
  const slotSpacing = slotCount <= 1 ? slotHeight : slotHeight / (slotCount - 1);
  const maxRadius = Math.max(BASE_RADIUS, Math.min(11, slotSpacing * 0.45, padTB - 3));
  const radiusOf = (id: number): number => {
    const peak = nodes.get(id)?.peakPopulation ?? null;
    const collapsed = collapsedCount(id);
    // An unknown peak (migrated save) draws at the base size rather than
    // guessing — a marker is not the place to invent history.
    const weight = Math.max(peak ?? 1, collapsed);
    return Math.min(maxRadius, BASE_RADIUS + Math.sqrt(Math.max(0, weight - 1)) * 0.85);
  };

  const startX = (id: number): number => view(xOf(nodes.get(id)?.createdTick ?? 0), 0).x;
  const markerX = (id: number): number => view(xOf(endTick(id)), 0).x;
  const rowY = (id: number): number => view(0, yOf(slot.get(id) ?? 0)).y;

  for (const id of drawn) {
    if (!nodes.has(id)) continue;
    positions.set(id, {
      x: markerX(id),
      y: rowY(id),
      // A generous floor: these are tap targets on a phone, and a dead end's
      // marker is only a few pixels of actual ink.
      radius: Math.max(9, radiusOf(id) + 3),
    });
  }

  // --- edges --------------------------------------------------------------
  // Every edge here is a speciation event by definition — one lineage
  // splitting off another — so they are all drawn in the speciation amber
  // rather than singling any out the way the individual tree has to.
  for (const id of drawn) {
    const node = nodes.get(id);
    if (!node || node.parentId === null || !drawn.has(node.parentId)) continue;
    const parentY = rowY(node.parentId);
    const childY = rowY(id);
    const branchX = startX(id);
    const onPath = opts.selectedId === id || opts.selectedId === node.parentId;
    ctx.strokeStyle = onPath ? 'rgba(255,255,255,0.9)' : `${SPECIATION_COLOR}99`;
    ctx.lineWidth = onPath ? 2 : 1;
    ctx.beginPath();
    // The split happens at the child's founding tick, on the parent's row,
    // then drops to the child's row — so the horizontal position of a branch
    // is a real date, not a layout artifact.
    ctx.moveTo(branchX, parentY);
    ctx.lineTo(branchX, childY);
    ctx.stroke();
  }

  // --- lifespan bars ------------------------------------------------------
  for (const id of drawn) {
    const node = nodes.get(id);
    if (!node) continue;
    const from = startX(id);
    const to = markerX(id);
    const y = rowY(id);
    const alive = showsAlive(id);
    ctx.strokeStyle =
      opts.selectedId === id
        ? 'rgba(255,255,255,0.9)'
        : alive
          ? `hsl(${node.hue}, 60%, 52%)`
          : `hsl(${node.hue}, 25%, 34%)`;
    ctx.lineWidth = opts.selectedId === id ? 2.5 : alive ? 2 : 1.2;
    ctx.beginPath();
    // A species that lived less than a pixel still needs to exist visually,
    // so the bar has a floor rather than collapsing to nothing.
    ctx.moveTo(from, y);
    ctx.lineTo(Math.max(to, from + 1.5), y);
    ctx.stroke();
  }

  // --- markers ------------------------------------------------------------
  for (const id of drawn) {
    const node = nodes.get(id);
    if (!node) continue;
    const x = markerX(id);
    const y = rowY(id);
    const r = radiusOf(id);
    const alive = showsAlive(id);
    const collapsed = collapsedCount(id) > 1;

    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    if (alive) {
      ctx.fillStyle = `hsl(${node.hue}, 65%, 55%)`;
      ctx.fill();
    } else {
      // Hollow, not just dim: an extinct species reads as an outline of
      // something that is no longer there, which is legible at a glance even
      // where the hue itself is dark.
      ctx.fillStyle = 'rgba(10, 15, 13, 0.85)';
      ctx.fill();
      ctx.strokeStyle = `hsl(${node.hue}, 35%, 45%)`;
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }

    if (collapsed) {
      ctx.strokeStyle = alive ? `hsl(${node.hue}, 70%, 78%)` : 'rgba(138, 154, 142, 0.6)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(x, y, r + 2.5, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (node.isPlayerDesigned) {
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x, y, r + 1.5, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (opts.selectedId === id) {
      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, r + 4, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  ctx.fillStyle = NEUTRAL;
  ctx.font = '10px sans-serif';
  ctx.fillText('time (tick) →', padL, h - 4);
  return positions;
}
