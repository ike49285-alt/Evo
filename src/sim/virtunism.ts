import {
  crossoverGenome,
  deriveCanEat,
  deriveEnergyCapture,
  deriveEnergyCapturePower,
  deriveMaxSpeed,
  deriveMotorPower,
  derivePredationPower,
  deriveSensorCount,
  deriveStructureBonus,
  deriveStructurePower,
  deriveTurnRate,
  deserializeGenome,
  Genome,
  mutateGenome,
  serializeGenome,
  SerializedGenome,
} from './genome.js';
import { Rng } from './rng.js';
import { GridPoint } from './grid.js';

let nextId = 1;

// --- life history ----------------------------------------------------------
// All three are SWEPT, not chosen — see NOTES.md for the tables, including
// the arms that failed. The precedent is speciationThreshold, which this
// project settled the same way.

/** Fraction of an individual's own maxAge spent immature. At
 * TRAIT_LIMITS.maxAge's {400, 2400} this is 40-240 ticks of adolescence
 * against a 50-tick reproduction cooldown, so it is a real delay without
 * being most of a lifetime. */
const MATURITY_FRACTION = 0.1;

/** How steeply the reproduction bar rises past maturity, and over what
 * span. At strength 0.5 and scale 400, an individual 400 ticks past its
 * maturity age needs 1.5x the energy to breed that it needed on the day it
 * matured. SENESCENCE_SCALE is fixed at TRAIT_LIMITS.maxAge.min so the
 * decline is measured in absolute ticks — see senescenceFactor for why that
 * matters more than it looks.
 *
 * Strength was swept: 1.0 is lethal (2-3 of 5 seeds extinct, population
 * collapsing from ~208 to 62-130), 0.5 is the strongest setting that keeps
 * every seed alive at full population. The failure mode is that the bar
 * rises without bound, so a long-lived individual eventually needs more
 * energy than its own maxEnergy and is sterile for the rest of its life. */
const SENESCENCE_STRENGTH = 0.5;
const SENESCENCE_SCALE = 400;

/** What the sperm-role parent pays. Small but deliberately non-zero:
 * gametes and mate-searching are not free. The real cost of the sperm role
 * is not this number at all — it is the cooldown, which takes a whole adult
 * body out of the breeding pool for exactly as long as the egg parent's
 * does. That is where the twofold cost actually lives. */
const SPERM_COST_FRACTION = 0.05;


/** The module-level id counter is process-global, not per-World — a saved
 * game has to restore it too, or a freshly-created virtunism after reload
 * could collide with an id that's still alive in the restored population. */
