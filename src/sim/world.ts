import {
  deserializeVirtunisms,
  getNextVirtunismId,
  mateVirtunisms,
  setNextVirtunismId,
  SerializedVirtunism,
  Virtunism,
} from './virtunism.js';
import { createFood, Food, getNextFoodId, setNextFoodId } from './food.js';
import { deriveMaxSpeed, deriveMotorPower, derivePredationPower, deriveStructureMitigation, genomeFromSequence, hasBud } from './genome.js';
import { decodeCoreTraits, GeneSequence, geneticDistance, genomeDistance, mutateGeneSequence } from './genes.js';
import { generateSpeciesName } from './speciesNames.js';
import { NeuralNet } from './nn.js';
import { Rng } from './rng.js';
import { BRAIN_TOPOLOGY, CatalysisClass } from './types.js';
import { SpatialGrid } from './grid.js';
import { CATALYSIS_CLASSES } from '../chem/polymer.js';

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** Three decimal places, for figures that are kept permanently rather than
 * recomputed — see sampleLineages' finalStats. */
function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** The last real measurements taken of a species while it still had living
 * members — what the Species card falls back to once there is nobody left to
 * measure. Sampled on World.statsSampleInterval (see sampleLineages), so for
 * an extinct species this is its final sample, not the instant of death. */
export interface LineageStats {
  maxGeneration: number;
  avgSize: number;
  avgSpeed: number;
  avgSense: number;
  dominantClass: CatalysisClass | null;
  avgClassPower: Record<CatalysisClass, number>;
}

/** A lineage record as it may arrive from storage: either the current shape,
 * or one written before save v10, which has no life-history fields at all.
 * Modelled explicitly rather than read as `any` so the backfill in
 * World.deserialize has to account for every field it is missing. */
export type StoredLineage = Omit<LineageInfo, 'peakPopulation' | 'extinctTick' | 'finalStats'> &
  Partial<Pick<LineageInfo, 'peakPopulation' | 'extinctTick' | 'finalStats'>>;

export interface LineageInfo {
  id: number;
  name: string;
  hue: number;
  isPlayerDesigned: boolean;
  createdTick: number;
  /** The genome new members of this species are measured against — see
   * World.checkSpeciation. For a founded species (Designer/bootstrap)
   * this is the template's own encoded sequence; for one that emerged
   * from divergence, it's the founding diverged individual's own genome.
   *
   * Null once the species is extinct, and that is a deliberate space
   * reclamation rather than an oversight: this field is read in exactly one
   * place (checkSpeciation), only ever against a *living* cell's own
   * lineage, and an extinct lineage can never acquire a new member — births
   * inherit the parent's lineageId, and speciation always mints a fresh id.
   * So the sequence is unreachable from the moment the last member dies,
   * while remaining 95% of a lineage record's serialized weight. Dropping it
   * is what makes keeping every extinct species affordable; see NOTES.md for
   * the measurement (872k -> 57k chars at 20,000 ticks). */
  referenceSequence: GeneSequence | null;
  /** null for an original founder; set when this species itself emerged
   * from another one drifting apart — the real phylogenetic link a plain
   * lineage label never had. */
  parentLineageId: number | null;
  /** Highest simultaneous member count ever observed, sampled every
   * statsSampleInterval ticks — so a spike shorter than that window can be
   * missed. Null only for records restored from a v9 save, where the run's
   * history genuinely predates this field: an unknown peak is shown as
   * unknown rather than backfilled with a fabricated number. */
  peakPopulation: number | null;
  /** The tick the last member died. Null while the species is still alive,
   * and also null for a v9-migrated record that was already extinct with no
   * record of when. Liveness itself is never read from here — it is derived
   * from World.cells, the one source that cannot go stale. */
  extinctTick: number | null;
  /** Last measurements taken while alive. Null while alive (read the living
   * members instead) and for v9-migrated extinct records. */
  finalStats: LineageStats | null;
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
  /** True if *this* individual is the one whose genome was measured to
   * have diverged past the speciation threshold — the edge from its
   * parent is a real speciation event, not an ordinary birth. Set after
   * the fact by World.checkSpeciation (birth is recorded before an
   * individual ever gets the chance to reproduce and trigger the check). */
  isSpeciationEvent: boolean;
  /** True if this individual is the first in its lineage to carry
   * isDna — the real moment heredity transitioned from RNA to DNA (see
   * genome.ts's DNA_TRANSITION_THRESHOLD), not just an ordinary birth
   * into an already-DNA lineage. Computed at the recordBirth call site,
   * where parent and child Genome objects are both already in scope. */
  isDnaTransition: boolean;
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
  avgMotor: number;
  avgPredation: number;
  avgEnergyCapture: number;
  avgSensors: number;
  avgStructure: number;
  avgAge: number;
  maxGeneration: number;
  meatFood: number;
}

/** One row of World.getSpeciesSummaries() — a lineage's identity plus its
 * population figures, for the Species panel. Covers extinct species too, so
 * every numeric field here has to mean something when nobody is left alive:
 * `population` is 0, and the trait figures come from `finalStats` with
 * `statsAreLastRecorded` set so the card can say so instead of presenting a
 * dead species' last sample as a live reading. */
export interface SpeciesSummary {
  lineageId: number;
  name: string;
  hue: number;
  isPlayerDesigned: boolean;
  createdTick: number;
  /** Null while alive; the tick the last member died, or null for a
   * v9-migrated record extinct before this was recorded. */
  extinctTick: number | null;
  /** True when this species has no living members right now. Derived from
   * World.cells rather than from extinctTick, which is null in two different
   * situations (alive, and migrated-unknown) and so cannot carry it. */
  isExtinct: boolean;
  /** Highest simultaneous member count observed. Null means genuinely
   * unknown (a v9-migrated record), not zero. */
  peakPopulation: number | null;
  /** True when the trait figures below are a last-recorded sample of a dead
   * species rather than a live measurement. */
  statsAreLastRecorded: boolean;
  /** Set when this lineage itself emerged via speciation (see
   * World.checkSpeciation) rather than being an original founder. */
  parentLineageId: number | null;
  parentName: string | null;
  population: number;
  maxGeneration: number;
  avgSize: number;
  avgSpeed: number;
  avgSense: number;
  /** The functional class most represented across this lineage's living
   * members' proteins right now — not a fixed trait, just a cheap-to-show
   * summary of what it currently leans toward. */
  dominantClass: CatalysisClass | null;
  /** Average real catalytic power per class, across this lineage's living
   * members — the same classPowerCache each individual already carries
   * (see Genome's own comment), just averaged across the population. This
   * is a real capability profile read off actual folded proteins, not a
   * looked-up archetype — the Species panel's radar chart plots this
   * directly. */
  avgClassPower: Record<CatalysisClass, number>;
}

/** How long the *last* update() call actually took, in milliseconds — the
 * game loop uses this to keep a bounded time budget per animation frame
 * (see main.ts) instead of blindly running a fixed number of ticks
 * regardless of how expensive each one turns out to be. */
export interface PerfSnapshot {
  lastTickMs: number;
}

/** World units per light region. Fixed rather than proportional, so a larger
 * dish gets more niches instead of larger ones.
 *
 * Sized deliberately larger than an organism's reach. The first attempt used
 * 320 — exactly the maximum sense radius — and it starved the dish: a region
 * an organism spans in one step is not a habitat, it is a tile, and a
 * founder cluster sitting in one competed for a single region's ~0.7% of the
 * light while the rest of the dish went unused. A niche has to be big enough
 * for a population to live inside, and for the gradient at its edge to be
 * worth migrating along. */
