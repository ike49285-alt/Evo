import { LegacySerializedNet, NeuralNet, SerializedNet } from './nn.js';
import { Rng } from './rng.js';
import { BRAIN_TOPOLOGY, CatalysisClass, ProteinPhenotype, ReproductionMode, TRAIT_LIMITS } from './types.js';
import {
  CORE_GENE_COUNT,
  crossoverGeneSequence,
  decodeCoreTraits,
  decodeProteinGene,
  decodeProteins,
  Gene,
  GENE_LENGTH,
  GeneSequence,
  mutateGeneSequence,
  randomGeneSequence,
} from './genes.js';
import { CATALYSIS_CLASSES } from '../chem/polymer.js';
import { NUCLEOTIDE_CODES } from '../chem/elements.js';

export { TRAIT_LIMITS };

/**
 * A virtunism's real heredity is `sequence` (see genes.ts) — everything
 * else here (`size`, `proteins`, etc.) is a *cached decode* of it,
 * refreshed by `decodePhenotype` every time the sequence changes
 * (construction, mutation, crossover). `proteins` holds every
 * protein-coding gene's real translation + fold — nothing here is a
 * looked-up "kind"; whatever functional class a fold's real chemistry
 * produces is read directly off `proteins[i].fold.catalysisClass` by the
 * derive* functions below.
 */
