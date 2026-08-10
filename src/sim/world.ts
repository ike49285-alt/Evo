import { Virtunism, mateVirtunisms } from './virtunism.js';
import { createFood, Food } from './food.js';
import {
  buildOrganelles,
  deriveArmorMitigation,
  deriveFlagellaPower,
  deriveMaxSpeed,
  deriveMouthPower,
  Genome,
  hasBud,
  StarterLoadout,
} from './genome.js';
import { NeuralNet } from './nn.js';
import { Rng } from './rng.js';
import { BRAIN_TOPOLOGY, ReproductionMode } from './types.js';
import { SpatialGrid } from './grid.js';

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export interface SpeciesTemplate {
  reproductionMode: ReproductionMode;
  size: number;
  senseRadius: number;
  maxAge: number;
  hue: number;
  loadout: StarterLoadout;
}

export interface LineageInfo {
  id: number;
  name: string;
  hue: number;
  isPlayerDesigned: boolean;
  createdTick: number;
}

/**
 * One entry in the ancestry tree — the "tree of life" view's data source.
 * Every virtunism that's ever been born gets a node, but the map as a
 * whole is *not* an unbounded history log: a node is deleted the moment
 * neither it nor anything descended from it is alive anymore (see
 * `recordDeath`'s pruning walk). What's left at any moment is exactly the
 * minimal tree connecting every currently-alive individual back to its
 * root ancestor(s) — bounded by population size and branch points, not by
 * how long the dish has been running.
 */
export interface TreeNode {
  id: number;
  parentId: number | null;
  // Sexual reproduction has two parents; `parentId` is the tree edge used
  // for layout/pruning (kept a tree, not a DAG), `secondParentId` is
  // carried along purely for display ("child of A and B").
  secondParentId: number | null;
  lineageId: number;
  generation: number;
  hue: number;
  isPlayerDesigned: boolean;
  birthTick: number;
  alive: boolean;
  // Count of live individuals in this node's own subtree, including
  // itself if alive. Reaches 0 exactly when this node can be forgotten.
  liveCount: number;
  children: number[];
}

export interface StatsSnapshot {
  tick: number;
  population: number;
  sexual: number;
  asexual: number;
  colonies: number;
  soloCells: number;
  avgColonySize: number;
  avgSize: number;
  avgSpeed: number;
  avgSense: number;
  avgFlagella: number;
  avgMouths: number;
  avgChloroplasts: number;
  avgEyes: number;
  avgArmor: number;
  avgAge: number;
  maxGeneration: number;
  meatFood: number;
}

/** How long the *last* update() call actually took, in milliseconds — the
 * game loop uses this to keep a bounded time budget per animation frame
 * (see main.ts) instead of blindly running a fixed number of ticks
 * regardless of how expensive each one turns out to be. */
export interface PerfSnapshot {
  lastTickMs: number;
}

export class World {
  readonly width: number;
  readonly height: number;
  readonly rng: Rng;

  cells: Virtunism[] = [];
  meatFood: Food[] = [];
  lineages = new Map<number, LineageInfo>();
  history: StatsSnapshot[] = [];
  perf: PerfSnapshot = { lastTickMs: 0 };
  /** The tree-of-life data source — see TreeNode's doc comment for why this
   * doesn't grow without bound over a long run. */
  readonly treeNodes = new Map<number, TreeNode>();

  tick = 0;

  // --- tunables -----------------------------------------------------
  readonly maxPopulation = 320;
  readonly maxColonySize = 14;
  // There is no ambient "plant food" resource — sunlight (chloroplast
  // organelles) is the only energy this dish generates from nothing.
  // Carrion is the only discrete food item left, and even that isn't a
  // free lunch: it only exists because something died. Left uncapped it
  // would still accumulate without bound over a long run (a slow,
  // easy-to-miss performance leak as much as a realism gap), so it decays
  // and is hard-capped as a backstop.
  readonly maxMeatFood = 260;
  readonly meatDecayTicks = 500;
  // Sunlight itself is unlimited, but this dish's *usable* share of it
  // isn't — real photosynthesizers compete for light and nutrients the
  // same way animals compete for prey. Without this, chloroplasts have no
  // carrying capacity at all (unlike animals, which are naturally capped
  // by how much prey exists) and photosynthesizers just grow to fill the
  // entire population cap, leaving predators no room to ever reproduce.
  // When total demand exceeds this budget, every photosynthesizer's
  // income is scaled down proportionally — a shared-resource ceiling, not
  // a per-species quota.
  readonly sunlightCapacity = 24;
  // The shared population cap has the same monopolization problem as
  // unlimited sunlight would: whichever lineage has the most individuals
  // wins the most reproduction attempts each tick and structurally starves
  // everyone else of the *room* to reproduce, even if those others are
  // metabolically fine. This is a soft territorial ceiling per lineage —
  // no single one can eat the whole population cap — so a slow-growing
  // predator population isn't crowded out of existing at all by a fast-
  // growing photosynthesizer one.
  readonly maxLineageShare = 0.65;
  readonly predationSizeRatio = 0.88; // prey must be <= predator.size * this
  readonly statsSampleInterval = 10;
  readonly maxHistory = 400;