const LIGHT_REGION_SIZE = 800;

/** A smooth, patchy distribution of light over the dish, normalised to a mean
 * of exactly 1 — the dish's average productivity is unchanged, only its
 * shape, so any change in the ecology is attributable to spatial structure
 * and not to having quietly handed the dish more energy.
 *
 * Built from a handful of overlapping Gaussian sources rather than
 * per-region noise, because per-region noise gives you salt-and-pepper: an
 * organism cannot adapt to a bright cell whose neighbours are dark, since it
 * moves through several of them in a lifetime. Broad overlapping blobs
 * produce regions large enough to actually live in, with gradients between
 * them for a population to spread along. */
function buildLightField(cols: number, rows: number, rng: Rng): Float32Array {
  const field = new Float32Array(cols * rows);
  // Roughly one source per 6 regions, so patchiness holds at any dish size.
  const sourceCount = Math.max(3, Math.round((cols * rows) / 6));
  const sources: { x: number; y: number; amp: number; radius: number }[] = [];
  for (let i = 0; i < sourceCount; i++) {
    sources.push({
      x: rng.range(0, cols),
      y: rng.range(0, rows),
      // Some sources darken rather than brighten, so the dish gets real
      // shade instead of only bright spots on a flat background.
      amp: rng.range(-0.6, 1.4),
      radius: rng.range(1.2, 3.5),
    });
  }
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      let v = 1;
      for (const s of sources) {
        const dx = cx + 0.5 - s.x;
        const dy = cy + 0.5 - s.y;
        v += s.amp * Math.exp(-(dx * dx + dy * dy) / (2 * s.radius * s.radius));
      }
      // A floor rather than zero: a fully dark region would be a dead zone
      // no photosynthesiser could cross, which fragments the dish into
      // unreachable islands rather than merely varied terrain.
      field[cy * cols + cx] = Math.max(0.15, v);
    }
  }
  let total = 0;
  for (const v of field) total += v;
  const mean = total / field.length;
  for (let i = 0; i < field.length; i++) field[i] /= mean;
  return field;
}

export class World {
  readonly width: number;
  readonly height: number;
  rng: Rng; // not readonly — restore() swaps in a state-restored instance

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
  // Not readonly — live-adjustable from the topbar's "Pop cap" input
  // while the right value is still being worked out, rather than a
  // recompile-to-test constant.
  maxPopulation = 320;
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
  // Total light across the whole dish, per tick. Scaled with world area by
  // main.ts, because a bigger dish that receives the same total light is
  // just a sparser dish -- measured: population tracks energy input almost
  // exactly linearly (sunlight 24/96/216/384 -> 189/1049/2137/3843
  // organisms), and is barely affected by the population cap at all. The
  // cap is a ceiling; this is what the dish can actually feed.
  sunlightCapacity = 24;

  // --- the light field -----------------------------------------------------
  // How that total is distributed across the dish, and the reason this round
  // exists. The budget used to be one dish-wide number, which meant every
  // photosynthesiser everywhere competed in a single global pool: the
  // environment was perfectly uniform, so there was nothing for lineages to
  // diverge *into*. Measured symptom -- speciation had stopped firing
  // entirely, 1 lineage over 20,000 ticks on each of three seeds.
  //
  // Now the dish is divided into regions, each with its own share of the
  // light and its own competition. Bright regions support dense
  // photosynthesiser populations; dim ones favour predation; and the two are
  // far enough apart that a lineage adapting to one is not automatically
  // competing with a lineage adapting to the other. That is a niche, and it
  // is the thing the model was missing.
  //
  // Deliberately redistributive rather than additive: the region shares are
  // normalised so the dish-wide total is still exactly sunlightCapacity.
  // Total productivity is unchanged, only its *shape*, so any change in the
  // ecology is attributable to spatial structure and not to having quietly
  // handed the dish more energy.
  // Public so the renderer can draw the field at exactly the resolution the
  // simulation samples it at — showing a smoother field than the sim
  // actually uses would be a prettier lie.
  readonly lightCols: number;
  readonly lightRows: number;
  /** Per-region light intensity, mean exactly 1 across the dish. A region at
   * 1.8 grows a photosynthesiser nearly twice as fast as an average one; a
   * region at 0.3 barely feeds it at all. */
  private lightIntensity: Float32Array;
  // The shared population cap has the same monopolization problem as
  // unlimited sunlight would: whichever lineage has the most individuals
  // wins the most reproduction attempts each tick and structurally starves
  // everyone else of the *room* to reproduce, even if those others are
  // metabolically fine. This is a soft territorial ceiling per lineage —
  // no single one can eat the whole population cap — so a slow-growing
  // predator population isn't crowded out of existing at all by a fast-
  // growing photosynthesizer one.
  readonly maxLineageShare = 0.65;
  // Genetic-distance threshold (see genes.ts's geneticDistance, 0..1-ish
  // scale) past which a diverged individual founds its own species rather
  // than staying counted under its parent lineage. An earlier 0.22 (picked
  // from an offline single-lineage ensemble average — 30 trials/generation
  // count, ~0.13 at 10 generations, ~0.31 at 50) turned out badly wrong at
  // population scale: headless-verified at 126 speciation events in 20k
  // ticks (avg gap 132 ticks) against a capped, continuously-reproducing
  // 320-individual population — an ensemble *average* doesn't see that
  // hundreds of reproduction attempts per tick means even a modest per-
  // individual chance of crossing a low bar fires constantly in aggregate.
  // Recalibrated with a direct population-scale sweep instead (same 320-
  // cap scenario, 20k ticks each): 0.22 -> 126 events/first@3479, 0.28 ->
  // 21/first@15484, 0.32 -> 25/first@10332, 0.36 -> 9/first@16031, avg gap
  // 485. 0.34 sits in that rare-but-reachable band — first event doesn't
  // land until a population's had real sustained generations to drift
  // through, not the first few hundred ticks. Note for future reading:
  // this will still show recurring events in a long enough run even at a
  // high threshold — a promoted lineage's reference resets to 0 distance,
  // and geneticDistance itself saturates (doesn't grow unboundedly), so
  // *any* threshold below the saturation ceiling is eventually crossed by
  // a deep-enough lineage again. That's an inherent property of a bounded-
  // metric random walk with reference-reset, not a bug — the tuning
  // question is the steady-state cadence, not eliminating recurrence.
  //
  // 0.34 -> 0.14, because 0.34 turned out to be UNREACHABLE. That earlier
  // sweep measured how often speciation fired at various thresholds; what
  // it never measured is how far a population can actually drift, and the
  // answer is: not that far. Distance from a lineage's reference sequence
  // saturates — measured 0.208 / 0.244 / 0.253 / 0.266 at 2k / 5k / 10k /
  // 15k ticks, still climbing but plainly asymptotic well under 0.34. A
  // threshold above the saturation point does not fire rarely, it cannot
  // fire at all, and the dish had been running as a single species for
  // 20,000 ticks at a stretch.
  //
  // This file already noted that geneticDistance saturates rather than
  // growing unboundedly. The mistake was not noticing that this puts a
  // hard ceiling on what any threshold can mean.
  readonly speciationThreshold = 0.14;
  // How far two genomes may diverge and still interbreed. This replaced a
  // flat `b.lineageId !== a.lineageId` test, which made reproductive
  // isolation an administrative fact rather than a biological one: two
  // individuals were incapable of breeding because a bookkeeping integer
  // differed, no matter how similar their genomes actually were. Worse, in
  // combination with the old ordering of checkSpeciation it made speciation
  // *sterilising* — an individual promoted to a new lineage found itself
  // the sole member of its species, unable to breed with the siblings it
  // was genetically all but identical to.
  //
  // Deliberately NOT hard-wired to speciationThreshold. They measure
  // different things — speciation compares an individual against its
  // lineage's fixed reference sequence, this compares two living
  // individuals against each other — and the metric's protein term
  // normalises by a pair-dependent maxTotal (genes.ts), so no bound
  // relating the two follows from the one holding.
  //
  // 0.34 -> 0.10, and this was the worse half of the same mistake. Pairwise
  // divergence never approaches 0.34 either, so NO PAIR WAS EVER
  // INCOMPATIBLE and the whole emergent-isolation mechanism was inert from
  // the day it was written: every individual could breed with every other,
  // and unrestricted gene flow is precisely what prevents divergence. The
  // rule was right and the constant made it a no-op.
  //
  // Swept at 0.34 / 0.20 / 0.15 / 0.10 against both a flat and a patchy
  // light field (table in NOTES.md). Effective species at 20,000 ticks over
  // 5 seeds: 1.0 at 0.34, 2.3 at 0.20, 6.7 at 0.10. Checked specifically
  // that a threshold this tight does not simply break sexual reproduction
  // into clonal fragments — the sexual fraction is unchanged (9.4% vs 10%
  // at 0.20), and where sex dominates a dish it still works.
  readonly mateCompatibilityThreshold = 0.10;
  // What recombination buys: sexual offspring take point mutations (and
  // brain-weight mutations) at this fraction of the asexual rate. Without
  // it, a sexual child paid the full asexual mutational load *on top of*
  // crossover — both costs, neither benefit — which is not the trade real
  // biology makes. Composes with the DNA ratchet's own multiplier rather
  // than overriding it; see mutateGenome. SWEPT — NOTES.md carries the
  // table, including the arms that failed.
  readonly sexualPointMutationMultiplier = 0.7;
  // Below this population, a newborn gets real per-tick internal
  // chemistry (Virtunism.runInternalChemistry — stochastic expression
  // noise, not a frozen fold-derived constant); at or above it, a
  // newborn gets the cheap, deterministic, already-verified-at-scale
  // formulas instead. Decided once, at birth, from the population at
  // that moment — not re-evaluated later, so individuals born early keep
  // richMode for their whole life even after the population grows past
  // this line (see Virtunism.richMode's own doc comment). First-pass
  // number, not yet swept the way e.g. speciationThreshold was — chosen
  // so the rich phase covers genuine early-founder-population scale
  // without ever approaching maxPopulation, where the per-tick cost of
  // richMode individuals would start to matter. See NOTES.md.
  readonly richChemistryPopulationThreshold = 60;
  readonly predationSizeRatio = 0.88; // prey must be <= predator.size * this
  // See resolveCrowding()'s own comment for the full mechanism. Kept
  // under 1 deliberately: resolving the full overlap in one tick risks a
  // pair pushing straight through each other and swapping sides
  // (oscillation) when several units are mutually overlapping at once;
  // 0.5 still visibly thins a crowd within a handful of ticks.
  readonly separationStrength = 0.5;
  readonly statsSampleInterval = 10;
  readonly maxHistory = 400;