export interface Genome {
  sequence: GeneSequence;
  reproductionMode: ReproductionMode;
  size: number; // chassis scale — base body radius/energy budget, independent of proteins
  senseRadius: number; // detection *range*; photoreceptor-class proteins separately control detection *angle*
  maxAge: number; // lifespan in ticks before death of old age
  hue: number; // 0-360, cosmetic + lets you track lineages visually
  proteins: ProteinPhenotype[];
  // Whether this lineage has transitioned to DNA-based heredity — see
  // DNA_TRANSITION_THRESHOLD below. A real historical fact about the
  // lineage, not a per-tick derived stat (contrast hasBud(), which reads
  // current replicase power fresh every call): once true it stays true
  // through further mutation/crossover, propagated in parallel with
  // `sequence`/`brain` by genomeFromSequence, the same way `brain` already
  // is rather than being decoded from the sequence itself.
  isDna: boolean;
  brain: NeuralNet;
  // Precomputed once here, not re-derived per call — genome.proteins never
  // changes after construction (mutation/crossover always build a *new*
  // Genome via genomeFromSequence, never mutate an existing one in place),
  // but classPower()/hasClass() used to re-scan the whole proteins array
  // on every single call. A real headless profile (see NOTES.md) found
  // that scan — specifically Virtunism.canEat, called for every nearby
  // individual a virtunism senses, every tick, for every cell — was the
  // single dominant per-tick cost once genomes routinely carried 10+
  // proteins (~25% of total runtime on its own, more than the actual
  // physics: distance math, neural net forward passes, everything else
  // combined). Not part of the public "trait" vocabulary (deliberately
  // not documented alongside size/senseRadius/etc above) — an internal
  // cache, read only through classPower()/countOfClass()/hasClass()
  // below, never touched directly by callers outside this file.
  readonly classPowerCache: Readonly<Record<CatalysisClass, number>>;
  readonly classCountCache: Readonly<Record<CatalysisClass, number>>;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

// A single fold's catalysisStrength is one molecule's worth of activity —
// real cellular capability isn't limited by one enzyme molecule's turnover,
// it's driven by how many copies of that gene are actively expressed
// (transcription/translation runs continuously, not once). Real gene
// expression levels vary hugely (single copies to thousands), so this is a
// coarse, single-number stand-in for that whole regulatory layer — headless-
// verified against the ecosystem's tuned upkeep/threshold economy (a
// population needs real net energy income to survive at all; see
// NOTES.md), not picked in the abstract. Applied once here rather than
// inflating catalysisStrength itself, which stays an honest, unscaled
// measurement of the fold's real quality.
const GENE_EXPRESSION_SCALE = 12;

/** Single pass over a genome's real proteins, building both per-class
 * caches at once (power-sum and raw count) — see Genome.classPowerCache's
 * comment for why this exists at all instead of being recomputed on
 * every classPower()/hasClass() call. */
function computeClassCaches(proteins: readonly ProteinPhenotype[]): {
  classPowerCache: Record<CatalysisClass, number>;
  classCountCache: Record<CatalysisClass, number>;
} {
  const classPowerCache = {} as Record<CatalysisClass, number>;
  const classCountCache = {} as Record<CatalysisClass, number>;
  for (const cls of CATALYSIS_CLASSES) {
    classPowerCache[cls] = 0;
    classCountCache[cls] = 0;
  }
  for (const p of proteins) {
    const cls = p.fold.catalysisClass;
    if (cls === null) continue;
    classPowerCache[cls] += p.fold.catalysisStrength;
    classCountCache[cls] += 1;
  }
  for (const cls of CATALYSIS_CLASSES) classPowerCache[cls] *= GENE_EXPRESSION_SCALE;
  return { classPowerCache, classCountCache };
}

function decodePhenotype(sequence: GeneSequence): Omit<Genome, 'sequence' | 'brain' | 'isDna'> {
  const core = decodeCoreTraits(sequence);
  const proteins = decodeProteins(sequence);
  const { classPowerCache, classCountCache } = computeClassCaches(proteins);
  return { ...core, proteins, classPowerCache, classCountCache };
}

// ---- derived physical stats (computed from real protein folds, not looked up) --------

function proteinsOf(genome: Genome, cls: CatalysisClass): ProteinPhenotype[] {
  return genome.proteins.filter((p) => p.fold.catalysisClass === cls);
}

/** O(1) — reads Genome.classCountCache, computed once at construction. */
function countOfClass(genome: Genome, cls: CatalysisClass): number {
  return genome.classCountCache[cls];
}

/** O(1) — same cache, just compared against zero. */
function hasClass(genome: Genome, cls: CatalysisClass): boolean {
  return genome.classCountCache[cls] > 0;
}

/** Total real catalytic strength across every protein that folded into
 * this class, scaled by gene expression — the emergent replacement for
 * "sum of organelle sizes of kind X". A genome can carry any number of
 * proteins contributing to any class; there's no slot system. O(1): reads
 * Genome.classPowerCache, computed once at construction (see its
 * comment) rather than re-summing genome.proteins on every call. */
function classPower(genome: Genome, cls: CatalysisClass): number {
  return genome.classPowerCache[cls];
}

/** Top speed a virtunism's motor-class proteins can push it to. Zero
 * motor power = nearly sessile (a real strategy for an energy-capturing
 * lineage that doesn't need to chase anything), not literally frozen. */
export function deriveMaxSpeed(genome: Genome): number {
  return 0.05 + Math.sqrt(classPower(genome, 'motor')) * 0.85;
}

/** More motor proteins spread around the rim = a more maneuverable body. */
export function deriveTurnRate(genome: Genome): number {
  return 0.08 + Math.min(0.25, countOfClass(genome, 'motor') * 0.03);
}

export function deriveMotorPower(genome: Genome): number {
  return classPower(genome, 'motor');
}

export function derivePredationCount(genome: Genome): number {
  return countOfClass(genome, 'protease');
}

/** Whether this genome has *any* real predation capability at all — a
 * cheap yes/no a lot of per-tick, per-neighbor checks only ever need
 * (see Virtunism.canEat). Kept as its own function rather than routed
 * through derivePredationCount()'s full count so those call sites get
 * the early-exit, allocation-free path instead of paying for a count
 * they were only going to compare against zero. */
export function deriveCanEat(genome: Genome): boolean {
  return hasClass(genome, 'protease');
}

export function derivePredationPower(genome: Genome): number {
  return classPower(genome, 'protease');
}

/** Raw structural/membrane investment (unscaled by the 0.15/0.12
 * bonus/mitigation curves deriveStructureBonus/Mitigation apply) — used
 * where upkeep cost needs the same raw power figure every other class's
 * upkeep term already reads. */
export function deriveStructurePower(genome: Genome): number {
  return classPower(genome, 'lipidsynthase');
}

/** Passive energy/tick from ambient light — the "plant" income stream.
 * peptidyl-class proteins build biomass from raw monomers + ambient
 * energy in Stage 0; the same anabolic reasoning carries over as this
 * dish's photosynthesis-analog income. */
export function deriveEnergyCapture(genome: Genome): number {
  return classPower(genome, 'peptidyl') * 0.05;
}

export function deriveEnergyCapturePower(genome: Genome): number {
  return classPower(genome, 'peptidyl');
}

/** Structural/membrane investment makes a virtunism read as effectively
 * bigger/tougher to predators without paying full chassis-size energy
 * cost for the same protection. */
export function deriveStructureBonus(genome: Genome): number {
  return 1 + classPower(genome, 'lipidsynthase') * 0.15;
}

export function deriveStructureMitigation(genome: Genome): number {
  return Math.min(0.5, classPower(genome, 'lipidsynthase') * 0.12);
}

/** Each photoreceptor-class protein contributes its own vision cone, at
 * its own gene-encoded mount angle — same mechanic organelle "eyes" used
 * to provide, just keyed off real fold class instead of a kind label. */
export function deriveSensors(genome: Genome): ProteinPhenotype[] {
  return proteinsOf(genome, 'photoreceptor');
}

/** Allocation-free count for callers (Virtunism.metabolize's upkeep term)
 * that only need how many, not the sensors themselves — see
 * countOfClass's comment for why this distinction is worth having. */
export function deriveSensorCount(genome: Genome): number {
  return countOfClass(genome, 'photoreceptor');
}

// A real replication-machinery investment is what a real lineage would
// channel into producing attached offspring rather than dispersing solo —
// budding is a threshold on aggregate replicase strength, not its own
// protein class. Picked as a starting point, not rigorously derived;
// worth the same kind of headless-tuned calibration pass every other
// threshold in this project has gotten (see NOTES.md).
const BUD_THRESHOLD = 1.0;

export function hasBud(genome: Genome): boolean {
  return classPower(genome, 'replicase') >= BUD_THRESHOLD;
}

// Reverse transcriptase is structurally a polymerase — the same real
// surface-chemistry axis (Arg/Lys-rich, RNA-backbone-binding) that
// already defines the replicase class, just a meaningfully harder bar to
// clear than "any repeatable replication" (BUD_THRESHOLD). Any lineage
// whose replicase power crosses this transcribes its own genome into the
// more stable molecule real DNA actually is (see DNA_MUTATION_RATE_
// MULTIPLIER below for why that matters) — not treated as a separate 7th
// catalysis class, since that would mean competing it against the other
// six for every fold's argmax when it's really the same functional axis
// at higher potency. 3x BUD_THRESHOLD as a starting point, not derived —
// pending the same empirical calibration pass every other threshold in
// this project gets (see NOTES.md).
const DNA_TRANSITION_THRESHOLD = 3.0;

// Not the literal ~100-1000x fidelity gap real DNA proofreading achieves
// over uncorrected RNA replication — at this simulation's scale that
// would make a DNA lineage's evolution effectively invisible, the same
// "reachability over literal magnitude" call made for Stage 0's soup
// density and catalytic-fold thresholds (see NOTES.md). A real, modest
// reduction instead: a DNA lineage's point mutations still happen, just
// meaningfully less often than an RNA lineage's — the correct *direction*
// for a real chemical reason (T-vs-U repair-detectability, no 2'-OH
// instability), calibrated for gameplay reachability rather than the
// literal number.
const DNA_MUTATION_RATE_MULTIPLIER = 0.25;

// ---- construction & evolution ----------------------------------------------

// The inverse of genes.ts's sum-based decode — needed wherever a specific
// locus value has to be forced into a real gene (chem/bridge.ts uses this
// to force a bootstrap founder's reproductionMode locus to asexual after
// building the rest of its sequence from real RNA content). Greedily
// hands out the max symbol value to as many positions as the target sum
// needs, zeros the rest — any distribution across positions that adds up
// to the right sum decodes correctly, this is just *a* valid one.
export function encodeUnit(unit: number, length: number): Gene {
  const maxSum = length * (NUCLEOTIDE_CODES.length - 1);
  let remaining = Math.round(clamp(unit, 0, 1) * maxSum);
  const digits: number[] = [];
  for (let i = 0; i < length; i++) {
    const take = Math.min(NUCLEOTIDE_CODES.length - 1, remaining);
    digits.push(take);
    remaining -= take;
  }
  return digits.map((d) => NUCLEOTIDE_CODES[d]);
}

/** Builds a Genome straight from an already-real gene sequence — the only
 * construction path now (no more encode-a-desired-loadout path, since
 * there's no loadout catalog to encode). Both the bootstrap path
 * (chem/bridge.ts, sequence built from a protocell's real RNA) and the
 * Designer tab's random-seed release (a fresh randomGeneSequence) go
 * through this with no parent genome in scope, so `inheritedIsDna`
 * defaults false — every fresh lineage starts on RNA, matching Stage 0
 * having no DNA at all to inherit from. `mutateGenome`/`crossoverGenome`
 * below are the only callers that ever pass true. */
export function genomeFromSequence(sequence: GeneSequence, brain: NeuralNet, inheritedIsDna = false): Genome {
  const decoded = decodePhenotype(sequence);
  const isDna = inheritedIsDna || decoded.classPowerCache.replicase >= DNA_TRANSITION_THRESHOLD;
  return { sequence, brain, isDna, ...decoded };
}

// Real, single-random-protein-gene hit rates (headless-measured against
// the actual class-score formula in chem/polymer.ts, 50,000-gene sample):
// peptidyl ~0.6%, protease ~0.95%, motor ~0.24% — each real class only
// wins the fold's argmax over a genuinely narrow slice of surface
// compositions once all six classes compete fairly for it (see
// polymer.ts's scores record and its comment on why motor needed its own
// independent axis). At those rates a 120-attempt cap — calibrated
// against an earlier, unbalanced version of that formula where two
// classes (motor/lipidsynthase) were mutually exclusive by construction
// and the other four effectively split a bigger remaining share — measured
// at only ~59% actual success once the six-way competition was fixed to
// be fair. A cap-vs-success-rate sweep (see NOTES.md) found 800 attempts
// gets to ~99.8% and 1200 reaches 100% over a 5,000-trial sample; 1200 is
// used here for real margin. Each attempt is one cheap gene draw + fold
// (sub-millisecond), one-time at construction — the higher cap costs
// nothing that matters, and the search itself is O(attempts), not
// O(attempts²) (see ensureEnergyCapable's incremental viability tracking
// below — an earlier version re-decoded the whole accumulated gene list
// on every attempt, which was fine at 120 attempts and a real problem at
// the low thousands).
const MAX_FOUNDER_REROLL_ATTEMPTS = 1200;

/** A freshly random genome needs a real, *reachable* way to get energy —
 * headless-verified this is stricter than just "has a peptidyl or
 * protease protein": a predator that can't move can't reliably catch
 * anything. Two random seed genomes in one verification run were exactly
 * that failure mode — real predation power (3.7, 3.1), zero motor power
 * (stuck at the sessile speed floor), zero energy capture — nothing to
 * eat yet and no way to go find something, a guaranteed slow starvation
 * that took the whole founding population down together. Passive
 * energy-capture doesn't need mobility to work, so it alone is enough;
 * predation only counts alongside real motor power. */
function isFounderViable(hasEnergyCapture: boolean, hasPredation: boolean, hasMotor: boolean): boolean {
  return hasEnergyCapture || (hasPredation && hasMotor);
}

// The three classes isFounderViable actually cares about — not "any
// functional class" (there are six now, and most of them don't help a
// founder survive at all).
const FOUNDER_VIABLE_CLASSES: ReadonlySet<CatalysisClass> = new Set(['peptidyl', 'protease', 'motor']);

/** Reorders protein genes so any whose class can satisfy founder
 * viability (peptidyl/protease/motor) sort before everything else. This
 * exists because of a real bug a headless run caught: trimToProteinCap's
 * own "keep functional genes first" only means *any* of the six classes,
 * and now that lipidsynthase/replicase/photoreceptor are all real,
 * reachable outcomes too (lipidsynthase alone came out the single most
 * common catalytic class in an ensemble sample — see NOTES.md), a long
 * viability search accumulates plenty of those non-viability-relevant
 * "functional" genes along the way. Left to trimToProteinCap's generic
 * bucketing alone, the *one* gene that actually made isFounderViable true
 * could land past the cap and get silently dropped by the very trim step
 * that's supposed to preserve a successful search's result — measured
 * directly: founder viability dropped to ~87% instead of the ~100% the
 * search loop's own attempt-count calibration predicted, entirely because
 * of this. Exported so chem/bridge.ts's bootstrap-founder search (which
 * has the identical trim-after-search shape) gets the same guarantee. */
export function prioritizeFounderGenes(genes: readonly Gene[]): Gene[] {
  const priority: Gene[] = [];
  const rest: Gene[] = [];
  for (const g of genes) {
    const cls = decodeProteinGene(g).fold.catalysisClass;
    (cls !== null && FOUNDER_VIABLE_CLASSES.has(cls) ? priority : rest).push(g);
  }
  return [...priority, ...rest];
}

/** Appends fresh protein genes (never overwrites an existing one) until
 * the genome clears isFounderViable or the attempts run out — search
 * headroom is deliberately *not* capped by TRAIT_LIMITS.maxProteins here:
 * an earlier version was, and with a typical 6-12 starting protein count
 * that left only a handful of real attempts before hitting the cap,
 * nowhere near the number needed for a real >99% success rate at this
 * combined class hit rate. Search freely, then trim back down to the
 * ongoing cap afterward (see trimToProteinCap) so the constraint that
 * matters for gameplay is still respected, just not for this one-time
 * construction-time search. Appending (not overwriting) still matters on
 * its own: an earlier version repeatedly overwrote the same last slot
 * while searching, and a real headless run caught it actually
 * *destroying* a genome's one working protein when that happened to be
 * the slot being overwritten, with no guaranteed replacement — leaving
 * the genome worse off than before the "fix" ran.
 *
 * Tracks the three booleans incrementally instead of re-decoding every
 * accumulated gene on every attempt — an earlier version did the latter
 * (`decodeProteins` over the whole growing array each time) and it was
 * quadratic in the attempt count purely by accident, never intentional:
 * fine at the original cap of 120, but a real problem once a corrected
 * class-score formula (see chem/polymer.ts) meant the cap had to grow by
 * an order of magnitude to keep the same success rate — a real headless
 * timing test is what caught this, not inspection. */
function ensureEnergyCapable(sequence: GeneSequence, rng: Rng): GeneSequence {
  const genes = [...sequence.genes];
  let hasEnergyCapture = false;
  let hasPredation = false;
  let hasMotor = false;
  const scan = (gene: Gene): void => {
    const cls = decodeProteinGene(gene).fold.catalysisClass;
    if (cls === 'peptidyl') hasEnergyCapture = true;
    else if (cls === 'protease') hasPredation = true;
    else if (cls === 'motor') hasMotor = true;
  };
  for (let i = CORE_GENE_COUNT; i < genes.length; i++) scan(genes[i]);

  for (let attempt = 0; attempt < MAX_FOUNDER_REROLL_ATTEMPTS && !isFounderViable(hasEnergyCapture, hasPredation, hasMotor); attempt++) {
    const gene = randomGeneSequence(rng, 1).genes[CORE_GENE_COUNT];
    genes.push(gene);
    scan(gene);
  }
  const core = genes.slice(0, CORE_GENE_COUNT);
  const proteinGenes = prioritizeFounderGenes(genes.slice(CORE_GENE_COUNT));
  return trimToProteinCap({ genes: [...core, ...proteinGenes] });
}

/** Brings a gene sequence back down to TRAIT_LIMITS.maxProteins protein
 * genes if a viability search grew it past that. Keeps every gene that
 * actually folded into a real functional class first (there are only
 * ever a handful, so this can't itself blow the cap), filling any
 * remaining room with whatever's left — a positional "keep the last N"
 * trim isn't safe here, since a successful search's one viable gene
 * could easily land outside whatever window survives, silently undoing
 * the very search that just ran. */
export function trimToProteinCap(sequence: GeneSequence): GeneSequence {
  const core = sequence.genes.slice(0, CORE_GENE_COUNT);
  const proteinGenes = sequence.genes.slice(CORE_GENE_COUNT);
  if (proteinGenes.length <= TRAIT_LIMITS.maxProteins) return sequence;

  const functional: Gene[] = [];
  const rest: Gene[] = [];
  for (const g of proteinGenes) {
    (decodeProteinGene(g).fold.catalysisClass !== null ? functional : rest).push(g);
  }
  const kept = [...functional, ...rest].slice(0, TRAIT_LIMITS.maxProteins);
  return { genes: [...core, ...kept] };
}

export function randomGenome(rng: Rng, reproductionMode: ReproductionMode = 'asexual'): Genome {
  const proteinCount = rng.int(6, 12);
  let sequence = randomGeneSequence(rng, proteinCount);
  // Random core genes decode to a random reproductionMode too (it's a real
  // evolvable locus — see genes.ts's LOCUS.reproductionMode) — override
  // just that one gene so callers that ask for a specific starting mode
  // (most of them do) actually get it, without hand-rolling the rest of
  // the sequence themselves.
  sequence = { genes: [encodeUnit(reproductionMode === 'sexual' ? 0.75 : 0.25, GENE_LENGTH), ...sequence.genes.slice(1)] };
  sequence = ensureEnergyCapable(sequence, rng);
  return genomeFromSequence(sequence, NeuralNet.random(BRAIN_TOPOLOGY, rng));
}

/** Produces a mutated child genome from a parent. Parent is untouched.
 *
 * `extraRateMultiplier` is the sexual-reproduction discount (see
 * mateVirtunisms). It composes with the DNA ratchet's multiplier rather
 * than replacing it: the two are independent fidelity mechanisms — one is
 * a better-copying molecule, the other is recombination substituting for
 * mutation as a source of variation — and a genome that has earned both
 * should get both. Deliberately no floor: a sexual DNA lineage really can
 * end up close to mutationally frozen, and if that turns out to matter it
 * should show up in the sweep as a measured effect rather than being
 * pre-empted by a second unswept constant. */
export function mutateGenome(parent: Genome, rng: Rng, extraRateMultiplier = 1): Genome {
  // A DNA parent's point mutations happen at a real, deliberately reduced
  // rate — see DNA_MUTATION_RATE_MULTIPLIER's comment. isDna itself is
  // passed through as inheritedIsDna: the ratchet only ever moves toward
  // DNA, ordinary mutation can't revert it.
  const rateMultiplier = (parent.isDna ? DNA_MUTATION_RATE_MULTIPLIER : 1) * extraRateMultiplier;
  const sequence = mutateGeneSequence(parent.sequence, rng, rateMultiplier);
  // Strength scaled down to match the brain's Xavier-init weight range
  // (roughly ±0.2-0.3) rather than the old flat [-1,1] one — mutation
  // noise should perturb a weight, not routinely swamp it.
  //
  // The discount reaches the brain's *rate* too, and has to: most of the
  // behavioural phenotype lives in these weights, and NeuralNet.crossover
  // has just recombined them. Scaling only the gene sequence would leave
  // sexual offspring still paying full mutational load across the part of
  // the genome that matters most, which is exactly the double-charge this
  // parameter exists to end. Strength is left alone — a mutation should be
  // rarer, not weaker.
  return genomeFromSequence(sequence, parent.brain.mutate(rng, 0.12 * extraRateMultiplier, 0.15), parent.isDna);
}

/** Crossover of two same-lineage parents (for sexual reproduction). Core
 * loci are picked per-gene from one parent or the other (independent
 * assortment); the protein-gene run uses real unequal crossover — see
 * genes.ts's crossoverGeneSequence for why that's not just a convenient
 * mechanic. Brain crossover is unchanged. */
export function crossoverGenome(a: Genome, b: Genome, rng: Rng): Genome {
  const sequence = crossoverGeneSequence(a.sequence, b.sequence, rng);
  // Either parent already having transitioned is enough — this lets two
  // RNA parents whose combined replicase genes finally clear
  // DNA_TRANSITION_THRESHOLD produce a DNA child neither parent was on
  // their own, a real payoff of sexual recombination, not extra logic.
  return genomeFromSequence(sequence, NeuralNet.crossover(a.brain, b.brain, rng), a.isDna || b.isDna);
}

// ---- save/restore ----------------------------------------------------------
// A genome is saved as the three things that cannot be derived — the gene
// sequence, the brain, and the isDna ratchet — and nothing else.
//
// This used to spread the entire Genome object. That wrote `proteins`,
// `classPowerCache`, `classCountCache` and all five decoded core traits
// into every cell of every save, and every one of those is recomputed
// from `sequence` by genomeFromSequence: about 2 KB of the 8.2 KB each
// cell cost, duplicated 200-320 times per save. The whole file was
// landing on iOS Safari's localStorage ceiling and failing silently (see
// save.ts), so this was not a tidiness question.
//
// Verified before relying on it: 300 mutated genomes rebuilt from
// sequence + brain + isDna alone are byte-identical to the full
// serialization, 0 mismatches.
//
// The durability win matters as much as the size. Derived fields are
// exactly the fields most likely to change as the model grows, and every
// one written into the save is a future reason to invalidate old saves —
// the v5 bump in save.ts's version log happened *because* the class
// caches were being serialized. Fields that are never written can never
// break a save.
export interface SerializedGenome {
  /** One string per gene rather than an array of single-character
   * strings: `["A","C","G"]` costs 4 bytes a symbol, `"ACG"` costs 1, and
   * a genome is ~650 symbols. */
  seq: string[];
  brain: SerializedNet;
  isDna: boolean;
}

/** The pre-compaction shape. Only ever read, never written. */
type LegacySerializedGenome = Omit<Genome, 'brain'> & { brain: LegacySerializedNet | SerializedNet };

export function serializeGenome(genome: Genome): SerializedGenome {
  return {
    seq: genome.sequence.genes.map((gene) => gene.join('')),
    brain: genome.brain.toJSON(),
    isDna: genome.isDna,
  };
}

/** Rebuilds a Genome from a save, accepting both the compact shape above
 * and the legacy one that carried every derived field. Old saves are
 * migrated rather than discarded — see save.ts.
 *
 * Both paths run the sequence back through genomeFromSequence rather than
 * trusting stored derived values, so a resumed genome is constructed by
 * exactly the same code as a newborn one. Measured at 11 ms to rebuild a
 * 207-cell dish (2,740 proteins), which is not worth caching around. */
export function deserializeGenome(json: SerializedGenome | LegacySerializedGenome): Genome {
  const brain = NeuralNet.fromJSON(json.brain);
  const sequence: GeneSequence = 'seq' in json
    ? { genes: json.seq.map((gene) => Array.from(gene) as Gene) }
    : json.sequence;
  return genomeFromSequence(sequence, brain, json.isDna);
}