  // Grid cell sizes: virtunismGrid is sized for the typical sensing range
  // (a few hundred units); carrionGrid is much finer since eating/
  // predation contact is a short-range check. Both are rebuilt fresh each
  // tick (or twice, for virtunisms — see update()) rather than maintained
  // incrementally.
  private readonly virtunismGrid = new SpatialGrid<Virtunism>(110);
  private readonly carrionGrid = new SpatialGrid<Food>(50);

  private nextLineageId = 1;

  constructor(width: number, height: number, seed: number) {
    this.width = width;
    this.height = height;
    this.rng = new Rng(seed);
  }

  static createDefault(width: number, height: number, seed: number): World {
    const world = new World(width, height, seed);
    world.seedBaseSpecies();
    return world;
  }

  /**
   * A small starting population of plants and herbivores — nothing else.
   * There is no hand-designed predator, scavenger, or "tree" — if this
   * dish ever grows one, it's because mutation and selection actually
   * found it, not because it was built in. Nothing here stops a rabbit
   * lineage from drifting toward bigger and more predatory (a wolf), or a
   * dandelion lineage toward bigger and more armored (a tree), or some
   * branch of the predatory line specializing in carrion over live prey
   * (a vulture) — the organelle system has no fixed "species" concept to
   * prevent it. Whether any of that actually happens in a given run is a
   * real, unscripted question, not a guaranteed outcome. Founding
   * populations are small but not knife-edge minimal — every mechanic in
   * this dish that starts from too few individuals has turned out to be
   * one unlucky brain away from extinction before it ever gets a chance
   * to evolve into anything.
   */
  seedBaseSpecies(): void {
    // Dandelions: the entire starting food supply. Pure photosynthesizer
    // (no mouth). A little of its own mobility + a real body (multiple
    // organelles, not just one) turns out to matter for more than just the
    // dandelion itself — it's also what gives a still-naive rabbit brain
    // enough of a target to actually close distance on. A single-organelle,
    // zero-flagella "minimal" plant looked right on paper but consistently
    // starved every predator population that depended on it in testing;
    // this loadout is the one that's actually been verified to work.
    this.addSpecies(
      {
        reproductionMode: 'asexual',
        size: 0.9,
        senseRadius: 150,
        maxAge: 1000,
        hue: 68,
        loadout: { flagella: 2, chloroplasts: 3, eyes: 1 },
      },
      16,
      { name: 'Dandelions', spread: true },
    );
    // Rabbits: sized with a deliberate, comfortable margin over a
    // dandelion so eating one is mechanically reliable from tick one
    // (predation eligibility is a real size-ratio check — too close a
    // margin and hunting silently becomes nearly impossible regardless of
    // behavior, a mistake worth not repeating here).
    this.addSpecies(
      {
        reproductionMode: 'asexual',
        size: 1.55,
        senseRadius: 190,
        maxAge: 900,
        hue: 30,
        loadout: { mouths: 1, flagella: 3, eyes: 1 },
      },
      12,
      { name: 'Rabbits', spread: true },
    );
  }