  // Grid cell sizes: virtunismGrid is sized for the typical sensing range
  // (a few hundred units); carrionGrid is much finer since eating/
  // predation contact is a short-range check. Both are rebuilt fresh each
  // tick (or twice, for virtunisms — see update()) rather than maintained
  // incrementally.
  // Constructed in the constructor rather than inline, because the grid is
  // now bounds-aware (see grid.ts) and a field initializer runs before
  // `width`/`height` are assigned.
  private readonly virtunismGrid: SpatialGrid<Virtunism>;
  private readonly carrionGrid: SpatialGrid<Food>;
  // Reused query buffers. SpatialGrid.queryRadius fills whatever array it is
  // handed and allocates a fresh one otherwise, so at ~200 cells x 2 queries
  // a tick the default was throwing away 400 arrays a tick for no reason.
  // One buffer per call site rather than one shared, so no two live query
  // results can ever alias each other.
  private readonly senseScratch: Virtunism[] = [];
  private readonly carrionScratch: Food[] = [];
  private readonly crowdScratch: Virtunism[] = [];
  private readonly eatScratch: Food[] = [];
  private readonly predateScratch: Virtunism[] = [];
  private readonly mateScratch: Virtunism[] = [];
  /** The living subset, rebuilt in place three times a tick. Was
   * `this.cells.filter(...)` at each of those points, i.e. three throwaway
   * arrays per tick that grow with the population. */
  private readonly liveScratch: Virtunism[] = [];

  private nextLineageId = 1;

  constructor(width: number, height: number, seed: number) {
    this.width = width;
    this.height = height;
    this.rng = new Rng(seed);
    this.virtunismGrid = new SpatialGrid<Virtunism>(110, width, height);
    this.carrionGrid = new SpatialGrid<Food>(50, width, height);
    // Region size is fixed in world units rather than as a fraction of the
    // dish, so a bigger world gets *more* niches rather than bigger ones —
    // which is the point of making it bigger.
    this.lightCols = Math.max(1, Math.round(width / LIGHT_REGION_SIZE));
    this.lightRows = Math.max(1, Math.round(height / LIGHT_REGION_SIZE));
    // Built from its own Rng, not `this.rng`. Drawing from the simulation's
    // stream here would shift every later draw and silently change the
    // trajectory of every existing seed — this way the light field varies
    // with the seed while leaving the rest of the sim's randomness exactly
    // where it was.
    this.lightIntensity = buildLightField(this.lightCols, this.lightRows, new Rng(seed ^ 0x9e3779b9));
  }

  /**
   * There is no hand-designed starter species anymore — no hard-coded
   * loadout catalog to build one from. A dish starts genuinely empty:
   * life enters either by actually evolving out of the primordial pool
   * (see chem/bridge.ts + main.ts's autoBootstrap), or via the Designer
   * tab's random-seed release (a fresh randomGeneSequence, not a
   * hand-picked body plan — see main.ts). Nothing here stops a lineage
   * from drifting toward bigger and more predatory, or more armored, or
   * anything else evolution and selection actually find — there's no
   * fixed "species" concept to prevent it, and now there's no fixed
   * starting point to anchor it either.
   */

