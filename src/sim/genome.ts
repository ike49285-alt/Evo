import { NeuralNet } from './nn.js';
import { Rng } from './rng.js';
import { BRAIN_TOPOLOGY, Organelle, OrganelleKind, ReproductionMode, TRAIT_LIMITS } from './types.js';
import {
  CORE_GENE_COUNT,
  crossoverGeneSequence,
  decodeCoreTraits,
  decodeOrganelles,
  Gene,
  GENE_LENGTH,
  GeneSequence,
  LOCUS,
  mutateGeneSequence,
  randomGeneSequence,
} from './genes.js';
import { NUCLEOTIDE_CODES } from '../chem/elements.js';

export { TRAIT_LIMITS };

/**
 * A virtunism's real heredity is `sequence` (see genes.ts) — everything
 * else here (`size`, `organelles`, etc.) is a *cached decode* of it,
 * refreshed by `decodePhenotype` every time the sequence changes
 * (construction, mutation, crossover). This is deliberate: it means
 * Virtunism, World, and the renderer never had to change — they still
 * just read `genome.size` / `genome.organelles` exactly as before. Only
 * genome *construction* got deeper.
 */
export interface Genome {
  sequence: GeneSequence;
  reproductionMode: ReproductionMode;
  size: number; // chassis scale — base body radius/energy budget, independent of organelles
  senseRadius: number; // detection *range*; organelle "eyes" separately control detection *angle*
  maxAge: number; // lifespan in ticks before death of old age
  hue: number; // 0-360, cosmetic + lets you track lineages visually
  organelles: Organelle[];
  brain: NeuralNet;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function decodePhenotype(sequence: GeneSequence): Omit<Genome, 'sequence' | 'brain'> {
  return { ...decodeCoreTraits(sequence), organelles: decodeOrganelles(sequence) };
}

// ---- derived physical stats (computed from organelles, not stored) --------

function organellesOf(genome: Genome, kind: OrganelleKind): Organelle[] {
  return genome.organelles.filter((o) => o.kind === kind);
}

function powerOf(genome: Genome, kind: OrganelleKind): number {
  let sum = 0;
  for (const o of genome.organelles) if (o.kind === kind) sum += o.size;
  return sum;
}

/** Top speed a virtunism's flagella can push it to. Zero flagella = nearly
 * sessile (a real strategy for a photosynthesizer that doesn't need to
 * chase anything), not literally frozen. */
export function deriveMaxSpeed(genome: Genome): number {
  return 0.05 + Math.sqrt(powerOf(genome, 'flagellum')) * 0.85;
}

/** More flagella spread around the rim = a more maneuverable body. */
export function deriveTurnRate(genome: Genome): number {
  return 0.08 + Math.min(0.25, organellesOf(genome, 'flagellum').length * 0.03);
}

export function deriveFlagellaPower(genome: Genome): number {
  return powerOf(genome, 'flagellum');
}

export function deriveMouthCount(genome: Genome): number {
  return organellesOf(genome, 'mouth').length;
}

export function deriveMouthPower(genome: Genome): number {
  return powerOf(genome, 'mouth');
}

/** Passive energy/tick from ambient light — the "plant" income stream. */
export function derivePhotosynthesis(genome: Genome): number {
  return powerOf(genome, 'chloroplast') * 0.05;
}

export function deriveChloroplastPower(genome: Genome): number {
  return powerOf(genome, 'chloroplast');
}

/** Armor makes a virtunism read as effectively bigger/tougher to predators
 * without paying full chassis-size energy cost for the same protection. */
export function deriveArmorBonus(genome: Genome): number {
  return 1 + powerOf(genome, 'armor') * 0.15;
}

export function deriveArmorMitigation(genome: Genome): number {
  return Math.min(0.5, powerOf(genome, 'armor') * 0.12);
}

export function deriveEyes(genome: Genome): Organelle[] {
  return organellesOf(genome, 'eye');
}

export function hasBud(genome: Genome): boolean {
  return genome.organelles.some((o) => o.kind === 'bud');
}

// ---- construction & evolution ----------------------------------------------

export interface StarterLoadout {
  flagella?: number;
  mouths?: number;
  chloroplasts?: number;
  eyes?: number;
  armor?: number;
  bud?: boolean;
}

/** Builds an evenly-spaced starter organelle ring from simple per-kind
 * counts — this is what the Designer UI hands to World.addSpecies(). Still
 * plain Organelle data; `encodeOrganelleGene` (below) is what turns a
 * desired organelle back into real gene symbols when a hand-designed
 * species needs an actual heritable sequence to start from. */
export function buildOrganelles(loadout: StarterLoadout): Organelle[] {
  const list: { kind: OrganelleKind }[] = [];
  for (let i = 0; i < (loadout.flagella ?? 0); i++) list.push({ kind: 'flagellum' });
  for (let i = 0; i < (loadout.mouths ?? 0); i++) list.push({ kind: 'mouth' });
  for (let i = 0; i < (loadout.chloroplasts ?? 0); i++) list.push({ kind: 'chloroplast' });
  for (let i = 0; i < (loadout.eyes ?? 0); i++) list.push({ kind: 'eye' });
  for (let i = 0; i < (loadout.armor ?? 0); i++) list.push({ kind: 'armor' });
  if (loadout.bud) list.push({ kind: 'bud' });

  return list.slice(0, TRAIT_LIMITS.maxOrganelles).map((o, i, arr) => ({
    kind: o.kind,
    angle: (i / Math.max(1, arr.length)) * Math.PI * 2,
    size: 1.0,
  }));
}

// ---- encoding: trait/organelle -> gene symbols -----------------------------
// The inverse of genes.ts's decode functions — needed wherever a *desired*
// phenotype (the Designer form, a bootstrapped protocell's translated
// stats) has to become a real starting sequence, not just the other way
// around. Matches genes.ts's sum-based (not positional) decode: greedily
// hands out the max symbol value (3) to as many positions as the target
// sum needs, zeros the rest — any distribution across positions that adds
// up to the right sum decodes correctly, this is just *a* valid one, not
// the only one. Round-trips approximately (decode is quantized to
// length*3 discrete sums), which is plenty for a starting point that
// mutation immediately starts drifting anyway.
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

// Mirrors genes.ts's weighted organelle-kind buckets — kept in sync by
// hand since it's a small, stable table, not worth a shared-state
// abstraction for six entries.
const ORGANELLE_KIND_BUCKETS: Array<{ kind: OrganelleKind; weight: number }> = [
  { kind: 'flagellum', weight: 5 },
  { kind: 'mouth', weight: 5 },
  { kind: 'chloroplast', weight: 5 },
  { kind: 'eye', weight: 4 },
  { kind: 'armor', weight: 4 },
  { kind: 'bud', weight: 1 },
];
const ORGANELLE_WEIGHT_TOTAL = ORGANELLE_KIND_BUCKETS.reduce((sum, o) => sum + o.weight, 0);

function kindToUnit(kind: OrganelleKind): number {
  let acc = 0;
  for (const bucket of ORGANELLE_KIND_BUCKETS) {
    if (bucket.kind === kind) return (acc + bucket.weight / 2) / ORGANELLE_WEIGHT_TOTAL; // bucket midpoint
    acc += bucket.weight;
  }
  return 0;
}

export function encodeOrganelleGene(organelle: Organelle): Gene {
  const kindUnit = kindToUnit(organelle.kind);
  // JS `%` can return a negative result for a negative angle, but only
  // ever needs *one* correction back into [0, 2π) — adding a full turn
  // unconditionally (rather than only when negative) overshoots past 2π
  // for any already-positive angle, which encodeUnit's clamp then
  // silently flattens to 1.0 regardless of the real value.
  let angleMod = organelle.angle % (Math.PI * 2);
  if (angleMod < 0) angleMod += Math.PI * 2;
  const angleUnit = angleMod / (Math.PI * 2);
  const sizeUnit = (organelle.size - TRAIT_LIMITS.organelleSize.min) / (TRAIT_LIMITS.organelleSize.max - TRAIT_LIMITS.organelleSize.min);
  return [...encodeUnit(kindUnit, 2), ...encodeUnit(angleUnit, 4), ...encodeUnit(sizeUnit, 4)];
}

export interface CoreTraitValues {
  reproductionMode: ReproductionMode;
  size: number;
  senseRadius: number;
  maxAge: number;
  hue: number;
}

/** Builds a real GeneSequence from a desired phenotype — used to seed a
 * hand-designed (Designer tab) or template-translated (bootstrap) species
 * with genes that actually decode to what was asked for, rather than
 * inventing a phenotype that bypasses genetics entirely. */
export function encodeGeneSequence(traits: CoreTraitValues, organelles: readonly Organelle[]): GeneSequence {
  const core: Gene[] = new Array(CORE_GENE_COUNT);
  core[LOCUS.reproductionMode] = encodeUnit(traits.reproductionMode === 'sexual' ? 0.75 : 0.25, GENE_LENGTH);
  core[LOCUS.size] = encodeUnit((traits.size - TRAIT_LIMITS.size.min) / (TRAIT_LIMITS.size.max - TRAIT_LIMITS.size.min), GENE_LENGTH);
  core[LOCUS.senseRadius] = encodeUnit(
    (traits.senseRadius - TRAIT_LIMITS.senseRadius.min) / (TRAIT_LIMITS.senseRadius.max - TRAIT_LIMITS.senseRadius.min),
    GENE_LENGTH,
  );
  core[LOCUS.maxAge] = encodeUnit((traits.maxAge - TRAIT_LIMITS.maxAge.min) / (TRAIT_LIMITS.maxAge.max - TRAIT_LIMITS.maxAge.min), GENE_LENGTH);
  core[LOCUS.hue] = encodeUnit(((traits.hue % 360) + 360) % 360 / 360, GENE_LENGTH);

  const organelleGenes = organelles.slice(0, TRAIT_LIMITS.maxOrganelles).map(encodeOrganelleGene);
  return { genes: [...core, ...organelleGenes] };
}

/** Builds a Genome straight from an already-real gene sequence (no
 * trait->encode step) — the bootstrap path (chem/bridge.ts) uses this
 * directly since its sequence is built from a protocell's actual RNA
 * content, not a desired phenotype to encode. */
export function genomeFromSequence(sequence: GeneSequence, brain: NeuralNet): Genome {
  return { sequence, brain, ...decodePhenotype(sequence) };
}

/** Builds a full Genome from a desired phenotype — the entry point for
 * anywhere a species starts from a *template* rather than being born
 * (World.addSpecies, both the hand-designed and bootstrapped-from-RNA
 * paths): encode the requested traits/organelles into real genes, then
 * decode straight back so the returned Genome's cached phenotype fields
 * always match what its own sequence actually says. */
export function buildGenome(traits: CoreTraitValues, organelles: readonly Organelle[], brain: NeuralNet): Genome {
  return genomeFromSequence(encodeGeneSequence(traits, organelles), brain);
}

export function randomGenome(rng: Rng, reproductionMode: ReproductionMode = 'asexual'): Genome {
  const organelleCount = rng.int(2, 6);
  let sequence = randomGeneSequence(rng, organelleCount);
  // Random core genes decode to a random reproductionMode too (it's a real
  // evolvable locus now — see genes.ts's LOCUS.reproductionMode) — override
  // just that one gene so callers that ask for a specific starting mode
  // (most of them do) actually get it, without hand-rolling the rest of
  // the sequence themselves.
  sequence = { genes: [encodeUnit(reproductionMode === 'sexual' ? 0.75 : 0.25, GENE_LENGTH), ...sequence.genes.slice(1)] };
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
 * assortment); the organelle-gene run uses real unequal crossover — see
 * genes.ts's crossoverGeneSequence for why that's not just a convenient
 * mechanic. Brain crossover is unchanged. */
export function crossoverGenome(a: Genome, b: Genome, rng: Rng): Genome {
  const sequence = crossoverGeneSequence(a.sequence, b.sequence, rng);
  return genomeFromSequence(sequence, NeuralNet.crossover(a.brain, b.brain, rng));
}

// ---- save/restore ----------------------------------------------------------
// Everything in a Genome except `brain` is already plain, JSON-safe data
// (the gene sequence is just arrays of single-character strings, organelles
// are kind/angle/size records) — only the brain's Float32Arrays need
// converting on the way out and back.
export type SerializedGenome = Omit<Genome, 'brain'> & { brain: ReturnType<NeuralNet['toJSON']> };

export function serializeGenome(genome: Genome): SerializedGenome {
  return { ...genome, brain: genome.brain.toJSON() };
}

export function deserializeGenome(json: SerializedGenome): Genome {
  return { ...json, brain: NeuralNet.fromJSON(json.brain) };
}
