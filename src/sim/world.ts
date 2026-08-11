// The tick loop: sunlight budget, grid-backed sensing, eating/predation,
// reproduction, population cap, stats. This is the only place that needs
// to know about more than one organism at a time.

import { Rng } from './rng.js';
import { Organism, Perception, SenseTarget } from './organism.js';
import { Genome, mutateGenome, deriveStats } from './genome.js';
import { SpatialGrid } from './grid.js';
import { Carrion, spawnCarrion, CARRION_DECAY_TICKS, MAX_CARRION } from './food.js';
import { dist, directionTo } from './types.js';
import {
  AminoAcid,
  Protein,
  spawnAminoAcid,
  supplyAminoAcids,
  driftChemistry,
  bondPass,
  decayProteins,
  attemptCondensation,
  MAX_AMINO_ACIDS,
} from './chemistry.js';

const GRID_CELL_SIZE = 48;
const LIGHT_BUDGET_PER_AREA = 0.9; // energy/tick per 10,000 sq. units of dish
const MAX_POPULATION = 500;
const ABSORB_RATE = 6; // energy/sec a vacuole can transfer at full contact
const ABSORB_EFFICIENCY = 0.7; // predator keeps this fraction; rest is lost, not free lunch
const REPRO_ENERGY_MULT = 2.0; // must bank this many x reproCost before reproducing
const CHILD_ENERGY_SHARE = 0.55; // fraction of reproCost handed to the child
const MAX_COLONY_SIZE = 16; // a bud-capable lineage that hits this falls back to ejecting instead
const BOND_DIFFUSION_RATE = 0.5; // fraction of a bonded pair's energy gap that equalizes per second
const SEPARATION_STRENGTH = 6; // push per unit of overlap, per second
const MAX_SEPARATION_PUSH = 40; // world units/sec cap, so a deeply-overlapping pair doesn't launch apart
const SEPARATION_QUERY_PAD = 80; // generous upper bound on "how big could the other colony be"

const NO_TARGET: SenseTarget = { dir: { x: 0, y: 0 }, dist01: 1 };
const CHEMISTRY_GRID_CELL_SIZE = 64; // bigger cells = fewer buckets touched per query at high particle counts

export interface WorldStats {
  population: number;
  carrionCount: number;
  avgMass: number;
  avgGeneration: number;
  highestGeneration: number;
  aminoAcidCount: number;
  proteinCount: number;
  sparkCount: number;
  colonyCount: number;
  largestColony: number;
  tick: number;
}

export class World {
  readonly width: number;
  readonly height: number;
  readonly rng: Rng;

  organisms: Organism[] = [];
  carrion: Carrion[] = [];
  aminoAcids: AminoAcid[] = [];
  proteins: Protein[] = [];
  private organismGrid = new SpatialGrid<Organism>(GRID_CELL_SIZE);
  private carrionGrid = new SpatialGrid<Carrion>(GRID_CELL_SIZE);
  private aminoGrid = new SpatialGrid<AminoAcid>(CHEMISTRY_GRID_CELL_SIZE);
  private proteinGrid = new SpatialGrid<Protein>(CHEMISTRY_GRID_CELL_SIZE);
  private aminoCarryover = 0;

  tickCount = 0;
  stats: WorldStats;
  private nextLineageId = 1;
  private sparkCount = 0;

  constructor(width: number, height: number, seed: number) {
    this.width = width;
    this.height = height;
    this.rng = new Rng(seed);
    this.stats = {
      population: 0,
      carrionCount: 0,
      avgMass: 0,
      avgGeneration: 0,
      highestGeneration: 0,
      aminoAcidCount: 0,
      proteinCount: 0,
      sparkCount: 0,
      colonyCount: 0,
      largestColony: 0,
      tick: 0,
    };
  }

  /** Drop in a genome at a specific spot (used by the condensation pass), or
   *  at a random spot if no position is given (manual/debug use). This is
   *  the only way an organism ever comes to exist — there is no seed()
   *  anymore. We start from prelife, or not at all. */
  spawnFounder(genome: Genome, x?: number, y?: number): Organism {
    const px = x ?? this.rng.range(0, this.width);
    const py = y ?? this.rng.range(0, this.height);
    const stats = deriveStats(genome);
    const org = new Organism(genome, px, py, stats.reproCost * 1.2, 0, this.nextLineageId++);
    this.organisms.push(org);
    return org;
  }

  /** Injects a burst of amino acids — the "+ Soup" control. Not a founder
   *  spawn; just more raw material for chemistry to work with. */
  injectSoup(count: number): void {
    for (let i = 0; i < count && this.aminoAcids.length < MAX_AMINO_ACIDS; i++) {
      this.aminoAcids.push(spawnAminoAcid(this.rng, this.rng.range(0, this.width), this.rng.range(0, this.height)));
    }
  }