  /** Releases a new population founded directly from an already-real gene
   * sequence, skipping the loadout->buildOrganelles->encode round trip —
   * the bootstrap path (see chem/bridge.ts), where a founder's genes are
   * built from its ancestral protocell's own surviving RNA content rather
   * than a hand-designed phenotype. Returns the new lineage id. */
  addSpeciesFromSequence(
    sequence: GeneSequence,
    count: number,
    opts: { name?: string; isPlayerDesigned?: boolean; spread?: boolean; spawnCenter?: { x: number; y: number } } = {},
  ): number {
    const lineageId = this.nextLineageId++;
    const traits = decodeCoreTraits(sequence);
    this.lineages.set(lineageId, {
      id: lineageId,
      name: opts.name ?? generateSpeciesName(sequence),
      hue: traits.hue,
      isPlayerDesigned: !!opts.isPlayerDesigned,
      createdTick: this.tick,
      referenceSequence: sequence,
      parentLineageId: null,
      // Set to the real founder count once the spawn loop below knows it (the
      // loop stops early at the population cap, so `count` is a request, not
      // an outcome). Seeded at all because sampleLineages only runs on the
      // stats cadence: a lineage founded and wiped out inside one interval
      // would otherwise report a peak of 0 despite provably having had
      // members.
      peakPopulation: 0,
      extinctTick: null,
      finalStats: null,
    });

    const clusterX = opts.spawnCenter?.x ?? this.rng.range(this.width * 0.2, this.width * 0.8);
    const clusterY = opts.spawnCenter?.y ?? this.rng.range(this.height * 0.2, this.height * 0.8);

    let founded = 0;
    for (let i = 0; i < count; i++) {
      if (this.cells.length >= this.maxPopulation) break;
      // The founding sequence itself becomes the first founder unchanged;
      // the rest each get one real mutation off it — the same starting-
      // variation role addSpecies's per-field jitter plays, just expressed
      // as an actual heritable mutation instead of a continuous nudge.
      const founderSequence = i === 0 ? sequence : mutateGeneSequence(sequence, this.rng);
      const genome = genomeFromSequence(founderSequence, NeuralNet.random(BRAIN_TOPOLOGY, this.rng));
      const x = opts.spread
        ? this.rng.range(20, this.width - 20)
        : clamp(clusterX + this.rng.gaussian(0, 90), 20, this.width - 20);
      const y = opts.spread
        ? this.rng.range(20, this.height - 20)
        : clamp(clusterY + this.rng.gaussian(0, 90), 20, this.height - 20);
      const startEnergy = 12 * genome.size;
      const richMode = this.cells.length < this.richChemistryPopulationThreshold;
      const founder = new Virtunism(genome, x, y, lineageId, 0, startEnergy, this.rng, !!opts.isPlayerDesigned, richMode);
      this.cells.push(founder);
      // No parent to compare against for a root — a founder that happens
      // to start above DNA_TRANSITION_THRESHOLD (rare, but possible via
      // ensureEnergyCapable's search or a hand-designed genome) is itself
      // the transition event for its lineage.
      this.recordBirth(founder, null, null, genome.isDna);
      founded++;
    }
    const info = this.lineages.get(lineageId);
    if (info) info.peakPopulation = founded;
    return lineageId;
  }