  /** Releases a new population built from a fixed body template (as
   * designed in the editor) with independently-randomized brains and a
   * little starting variation on each individual's organelle layout.
   * Returns the new lineage id. */
  addSpecies(template: SpeciesTemplate, count: number, opts: { name?: string; isPlayerDesigned?: boolean; spread?: boolean } = {}): number {
    const lineageId = this.nextLineageId++;
    this.lineages.set(lineageId, {
      id: lineageId,
      name: opts.name ?? `Species ${lineageId}`,
      hue: template.hue,
      isPlayerDesigned: !!opts.isPlayerDesigned,
      createdTick: this.tick,
    });

    const baseOrganelles = buildOrganelles(template.loadout);
    const clusterX = this.rng.range(this.width * 0.2, this.width * 0.8);
    const clusterY = this.rng.range(this.height * 0.2, this.height * 0.8);
    const jitterPct = (value: number, pct: number): number => Math.max(0.01, value * (1 + this.rng.gaussian(0, pct)));

    for (let i = 0; i < count; i++) {
      if (this.cells.length >= this.maxPopulation) break;
      const genome: Genome = {
        reproductionMode: template.reproductionMode,
        size: jitterPct(template.size, 0.03),
        senseRadius: jitterPct(template.senseRadius, 0.03),
        maxAge: jitterPct(template.maxAge, 0.08),
        hue: template.hue,
        organelles: baseOrganelles.map((o) => ({
          kind: o.kind,
          angle: o.angle + this.rng.gaussian(0, 0.08),
          size: clamp(o.size + this.rng.gaussian(0, 0.04), 0.5, 1.5),
        })),
        brain: NeuralNet.random(BRAIN_TOPOLOGY, this.rng),
      };
      const x = opts.spread
        ? this.rng.range(20, this.width - 20)
        : clamp(clusterX + this.rng.gaussian(0, 90), 20, this.width - 20);
      const y = opts.spread
        ? this.rng.range(20, this.height - 20)
        : clamp(clusterY + this.rng.gaussian(0, 90), 20, this.height - 20);
      // Deliberately well below both reproduceThreshold (0.42 * maxEnergy)
      // and the lower sexual matingThreshold (0.3 * maxEnergy) so a freshly
      // released population always has to forage first.
      const startEnergy = 12 * template.size;
      const founder = new Virtunism(genome, x, y, lineageId, 0, startEnergy, this.rng, !!opts.isPlayerDesigned);
      this.cells.push(founder);
      this.recordBirth(founder, null, null);
    }
    return lineageId;
  }

  /** Registers a new individual as a tree-of-life node and links it under
   * its parent(s), propagating the +1 live-count up to the root so every
   * ancestor knows it still has a living descendant. `parentId: null`
   * marks a root (a founder released via addSpecies). */
  private recordBirth(child: Virtunism, parentId: number | null, secondParentId: number | null): void {
    const node: TreeNode = {
      id: child.id,
      parentId,
      secondParentId,
      lineageId: child.lineageId,
      generation: child.generation,
      hue: child.genome.hue,
      isPlayerDesigned: child.isPlayerDesigned,
      birthTick: Math.floor(this.tick),
      alive: true,
      liveCount: 1,
      children: [],
    };
    this.treeNodes.set(child.id, node);
    if (parentId === null) return;
    const parent = this.treeNodes.get(parentId);
    if (!parent) return; // defensive — should always exist while it has a living child
    parent.children.push(child.id);
    let cur: TreeNode | undefined = parent;
    while (cur) {
      cur.liveCount += 1;
      cur = cur.parentId !== null ? this.treeNodes.get(cur.parentId) : undefined;
    }
  }

  /** Marks a tree node as no longer alive, then compacts from there upward
   * (see `compactFrom`) — the actual mechanism that keeps `treeNodes`
   * bounded to roughly "current population + branch points" regardless of
   * total ticks run, not just the dead-end pruning by itself. */
  private recordDeath(individual: Virtunism): void {
    const node = this.treeNodes.get(individual.id);
    if (!node || !node.alive) return;
    node.alive = false;
    let cur: TreeNode | undefined = node;
    while (cur) {
      cur.liveCount -= 1;
      cur = cur.parentId !== null ? this.treeNodes.get(cur.parentId) : undefined;
    }
    this.compactFrom(node.id);
  }