  reset(): void {
    this.organisms = [];
    this.carrion = [];
    this.aminoAcids = [];
    this.proteins = [];
    this.aminoCarryover = 0;
    this.tickCount = 0;
    this.nextLineageId = 1;
    this.sparkCount = 0;
  }

  tick(dt: number): void {
    this.tickChemistry(dt);

    this.organismGrid.rebuild(this.organisms);
    this.carrionGrid.rebuild(this.carrion);

    const sunlightScale = this.computeSunlightScale();

    // Only a colony's root actually senses/thinks/acts — a bonded member's
    // position is derived from the root's transform, not simulated
    // independently (see Organism.propagateColonyTransform). A singleton
    // organism is trivially its own one-member colony, so this applies to
    // it too. Metabolism (upkeep/photosynthesis) runs for everyone —
    // bonded members still have working organelles, they just don't drive.
    for (const org of this.organisms) {
      if (org.isRoot) {
        const perception = this.perceive(org);
        const inputs = org.sense(perception);
        const outputs = org.think(inputs);
        org.act(outputs, dt);
        this.wrapPosition(org);
        org.propagateColonyTransform();
      }
      org.metabolize(dt, sunlightScale);
    }

    this.resolveSeparation(dt);
    this.resolveBondDiffusion(dt);
    this.resolveIngestion(dt);
    this.resolveReproduction();
    this.resolveDeaths();
    this.decayCarrion(dt);

    this.tickCount += dt;
    this.updateStats();
  }

  /** Amino acids -> proteins -> (sometimes) a spontaneous new founder. */
  private tickChemistry(dt: number): void {
    const supplied = supplyAminoAcids(this.aminoAcids, this.aminoCarryover, this.rng, this.width, this.height, dt);
    this.aminoAcids = supplied.aminoAcids;
    this.aminoCarryover = supplied.carryover;

    driftChemistry(this.aminoAcids, this.proteins, dt, this.width, this.height, this.rng);

    this.aminoGrid.rebuild(this.aminoAcids);
    this.proteinGrid.rebuild(this.proteins);

    const bonded = bondPass(this.aminoAcids, this.proteins, this.aminoGrid, this.proteinGrid, dt, this.rng);
    this.aminoAcids = bonded.aminoAcids;
    this.proteins = decayProteins(bonded.proteins, dt);
    this.proteinGrid.rebuild(this.proteins);

    // Population cap applies to abiogenesis too — a cluster that qualifies
    // while the dish is full still consumes its proteins (the chemistry
    // happened), it just doesn't get to become anything.
    const { proteins, sparks } = attemptCondensation(this.proteins, this.proteinGrid, dt, this.rng);
    this.proteins = proteins;
    for (const spark of sparks) {
      if (this.organisms.length >= MAX_POPULATION) break;
      this.spawnFounder(spark.genome, spark.x, spark.y);
      this.sparkCount++;
    }
  }

  private wrapPosition(org: Organism): void {
    if (org.x < 0) org.x += this.width;
    else if (org.x >= this.width) org.x -= this.width;
    if (org.y < 0) org.y += this.height;
    else if (org.y >= this.height) org.y -= this.height;
  }

  private computeSunlightScale(): number {
    let demand = 0;
    for (const org of this.organisms) demand += org.stats.photoRate;
    const budget = (this.width * this.height) * (LIGHT_BUDGET_PER_AREA / 10000);
    if (demand <= budget || demand === 0) return 1;
    return budget / demand;
  }

  /** Pushes overlapping, unrelated roots apart. A colony's own members are
   *  never separated from each other — their positions are derived from the
   *  root's transform, not free physics — so this only ever compares one
   *  colony's root against another's, using each colony's full extent
   *  (`colonyRadius`), not just the root's own hull. Accumulate-then-apply
   *  so processing order within the pass can't double-push a pair. */
  private resolveSeparation(dt: number): void {
    for (const org of this.organisms) {
      if (org.isRoot) {
        org.pendingPushX = 0;
        org.pendingPushY = 0;
      }
    }

    for (const org of this.organisms) {
      if (!org.isRoot) continue;
      const nearby = this.organismGrid.queryRadius(org, org.colonyRadius + SEPARATION_QUERY_PAD);
      for (const other of nearby) {
        if (other === org || !other.isRoot) continue;
        const dx = org.x - other.x;
        const dy = org.y - other.y;
        const minDist = org.colonyRadius + other.colonyRadius;
        let d = Math.sqrt(dx * dx + dy * dy);
        if (d >= minDist) continue;
        if (d < 1e-6) d = 1e-6; // perfectly coincident — pick an arbitrary push direction
        const overlap = minDist - d;
        const push = Math.min(overlap * SEPARATION_STRENGTH, MAX_SEPARATION_PUSH) * dt;
        org.pendingPushX += (dx / d) * push;
        org.pendingPushY += (dy / d) * push;
      }
    }

    for (const org of this.organisms) {
      if (!org.isRoot || (org.pendingPushX === 0 && org.pendingPushY === 0)) continue;
      org.x += org.pendingPushX;
      org.y += org.pendingPushY;
      this.wrapPosition(org);
      org.propagateColonyTransform();
    }
  }

