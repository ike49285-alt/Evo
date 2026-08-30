/**
 * Real gene-sequence genetics. genes[0..CORE_GENE_COUNT-1] are fixed-locus
 * core genes (one trait each, always present — like a conserved
 * single-copy gene). genes[CORE_GENE_COUNT..] is a *variable-length* run
 * of real protein-coding genes: each one translates through the actual
 * genetic code (chem/elements.ts's CODON_TABLE) into an amino-acid
 * sequence, which folds (chem/polymer.ts's foldPeptide — the exact
 * mechanism Stage 0's prebiotic chemistry already uses) into whatever
 * functional class its real surface chemistry happens to produce. There
 * is no catalog of organelle "kinds" to pick from anywhere in this file —
 * capability is discovered from the fold, not looked up from a table.
 *
 * The molecular thread is unbroken on purpose: a bootstrapped founder's
 * protein genes are literally built from its ancestral protocell's real
 * RNA (see chem/bridge.ts), translated by the same codon table, folded by
 * the same function Stage 0 uses on its own peptides.
 */
import { AminoAcidCode, CODON_TABLE, Codon, NucleotideCode, NUCLEOTIDE_CODES } from '../chem/elements.js';
import { CATALYSIS_CLASSES, foldPeptide } from '../chem/polymer.js';
import { CatalysisClass, ProteinPhenotype, ReproductionMode, TRAIT_LIMITS } from './types.js';
// Type-only, and it must stay that way: genome.ts imports this module, so a
// value import here would close a runtime cycle. `import type` is erased at
// compile time, leaving genomeDistance below reading two plain fields off a
// structure it never has to construct.
import type { Genome } from './genome.js';
import { Rng } from './rng.js';

export const GENE_LENGTH = 10; // symbols per core-locus gene
// 20 codons. The real genetic code's STOP codons are ~4.7% of the 64 (3
// of 64) — headless-verified this matters a lot at this length: a first
// attempt at 10 codons averaged only 7.83 real residues after STOP
// truncation, *below* chem/polymer.ts's own MIN_FOLD_LENGTH (8) on
// average, so most proteins never even attempted to fold. 20 codons
// gives the length distribution enough room to approach its natural
// geometric mean (~20 residues) before the gene boundary cuts it off,
// which is what a real, comfortably-foldable, occasionally-truncated
// protein population actually needs — still cheap to fold (same order of
// magnitude as Stage 0's own peptides).
export const PROTEIN_GENE_LENGTH = 60;
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

/** A deep copy: fresh outer array *and* a fresh array per gene. Sharing
 * matters here in a way it doesn't for most data in this project — a
 * living cell's own sequence object is, in two real cases, the very same
 * object as its lineage's speciation baseline (World.addSpeciesFromSequence
 * hands founder #0 the identical object it stored as
 * LineageInfo.referenceSequence; World.checkSpeciation stores the promoted
 * cell's own sequence as the new lineage's reference), and
 * crossoverGeneSequence splices parent Gene arrays in by reference. Any
 * caller that intends to *modify* a sequence rather than derive a new one
 * from it must start here — an in-place write would otherwise rewrite the
 * cell's own species baseline to match itself, pinning its genetic
 * distance from that baseline at 0 and silently disabling speciation for
 * the whole lineage. */
export function cloneGeneSequence(seq: GeneSequence): GeneSequence {
  return { genes: seq.genes.map((g) => [...g]) };
}

/** Every structural invariant a GeneSequence has always had but nothing
 * ever checked, because until the Tree tab's gene editor every sequence in
 * the program was produced by this file (randomGeneSequence /
 * mutateGeneSequence / crossoverGeneSequence) and provably satisfied them.
 * Returns a human-readable reason, or null if the sequence is sound —
 * deliberately not a throw, since its one caller wants to show the reason
 * inline rather than take down the frame.
 *
 * Worth the code despite the editor being structurally unable to violate
 * any of it (fixed gene count, fixed positions, symbols cycled within
 * NUCLEOTIDE_CODES): the blast radius if anything ever does is severe and
 * silent. decodeUnitFromSymbols scores an unknown symbol via
 * NUCLEOTIDE_CODES.indexOf -> -1, and lerp below is unclamped, so a single
 * stray symbol drives `size` negative — past TRAIT_LIMITS entirely — which
 * makes radius, maxEnergy and reproduceThreshold all negative and leaves
 * Virtunism.canReproduce() unconditionally true. A sequence shorter than
 * CORE_GENE_COUNT throws out of decodeCoreTraits instead.
 *
 * Deliberately NOT called from genomeFromSequence: that is the birth hot
 * path (every reproduction, every tick), where mutation and crossover
 * provably preserve these invariants, so a full-sequence scan there would
 * be real per-tick cost for no benefit. */