  /**
   * Walks upward from a just-died node, applying two collapses:
   *  1. A node with liveCount 0 (nothing alive left in its subtree) has
   *     nothing left to connect — delete it and keep walking up.
   *  2. A *dead* node with exactly one remaining child is a redundant
   *     waypoint — a single unbranched step of "this lineage existed, then
   *     had one descendant" that a tree-of-life view doesn't need to show
   *     individually (only where lineages actually branch or a currently-
   *     alive individual sits). Splice it out: reattach its one child
   *     directly to its own parent.
   * Without step 2, a long-running population in genealogical steady
   * state accumulates one retained "spine" node per birth/death cycle
   * forever — bounded by turnover count, not by population size, which
   * defeats the point. With it, only actual branch points and currently-
   * alive individuals stick around, which *is* bounded by population size
   * (verified: population holds steady while treeNodes.size stays flat
   * over tens of thousands of ticks — see tree_bound_check.mjs).
   * Both collapses only ever need to look at the single node just touched
   * — once a node doesn't qualify for either, nothing further up could
   * have changed, so it's safe to stop.
   */
  private compactFrom(startId: number): void {
    let curId: number | null = startId;
    while (curId !== null) {
      const cur: TreeNode | undefined = this.treeNodes.get(curId);
      if (!cur) return;

      if (cur.liveCount === 0) {
        const parentId: number | null = cur.parentId;
        if (parentId !== null) {
          const parent = this.treeNodes.get(parentId);
          if (parent) parent.children = parent.children.filter((id: number) => id !== cur.id);
        }
        this.treeNodes.delete(cur.id);
        curId = parentId;
        continue;
      }

      if (!cur.alive && cur.children.length === 1) {
        const onlyChildId = cur.children[0];
        const onlyChild = this.treeNodes.get(onlyChildId);
        const parentId: number | null = cur.parentId;
        if (onlyChild) onlyChild.parentId = parentId;
        if (parentId !== null) {
          const parent = this.treeNodes.get(parentId);
          if (parent) {
            const idx = parent.children.indexOf(cur.id);
            if (idx !== -1) parent.children[idx] = onlyChildId;
          }
        }
        this.treeNodes.delete(cur.id);
      }
      return;
    }
  }

  /** Advances the simulation by one fixed tick. */
  update(dt: number): void {
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();

    this.decayMeatFood();
    this.carrionGrid.rebuild(this.meatFood);

    // Sense + think using positions from *before* this tick's movement (a
    // consistent "everyone sees the world as it was a moment ago" model).
    this.virtunismGrid.rebuild(this.cells.filter((c) => c.alive));
    for (const cell of this.cells) {
      if (!cell.alive) continue;
      const inputs = this.buildInputs(cell);
      cell.think(inputs);
    }

    // Movement: solo virtunisms act individually; colony roots move the
    // whole bonded tree as one rigid body and cascade positions to every
    // member.
    for (const cell of this.cells) {
      if (!cell.alive || cell.attachedTo !== null) continue;
      if (cell.attachedChildren.length > 0) {
        this.moveColonyRigid(cell, dt);
      } else {
        cell.act(cell.lastOutputs, dt, this.width, this.height);
      }
    }

    for (const cell of this.cells) {
      if (cell.alive) cell.metabolize(dt);
    }
    this.applyPhotosynthesis(dt);

    // Rebuild with post-movement positions for contact-driven systems.
    this.virtunismGrid.rebuild(this.cells.filter((c) => c.alive));

    this.handleEating();
    this.handlePredation();
    this.diffuseColonyEnergy(dt);
    this.handleReproduction();
    this.cleanupDead();

    this.tick += dt;
    if (Math.floor(this.tick) % this.statsSampleInterval === 0) {
      this.pushStatsSnapshot();
    }

    const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this.perf.lastTickMs = t1 - t0;
  }

  getLiveStats(): StatsSnapshot {
    let sexual = 0;
    let asexual = 0;
    let sumSize = 0;
    let sumSpeed = 0;
    let sumSense = 0;
    let sumFlagella = 0;
    let sumMouths = 0;
    let sumChloroplasts = 0;
    let sumEyes = 0;
    let sumArmor = 0;
    let sumAge = 0;
    let maxGeneration = 0;
    let colonies = 0;
    let soloCells = 0;
    let colonyMemberTotal = 0;

    for (const c of this.cells) {
      if (c.genome.reproductionMode === 'sexual') sexual++;
      else asexual++;
      sumSize += c.genome.size;
      sumSpeed += deriveMaxSpeed(c.genome);
      sumSense += c.genome.senseRadius;
      for (const o of c.genome.organelles) {
        if (o.kind === 'flagellum') sumFlagella += o.size;
        else if (o.kind === 'mouth') sumMouths += o.size;
        else if (o.kind === 'chloroplast') sumChloroplasts += o.size;
        else if (o.kind === 'eye') sumEyes += 1;
        else if (o.kind === 'armor') sumArmor += o.size;
      }
      sumAge += c.age;
      if (c.generation > maxGeneration) maxGeneration = c.generation;
      if (c.attachedTo === null) {
        if (c.attachedChildren.length > 0) {
          colonies++;
          colonyMemberTotal += this.collectColonyMembers(c).length;
        } else {
          soloCells++;
        }
      }
    }
    const n = this.cells.length || 1;
    return {
      tick: Math.floor(this.tick),
      population: this.cells.length,
      sexual,
      asexual,
      colonies,
      soloCells,
      avgColonySize: colonies > 0 ? colonyMemberTotal / colonies : 0,
      avgSize: sumSize / n,
      avgSpeed: sumSpeed / n,
      avgSense: sumSense / n,
      avgFlagella: sumFlagella / n,
      avgMouths: sumMouths / n,
      avgChloroplasts: sumChloroplasts / n,
      avgEyes: sumEyes / n,
      avgArmor: sumArmor / n,
      avgAge: sumAge / n,
      maxGeneration,
      meatFood: this.meatFood.length,
    };
  }