  /** Registers a new individual as a tree-of-life node and links it under
   * its parent(s), propagating the +1 live-count up to the root so every
   * ancestor knows it still has a living descendant. `parentId: null`
   * marks a root (a founder released via addSpeciesFromSequence).
   * `isDnaTransition` is computed by the caller, which already has the
   * real parent/child Genome objects in scope — true only when this
   * individual is the first in its lineage to carry isDna, not on every
   * ordinary birth into an already-DNA lineage. */
  private recordBirth(child: Virtunism, parentId: number | null, secondParentId: number | null, isDnaTransition: boolean): void {
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
      isSpeciationEvent: false,
      isDnaTransition,
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

  /** Measures a cell's genome against its lineage's reference sequence and,
   * if it's drifted past `speciationThreshold`, promotes it to found a
   * brand-new species right there rather than staying counted under its
   * parent lineage. Called just before an individual actually reproduces
   * (not at birth) — a one-off mutant that never manages to pass anything
   * on shouldn't get to register as a "species" that immediately goes
   * extinct with it; only a genome that's about to prove itself by
   * reproducing gets to found one. */
  private checkSpeciation(cell: Virtunism): void {
    const lineage = this.lineages.get(cell.lineageId);
    if (!lineage) return; // defensive — every live cell's lineage should exist
    // Unreachable by construction: a sequence is only shed once a lineage has
    // no living members, and this cell is one. Guarded rather than asserted
    // because the alternative is a crash inside the reproduction loop.
    if (lineage.referenceSequence === null) return;
    const distance = geneticDistance(cell.genome.sequence, lineage.referenceSequence);
    if (distance < this.speciationThreshold) return;

    const newLineageId = this.nextLineageId++;
    this.lineages.set(newLineageId, {
      id: newLineageId,
      name: generateSpeciesName(cell.genome.sequence),
      hue: cell.genome.hue,
      isPlayerDesigned: false,
      createdTick: this.tick,
      referenceSequence: cell.genome.sequence,
      parentLineageId: cell.lineageId,
      // Exactly one member at the instant of divergence — the cell being
      // promoted. Everything after this is sampleLineages' job.
      peakPopulation: 1,
      extinctTick: null,
      finalStats: null,
    });
    cell.lineageId = newLineageId;

    const node = this.treeNodes.get(cell.id);
    if (node) {
      node.lineageId = newLineageId;
      node.isSpeciationEvent = true;
      node.hue = cell.genome.hue;
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
    this.virtunismGrid.rebuild(this.liveCells());
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

    // Rebuild so resolveCrowding() below queries this tick's actual
    // post-movement positions, not the pre-movement snapshot from the top
    // of this method.
    this.virtunismGrid.rebuild(this.liveCells());
    this.resolveCrowding();

    for (const cell of this.cells) {
      if (cell.alive) {
        cell.runInternalChemistry(dt, this.rng); // no-op for cheap-mode cells
        cell.metabolize(dt);
      }
    }
    this.applyPhotosynthesis(dt);

    // Rebuild with post-separation positions for contact-driven systems.
    this.virtunismGrid.rebuild(this.liveCells());

    this.handleEating();
    this.handlePredation();
    this.diffuseColonyEnergy(dt);
    this.handleReproduction();
    this.cleanupDead();

    this.tick += dt;
    if (Math.floor(this.tick) % this.statsSampleInterval === 0) {
      this.pushStatsSnapshot();
      this.sampleLineages();
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
    let sumMotor = 0;
    let sumPredation = 0;
    let sumEnergyCapture = 0;
    let sumSensors = 0;
    let sumStructure = 0;
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
      for (const p of c.genome.proteins) {
        const strength = p.fold.catalysisStrength;
        if (p.fold.catalysisClass === 'motor') sumMotor += strength;
        else if (p.fold.catalysisClass === 'protease') sumPredation += strength;
        else if (p.fold.catalysisClass === 'peptidyl') sumEnergyCapture += strength;
        else if (p.fold.catalysisClass === 'photoreceptor') sumSensors += 1;
        else if (p.fold.catalysisClass === 'lipidsynthase') sumStructure += strength;
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
      avgMotor: sumMotor / n,
      avgPredation: sumPredation / n,
      avgEnergyCapture: sumEnergyCapture / n,
      avgSensors: sumSensors / n,
      avgStructure: sumStructure / n,
      avgAge: sumAge / n,
      maxGeneration,
      meatFood: this.meatFood.length,
    };
  }

  private pushStatsSnapshot(): void {
    this.history.push(this.getLiveStats());
    if (this.history.length > this.maxHistory) this.history.shift();
  }

  /** Per-lineage aggregation over the living population, in one pass — the
   * shared kernel behind both sampleLineages() (which persists it as life
   * history) and getSpeciesSummaries() (which renders it). Deliberately one
   * function rather than two similar loops: they must agree about what a
   * species' figures *are*, or a card would contradict the extinction
   * snapshot taken from the same population moments earlier. */
  private accumulateByLineage(): Map<number, LineageStats & { population: number }> {
    interface Acc {
      population: number;
      maxGeneration: number;
      sumSize: number;
      sumSpeed: number;
      sumSense: number;
      classCounts: Partial<Record<CatalysisClass, number>>;
      sumClassPower: Record<CatalysisClass, number>;
    }
    const zeroClassPower = (): Record<CatalysisClass, number> => {
      const r = {} as Record<CatalysisClass, number>;
      for (const cls of CATALYSIS_CLASSES) r[cls] = 0;
      return r;
    };
    const acc = new Map<number, Acc>();
    for (const c of this.cells) {
      let a = acc.get(c.lineageId);
      if (!a) {
        a = { population: 0, maxGeneration: 0, sumSize: 0, sumSpeed: 0, sumSense: 0, classCounts: {}, sumClassPower: zeroClassPower() };
        acc.set(c.lineageId, a);
      }
      a.population++;
      a.sumSize += c.genome.size;
      a.sumSpeed += deriveMaxSpeed(c.genome);
      a.sumSense += c.genome.senseRadius;
      if (c.generation > a.maxGeneration) a.maxGeneration = c.generation;
      for (const p of c.genome.proteins) {
        const cls = p.fold.catalysisClass;
        if (cls === null) continue;
        a.classCounts[cls] = (a.classCounts[cls] ?? 0) + 1;
      }
      for (const cls of CATALYSIS_CLASSES) a.sumClassPower[cls] += c.genome.classPowerCache[cls];
    }

    const out = new Map<number, LineageStats & { population: number }>();
    for (const [lineageId, a] of acc) {
      let dominant: CatalysisClass | null = null;
      let dominantCount = 0;
      for (const cls in a.classCounts) {
        const count = a.classCounts[cls as CatalysisClass]!;
        if (count > dominantCount) {
          dominant = cls as CatalysisClass;
          dominantCount = count;
        }
      }
      out.set(lineageId, {
        population: a.population,
        maxGeneration: a.maxGeneration,
        avgSize: a.sumSize / a.population,
        avgSpeed: a.sumSpeed / a.population,
        avgSense: a.sumSense / a.population,
        dominantClass: dominant,
        avgClassPower: Object.fromEntries(CATALYSIS_CLASSES.map((cls) => [cls, a.sumClassPower[cls] / a.population])) as Record<
          CatalysisClass,
          number
        >,
      });
    }
    return out;
  }

  /** Advances every lineage's life history: peak population, a refreshed
   * last-known stats snapshot, and — for any species whose final member has
   * just died — an extinction stamp and the release of its now-unreachable
   * reference sequence (see LineageInfo.referenceSequence).
   *
   * Runs on the statsSampleInterval cadence from update(), independent of
   * which tab is showing: extinction is a fact about the world, not about
   * what the player happens to be looking at, and a species that died while
   * the Ecosystem tab was open must still be recorded. */
  private sampleLineages(): void {
    const live = this.accumulateByLineage();
    for (const info of this.lineages.values()) {
      const stats = live.get(info.id);
      if (stats) {
        if (info.peakPopulation === null || stats.population > info.peakPopulation) {
          info.peakPopulation = stats.population;
        }
        // Kept fresh every sample so the snapshot left behind at extinction
        // is the last real measurement, not the founding moment.
        //
        // Rounded on the way in, and that is a storage decision with teeth:
        // this snapshot is kept forever for every species that ever lived, and
        // a raw double serializes as ~17 characters against 5 for three
        // decimal places. Nine floats per record, hundreds of records per run.
        // Three decimals is far finer than a radar chart or a stat line can
        // show, so nothing legible is lost. Live figures are never rounded —
        // only this permanent copy.
        info.finalStats = {
          maxGeneration: stats.maxGeneration,
          avgSize: round3(stats.avgSize),
          avgSpeed: round3(stats.avgSpeed),
          avgSense: round3(stats.avgSense),
          dominantClass: stats.dominantClass,
          avgClassPower: Object.fromEntries(
            CATALYSIS_CLASSES.map((cls) => [cls, round3(stats.avgClassPower[cls])]),
          ) as Record<CatalysisClass, number>,
        };
        // A lineage cannot come back from extinction (see
        // LineageInfo.referenceSequence), so this branch never un-stamps a
        // previously extinct record — it only ever runs for the living.
        continue;
      }
      if (info.extinctTick === null && info.referenceSequence !== null) {
        info.extinctTick = Math.floor(this.tick);
        info.referenceSequence = null;
      }
    }
  }

  /** One entry per species, for the Species panel. Living lineages carry
   * live measurements; extinct ones carry their final recorded sample,
   * flagged so the card can label it rather than pass it off as current.
   *
   * Not sampled/cached: the same O(population) cost as getLiveStats(), and
   * callers already throttle how often they call it. */
  getSpeciesSummaries(includeExtinct: boolean): SpeciesSummary[] {
    const live = this.accumulateByLineage();
    const result: SpeciesSummary[] = [];
    for (const info of this.lineages.values()) {
      const stats = live.get(info.id);
      if (!stats && !includeExtinct) continue;
      // An extinct species with no snapshot at all is a v9-migrated record:
      // it still gets a row (it really existed, and its place in the tree is
      // real), just with nothing to say about its traits.
      const shown = stats ?? info.finalStats;
      const parent = info.parentLineageId !== null ? this.lineages.get(info.parentLineageId) : undefined;
      result.push({
        lineageId: info.id,
        name: info.name,
        hue: info.hue,
        isPlayerDesigned: info.isPlayerDesigned,
        createdTick: info.createdTick,
        extinctTick: info.extinctTick,
        isExtinct: !stats,
        peakPopulation: info.peakPopulation,
        statsAreLastRecorded: !stats,
        parentLineageId: info.parentLineageId,
        parentName: parent?.name ?? null,
        population: stats?.population ?? 0,
        maxGeneration: shown?.maxGeneration ?? 0,
        avgSize: shown?.avgSize ?? 0,
        avgSpeed: shown?.avgSpeed ?? 0,
        avgSense: shown?.avgSense ?? 0,
        dominantClass: shown?.dominantClass ?? null,
        avgClassPower: shown?.avgClassPower ?? ({} as Record<CatalysisClass, number>),
      });
    }
    // Living first and biggest-first within that, so the panel's ordering
    // still leads with what is actually in the dish.
    result.sort((x, y) => y.population - x.population || x.createdTick - y.createdTick);
    return result;
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
   * narrow always-on "chemoreception" cone plus the union of whatever
   * photoreceptor-class proteins it's grown, each mounted at its own
   * gene-encoded angle relative to its heading with a width set by that
   * protein's real fold-derived catalytic strength. */
  private inFOV(cell: Virtunism, tx: number, ty: number): boolean {
    const angleToTarget = Math.atan2(ty - cell.y, tx - cell.x);
    const within = (mountAngle: number, halfWidth: number): boolean => {
      let diff = angleToTarget - (cell.heading + mountAngle);
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      return Math.abs(diff) <= halfWidth;
    };
    const baselineHalf = ((50 * Math.PI) / 180) * 0.5;
    if (within(0, baselineHalf)) return true;
    for (const p of cell.genome.proteins) {
      if (p.fold.catalysisClass !== 'photoreceptor') continue;
      const halfWidth = (((50 + p.fold.catalysisStrength * 40) * Math.PI) / 180) * 0.5;
      if (within(p.angle, halfWidth)) return true;
    }
    return false;
  }

  /** How far a predator's mouth investment stretches its max-prey-size
   * threshold — a bigger mouth can tackle relatively bigger prey. */
  private predatorReach(predator: Virtunism): number {
    return clamp(0.7 + derivePredationPower(predator.genome) * 0.15, 0.7, 1.4);
  }

  /** Builds the fixed sensor vector consumed by Virtunism/NeuralNet (see
   * BRAIN_TOPOLOGY.inputs). A mouthed virtunism's only food sources are
   * carrion and other virtunisms (predation) — there's no ambient food
   * resource, so "prey" covers everything from a photosynthesizer smaller
   * than you to a fresh corpse. Candidates come from the spatial grid
   * (only nearby buckets), not the whole population. */
  /** The living cells, into a buffer this class owns. SpatialGrid.rebuild
   * copies what it is given (see grid.ts on why), so handing it a reused
   * array is safe. */
  private liveCells(): readonly Virtunism[] {
    const out = this.liveScratch;
    out.length = 0;
    for (const c of this.cells) if (c.alive) out.push(c);
    return out;
  }

  private buildInputs(cell: Virtunism): number[] {
    const sr = cell.genome.senseRadius;
    const sr2 = sr * sr;
    const canEat = cell.canEat;

    let foodDx = 0;
    let foodDy = 0;
    let foodDist = 1;
    let bestFood2 = sr2;

    if (canEat) {
      const nearbyCarrion = this.carrionGrid.queryRadius(cell.x, cell.y, sr, this.carrionScratch);
      for (const f of nearbyCarrion) {
        const dx = f.x - cell.x;
        const dy = f.y - cell.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestFood2 && this.inFOV(cell, f.x, f.y)) {
          bestFood2 = d2;
          foodDx = dx / sr;
          foodDy = dy / sr;
          foodDist = Math.sqrt(d2) / sr;
        }
      }
    }

    let threatDx = 0;
    let threatDy = 0;
    let threatDist = 1;
    let bestThreat2 = sr2;
    let mateDx = 0;
    let mateDy = 0;
    let mateDist = 1;
    let bestMate2 = sr2;
    const wantsMate = cell.genome.reproductionMode === 'sexual';
    const preyReach = cell.genome.size * this.predationSizeRatio * this.predatorReach(cell);

    // ONE query, three senses. This used to run queryRadius over the
    // virtunism grid twice with identical arguments — once looking for prey
    // and once for threats and mates — and buildInputs was 67% of the whole
    // tick. The three accumulators are independent maxima over the same
    // ordered candidate list, so folding them into a single pass is exactly
    // equivalent, not an approximation.
    //
    // Distances are compared squared and only square-rooted when a
    // candidate actually wins, which is a handful of times per cell rather
    // than once per neighbour. Math.hypot in particular is not a cheap
    // sqrt: it carries overflow/underflow guarding this code does not need.
    const nearby = this.virtunismGrid.queryRadius(cell.x, cell.y, sr, this.senseScratch);
    for (const other of nearby) {
      if (other === cell || !other.alive) continue;
      const dx = other.x - cell.x;
      const dy = other.y - cell.y;
      const d2 = dx * dx + dy * dy;

      if (canEat && d2 < bestFood2 && other.effectiveDefenseSize < preyReach && this.inFOV(cell, other.x, other.y)) {
        bestFood2 = d2;
        foodDx = dx / sr;
        foodDy = dy / sr;
        foodDist = Math.sqrt(d2) / sr;
      }

      if (
        d2 < bestThreat2 &&
        other.canEat &&
        cell.effectiveDefenseSize < other.genome.size * this.predationSizeRatio * this.predatorReach(other) &&
        this.inFOV(cell, other.x, other.y)
      ) {
        bestThreat2 = d2;
        threatDx = dx / sr;
        threatDy = dy / sr;
        threatDist = Math.sqrt(d2) / sr;
      }

      // The mate-seeking sense has to agree with the rule that actually
      // decides matings, or the brain spends its life steering toward
      // partners it cannot breed with. This used to test lineage equality,
      // matching handleReproduction's old lineage gate; now that mating is
      // decided by real divergence, so is this. genomeDistance last, for the
      // same reason as there — it is the expensive test, and it only runs on
      // a candidate that has already passed everything cheaper.
      if (
        wantsMate &&
        d2 < bestMate2 &&
        other.genome.reproductionMode === 'sexual' &&
        other.canMate() &&
        this.inFOV(cell, other.x, other.y) &&
        genomeDistance(cell.genome, other.genome) <= this.mateCompatibilityThreshold
      ) {
        bestMate2 = d2;
        mateDx = dx / sr;
        mateDy = dy / sr;
        mateDist = Math.sqrt(d2) / sr;
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
      const power = deriveMotorPower(m.genome);
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

    this.cascadeColonyPositions(root);
  }

  /** Repositions every bonded descendant from `root`'s current position —
   * the rigid-body half of colony movement, shared by moveColonyRigid()
   * (after the root's own thrust/heading integration) and
   * resolveCrowding() (after a separation nudge to the root) so both
   * callers reposition children from exactly the same fixed
   * parent-relative joints, never independently. */
  private cascadeColonyPositions(root: Virtunism): void {
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

  /** Soft separation: nothing in this sim has ever pushed two overlapping
   * virtunisms apart (only the outer world walls are clamped against), so
   * a favorable spot with nothing else limiting density can accumulate a
   * crowd stacked far past what the space actually holds. A colony must
   * move as one rigid unit, never deform — its members' positions are
   * fixed parent-relative joints (cascadeColonyPositions()), not
   * independently movable — so this resolves overlap once per *unit*
   * (a solo virtunism, or an entire bonded colony via its root), not per
   * member: every member's overlap against anything *outside* its own
   * unit contributes to one shared push, averaged across the unit's
   * member count (so a large colony doesn't get an outsized net shove
   * just because it has more members individually detecting overlap),
   * applied to the root, then cascaded down exactly like ordinary
   * movement. Resolves only half the measured overlap per tick — under
   * 1.0 guarantees a pair can never push straight through each other and
   * swap sides (no oscillation), while still visibly thinning a crowd
   * within a handful of ticks rather than snapping positions instantly. */
  private resolveCrowding(): void {
    for (const root of this.cells) {
      if (!root.alive || root.attachedTo !== null) continue;
      const members = this.collectColonyMembers(root);

      let pushX = 0;
      let pushY = 0;
      for (const m of members) {
        const nearby = this.virtunismGrid.queryRadius(m.x, m.y, m.radius + 40, this.crowdScratch);
        for (const o of nearby) {
          if (!o.alive || o === m) continue;
          // Same unit -- bonded, not repelling. A solo cell IS its own root,
          // so for the overwhelming majority of candidates this is an
          // identity check and the chain walk can be skipped outright.
          // Exactly equivalent, and findColonyRoot was showing up at
          // ~2.4us/organism purely from being called once per candidate.
          if (o.attachedTo === null ? o === root : this.findColonyRoot(o) === root) continue;
          const dist = Math.hypot(o.x - m.x, o.y - m.y);
          if (dist <= 0) continue; // exact-coincident pair -- vanishingly rare, self-resolves once anything else nudges either one
          const overlap = m.radius + o.radius - dist;
          if (overlap <= 0) continue;
          pushX += ((m.x - o.x) / dist) * overlap;
          pushY += ((m.y - o.y) / dist) * overlap;
        }
      }
      if (pushX === 0 && pushY === 0) continue;

      root.x += (pushX / members.length) * this.separationStrength;
      root.y += (pushY / members.length) * this.separationStrength;
      this.cascadeColonyPositions(root);
      root.clampToBounds(this.width, this.height, false);
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
      const wanted = (parent.energy - cell.energy) * rate * dt;
      // Capped by the *receiver's* remaining headroom, in whichever
      // direction the flow runs. This was an unclamped `+=` on both sides,
      // which meant a colony could push a small-genomed member above its
      // own maxEnergy and park it there — the same free ride the
      // photosynthesis clamp closes, arriving through a different pipe.
      // The cap is applied to `wanted` before either side is touched so
      // the transfer stays exactly conserved: whatever the receiver is
      // allowed to take is precisely what the donor gives up.
      const headroom = wanted > 0 ? cell.maxEnergy - cell.energy : parent.maxEnergy - parent.energy;
      const transfer = Math.sign(wanted) * Math.min(Math.abs(wanted), Math.max(0, headroom));
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
  /** Which light region a point falls in. */
  private regionOf(x: number, y: number): number {
    const cx = Math.min(this.lightCols - 1, Math.max(0, Math.floor((x / this.width) * this.lightCols)));
    const cy = Math.min(this.lightRows - 1, Math.max(0, Math.floor((y / this.height) * this.lightRows)));
    return cy * this.lightCols + cx;
  }

  /** How brightly a point is lit, relative to an evenly-lit dish (1.0 =
   * average). Exposed for the renderer, which shades the dish so the player
   * can see the terrain their organisms are adapting to — an invisible niche
   * structure would be indistinguishable from noise. */
  lightAt(x: number, y: number): number {
    return this.lightIntensity[this.regionOf(x, y)];
  }

  /** Grants photosynthesis income, throttled by a dish-wide sunlight budget
   * shared across every chloroplast-bearing virtunism, and *scaled by where
   * each one is standing*.
   *
   * The dish-wide budget is deliberately kept. It is what gives
   * photosynthesisers a carrying capacity at all — without it they simply
   * grow to fill the population cap and leave predators no room — and an
   * earlier attempt at this replaced it with per-region budgets, which was
   * worse in a way worth recording: light falling on a region nobody is
   * standing in is *wasted*, so a clustered population effectively lost most
   * of the dish's productivity, phototrophs died out, and the dish collapsed
   * to a predators-and-carrion economy where extra sunlight bought nothing.
   *
   * Modulating intensity instead keeps every photon in play while still
   * making place matter: demand is weighted by local light, so standing in a
   * bright patch earns more AND draws more of the shared budget. With a flat
   * field this reduces exactly to the old global behaviour, which is what
   * makes it testable. */
  private applyPhotosynthesis(dt: number): void {
    let weightedDemand = 0;
    for (const cell of this.cells) {
      if (!cell.alive) continue;
      const d = cell.baseSunlightDemand;
      if (d > 0) weightedDemand += d * this.lightIntensity[this.regionOf(cell.x, cell.y)];
    }
    if (weightedDemand <= 0) return;
    const availability = Math.min(1, this.sunlightCapacity / weightedDemand);
    for (const cell of this.cells) {
      if (!cell.alive || cell.baseSunlightDemand <= 0) continue;
      cell.photosynthesize(dt, availability * this.lightIntensity[this.regionOf(cell.x, cell.y)]);
    }
  }

  /** Carrion is the only discrete food item in the dish — everything else
   * a mouthed virtunism eats, it has to catch alive (see handlePredation). */
  private handleEating(): void {
    for (const cell of this.cells) {
      if (!cell.alive || !cell.canEat) continue;
      const reach = cell.radius + (derivePredationPower(cell.genome) - 1) * 4;
      const yieldMult = cell.biteYield;
      const nearbyCarrion = this.carrionGrid.queryRadius(cell.x, cell.y, reach + 10, this.eatScratch);
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
      const reach = predator.radius + 6 + (derivePredationPower(predator.genome) - 1) * 4;
      const nearby = this.virtunismGrid.queryRadius(predator.x, predator.y, reach + 30, this.predateScratch);
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
          const mitigation = deriveStructureMitigation(prey.genome);
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
    // Same birth-time rule as addSpeciesFromSequence: decided once, off
    // the population size at the moment of birth (existing cells plus
    // whatever's already been born this tick), never re-evaluated later.
    const richModeNow = (): boolean => this.cells.length + newborns.length < this.richChemistryPopulationThreshold;

    const lineageCounts = new Map<number, number>();
    for (const c of this.cells) lineageCounts.set(c.lineageId, (lineageCounts.get(c.lineageId) ?? 0) + 1);
    const lineageCap = this.maxPopulation * this.maxLineageShare;
    const roomFor = (lineageId: number): boolean => (lineageCounts.get(lineageId) ?? 0) < lineageCap;
    const grow = (lineageId: number): void => {
      lineageCounts.set(lineageId, (lineageCounts.get(lineageId) ?? 0) + 1);
    };

    // Sexual pairing: two mating-ready, *genetically compatible* virtunisms
    // produce one crossed-over child once they're within sensing range of
    // each other — always ejected as a free virtunism (sexual reproduction
    // is the "spread to a new lineage" path). The pairing is anisogamous:
    // one of the two funds the offspring at full asexual cost and the other
    // contributes gametes, so a sexual birth consumes two adults' cooldowns
    // to produce the one child an asexual birth produces from one. That is
    // the twofold cost of sex, and it arises from the mechanism rather than
    // from a penalty constant.
    for (const a of this.cells) {
      if (this.cells.length + newborns.length >= this.maxPopulation) break;
      if (mated.has(a.id) || !a.canMate() || !roomFor(a.lineageId)) continue;
      const meetRange = a.genome.senseRadius;
      const candidates = this.virtunismGrid.queryRadius(a.x, a.y, meetRange, this.mateScratch);
      for (const b of candidates) {
        // Ordered cheapest test first, deliberately. The compatibility test
        // is the most expensive thing in this loop and it sits last, so it
        // only ever runs on a pair that has already cleared readiness,
        // range and field of view — a few per tick rather than
        // O(cells x candidates).
        if (b === a || mated.has(b.id) || !b.canMate()) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const range = Math.max(a.genome.senseRadius, b.genome.senseRadius);
        if (dx * dx + dy * dy >= range * range) continue;
        if (!this.inFOV(a, b.x, b.y) && !this.inFOV(b, a.x, a.y)) continue;
        if (genomeDistance(a.genome, b.genome) > this.mateCompatibilityThreshold) continue;

        // Captured before checkSpeciation runs below, and used for both the
        // child's lineage and the population cap. `roomFor` above was tested
        // against this same pre-speciation id, so growing a *different*
        // (post-speciation) counter would leave the two permanently
        // disagreeing about how full a lineage is.
        // Role assignment. Both partners have already cleared the one
        // shared reproduction bar (canMate), so both could have funded a
        // child; the coin decides which actually does. That is what makes
        // a mating consume two would-be parents to produce the single
        // offspring one of them would have produced alone.
        //
        // Neither "whoever is `a`" nor "whoever has more energy" would do.
        // `this.cells` is birth-ordered and the spatial grid preserves
        // insertion order, so the outer-loop individual is systematically
        // the *oldest* eligible one in the dish: making it pay would tax age
        // rather than sex. Picking by energy instead ties the investment to
        // whoever is currently fittest, which is defensible biology
        // (condition-dependent sex allocation) but confounds the mutation-
        // rate sweep by correlating the cost with fitness. A coin between
        // qualified candidates keeps the cost of sex measuring the cost of
        // sex. A heritable mating type is the principled long-term answer
        // and is a much larger change — it needs a sixth core locus, which
        // shifts every LOCUS index, changes what every existing gene
        // sequence means, and (since geneticDistance divides its core term
        // by CORE_GENE_COUNT) would invalidate the swept speciationThreshold
        // and force a save-format bump. Separate project; noted in NOTES.md
        // so it isn't quietly re-proposed as a small tweak.
        const eggIsA = this.rng.bool(0.5);
        const egg = eggIsA ? a : b;
        const sperm = eggIsA ? b : a;

        // The child joins the EGG's lineage — maternal inheritance, matching
        // which parent actually provisions it. Using the outer-loop
        // individual's lineage instead would look neutral and would not be:
        // `a` is systematically the oldest eligible cell in the dish (see the
        // role-assignment note above), so the child's species label would
        // track age rather than parentage — the same positional bias the coin
        // exists to avoid.
        //
        // Captured before checkSpeciation runs below, and used for the
        // child's lineage, the tree edge and the population cap alike. The
        // cap has to be tested against the lineage actually about to grow,
        // and `roomFor(a.lineageId)` in the outer loop cannot know yet which
        // of the pair that will be — so it is re-tested here.
        const childLineageId = egg.lineageId;
        if (!roomFor(childLineageId)) continue;
        const child = mateVirtunisms(egg, sperm, this.rng, richModeNow(), childLineageId, this.sexualPointMutationMultiplier);
        newborns.push(child);
        // Neither parent already having isDna is what makes this the
        // real transition moment, not just ordinary inheritance — see
        // crossoverGenome's comment on why two RNA parents can still
        // produce a DNA child via recombination.
        const isDnaTransition = child.genome.isDna && !a.genome.isDna && !b.genome.isDna;
        this.recordBirth(child, egg.id, sperm.id, isDnaTransition);
        mated.add(a.id);
        mated.add(b.id);
        grow(childLineageId);
        // After the mating, never before it. Run first (as it was), it
        // reassigned a.lineageId while the old rule required partners to
        // share one — so the instant an individual speciated it became
        // reproductively isolated from the entire population it had just
        // been a member of, and the only same-lineage partner it would ever
        // have was the child it was in the middle of conceiving. Both
        // parents are checked: either may have drifted past threshold, and
        // there is no reason only the outer-loop one should get to found a
        // species.
        this.checkSpeciation(a);
        this.checkSpeciation(b);
        break;
      }
    }

    // Asexual: a virtunism with a bud organelle grows its colony (if
    // there's room); everyone else ejects a free-floating clone.
    for (const cell of this.cells) {
      if (this.cells.length + newborns.length >= this.maxPopulation) break;
      if (!cell.canReproduce() || !roomFor(cell.lineageId)) continue;
      this.checkSpeciation(cell);
      if (hasBud(cell.genome)) {
        const root = this.findColonyRoot(cell);
        if (this.collectColonyMembers(root).length < this.maxColonySize) {
          const child = cell.budOffspring(this.rng, richModeNow());
          newborns.push(child);
          this.recordBirth(child, cell.id, null, child.genome.isDna && !cell.genome.isDna);
          grow(cell.lineageId);
          continue;
        }
      }
      {
        const child = cell.reproduce(this.rng, richModeNow());
        newborns.push(child);
        this.recordBirth(child, cell.id, null, child.genome.isDna && !cell.genome.isDna);
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

  // --- save/restore --------------------------------------------------------
  // Everything here is plain, JSON-safe data except Maps (flattened to
  // arrays) and each Virtunism (which has its own serialize() — see
  // virtunism.ts for why that one needs a real method instead of just
  // spreading fields). The process-global id counters (Virtunism, Food)
  // are captured too, so a freshly-created individual after a restore can
  // never collide with one that's still alive in the restored population.
  serialize(): SerializedWorld {
    return {
      width: this.width,
      height: this.height,
      tick: this.tick,
      rngState: this.rng.getState(),
      nextLineageId: this.nextLineageId,
      nextVirtunismId: getNextVirtunismId(),
      nextFoodId: getNextFoodId(),
      cells: this.cells.map((c) => c.serialize()),
      meatFood: this.meatFood,
      lineages: [...this.lineages.values()],
      history: this.history,
      // The dish's terrain. Carried in the save because deserialize()
      // reconstructs with seed 0 and would otherwise regenerate a different
      // world under a returning player's population. Optional on the way in
      // (see deserialize) so saves written before the light field existed
      // still load — they simply get a freshly generated one, which is the
      // correct outcome for a world that never had terrain.
      lightIntensity: Array.from(this.lightIntensity),
      treeNodes: [...this.treeNodes.values()],
    };
  }

  static deserialize(data: SerializedWorld): World {
    const world = new World(data.width, data.height, 0);
    world.rng = Rng.fromState(data.rngState);
    world.tick = data.tick;
    world.nextLineageId = data.nextLineageId;
    setNextVirtunismId(data.nextVirtunismId);
    setNextFoodId(data.nextFoodId);
    world.cells = deserializeVirtunisms(data.cells);
    world.meatFood = data.meatFood;
    // Lineage records gained life-history fields in save v10. A v8/v9 record
    // arrives without them, and the honest backfill is mostly *nothing*: a
    // peak population that was never recorded cannot be reconstructed from a
    // snapshot, so it stays null and the UI says "unknown" rather than
    // inventing a number. Aliveness is the one thing that *is* recoverable,
    // because the cells are right here — so an old record with no living
    // members is recognised as extinct now, and sheds its reference sequence
    // on the spot. That reclaims the bulk of an old long run's save on the
    // very first load, which is the point: those runs are the ones closest to
    // the storage ceiling. Anything already carrying the fields is left
    // exactly as saved.
    const liveLineageIds = new Set(world.cells.map((c) => c.lineageId));
    world.lineages = new Map(
      data.lineages.map((l): [number, LineageInfo] => [
        l.id,
        {
          ...l,
          referenceSequence: liveLineageIds.has(l.id) ? l.referenceSequence : null,
          peakPopulation: l.peakPopulation ?? null,
          extinctTick: l.extinctTick ?? null,
          finalStats: l.finalStats ?? null,
        },
      ]),
    );
    world.history = data.history;
    // Only adopt a stored field that matches this world's region layout —
    // a mismatched length would mean the save came from a differently-sized
    // dish, and indexing it would be silently wrong rather than loudly so.
    if (data.lightIntensity && data.lightIntensity.length === world.lightIntensity.length) {
      world.lightIntensity = Float32Array.from(data.lightIntensity);
    }
    for (const node of data.treeNodes) world.treeNodes.set(node.id, node);
    return world;
  }
}

export interface SerializedWorld {
  width: number;
  height: number;
  tick: number;
  rngState: number;
  nextLineageId: number;
  nextVirtunismId: number;
  nextFoodId: number;
  cells: SerializedVirtunism[];
  meatFood: Food[];
  lineages: StoredLineage[];
  history: StatsSnapshot[];
  /** Optional: absent in saves written before the light field existed. */
  lightIntensity?: number[];
  treeNodes: TreeNode[];
}