  /** Energy equalizes across a bond toward whichever side has less —
   *  a photosynthesizing member can carry a bonded sibling that has no
   *  income of its own, the whole point of being a colony instead of just
   *  independent neighbors. */
  private resolveBondDiffusion(dt: number): void {
    for (const org of this.organisms) {
      if (!org.parent) continue;
      const flow = (org.parent.energy - org.energy) * BOND_DIFFUSION_RATE * dt;
      org.parent.energy -= flow;
      org.energy += flow;
    }
  }

  private colonySize(org: Organism): number {
    let root = org;
    while (root.parent) root = root.parent;
    let count = 0;
    const stack: Organism[] = [root];
    while (stack.length) {
      const node = stack.pop()!;
      count++;
      for (const child of node.children) stack.push(child);
    }
    return count;
  }

  private perceive(org: Organism): Perception {
    const range = org.stats.visionRange;
    if (range <= 0) return { food: NO_TARGET, threat: NO_TARGET, mate: NO_TARGET };

    const nearbyOrgs = this.organismGrid.queryRadius(org, range);
    let bestFood: { d: number; entity: { x: number; y: number } } | null = null;
    let bestThreat: { d: number; entity: { x: number; y: number } } | null = null;
    let bestMate: { d: number; entity: { x: number; y: number } } | null = null;

    if (org.stats.vacuoleRadius > 0) {
      const nearbyCarrion = this.carrionGrid.queryRadius(org, range);
      for (const c of nearbyCarrion) {
        const d = dist(org, c);
        if (d <= range && (!bestFood || d < bestFood.d)) bestFood = { d, entity: c };
      }
    }

    for (const other of nearbyOrgs) {
      if (other === org || !other.alive) continue;
      const d = dist(org, other);
      if (d > range) continue;

      if (org.stats.vacuoleRadius > 0 && other.stats.mass <= org.stats.maxIngestMass && (!bestFood || d < bestFood.d)) {
        bestFood = { d, entity: other };
      }
      if (other.stats.vacuoleRadius > 0 && org.stats.mass <= other.stats.maxIngestMass && (!bestThreat || d < bestThreat.d)) {
        bestThreat = { d, entity: other };
      }
      if (other.lineageId === org.lineageId && other.matingReady && (!bestMate || d < bestMate.d)) {
        bestMate = { d, entity: other };
      }
    }

    return {
      food: bestFood ? { dir: directionTo(org, bestFood.entity), dist01: bestFood.d / range } : NO_TARGET,
      threat: bestThreat ? { dir: directionTo(org, bestThreat.entity), dist01: bestThreat.d / range } : NO_TARGET,
      mate: bestMate ? { dir: directionTo(org, bestMate.entity), dist01: bestMate.d / range } : NO_TARGET,
    };
  }

  /** Vacuole-based ingestion: a slow, continuous engulf-and-digest while in
   *  contact — not a bite/kill. Carrion is free calories; live prey has to
   *  be small enough to engulf and armor slows the rate, but there's no
   *  single decisive "attack". */
  private resolveIngestion(dt: number): void {
    for (const org of this.organisms) {
      if (!org.alive || org.stats.vacuoleRadius <= 0) continue;

      // Carrion first — free calories, no resistance.
      const nearCarrion = this.carrionGrid.queryRadius(org, org.stats.vacuoleRadius);
      for (const c of nearCarrion) {
        if (c.energy <= 0) continue;
        if (dist(org, c) > org.stats.vacuoleRadius) continue;
        const take = Math.min(c.energy, ABSORB_RATE * dt);
        c.energy -= take;
        org.energy += take * ABSORB_EFFICIENCY;
      }

      // Live prey — must be small enough to engulf.
      const nearOrgs = this.organismGrid.queryRadius(org, org.stats.vacuoleRadius);
      for (const prey of nearOrgs) {
        if (prey === org || !prey.alive) continue;
        if (prey.stats.mass > org.stats.maxIngestMass) continue;
        if (dist(org, prey) > org.stats.vacuoleRadius) continue;
        const armorFactor = 1 / (1 + prey.stats.armor);
        const drained = ABSORB_RATE * dt * armorFactor;
        prey.energy -= drained;
        org.energy += drained * ABSORB_EFFICIENCY;
      }
    }
  }