  private pushStatsSnapshot(): void {
    this.history.push(this.getLiveStats());
    if (this.history.length > this.maxHistory) this.history.shift();
  }

  /** Adds a carrion pellet, oldest-first-evicting if that would push the
   * standing amount over the cap — a predation/death spike (a colony wiped
   * out at once, say) can't make the meat pile grow without bound. */
  private spawnMeat(x: number, y: number, energy: number): void {
    if (this.meatFood.length >= this.maxMeatFood) this.meatFood.shift();
    this.meatFood.push(createFood(x, y, energy, Math.floor(this.tick)));
  }

  /** Removes carrion that's been sitting long enough to rot away — the
   * actual fix for meat food's unbounded growth, not just the cap. */
  private decayMeatFood(): void {
    if (this.meatFood.length === 0) return;
    const cutoff = this.tick - this.meatDecayTicks;
    this.meatFood = this.meatFood.filter((f) => f.bornTick > cutoff);
  }

  /** True if world point (tx, ty) falls inside cell's field of view — a
   * narrow always-on "chemoreception" cone plus the union of whatever eye
   * organelles it's grown, each mounted at its own angle relative to its
   * heading with a width set by that eye's size. */
  private inFOV(cell: Virtunism, tx: number, ty: number): boolean {
    const angleToTarget = Math.atan2(ty - cell.y, tx - cell.x);
    const within = (mountAngle: number, halfWidth: number): boolean => {
      let diff = angleToTarget - (cell.heading + mountAngle);
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      return Math.abs(diff) <= halfWidth;
    };
    const baselineHalf = ((50 * Math.PI) / 180) * 0.5;
    if (within(0, baselineHalf)) return true;
    for (const eye of cell.genome.organelles) {
      if (eye.kind !== 'eye') continue;
      const halfWidth = (((50 + eye.size * 40) * Math.PI) / 180) * 0.5;
      if (within(eye.angle, halfWidth)) return true;
    }
    return false;
  }

  /** How far a predator's mouth investment stretches its max-prey-size
   * threshold — a bigger mouth can tackle relatively bigger prey. */
  private predatorReach(predator: Virtunism): number {
    return clamp(0.7 + deriveMouthPower(predator.genome) * 0.15, 0.7, 1.4);
  }

