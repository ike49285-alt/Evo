import { NeuralNet } from './nn.js';
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
  brain: NeuralNet;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function decodePhenotype(sequence: GeneSequence): Omit<Genome, 'sequence' | 'brain'> {
  return { ...decodeCoreTraits(sequence), proteins: decodeProteins(sequence) };
}

// ---- derived physical stats (computed from real protein folds, not looked up) --------

function proteinsOf(genome: Genome, cls: CatalysisClass): ProteinPhenotype[] {
  return genome.proteins.filter((p) => p.fold.catalysisClass === cls);
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

/** Total real catalytic strength across every protein that folded into
 * this class, scaled by gene expression — the emergent replacement for
 * "sum of organelle sizes of kind X". A genome can carry any number of
 * proteins contributing to any class; there's no slot system. */
function classPower(genome: Genome, cls: CatalysisClass): number {
  let sum = 0;
  for (const p of genome.proteins) if (p.fold.catalysisClass === cls) sum += p.fold.catalysisStrength;
  return sum * GENE_EXPRESSION_SCALE;
}

/** Top speed a virtunism's motor-class proteins can push it to. Zero
 * motor power = nearly sessile (a real strategy for an energy-capturing
 * lineage that doesn't need to chase anything), not literally frozen. */
export function deriveMaxSpeed(genome: Genome): number {
  return 0.05 + Math.sqrt(classPower(genome, 'motor')) * 0.85;
}

/** More motor proteins spread around the rim = a more maneuverable body. */
export function deriveTurnRate(genome: Genome): number {
  return 0.08 + Math.min(0.25, proteinsOf(genome, 'motor').length * 0.03);
}

export function deriveMotorPower(genome: Genome): number {
  return classPower(genome, 'motor');
}

export function derivePredationCount(genome: Genome): number {
  return proteinsOf(genome, 'protease').length;
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
 * through this. */
export function genomeFromSequence(sequence: GeneSequence, brain: NeuralNet): Genome {
  return { sequence, brain, ...decodePhenotype(sequence) };
}

// Real codon-translated protein genes land on peptidyl or protease
// specifically (the two energy-capable classes) at a combined ~4.8%
// (headless-verified — see NOTES.md). A single-digit reroll cap looked
// reasonable on paper but measured at only ~32% actual success
// ((1-0.048)^8) — nowhere near enough. Solving for a >99% success rate
// at that hit rate needs ~94 independent attempts; 120 gives real margin.
// Each attempt is one cheap gene draw + fold (a few hundred microseconds
// total, one-time at construction), so the higher cap costs nothing that
// matters.
const MAX_FOUNDER_REROLL_ATTEMPTS = 120;

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
function isFounderViable(genes: readonly Gene[]): boolean {
  const proteins = decodeProteins({ genes: [...genes] });
  const hasEnergyCapture = proteins.some((p) => p.fold.catalysisClass === 'peptidyl');
  const hasPredation = proteins.some((p) => p.fold.catalysisClass === 'protease');
  const hasMotor = proteins.some((p) => p.fold.catalysisClass === 'motor');
  return hasEnergyCapture || (hasPredation && hasMotor);
}

/** Appends fresh protein genes (never overwrites an existing one) until
 * the genome clears isFounderViable or the attempts run out — search
 * headroom is deliberately *not* capped by TRAIT_LIMITS.maxProteins here:
 * an earlier version was, and with a typical 6-12 starting protein count
 * that left only a handful of real attempts before hitting the cap,
 * nowhere near the ~94 needed for the intended >99% success rate at this
 * combined class hit rate. Search freely, then trim back down to the
 * ongoing cap afterward (see trimToProteinCap) so the constraint that
 * matters for gameplay is still respected, just not for this one-time
 * construction-time search. Appending (not overwriting) still matters on
 * its own: an earlier version repeatedly overwrote the same last slot
 * while searching, and a real headless run caught it actually
 * *destroying* a genome's one working protein when that happened to be
 * the slot being overwritten, with no guaranteed replacement — leaving
 * the genome worse off than before the "fix" ran. */
function ensureEnergyCapable(sequence: GeneSequence, rng: Rng): GeneSequence {
  let genes = [...sequence.genes];
  for (let attempt = 0; attempt < MAX_FOUNDER_REROLL_ATTEMPTS && !isFounderViable(genes); attempt++) {
    genes = [...genes, randomGeneSequence(rng, 1).genes[CORE_GENE_COUNT]];
  }
  return trimToProteinCap({ genes });
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

/** Produces a mutated child genome from a parent. Parent is untouched. */
export function mutateGenome(parent: Genome, rng: Rng): Genome {
  const sequence = mutateGeneSequence(parent.sequence, rng);
  // Strength scaled down to match the brain's Xavier-init weight range
  // (roughly ±0.2-0.3) rather than the old flat [-1,1] one — mutation
  // noise should perturb a weight, not routinely swamp it.
  return genomeFromSequence(sequence, parent.brain.mutate(rng, 0.12, 0.15));
}

/** Crossover of two same-lineage parents (for sexual reproduction). Core
 * loci are picked per-gene from one parent or the other (independent
 * assortment); the protein-gene run uses real unequal crossover — see
 * genes.ts's crossoverGeneSequence for why that's not just a convenient
 * mechanic. Brain crossover is unchanged. */
export function crossoverGenome(a: Genome, b: Genome, rng: Rng): Genome {
  const sequence = crossoverGeneSequence(a.sequence, b.sequence, rng);
  return genomeFromSequence(sequence, NeuralNet.crossover(a.brain, b.brain, rng));
}

// ---- save/restore ----------------------------------------------------------
// Everything in a Genome except `brain` is already plain, JSON-safe data
// (the gene sequence is just arrays of single-character strings, proteins
// are sequence/fold/angle records) — only the brain's Float32Arrays need
// converting on the way out and back.
export type SerializedGenome = Omit<Genome, 'brain'> & { brain: ReturnType<NeuralNet['toJSON']> };

export function serializeGenome(genome: Genome): SerializedGenome {
  return { ...genome, brain: genome.brain.toJSON() };
}

export function deserializeGenome(json: SerializedGenome): Genome {
  return { ...json, brain: NeuralNet.fromJSON(json.brain) };
}