  private resolveReproduction(): void {
    if (this.organisms.length >= MAX_POPULATION) return;
    const newborns: Organism[] = [];
    for (const org of this.organisms) {
      if (!org.alive) continue;
      if (this.organisms.length + newborns.length >= MAX_POPULATION) break;
      if (org.energy < org.stats.reproCost * REPRO_ENERGY_MULT) continue;

      const childGenome = mutateGenome(org.genome, this.rng);
      const childEnergy = org.stats.reproCost * CHILD_ENERGY_SHARE;
      org.energy -= childEnergy + org.stats.reproCost * 0.3; // cost of reproducing beyond what the child gets

      // Bud-capable and there's still room in the colony: stay bonded
      // instead of ejecting. Any member can bud, not just the root — a
      // colony branches wherever reproduction happens, not just at the top.
      // (budCapable is the *parent's* trait — it decides whether ITS
      // offspring bond. The child deciding its own future offspring's fate
      // is just it reproducing later, off its own stats.)
      if (org.stats.budCapable && this.colonySize(org) < MAX_COLONY_SIZE) {
        const childStats = deriveStats(childGenome);
        const localAngle = this.rng.range(0, Math.PI * 2);
        const localDistance = org.stats.hullRadius + childStats.hullRadius * 0.8;
        const child = new Organism(childGenome, org.x, org.y, childEnergy, org.generation + 1, org.lineageId);
        org.bondChild(child, localAngle, localDistance);
        // Place it now (not just next tick's propagate pass) so it isn't
        // misdrawn/miscontacted for the rest of *this* tick.
        const worldAngle = org.heading + localAngle;
        child.x = org.x + Math.cos(worldAngle) * localDistance;
        child.y = org.y + Math.sin(worldAngle) * localDistance;
        child.heading = org.heading;
        newborns.push(child);
        continue;
      }

      const angle = this.rng.range(0, Math.PI * 2);
      const child = new Organism(
        childGenome,
        org.x + Math.cos(angle) * org.stats.hullRadius * 2,
        org.y + Math.sin(angle) * org.stats.hullRadius * 2,
        childEnergy,
        org.generation + 1,
        org.lineageId,
      );
      this.wrapPosition(child);
      newborns.push(child);
    }
    if (newborns.length) this.organisms.push(...newborns);
  }

  private resolveDeaths(): void {
    if (this.organisms.length === 0) return;
    const survivors: Organism[] = [];
    for (const org of this.organisms) {
      if (org.isDead) {
        // Direct children each become the root of their own still-intact
        // sub-colony — a colony fragments on a member's death, it doesn't
        // vaporize down to individuals.
        org.dissolveBonds();
        if (org.parent) {
          const idx = org.parent.children.indexOf(org);
          if (idx !== -1) org.parent.children.splice(idx, 1);
        }
        if (this.carrion.length < MAX_CARRION) {
          this.carrion.push(spawnCarrion(org.x, org.y, org.stats.mass * 1.5));
        }
      } else {
        survivors.push(org);
      }
    }
    this.organisms = survivors;
  }

  private decayCarrion(dt: number): void {
    const alive: Carrion[] = [];
    for (const c of this.carrion) {
      c.age += dt;
      if (c.age < CARRION_DECAY_TICKS && c.energy > 0.05) alive.push(c);
    }
    this.carrion = alive.length <= MAX_CARRION ? alive : alive.slice(alive.length - MAX_CARRION);
  }

  private updateStats(): void {
    const n = this.organisms.length;
    let massSum = 0;
    let genSum = 0;
    let highestGen = 0;
    let colonyCount = 0;
    let largestColony = 0;
    for (const org of this.organisms) {
      massSum += org.stats.mass;
      genSum += org.generation;
      if (org.generation > highestGen) highestGen = org.generation;
      if (org.isRoot) {
        const size = org.children.length > 0 ? this.colonySize(org) : 1;
        if (org.children.length > 0) colonyCount++;
        if (size > largestColony) largestColony = size;
      }
    }
    this.stats = {
      population: n,
      carrionCount: this.carrion.length,
      avgMass: n ? massSum / n : 0,
      avgGeneration: n ? genSum / n : 0,
      highestGeneration: highestGen,
      aminoAcidCount: this.aminoAcids.length,
      proteinCount: this.proteins.length,
      sparkCount: this.sparkCount,
      colonyCount,
      largestColony,
      tick: this.tickCount,
    };
  }
}