  /** Builds the fixed sensor vector consumed by Virtunism/NeuralNet (see
   * BRAIN_TOPOLOGY.inputs). A mouthed virtunism's only food sources are
   * carrion and other virtunisms (predation) — there's no ambient food
   * resource, so "prey" covers everything from a photosynthesizer smaller
   * than you to a fresh corpse. Candidates come from the spatial grid
   * (only nearby buckets), not the whole population. */
  private buildInputs(cell: Virtunism): number[] {
    const sr = cell.genome.senseRadius;
    const canEat = cell.canEat;

    let foodDx = 0;
    let foodDy = 0;
    let foodDist = 1;
    let bestFoodD = sr;

    if (canEat) {
      const nearbyCarrion = this.carrionGrid.queryRadius(cell.x, cell.y, sr);
      for (const f of nearbyCarrion) {
        const dx = f.x - cell.x;
        const dy = f.y - cell.y;
        const d = Math.hypot(dx, dy);
        if (d < bestFoodD && this.inFOV(cell, f.x, f.y)) {
          bestFoodD = d;
          foodDx = dx / sr;
          foodDy = dy / sr;
          foodDist = d / sr;
        }
      }
      const nearbyCells = this.virtunismGrid.queryRadius(cell.x, cell.y, sr);
      for (const other of nearbyCells) {
        if (other === cell || !other.alive) continue;
        if (other.effectiveDefenseSize >= cell.genome.size * this.predationSizeRatio * this.predatorReach(cell)) continue;
        const dx = other.x - cell.x;
        const dy = other.y - cell.y;
        const d = Math.hypot(dx, dy);
        if (d < bestFoodD && this.inFOV(cell, other.x, other.y)) {
          bestFoodD = d;
          foodDx = dx / sr;
          foodDy = dy / sr;
          foodDist = d / sr;
        }
      }
    }

    let threatDx = 0;
    let threatDy = 0;
    let threatDist = 1;
    let bestThreatD = sr;
    let mateDx = 0;
    let mateDy = 0;
    let mateDist = 1;
    let bestMateD = sr;
    const wantsMate = cell.genome.reproductionMode === 'sexual';

    const nearbyForThreatAndMate = this.virtunismGrid.queryRadius(cell.x, cell.y, sr);
    for (const other of nearbyForThreatAndMate) {
      if (other === cell || !other.alive) continue;
      const dx = other.x - cell.x;
      const dy = other.y - cell.y;
      const d = Math.hypot(dx, dy);

      if (
        other.canEat &&
        cell.effectiveDefenseSize < other.genome.size * this.predationSizeRatio * this.predatorReach(other) &&
        d < bestThreatD &&
        this.inFOV(cell, other.x, other.y)
      ) {
        bestThreatD = d;
        threatDx = dx / sr;
        threatDy = dy / sr;
        threatDist = d / sr;
      }

      if (
        wantsMate &&
        other.lineageId === cell.lineageId &&
        other.genome.reproductionMode === 'sexual' &&
        other.canMate() &&
        d < bestMateD &&
        this.inFOV(cell, other.x, other.y)
      ) {
        bestMateD = d;
        mateDx = dx / sr;
        mateDy = dy / sr;
        mateDist = d / sr;
      }
    }

    const energyNorm = clamp(cell.energy / cell.maxEnergy, 0, 1);
    const maxSpeed = deriveMaxSpeed(cell.genome);
    const speedNorm = maxSpeed > 0 ? cell.speed / maxSpeed : 0;

    const marginX = Math.min(cell.x, this.width - cell.x);
    const marginY = Math.min(cell.y, this.height - cell.y);
    const wallSignX = cell.x < this.width / 2 ? 1 : -1;
    const wallSignY = cell.y < this.height / 2 ? 1 : -1;
    const wallUrgencyX = clamp(1 - marginX / sr, 0, 1) * wallSignX;
    const wallUrgencyY = clamp(1 - marginY / sr, 0, 1) * wallSignY;

    // A per-individual oscillator ("run and tumble" drive) — without it a
    // virtunism with nothing nearby sees an almost constant input vector
    // and a random brain settles into a fixed turn output, orbiting a tiny
    // circle forever. Gives every genome some baseline ability to explore.
    const wander = Math.sin(cell.age * 0.05 + cell.id * 0.7321);

    return [
      foodDx,
      foodDy,
      foodDist,
      threatDx,
      threatDy,
      threatDist,
      mateDx,
      mateDy,
      mateDist,
      energyNorm,
      speedNorm,
      wallUrgencyX,
      wallUrgencyY,
      wander,
      1, // bias
    ];
  }

  private collectColonyMembers(root: Virtunism): Virtunism[] {
    const members: Virtunism[] = [];
    const stack: Virtunism[] = [root];
    while (stack.length) {
      const cell = stack.pop() as Virtunism;
      members.push(cell);
      for (const child of cell.attachedChildren) stack.push(child);
    }
    return members;
  }

  /** Moves an entire bonded colony as one rigid body: every member's brain
   * cast a [turn, thrust] vote this tick (cached in lastOutputs); votes are
   * pooled weighted by each member's own flagella investment, so
   * heavily-flagellated members steer more than a bare passenger would. The
   * colony's top speed comes from its *pooled* flagella power (with
   * diminishing returns), same shape as a solo virtunism's but bigger.
   * After integrating the root, every other member is repositioned from
   * its fixed parent-relative joint. */
  private moveColonyRigid(root: Virtunism, dt: number): void {
    const members = this.collectColonyMembers(root);
    let turnSum = 0;
    let thrustSum = 0;
    let weightSum = 0;
    let totalFlagellaPower = 0;
    for (const m of members) {
      const power = deriveFlagellaPower(m.genome);
      totalFlagellaPower += power;
      if (power <= 0) continue;
      const turnOut = clamp(m.lastOutputs[0] ?? 0, -1, 1);
      const thrustOut = clamp(m.lastOutputs[1] ?? 0, 0, 1);
      turnSum += turnOut * power;
      thrustSum += thrustOut * power;
      weightSum += power;
    }
    const avgTurn = weightSum > 0 ? turnSum / weightSum : 0;
    const avgThrust = weightSum > 0 ? thrustSum / weightSum : 0;

    const colonyMaxSpeed = 0.05 + Math.sqrt(totalFlagellaPower) * 0.85;
    const colonyTurnRate = 0.06 + Math.min(0.22, members.length * 0.02);

    root.heading += avgTurn * colonyTurnRate * dt;
    root.speed = avgThrust * colonyMaxSpeed;
    root.x += Math.cos(root.heading) * root.speed * dt;
    root.y += Math.sin(root.heading) * root.speed * dt;
    root.clampToBounds(this.width, this.height, true);

    // Cascade positions from root down through the bond tree.
    const stack: Virtunism[] = [root];
    while (stack.length) {
      const cell = stack.pop() as Virtunism;
      for (const child of cell.attachedChildren) {
        const worldAngle = cell.heading + child.localAngle;
        child.x = cell.x + Math.cos(worldAngle) * child.localDist;
        child.y = cell.y + Math.sin(worldAngle) * child.localDist;
        child.heading = worldAngle;
        child.clampToBounds(this.width, this.height, false);
        stack.push(child);
      }
    }
  }

