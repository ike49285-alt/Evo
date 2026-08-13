/**
 * Real gene-sequence genetics — replaces the old flat "jitter five
 * independent fields" genome with an actual linear sequence, mutated by
 * biologically-grounded operators, that a virtunism's real phenotype gets
 * *decoded* from (see genome.ts's decodePhenotype).
 *
 * Genes are made of the same 4-letter nucleotide alphabet Stage 0's RNA
 * uses (see chem/elements.ts) — not a coincidence or convenience reuse: a
 * bootstrapped founder's genes are literally built from its ancestral
 * protocell's real RNA sequence (see chem/bridge.ts), so there's an
 * unbroken molecular thread from the primordial pool into every
 * virtunism's heredity, not just a spatial one.
 *
 * Layout: genes[0..CORE_GENE_COUNT-1] are fixed-locus core genes (one
 * trait each, always present, always in the same position — like a
 * conserved single-copy gene in a real genome). genes[CORE_GENE_COUNT..]
 * is a *variable-length* run of organelle genes — variable length is the
 * whole point: organelle count/composition evolves through real
 * duplication and deletion, not a hand-rolled "5% chance to lose one, 6%
 * chance to gain one" special case.
 */
import { NucleotideCode, NUCLEOTIDE_CODES } from '../chem/elements.js';
import { Organelle, OrganelleKind, ReproductionMode, TRAIT_LIMITS } from './types.js';
import { Rng } from './rng.js';

export const GENE_LENGTH = 10; // symbols per gene locus
export type Gene = NucleotideCode[];

export const LOCUS = {
  size: 0,
  senseRadius: 1,
  maxAge: 2,
  hue: 3,
  reproductionMode: 4,
} as const;
export const CORE_GENE_COUNT = 5;

export interface GeneSequence {
  genes: Gene[];
}

// --- decoding ------------------------------------------------------------
// Deterministic decode — the same "sequence determines outcome" principle
// chem/polymer.ts's folding uses (Anfinsen's dogma), just applied to a
// whole-organism trait instead of a protein shape. Sum-based, not
// place-value/positional: every symbol contributes equally (0-3 out of a
// 0-3*length total), so no single symbol dominates the decoded value. This
// matters for mutation realism — an earlier positional (base-4 "big
// endian") version let a single point mutation to the first symbol swing
// the decoded trait by up to 75% of its whole range, which in practice
// meant one lucky/unlucky mutation, not sustained drift, was deciding
// genetic distance — headless verification caught this directly: with
// positional decoding, checkSpeciation fired on nearly every reproduction
// instead of being a rare event, because the offline threshold calibration
// (an *average* over many generations) didn't account for that single-
// mutation heavy tail. Sum-based decoding caps one point mutation's effect
// on a locus to roughly 1/length of its range — much closer to a real
// polygenic, many-small-effect-loci model, and to what the speciation
// threshold was actually calibrated against once this was fixed.
function decodeUnitFromSymbols(symbols: readonly NucleotideCode[]): number {
  let acc = 0;
  for (const s of symbols) acc += NUCLEOTIDE_CODES.indexOf(s);
  const max = symbols.length * (NUCLEOTIDE_CODES.length - 1);
  return max > 0 ? acc / max : 0;
}

export function decodeUnit(gene: Gene): number {
  return decodeUnitFromSymbols(gene);
}

function lerp(unit: number, min: number, max: number): number {
  return min + unit * (max - min);
}

// Weighted, not uniform — a real mutation/expression landscape isn't flat
// either, and this preserves the original design's intent that budding
// (discovering multicellularity) is a rare structural event, not an
// ordinary one-in-six organelle outcome.
const ORGANELLE_WEIGHTS: Array<{ kind: OrganelleKind; weight: number }> = [
  { kind: 'flagellum', weight: 5 },
  { kind: 'mouth', weight: 5 },
  { kind: 'chloroplast', weight: 5 },
  { kind: 'eye', weight: 4 },
  { kind: 'armor', weight: 4 },
  { kind: 'bud', weight: 1 },
];
const ORGANELLE_WEIGHT_TOTAL = ORGANELLE_WEIGHTS.reduce((sum, o) => sum + o.weight, 0);