export function validateGeneSequence(seq: GeneSequence): string | null {
  if (seq.genes.length < CORE_GENE_COUNT) {
    return `A genome needs at least ${CORE_GENE_COUNT} core genes; this one has ${seq.genes.length}.`;
  }
  const proteinCount = seq.genes.length - CORE_GENE_COUNT;
  if (proteinCount > TRAIT_LIMITS.maxProteins) {
    return `A genome can carry at most ${TRAIT_LIMITS.maxProteins} protein genes; this one has ${proteinCount}.`;
  }
  for (let i = 0; i < seq.genes.length; i++) {
    const gene = seq.genes[i];
    const isCore = i < CORE_GENE_COUNT;
    const expected = isCore ? GENE_LENGTH : PROTEIN_GENE_LENGTH;
    const label = isCore ? `core gene ${i}` : `protein gene ${i - CORE_GENE_COUNT + 1}`;
    if (gene.length !== expected) {
      return `${label} must be ${expected} symbols long; it is ${gene.length}.`;
    }
    for (let j = 0; j < gene.length; j++) {
      // Runtime check against a value the type system already believes is
      // a NucleotideCode — the whole point is guarding a boundary the
      // types can't, so the widening cast is deliberate.
      if (!(NUCLEOTIDE_CODES as readonly string[]).includes(gene[j] as string)) {
        return `${label} carries an unknown symbol "${gene[j]}" at position ${j + 1}.`;
      }
    }
  }
  return null;
}

// --- decoding ------------------------------------------------------------
// Sum-based, not positional — every symbol contributes equally, so no
// single symbol dominates a decoded value (see the point-mutation-heavy-
// tail bug this fixed, documented in NOTES.md). Used for core traits and
// for a protein gene's rendering angle; translation to amino acids (below)
// is a completely separate, codon-based reading of the same symbols.
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

/** Translates a protein gene into a real amino-acid sequence via the
 * actual genetic code — reads codons left to right, stopping at the
 * gene's end or the first STOP, whichever comes first. A STOP introduced
 * early by a point mutation is a real, biologically grounded large-effect
 * mutation: it truncates the protein, which can easily wreck its ability
 * to fold at all (chem/polymer.ts gates folding on a minimum length) — a
 * genuine source of occasional large-effect mutations, not one hand-
 * injected to simulate the idea. */
export function translateProteinGene(gene: Gene): AminoAcidCode[] {
  const aminoAcids: AminoAcidCode[] = [];
  for (let i = 0; i + 3 <= gene.length; i += 3) {
    const codon = (gene[i] + gene[i + 1] + gene[i + 2]) as Codon;
    const residue = CODON_TABLE.get(codon);
    if (residue === undefined || residue === 'STOP') break;
    aminoAcids.push(residue);
  }
  return aminoAcids;
}

/** Decodes one protein gene into its full phenotype: real translation,
 * real fold, and a mount angle for rendering/vision-cone geometry. The
 * angle has no biological analog (real genes don't encode "a position
 * around the cell rim") — it's a Stage-1 rendering convenience, but still
 * a deterministic, heritable, mutable function of the gene's own content,
 * derived the same sum-based way core traits are, not a hidden extra
 * field bolted on separately. */