  /** Slowly equalizes energy across each bonded parent-child joint — how a
   * colony shares resources, letting e.g. a flagella-heavy propulsion
   * member survive on income harvested by its photosynthetic/mouthed
   * neighbors. */
  private diffuseColonyEnergy(dt: number): void {
    const rate = 0.08;
    for (const cell of this.cells) {
      if (!cell.alive || !cell.attachedTo || !cell.attachedTo.alive) continue;
      const parent = cell.attachedTo;
      const transfer = (parent.energy - cell.energy) * rate * dt;
      parent.energy -= transfer;
      cell.energy += transfer;
    }
  }

  /** Grants photosynthesis income, throttled by a dish-wide sunlight
   * budget shared across every chloroplast-bearing virtunism. If total
   * demand is under budget everyone gets their full uncontested share
   * (the common case at low population); once it isn't, income scales
   * down proportionally for all of them — the mechanism that gives
   * photosynthesizers an actual carrying capacity instead of growing to
   * fill the entire population cap. */
  private applyPhotosynthesis(dt: number): void {
    let totalDemand = 0;
    for (const cell of this.cells) {
      if (cell.alive) totalDemand += cell.baseSunlightDemand;
    }
    if (totalDemand <= 0) return;
    const availability = Math.min(1, this.sunlightCapacity / totalDemand);
    for (const cell of this.cells) {
      if (cell.alive) cell.photosynthesize(dt, availability);
    }
  }

  /** Carrion is the only discrete food item in the dish — everything else
   * a mouthed virtunism eats, it has to catch alive (see handlePredation). */
  private handleEating(): void {
    for (const cell of this.cells) {
      if (!cell.alive || !cell.canEat) continue;
      const reach = cell.radius + (deriveMouthPower(cell.genome) - 1) * 4;
      const yieldMult = cell.biteYield;
      const nearbyCarrion = this.carrionGrid.queryRadius(cell.x, cell.y, reach + 10);
      for (const f of nearbyCarrion) {
        const d = Math.hypot(f.x - cell.x, f.y - cell.y);
        if (d >= reach + f.radius) continue;
        const idx = this.meatFood.indexOf(f);
        if (idx === -1) continue; // already eaten by someone else this pass
        cell.eat(f.energy * yieldMult);
        this.meatFood.splice(idx, 1);
      }
    }
  }

  private handlePredation(): void {
    for (const predator of this.cells) {
      if (!predator.alive || !predator.canEat) continue;
      // A flat "lunge" bonus on top of body/mouth reach — without it, a
      // baseline one-mouth predator has a genuinely tiny catch radius, and
      // early-generation (still-random-brained) hunters need *some* margin
      // to survive on lucky catches long enough for real chase behavior to
      // evolve. Same lesson as foraging and mate-finding before it: a
      // mechanic that's only winnable once you're already good at it never
      // gets the chance to be learned at all.
      const reach = predator.radius + 6 + (deriveMouthPower(predator.genome) - 1) * 4;
      const nearby = this.virtunismGrid.queryRadius(predator.x, predator.y, reach + 30);
      for (const prey of nearby) {
        if (prey === predator || !prey.alive) continue;
        if (prey.effectiveDefenseSize >= predator.genome.size * this.predationSizeRatio * this.predatorReach(predator)) continue;
        const d = Math.hypot(prey.x - predator.x, prey.y - predator.y);
        if (d < reach + prey.radius * 0.9) {
          // A deliberately modest fraction — real trophic pyramids only
          // pass roughly a tenth of prey biomass up a level. Too generous
          // here and predators can outbreed their own prey base faster
          // than it can recover, overshoot, and crash the whole dish (prey
          // hunted to extinction, then predators starve with nothing
          // left) instead of settling into an oscillating equilibrium.
          const mitigation = deriveArmorMitigation(prey.genome);
          const bite = prey.energy * 0.35 * clamp(predator.biteYield, 0.4, 1.6) * (1 - mitigation);
          predator.eat(bite);
          const corpseEnergy = Math.max(0, prey.energy - bite);
          if (corpseEnergy > 0.5) this.spawnMeat(prey.x, prey.y, corpseEnergy);
          prey.alive = false;
          prey.detachFromColony();
          break; // one successful strike per predator per tick
        }
      }
    }
  }