function decodeOrganelleKind(unit: number): OrganelleKind {
  let acc = unit * ORGANELLE_WEIGHT_TOTAL;
  for (const { kind, weight } of ORGANELLE_WEIGHTS) {
    if (acc < weight) return kind;
    acc -= weight;
  }
  return ORGANELLE_WEIGHTS[ORGANELLE_WEIGHTS.length - 1].kind;
}

export function decodeOrganelleGene(gene: Gene): Organelle {
  const kind = decodeOrganelleKind(decodeUnitFromSymbols(gene.slice(0, 2)));
  const angle = decodeUnitFromSymbols(gene.slice(2, 6)) * Math.PI * 2;
  const size = lerp(decodeUnitFromSymbols(gene.slice(6, 10)), TRAIT_LIMITS.organelleSize.min, TRAIT_LIMITS.organelleSize.max);
  return { kind, angle, size };
}

export interface DecodedCoreTraits {
  reproductionMode: ReproductionMode;
  size: number;
  senseRadius: number;
  maxAge: number;
  hue: number;
}

export function decodeCoreTraits(seq: GeneSequence): DecodedCoreTraits {
  return {
    reproductionMode: decodeUnit(seq.genes[LOCUS.reproductionMode]) < 0.5 ? 'asexual' : 'sexual',
    size: lerp(decodeUnit(seq.genes[LOCUS.size]), TRAIT_LIMITS.size.min, TRAIT_LIMITS.size.max),
    senseRadius: lerp(decodeUnit(seq.genes[LOCUS.senseRadius]), TRAIT_LIMITS.senseRadius.min, TRAIT_LIMITS.senseRadius.max),
    maxAge: lerp(decodeUnit(seq.genes[LOCUS.maxAge]), TRAIT_LIMITS.maxAge.min, TRAIT_LIMITS.maxAge.max),
    hue: decodeUnit(seq.genes[LOCUS.hue]) * 360,
  };
}

export function decodeOrganelles(seq: GeneSequence): Organelle[] {
  return seq.genes.slice(CORE_GENE_COUNT).map(decodeOrganelleGene);
}

// --- construction ----------------------------------------------------------
function randomGene(rng: Rng): Gene {
  const g: Gene = [];
  for (let i = 0; i < GENE_LENGTH; i++) g.push(rng.pick(NUCLEOTIDE_CODES));
  return g;
}

export function randomGeneSequence(rng: Rng, organelleGeneCount: number): GeneSequence {
  const count = CORE_GENE_COUNT + Math.min(TRAIT_LIMITS.maxOrganelles, Math.max(0, organelleGeneCount));
  const genes: Gene[] = [];
  for (let i = 0; i < count; i++) genes.push(randomGene(rng));
  return { genes };
}

// --- mutation ----------------------------------------------------------
const POINT_MUTATION_RATE = 0.02; // per-symbol chance
const DUPLICATION_RATE = 0.05; // per-reproduction chance of one organelle-gene duplication
const DELETION_RATE = 0.045; // per-reproduction chance of one organelle-gene deletion
const INVERSION_RATE = 0.02; // per-reproduction chance of a short inversion

function pointMutateGene(gene: Gene, rng: Rng): Gene {
  return gene.map((symbol) => {
    if (!rng.bool(POINT_MUTATION_RATE)) return symbol;
    // A real point mutation substitutes a *different* base, not a reroll
    // that might land on the same one — otherwise the effective mutation
    // rate is silently 3/4 of the stated one.
    const others = NUCLEOTIDE_CODES.filter((c) => c !== symbol);
    return rng.pick(others);
  });
}