export function decodeProteinGene(gene: Gene): ProteinPhenotype {
  const sequence = translateProteinGene(gene);
  return {
    sequence,
    fold: foldPeptide(sequence),
    angle: decodeUnitFromSymbols(gene) * Math.PI * 2,
  };
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

/** Every protein gene, translated and folded — foldPeptide is memoized by
 * sequence, so calling this repeatedly on the same GeneSequence (as
 * geneticDistance below routinely does against a lineage's unchanging
 * reference sequence) only pays the real translate+fold cost once. */
export function decodeProteins(seq: GeneSequence): ProteinPhenotype[] {
  return seq.genes.slice(CORE_GENE_COUNT).map(decodeProteinGene);
}

// --- construction ----------------------------------------------------------
function randomGene(rng: Rng, length: number): Gene {
  const g: Gene = [];
  for (let i = 0; i < length; i++) g.push(rng.pick(NUCLEOTIDE_CODES));
  return g;
}

export function randomGeneSequence(rng: Rng, proteinGeneCount: number): GeneSequence {
  const count = Math.min(TRAIT_LIMITS.maxProteins, Math.max(0, proteinGeneCount));
  const genes: Gene[] = [];
  for (let i = 0; i < CORE_GENE_COUNT; i++) genes.push(randomGene(rng, GENE_LENGTH));
  for (let i = 0; i < count; i++) genes.push(randomGene(rng, PROTEIN_GENE_LENGTH));
  return { genes };
}

// --- mutation ----------------------------------------------------------
const POINT_MUTATION_RATE = 0.02; // per-symbol chance
const DUPLICATION_RATE = 0.05; // per-reproduction chance of one protein-gene duplication
const DELETION_RATE = 0.045; // per-reproduction chance of one protein-gene deletion
const INVERSION_RATE = 0.02; // per-reproduction chance of a short inversion

function pointMutateGene(gene: Gene, rng: Rng, rateMultiplier: number): Gene {
  return gene.map((symbol) => {
    if (!rng.bool(POINT_MUTATION_RATE * rateMultiplier)) return symbol;
    // A real point mutation substitutes a *different* base, not a reroll
    // that might land on the same one — otherwise the effective mutation
    // rate is silently 3/4 of the stated one.
    const others = NUCLEOTIDE_CODES.filter((c) => c !== symbol);
    return rng.pick(others);
  });
}

/** `pointMutationRateMultiplier` lets a DNA-genome parent's point
 * mutations happen at a real, reduced rate (see genome.ts's
 * DNA_MUTATION_RATE_MULTIPLIER) — structural mutations below
 * (duplication/deletion/inversion) are deliberately left at their normal
 * rate for now, a modest, single-lever first pass rather than reworking
 * every mutation type's fidelity at once. */
export function mutateGeneSequence(parent: GeneSequence, rng: Rng, pointMutationRateMultiplier = 1): GeneSequence {
  const coreGenes = parent.genes.slice(0, CORE_GENE_COUNT).map((g) => pointMutateGene(g, rng, pointMutationRateMultiplier));
  let proteinGenes = parent.genes.slice(CORE_GENE_COUNT).map((g) => pointMutateGene(g, rng, pointMutationRateMultiplier));

  // Structural mutations — the real mechanism for a body plan growing or
  // shrinking a protein-coding gene.
  if (proteinGenes.length > 0 && rng.bool(DUPLICATION_RATE) && proteinGenes.length < TRAIT_LIMITS.maxProteins) {
    const idx = rng.int(0, proteinGenes.length - 1);
    proteinGenes.splice(idx, 0, [...proteinGenes[idx]]);
  }
  if (proteinGenes.length > 0 && rng.bool(DELETION_RATE)) {
    proteinGenes.splice(rng.int(0, proteinGenes.length - 1), 1);
  }
  if (proteinGenes.length > 2 && rng.bool(INVERSION_RATE)) {
    const start = rng.int(0, proteinGenes.length - 2);
    const len = rng.int(2, Math.min(4, proteinGenes.length - start));
    const segment = proteinGenes.slice(start, start + len).reverse();
    proteinGenes.splice(start, len, ...segment);
  }
  if (proteinGenes.length > TRAIT_LIMITS.maxProteins) proteinGenes = proteinGenes.slice(0, TRAIT_LIMITS.maxProteins);

  return { genes: [...coreGenes, ...proteinGenes] };
}

/** Unequal crossover: an independent cut point in each parent's
 * protein-gene run, spliced together — the offspring's protein-gene count
 * doesn't have to match either parent's. This is itself a real biological
 * route to gene duplication/deletion, not just a crossover mechanic
 * borrowed for convenience. Core loci still assort independently. */
export function crossoverGeneSequence(a: GeneSequence, b: GeneSequence, rng: Rng): GeneSequence {
  const coreGenes: Gene[] = [];
  for (let i = 0; i < CORE_GENE_COUNT; i++) coreGenes.push(rng.bool(0.5) ? a.genes[i] : b.genes[i]);

  const aProtein = a.genes.slice(CORE_GENE_COUNT);
  const bProtein = b.genes.slice(CORE_GENE_COUNT);
  const aCut = Math.floor(rng.range(0, aProtein.length + 1));
  const bCut = Math.floor(rng.range(0, bProtein.length + 1));
  let proteinGenes = [...aProtein.slice(0, aCut), ...bProtein.slice(bCut)];
  if (proteinGenes.length > TRAIT_LIMITS.maxProteins) proteinGenes = proteinGenes.slice(0, TRAIT_LIMITS.maxProteins);

  return { genes: [...coreGenes, ...proteinGenes] };
}

// --- genetic distance (for speciation) --------------------------------
/** A deliberate proxy, not a rigorous population-genetics statistic: real
 * sequence alignment between two variable-length, independently-
 * duplicated/deleted gene runs is a much harder problem than this needed
 * to solve for a usable divergence signal. Combines (1) per-locus distance
 * over the core traits' decoded values and (2) an alignment-free distance
 * over protein *catalysis-class composition* (a histogram comparison of
 * what functional classes a genome's proteins actually fold into, not
 * exact positional matching). Symmetric, 0 for identical genomes, roughly
 * bounded to 0..1. */
export function geneticDistance(a: GeneSequence, b: GeneSequence): number {
  return distanceFromParts(a.genes, catalysisClassHistogram(a), b.genes, catalysisClassHistogram(b));
}

/** The same distance as `geneticDistance`, read off the class-count caches
 * every Genome already carries instead of re-translating and re-folding
 * every protein of both genomes.
 *
 * This exists because mate choice needs the measure *per candidate pair,
 * per tick* — `geneticDistance`'s fold cost is fine for speciation (once
 * per individual against one unchanging reference) and far too expensive
 * there. Measured at 49x faster over 2,000 pair evaluations (197ms -> 4ms),
 * and verified to agree with `geneticDistance` to 0.0 over 1,770 pairs:
 * `classCountCache` is built from `decodeProteins` by the very same
 * catalysis-class tally (genome.ts's computeClassCaches), so the histogram
 * it replaces is not an approximation of it — it is the same numbers,
 * already computed at birth. The caches list all six classes with explicit
 * zeros where the histogram simply omits them, which the `?? 0` and
 * `Math.max` below already treat identically.
 *
 * Both entry points route through one shared formula deliberately: the
 * mating rule and the speciation rule read the same threshold, so a change
 * to one that silently failed to reach the other would make individuals
 * that count as one species unable to interbreed, or the reverse. */
export function genomeDistance(a: Genome, b: Genome): number {
  return distanceFromParts(a.sequence.genes, a.classCountCache, b.sequence.genes, b.classCountCache);
}

type ClassTally = Readonly<Partial<Record<CatalysisClass, number>>>;

function distanceFromParts(aGenes: readonly Gene[], aTally: ClassTally, bGenes: readonly Gene[], bTally: ClassTally): number {
  let coreDist = 0;
  for (let i = 0; i < CORE_GENE_COUNT; i++) coreDist += Math.abs(decodeUnit(aGenes[i]) - decodeUnit(bGenes[i]));
  coreDist /= CORE_GENE_COUNT;

  let diff = 0;
  let maxTotal = 0;
  for (const cls of CATALYSIS_CLASSES) {
    diff += Math.abs((aTally[cls] ?? 0) - (bTally[cls] ?? 0));
    maxTotal += Math.max(aTally[cls] ?? 0, bTally[cls] ?? 0);
  }
  const proteinDist = maxTotal > 0 ? diff / (2 * maxTotal) : 0;

  return 0.5 * coreDist + 0.5 * proteinDist;
}

function catalysisClassHistogram(seq: GeneSequence): Partial<Record<CatalysisClass, number>> {
  const hist: Partial<Record<CatalysisClass, number>> = {};
  for (const protein of decodeProteins(seq)) {
    const cls = protein.fold.catalysisClass;
    if (cls === null) continue;
    hist[cls] = (hist[cls] ?? 0) + 1;
  }
  return hist;
}