  private findColonyRoot(cell: Virtunism): Virtunism {
    let root = cell;
    while (root.attachedTo) root = root.attachedTo;
    return root;
  }

  private handleReproduction(): void {
    if (this.cells.length >= this.maxPopulation) return;
    const newborns: Virtunism[] = [];
    const mated = new Set<number>();

    const lineageCounts = new Map<number, number>();
    for (const c of this.cells) lineageCounts.set(c.lineageId, (lineageCounts.get(c.lineageId) ?? 0) + 1);
    const lineageCap = this.maxPopulation * this.maxLineageShare;
    const roomFor = (lineageId: number): boolean => (lineageCounts.get(lineageId) ?? 0) < lineageCap;
    const grow = (lineageId: number): void => {
      lineageCounts.set(lineageId, (lineageCounts.get(lineageId) ?? 0) + 1);
    };

    // Sexual pairing: two same-lineage, mating-ready virtunisms produce one
    // crossed-over child once they're within sensing range of each other —
    // always ejected as a free virtunism (sexual reproduction is the
    // "spread to a new lineage" path).
    for (const a of this.cells) {
      if (this.cells.length + newborns.length >= this.maxPopulation) break;
      if (mated.has(a.id) || !a.canMate() || !roomFor(a.lineageId)) continue;
      const meetRange = a.genome.senseRadius;
      const candidates = this.virtunismGrid.queryRadius(a.x, a.y, meetRange);
      for (const b of candidates) {
        if (b === a || mated.has(b.id) || !b.canMate()) continue;
        if (b.lineageId !== a.lineageId) continue;
        const d = Math.hypot(b.x - a.x, b.y - a.y);
        const range = Math.max(a.genome.senseRadius, b.genome.senseRadius);
        if (d < range && (this.inFOV(a, b.x, b.y) || this.inFOV(b, a.x, a.y))) {
          const child = mateVirtunisms(a, b, this.rng);
          newborns.push(child);
          this.recordBirth(child, a.id, b.id);
          mated.add(a.id);
          mated.add(b.id);
          grow(a.lineageId);
          break;
        }
      }
    }

    // Asexual: a virtunism with a bud organelle grows its colony (if
    // there's room); everyone else ejects a free-floating clone.
    for (const cell of this.cells) {
      if (this.cells.length + newborns.length >= this.maxPopulation) break;
      if (!cell.canReproduce() || !roomFor(cell.lineageId)) continue;
      if (hasBud(cell.genome)) {
        const root = this.findColonyRoot(cell);
        if (this.collectColonyMembers(root).length < this.maxColonySize) {
          const child = cell.budOffspring(this.rng);
          newborns.push(child);
          this.recordBirth(child, cell.id, null);
          grow(cell.lineageId);
          continue;
        }
      }
      {
        const child = cell.reproduce(this.rng);
        newborns.push(child);
        this.recordBirth(child, cell.id, null);
        grow(cell.lineageId);
      }
    }

    if (newborns.length) this.cells.push(...newborns);
  }

  private cleanupDead(): void {
    const survivors: Virtunism[] = [];
    for (const cell of this.cells) {
      if (!cell.alive) {
        cell.detachFromColony(); // already corpsed by handlePredation
        this.recordDeath(cell);
        continue;
      }
      if (cell.isDead()) {
        this.spawnMeat(cell.x, cell.y, Math.max(4, cell.genome.size * 8));
        cell.detachFromColony();
        this.recordDeath(cell);
        continue;
      }
      survivors.push(cell);
    }
    this.cells = survivors;
  }
}