export function getNextVirtunismId(): number {
  return nextId;
}
export function setNextVirtunismId(n: number): void {
  nextId = n;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/**
 * A single virtunism — a virtual organism. It only knows how to move
 * itself, burn energy, and reproduce; it has no idea what's around it.
 * World does the sensing (spatial-grid queries) and hands it a finished
 * input vector, so this class stays a plain, testable state machine with
 * no knowledge of the rest of the population.
 *
 * Virtunisms can also be *bonded*: attachedTo/attachedChildren form a tree
 * of virtunisms that move as a single colony (see World's colony-movement
 * pass). localAngle/localDist are the fixed joint to this virtunism's
 * immediate parent in that tree — irrelevant for one with no attachedTo.
 */
export class Virtunism implements GridPoint {
  readonly id: number;
  // Not readonly — a real speciation event (see World.checkSpeciation)
  // reassigns a living individual to a newly-registered species the
  // instant its genome is measured to have diverged past the threshold,
  // rather than only ever being fixed at birth.
  lineageId: number;
  readonly generation: number;
  readonly isPlayerDesigned: boolean;

  genome: Genome;
  x: number;
  y: number;
  heading: number; // radians
  speed = 0; // current scalar speed, 0..deriveMaxSpeed(genome)
  energy: number;
  age = 0; // ticks
  reproCooldown = 0;
  alive = true;

  // Rich/cheap mode is decided once, at construction, from the world's
  // population at that moment (see World's callers) — not re-evaluated
  // later, so an individual born into a small population keeps its real,
  // richer simulation for its whole life even after the population grows
  // past the threshold; only *new* births past that point start cheap.
  // See runInternalChemistry for what rich mode actually does.
  readonly richMode: boolean;
  // Slow mean-reverting stochastic drift (an Ornstein-Uhlenbeck process),
  // only ever updated for richMode individuals — a real, well-documented
  // phenomenon (transcriptional/translational "noise" or "bursting": gene
  // expression genuinely fluctuates tick-to-tick around its mean in real
  // cells, not just because of what's nearby) rather than a frozen
  // fold-derived constant. Affects both capability and its upkeep cost
  // together, same as real expression bursts do.
  private expressionNoise = 0;
  private noiseVelocity = 0;

  // bond-tree state (multicellularity)
  attachedTo: Virtunism | null = null;
  attachedChildren: Virtunism[] = [];
  localAngle = 0; // relative to attachedTo's heading, fixed at bud time
  localDist = 0; // fixed at bud time

  // scratch: this tick's brain output, cached so colony movement can pool
  // every member's vote without re-running the network.
  lastOutputs: readonly number[] = [0, 0];

  constructor(
    genome: Genome,
    x: number,
    y: number,
    lineageId: number,
    generation: number,
    energy: number,
    rng: Rng,
    isPlayerDesigned = false,
    richMode = false,
    // Only set when reconstructing a saved individual — lets save/restore
    // reproduce its exact id and heading instead of minting a new id and
    // rolling a fresh random heading, while every other normal-creation
    // call site (reproduce, budOffspring, mateVirtunisms, addSpecies) stays
    // untouched.
    restore?: { id: number; heading: number },
  ) {
    this.id = restore?.id ?? nextId++;
    this.genome = genome;
    this.x = x;
    this.y = y;
    this.heading = restore?.heading ?? rng.range(0, Math.PI * 2);
    this.energy = energy;
    this.richMode = richMode;
    this.lineageId = lineageId;
    this.generation = generation;
    this.isPlayerDesigned = isPlayerDesigned;
  }

  get radius(): number {
    return 5 + this.genome.size * 5 + this.genome.proteins.length * 0.55;
  }

  get maxEnergy(): number {
    return 60 * this.genome.size + this.genome.proteins.length * 3;
  }

  /** There is exactly ONE energetic bar for "can afford to produce an
   * offspring", and both sexual partners must clear it. This is the whole
   * twofold cost of sex, and getting here took a failed design worth
   * recording.
   *
   * The original code gave sexual reproduction a *lower* bar
   * (`maxEnergy * 0.3`) than asexual's 0.42, on the stated reasoning that a
   * mating already costs two ready individuals so taxing each of them
   * further would make sex "strictly worse". That overshot: paired with a
   * 25%/25% energy split against asexual's 50%, it made sex strictly
   * better, and sex swept — 76-92% from asexual founders against a
   * drift-only null of 5.1%.
   *
   * The first fix imposed real anisogamy (one partner pays the full 50%,
   * the other a token 5%) but kept the cheap 0.3 gate for the token payer,
   * and that was still not enough: measured across six mutation-rate arms
   * and five seeds, asexual could never invade a sexual population —
   * 95-99% sexual in every single arm. The reason is that the low gate
   * hands a sexual individual a reproductive route that has no asexual
   * equivalent. A cell sitting at 35% of its ceiling cannot reproduce
   * asexually at all, but it could father a child for 5% — so the strategy
   * with the lower bar simply reproduces more often, and no amount of
   * recombination-cost tuning on the other side can correct it.
   *
   * With one shared bar, a sexual individual reaching it gets a coin flip:
   * half the time it pays 50% as the egg, half the time 5% as the sperm,
   * and either way the resulting child carries only half its genome. An
   * asexual individual reaching the same bar pays 50% for a child carrying
   * all of it. Two adults are consumed to make the one offspring one adult
   * would have made alone. That is the twofold cost, and it now falls out
   * of the mechanism instead of a penalty constant.
   *
   * Honest limitation: in real biology the twofold cost emerges from a sex
   * *ratio* — half the population is male and bears no young. This model
   * has no heritable sexes (see NOTES.md on why adding them is a separate
   * project), so every sexual individual can take either role and the cost
   * has to be imposed at the pairing gate instead of emerging from a ratio.
   */
  get reproduceThreshold(): number {
    return this.maxEnergy * 0.42;
  }

  /** The age at which reproduction of any kind becomes possible, as a
   * fraction of this individual's *own* maxAge rather than a flat number of
   * ticks. That is the whole point: it makes longevity cost something.
   * Buying a later death with a later first offspring is the classic r/K
   * trade-off.
   *
   * Before this, maxAge bought a longer life for nothing, and the locus
   * ratcheted upward unopposed: measured over 20,000 ticks it climbed
   * 1291 -> 1716. (An earlier 5,000-tick measurement read 1561 -> 1564 and
   * was mistaken for neutrality — the window was simply too short to see
   * the trend, which is worth remembering before calling any locus in this
   * model neutral.) With maturity scaled to maxAge the same measurement
   * gives 1291 -> 1443, so the climb is damped to about a third of its
   * unopposed rate rather than eliminated — longevity still pays, it just
   * pays for itself now. */
  get maturityAge(): number {
    return this.genome.maxAge * MATURITY_FRACTION;
  }

  get isColonyMember(): boolean {
    return this.attachedTo !== null || this.attachedChildren.length > 0;
  }

  /** Runs the brain forward pass on a pre-built sensor vector. */
  think(inputs: readonly number[]): number[] {
    const outputs = this.genome.brain.forward(inputs);
    this.lastOutputs = outputs;
    return outputs;
  }

  /** Applies brain outputs [turn, thrust] to move a *solo* (unbonded)
   * virtunism for one tick. Colony members are moved instead by World's
   * rigid colony-movement pass — see moveColonyRigid(). */
  act(outputs: readonly number[], dt: number, worldWidth: number, worldHeight: number): void {
    const turnOut = clamp(outputs[0] ?? 0, -1, 1);
    const thrustOut = clamp(outputs[1] ?? 0, 0, 1);

    // Approximation: scales the whole formula output, including its fixed
    // "sessile" floor, rather than just the motor-power term inside it —
    // simpler than threading a multiplier into derive* itself, and the
    // floor is small enough (0.05) that the difference is negligible.
    const mult = this.expressionMultiplier;
    const maxTurnRate = deriveTurnRate(this.genome) * mult;
    this.heading += turnOut * maxTurnRate * dt;

    this.speed = thrustOut * deriveMaxSpeed(this.genome) * mult;
    this.x += Math.cos(this.heading) * this.speed * dt;
    this.y += Math.sin(this.heading) * this.speed * dt;

    this.clampToBounds(worldWidth, worldHeight, true);
  }

  /** Keeps it inside the dish. `bounce` reflects heading off the wall (used
   * for solo virtunisms); colony members just get clamped positionally,
   * since their heading is dictated by the colony's joint geometry. */
  clampToBounds(worldWidth: number, worldHeight: number, bounce: boolean): void {
    const r = this.radius;
    if (this.x < r) {
      this.x = r;
      if (bounce) this.heading = Math.PI - this.heading;
    } else if (this.x > worldWidth - r) {
      this.x = worldWidth - r;
      if (bounce) this.heading = Math.PI - this.heading;
    }
    if (this.y < r) {
      this.y = r;
      if (bounce) this.heading = -this.heading;
    } else if (this.y > worldHeight - r) {
      this.y = worldHeight - r;
      if (bounce) this.heading = -this.heading;
    }
  }

  /** Rich-mode-only: advances the stochastic expression-noise process one
   * tick (an Ornstein-Uhlenbeck walk — mean-reverting, so it wanders but
   * always drifts back toward 0 rather than random-walking away forever,
   * the standard model for this kind of real biological fluctuation).
   * First-pass constants, not yet empirically calibrated the way e.g.
   * speciationThreshold was — see NOTES.md. No-op for cheap-mode
   * individuals, which stay exactly the deterministic, already-verified
   * behavior. World calls this once per tick, before metabolize(), only
   * for cells where richMode is true. */
  runInternalChemistry(dt: number, rng: Rng): void {
    if (!this.richMode) return;
    const MEAN_REVERSION = 0.02;
    const NOISE_MAGNITUDE = 0.015;
    const MAX_DRIFT = 0.4;
    this.noiseVelocity += (-MEAN_REVERSION * this.noiseVelocity + NOISE_MAGNITUDE * rng.gaussian(0, 1)) * dt;
    this.expressionNoise = clamp(this.expressionNoise + this.noiseVelocity * dt, -MAX_DRIFT, MAX_DRIFT);
  }

  /** 1 for cheap-mode individuals (no effect — exactly the deterministic
   * formulas already verified), 1+expressionNoise for rich-mode ones. A
   * real expression burst raises both capability *and* its upkeep cost
   * together, same as actual transcriptional bursts do, so this one
   * multiplier is applied on both sides rather than inventing an
   * asymmetric version. */
  private get expressionMultiplier(): number {
    return this.richMode ? 1 + this.expressionNoise : 1;
  }

  /** Burns upkeep + movement energy and ages by one tick. Every protein
   * has a real running cost — a bigger genome is never free, it's a bet
   * that what its proteins do is worth what they burn. Energy-capture
   * income is handled separately by World (see photosynthesize()) since —
   * unlike upkeep, which is purely a function of this virtunism's own
   * body — it has to be weighed against every other energy-capturer
   * competing for the same finite sunlight. */
  metabolize(dt: number): void {
    const size = this.genome.size;
    // Read the same scaled power figures every other formula (max speed,
    // bite yield, energy income) reads — computing this independently
    // inline used to skip the gene-expression scale genome.ts's derive*
    // functions apply, silently making upkeep cheaper than it should be
    // relative to income.
    const mult = this.expressionMultiplier;
    const motorPower = deriveMotorPower(this.genome) * mult;
    const predationPower = derivePredationPower(this.genome) * mult;
    const energyCapturePower = deriveEnergyCapturePower(this.genome) * mult;
    const sensorCount = deriveSensorCount(this.genome);
    const structurePower = deriveStructurePower(this.genome) * mult;

    const baseUpkeep = 0.002 + 0.005 * size * size + 0.0008 * (this.genome.senseRadius / 100);
    const proteinUpkeep =
      0.0035 * motorPower + 0.0025 * predationPower + 0.0015 * energyCapturePower + 0.0006 * sensorCount + 0.002 * structurePower;
    const moveCost = 0.005 * this.speed * size;

    this.energy -= (baseUpkeep + proteinUpkeep + moveCost) * dt;

    this.age += dt;
    if (this.reproCooldown > 0) this.reproCooldown = Math.max(0, this.reproCooldown - dt);
  }

  /** This virtunism's uncontested share of sunlight — World scales this by
   * a dish-wide availability multiplier before actually granting it. */
  get baseSunlightDemand(): number {
    return deriveEnergyCapture(this.genome) * this.expressionMultiplier;
  }

  photosynthesize(dt: number, availabilityMultiplier: number): void {
    // Clamped exactly as eat() is. It wasn't, and that was a standing free
    // ride: a photosynthesizer's income never stopped, so it climbed past
    // its own maxEnergy (measured over 8,000 ticks: 6.1-36.5% of samples
    // above their own ceiling depending on seed, peaking at 7.5x) and sat
    // permanently above reproduceThreshold. That turned
    // reproduction into a pure function of the cooldown timer for every
    // phototroph in the dish -- energy had stopped being the currency it
    // is for every other cell.
    this.energy = Math.min(this.maxEnergy, this.energy + this.baseSunlightDemand * availabilityMultiplier * dt);
  }

  eat(energy: number): void {
    this.energy = Math.min(this.maxEnergy, this.energy + energy);
  }

  /** How much energy a bite yields, scaled by total predation investment. */
  get biteYield(): number {
    return 0.4 + derivePredationPower(this.genome) * this.expressionMultiplier * 0.5;
  }

  get canEat(): boolean {
    return deriveCanEat(this.genome);
  }

  /** Effective size for predation purposes — armor counts without costing
   * full chassis growth. */
  get effectiveDefenseSize(): number {
    return this.genome.size * deriveStructureBonus(this.genome);
  }

  canReproduce(): boolean {
    return (
      this.alive &&
      this.genome.reproductionMode === 'asexual' &&
      this.reproCooldown <= 0 &&
      this.age >= this.maturityAge &&
      this.energy >= this.effectiveReproduceThreshold
    );
  }

  /** Readiness to take part in a mating, in either role — see the comment
   * above on why there is only one bar and it is the asexual one. */
  canMate(): boolean {
    return (
      this.alive &&
      this.genome.reproductionMode === 'sexual' &&
      this.reproCooldown <= 0 &&
      this.age >= this.maturityAge &&
      this.energy >= this.effectiveReproduceThreshold
    );
  }

  /** Reproduction gets steadily more expensive with age past maturity —
   * declining fecundity rather than a second mortality curve, since isDead
   * is already a clean two-term check and this feeds the existing energy
   * ledger instead of running alongside it.
   *
   * The keying is the subtle part, and the obvious choice is wrong. Scale
   * the decline by `age / maxAge` and a long-lived individual senesces more
   * *slowly* — maxAge would buy both a later death and a gentler decline,
   * which is a pure win again and defeats the trade-off maturityAge exists
   * to create. So: the ONSET scales with maxAge (via maturityAge, the
   * reward for longevity), while the RATE past onset is in absolute ticks.
   * A long-lived individual earns a later start to its decline. It does not
   * also earn a shallower one. */
  get senescenceFactor(): number {
    const past = this.age - this.maturityAge;
    if (past <= 0) return 1;
    return 1 + SENESCENCE_STRENGTH * (past / SENESCENCE_SCALE);
  }

  get effectiveReproduceThreshold(): number {
    return this.reproduceThreshold * this.senescenceFactor;
  }

  /** Splits off a mutated, energy-costed child genome — shared by both the
   * "eject a free virtunism" and "bud an attached one" reproduction paths. */
  private spawnChildGenome(rng: Rng): { genome: Genome; energy: number } {
    const genome = mutateGenome(this.genome, rng);
    const childEnergy = this.energy * 0.5;
    this.energy *= 0.5;
    this.reproCooldown = 50;
    return { genome, energy: childEnergy };
  }

  /** Asexual reproduction that ejects a fully independent, free-floating
   * child nearby. `richMode` is decided by the caller (World knows the
   * current population, this class doesn't) at the moment of this birth. */
  reproduce(rng: Rng, richMode: boolean): Virtunism {
    const { genome, energy } = this.spawnChildGenome(rng);
    const angle = rng.range(0, Math.PI * 2);
    const dist = this.radius * 2.2;
    return settleNewborn(new Virtunism(
      genome,
      this.x + Math.cos(angle) * dist,
      this.y + Math.sin(angle) * dist,
      this.lineageId,
      this.generation + 1,
      energy,
      rng,
      this.isPlayerDesigned,
      richMode,
    ));
  }

  /** Asexual reproduction that instead buds a child permanently attached to
   * this virtunism — how colonies grow. Requires this one to carry a bud
   * organelle (checked by the caller). */
  budOffspring(rng: Rng, richMode: boolean): Virtunism {
    const { genome, energy } = this.spawnChildGenome(rng);
    const siblingCount = this.attachedChildren.length;
    const child = settleNewborn(new Virtunism(genome, this.x, this.y, this.lineageId, this.generation + 1, energy, rng, this.isPlayerDesigned, richMode));
    child.attachedTo = this;
    // Spread siblings out around this one rather than stacking on one spot.
    child.localAngle = (siblingCount / 5) * Math.PI * 2 + rng.range(-0.3, 0.3);
    child.localDist = Virtunism.jointDistance(this, child);
    this.attachedChildren.push(child);
    return child;
  }

  /** The joint distance between a bonded parent and child — both bodies'
   * radii plus a small gap. Extracted so budOffspring (which establishes a
   * joint at bud time) and replaceGenome (which has to re-establish one
   * when a body changes size mid-life) can't drift apart: there is exactly
   * one definition of this rule. */
  private static jointDistance(parent: Virtunism, child: Virtunism): number {
    return parent.radius + child.radius + 1;
  }

  /** Replaces this individual's genome mid-life and repairs every invariant
   * the simulation only ever establishes at birth. Nothing in the sim does
   * this — a mutated genome always belongs to a *new* individual (see
   * genome.ts) — so this exists solely for the Tree tab's gene editor, and
   * lives here because all three invariants it repairs are defined in this
   * file:
   *
   *  - `energy` is clamped to maxEnergy only by eat(), on the way *up*. A
   *    smaller genome lowers maxEnergy underneath a cell that is already
   *    full, leaving it permanently over its own ceiling (and so
   *    permanently past reproduceThreshold).
   *  - `speed` is re-derived every tick by act() — but only for *solo*
   *    cells. World.moveColonyRigid writes only the colony root's speed and
   *    World's movement loop skips bonded members entirely, so a non-root
   *    member's stale speed would outlive the edit forever and feed
   *    World.buildInputs an out-of-range speedNorm (which, unlike
   *    energyNorm, is not clamped there).
   *  - `localDist` is fixed at bud time, correct for a body that never
   *    changes size and wrong the instant one does. Only the *immediate*
   *    joints move: localDist is parent-relative, so a grandchild's joint
   *    is unaffected by this cell's radius.
   *
   * The caller owns validating the sequence and building the Genome through
   * the ordinary genomeFromSequence pipeline; this only takes the result.
   * Positions aren't re-cascaded here — World.cascadeColonyPositions does
   * that on the next tick — so a re-seated colony can look slightly gapped
   * until the sim is unpaused. */
  replaceGenome(genome: Genome): void {
    this.genome = genome;
    this.energy = Math.min(this.energy, this.maxEnergy);
    this.speed = Math.min(this.speed, deriveMaxSpeed(this.genome));
    if (this.attachedTo !== null) this.localDist = Virtunism.jointDistance(this.attachedTo, this);
    for (const child of this.attachedChildren) child.localDist = Virtunism.jointDistance(this, child);
  }

  isDead(): boolean {
    return this.energy <= 0 || this.age >= this.genome.maxAge;
  }

  /** Removes this virtunism from its bond tree (on death or predation). Any
   * children become independent colony roots rather than vanishing with
   * their parent — a predator eating one member doesn't wipe the colony. */
  detachFromColony(): void {
    if (this.attachedTo) {
      this.attachedTo.attachedChildren = this.attachedTo.attachedChildren.filter((c) => c !== this);
    }
    for (const child of this.attachedChildren) {
      child.attachedTo = null;
    }
    this.attachedTo = null;
    this.attachedChildren = [];
  }

  /** attachedTo/attachedChildren are direct object references (a real bond
   * tree, not just ids) — not JSON-safe as-is, so they're flattened to ids
   * here and relinked in a second pass by `deserializeVirtunisms` below,
   * once every individual in the save has actually been reconstructed. */
  serialize(): SerializedVirtunism {
    return {
      id: this.id,
      genome: serializeGenome(this.genome),
      x: this.x,
      y: this.y,
      heading: this.heading,
      speed: this.speed,
      energy: this.energy,
      age: this.age,
      reproCooldown: this.reproCooldown,
      alive: this.alive,
      lineageId: this.lineageId,
      generation: this.generation,
      isPlayerDesigned: this.isPlayerDesigned,
      richMode: this.richMode,
      expressionNoise: this.expressionNoise,
      noiseVelocity: this.noiseVelocity,
      attachedToId: this.attachedTo?.id ?? null,
      attachedChildrenIds: this.attachedChildren.map((c) => c.id),
      localAngle: this.localAngle,
      localDist: this.localDist,
      lastOutputs: [...this.lastOutputs],
    };
  }

  /** Only used by deserializeVirtunisms (a module-level function, so this
   * can't itself be `private` despite being internal bookkeeping) —
   * expressionNoise/noiseVelocity aren't part of the constructor's public
   * surface, so a saved individual needs this one setter to restore them
   * exactly rather than resuming from zero. */
  restoreExpressionState(noise: number, velocity: number): void {
    this.expressionNoise = noise;
    this.noiseVelocity = velocity;
  }
}

export interface SerializedVirtunism {
  id: number;
  genome: SerializedGenome;
  x: number;
  y: number;
  heading: number;
  speed: number;
  energy: number;
  age: number;
  reproCooldown: number;
  alive: boolean;
  lineageId: number;
  generation: number;
  isPlayerDesigned: boolean;
  richMode: boolean;
  expressionNoise: number;
  noiseVelocity: number;
  attachedToId: number | null;
  attachedChildrenIds: number[];
  localAngle: number;
  localDist: number;
  lastOutputs: number[];
}

/** Reconstructs a whole saved population in two passes: every individual
 * first (so every id has a live instance to point to), then every bond-tree
 * link (attachedTo/attachedChildren) — a Virtunism can reference a sibling
 * that hasn't been constructed yet if done in one pass. */
export function deserializeVirtunisms(list: readonly SerializedVirtunism[]): Virtunism[] {
  const dummyRng = new Rng(0); // never actually drawn from — heading is always restored explicitly
  const byId = new Map<number, Virtunism>();
  const result: Virtunism[] = [];
  for (const data of list) {
    const v = new Virtunism(
      deserializeGenome(data.genome),
      data.x,
      data.y,
      data.lineageId,
      data.generation,
      data.energy,
      dummyRng,
      data.isPlayerDesigned,
      data.richMode,
      { id: data.id, heading: data.heading },
    );
    v.speed = data.speed;
    v.age = data.age;
    v.reproCooldown = data.reproCooldown;
    v.alive = data.alive;
    v.localAngle = data.localAngle;
    v.localDist = data.localDist;
    v.lastOutputs = data.lastOutputs;
    v.restoreExpressionState(data.expressionNoise, data.noiseVelocity);
    byId.set(v.id, v);
    result.push(v);
  }
  for (const data of list) {
    const v = byId.get(data.id)!;
    v.attachedTo = data.attachedToId !== null ? (byId.get(data.attachedToId) ?? null) : null;
    v.attachedChildren = data.attachedChildrenIds.map((id) => byId.get(id)).filter((c): c is Virtunism => !!c);
  }
  return result;
}

/**
 * Sexual reproduction, anisogamous. Crosses over both parents' genomes
 * (traits, brain weights, and organelles each independently drawn from one
 * parent or the other), mutates the result, and charges the two parents
 * very differently. Always produces a free-floating virtunism — sexual
 * reproduction is the "spread genes to a new lineage" path; budding
 * (asexual + bud organelle) is the "grow this colony" path.
 *
 * The asymmetry is the whole point, so the parameter names are `egg` and
 * `sperm` rather than `a` and `b`. `egg` provisions the offspring and pays
 * exactly what an asexual parent pays: half its body, which becomes the
 * child's starting energy. `sperm` pays a token share, burned rather than
 * handed over — real sperm contributes essentially no material — so the
 * child is provisioned identically to an asexual child and sex cannot buy
 * a better-fed offspring for less.
 *
 * Both cooldowns are 50, the same as asexual's, and that equality is
 * load-bearing rather than incidental. It leaves exactly two differences
 * between the strategies: a sexual birth occupies two bodies instead of one
 * and needs a partner in range, and a sexual child gets recombination and a
 * reduced mutational load. Giving sex a longer cooldown as well would
 * quietly stack a fecundity penalty on top of the twofold cost, and the
 * sweep would then misattribute it to the mutation-rate lever.
 *
 * `sexualPointMutationMultiplier` is what recombination buys. Without it,
 * sexual offspring take the full asexual point-mutation pass *on top of*
 * crossover — paying for both instead of trading one for the other — which
 * is not how the mutational-load argument for sex works. World owns the
 * value so it can be swept.
 *
 * `richMode` and `childLineageId` are decided by the caller (World) at the
 * moment of this birth.
 */
export function mateVirtunisms(
  egg: Virtunism,
  sperm: Virtunism,
  rng: Rng,
  richMode: boolean,
  childLineageId: number,
  sexualPointMutationMultiplier = 1,
): Virtunism {
  const childGenome = mutateGenome(crossoverGenome(egg.genome, sperm.genome, rng), rng, sexualPointMutationMultiplier);

  const childEnergy = egg.energy * 0.5;
  egg.energy *= 0.5;
  sperm.energy *= 1 - SPERM_COST_FRACTION;
  egg.reproCooldown = 50;
  sperm.reproCooldown = 50;

  const angle = rng.range(0, Math.PI * 2);
  const dist = (egg.radius + sperm.radius) * 0.6;
  const midX = (egg.x + sperm.x) / 2;
  const midY = (egg.y + sperm.y) / 2;
  return settleNewborn(new Virtunism(
    childGenome,
    midX + Math.cos(angle) * dist,
    midY + Math.sin(angle) * dist,
    childLineageId,
    Math.max(egg.generation, sperm.generation) + 1,
    childEnergy,
    rng,
    egg.isPlayerDesigned || sperm.isPlayerDesigned,
    richMode,
  ));
}

/** A newborn's energy comes out of its parent's ledger, but its ceiling
 * comes from its own freshly mutated genome — which can be *smaller* than
 * the parent's. Without this, a child born under a shrinking mutation
 * starts life permanently above its own maxEnergy, and so permanently past
 * reproduceThreshold: the identical standing-over-ceiling state
 * replaceGenome's comment describes, reached from the other direction.
 *
 * Applied at the birth sites rather than inside the constructor on purpose
 * — deserializeVirtunisms restores a saved energy that is already correct
 * for its genome, and a constructor clamp would silently rewrite it. */
function settleNewborn(child: Virtunism): Virtunism {
  child.energy = Math.min(child.energy, child.maxEnergy);
  return child;
}
