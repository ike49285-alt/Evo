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

    for (const org of this.organisms) {
      const perception = this.perceive(org);
      const inputs = org.sense(perception);
      const outputs = org.think(inputs);
      org.act(outputs, dt);
      org.metabolize(dt, sunlightScale);
      this.wrapPosition(org);
    }

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
    for (const org of this.organisms) {
      massSum += org.stats.mass;
      genSum += org.generation;
      if (org.generation > highestGen) highestGen = org.generation;
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
      tick: this.tickCount,
    };
  }
}