export function mutateGeneSequence(parent: GeneSequence, rng: Rng): GeneSequence {
  const coreGenes = parent.genes.slice(0, CORE_GENE_COUNT).map((g) => pointMutateGene(g, rng));
  let organelleGenes = parent.genes.slice(CORE_GENE_COUNT).map((g) => pointMutateGene(g, rng));

  // Structural mutations — the real mechanism for a body plan growing or
  // shrinking an organelle, replacing the old genome.ts special case.
  if (organelleGenes.length > 0 && rng.bool(DUPLICATION_RATE) && organelleGenes.length < TRAIT_LIMITS.maxOrganelles) {
    const idx = rng.int(0, organelleGenes.length - 1);
    organelleGenes.splice(idx, 0, [...organelleGenes[idx]]);
  }
  if (organelleGenes.length > 0 && rng.bool(DELETION_RATE)) {
    organelleGenes.splice(rng.int(0, organelleGenes.length - 1), 1);
  }
  if (organelleGenes.length > 2 && rng.bool(INVERSION_RATE)) {
    const start = rng.int(0, organelleGenes.length - 2);
    const len = rng.int(2, Math.min(4, organelleGenes.length - start));
    const segment = organelleGenes.slice(start, start + len).reverse();
    organelleGenes.splice(start, len, ...segment);
  }
  if (organelleGenes.length > TRAIT_LIMITS.maxOrganelles) organelleGenes = organelleGenes.slice(0, TRAIT_LIMITS.maxOrganelles);

  return { genes: [...coreGenes, ...organelleGenes] };
}

/** Unequal crossover: an independent cut point in each parent's
 * organelle-gene run, spliced together — the offspring's organelle count
 * doesn't have to match either parent's. This isn't just a crossover
 * mechanic borrowed for convenience: unequal crossover is itself a real
 * biological route to gene duplication/deletion, so sexual reproduction
 * gets a second, independent source of structural variation beyond
 * ordinary mutation. Core loci are still picked per-locus (independent
 * assortment of unlinked genes), same model as before. */
export function crossoverGeneSequence(a: GeneSequence, b: GeneSequence, rng: Rng): GeneSequence {
  const coreGenes: Gene[] = [];
  for (let i = 0; i < CORE_GENE_COUNT; i++) coreGenes.push(rng.bool(0.5) ? a.genes[i] : b.genes[i]);

  const aOrganelle = a.genes.slice(CORE_GENE_COUNT);
  const bOrganelle = b.genes.slice(CORE_GENE_COUNT);
  const aCut = Math.floor(rng.range(0, aOrganelle.length + 1));
  const bCut = Math.floor(rng.range(0, bOrganelle.length + 1));
  let organelleGenes = [...aOrganelle.slice(0, aCut), ...bOrganelle.slice(bCut)];
  if (organelleGenes.length > TRAIT_LIMITS.maxOrganelles) organelleGenes = organelleGenes.slice(0, TRAIT_LIMITS.maxOrganelles);

  return { genes: [...coreGenes, ...organelleGenes] };
}

// --- genetic distance (for speciation) --------------------------------
/** A deliberate proxy, not a rigorous population-genetics statistic: real
 * sequence alignment between two variable-length, independently-
 * duplicated/deleted gene runs is a much harder problem (edit distance /
 * alignment) than this project needs to solve to get a *usable*
 * divergence signal. Combines (1) per-locus distance over the core traits'
 * decoded values and (2) an alignment-free distance over organelle-kind
 * *composition* (a histogram comparison, not exact positional matching).
 * Symmetric, 0 for identical genomes, roughly bounded to 0..1. */
export function geneticDistance(a: GeneSequence, b: GeneSequence): number {
  let coreDist = 0;
  for (let i = 0; i < CORE_GENE_COUNT; i++) coreDist += Math.abs(decodeUnit(a.genes[i]) - decodeUnit(b.genes[i]));
  coreDist /= CORE_GENE_COUNT;

  const histA = organelleKindHistogram(a);
  const histB = organelleKindHistogram(b);
  let diff = 0;
  let maxTotal = 0;
  for (const { kind } of ORGANELLE_WEIGHTS) {
    diff += Math.abs((histA[kind] ?? 0) - (histB[kind] ?? 0));
    maxTotal += Math.max(histA[kind] ?? 0, histB[kind] ?? 0);
  }
  const organelleDist = maxTotal > 0 ? diff / (2 * maxTotal) : 0;

  return 0.5 * coreDist + 0.5 * organelleDist;
}

function organelleKindHistogram(seq: GeneSequence): Partial<Record<OrganelleKind, number>> {
  const hist: Partial<Record<OrganelleKind, number>> = {};
  for (const organelle of decodeOrganelles(seq)) {
    hist[organelle.kind] = (hist[organelle.kind] ?? 0) + 1;
  }
  return hist;
}
