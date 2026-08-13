/**
 * The handoff from Stage 0 (chemistry) to the existing organelle/Virtunism
 * dish: once a protocell in Origin clears the bootstrap bar (see
 * vesicle.ts's isBootstrapEligible), this turns *what it actually evolved*
 * — its own real RNA content, plus which catalyst classes its peptides
 * settled into — into a founding GeneSequence for World.addSpeciesFromSequence.
 *
 * The genetic thread is literal, not just spatial: genes.ts's Gene is
 * already `NucleotideCode[]`, the exact same 4-letter alphabet Stage 0's
 * RNA is made of (see chem/elements.ts) — so a founder's genes here are
 * built by chunking its ancestral protocell's surviving RNA nucleotide
 * sequences directly into GENE_LENGTH-sized genes, not translated through
 * an abstract stat/loadout struct. "From abiogenesis through evolving
 * life" is meant to be an unbroken molecular sequence, not a resemblance.
 *
 * The catalyst-class reasoning from the original stat-translation design
 * isn't thrown away — it still decides *how many* organelle genes a
 * founder gets (a lineage that evolved strong replicase, protease, etc.
 * still earns a bigger body plan), it just no longer invents the gene
 * content itself:
 *  - `peptidyl` catalysts build biomass from raw monomers + ambient
 *    energy — the closest thing this soup has to anabolism, so they lean
 *    the organelle count toward more chloroplast-decoding genes surviving
 *    the cut.
 *  - `protease` catalysts break external polymers down into usable
 *    pieces — literal digestion, so they lean toward mouths.
 *  - `lipidsynthase` catalysts work at the membrane — structural
 *    upkeep, so they lean toward armor.
 *  - `replicase` catalysts are what made heredity possible at all; they
 *    don't map to a body part, they map to a small mobility baseline,
 *    since a lineage that solved replication well earns a real head
 *    start.
 * This is a deliberate, documented translation, not a claim that real
 * biology encodes a genetic code or codon translation this way (that gap
 * is exactly what NOTES.md's honesty section flags, not quietly assumes).
 */
import { encodeOrganelleGene, encodeUnit } from '../sim/genome.js';
import { CORE_GENE_COUNT, Gene, GENE_LENGTH, GeneSequence, LOCUS, decodeOrganelles } from '../sim/genes.js';
import { TRAIT_LIMITS } from '../sim/types.js';
import { CatalysisClass } from './polymer.js';
import { BootstrapCandidate } from './origin.js';
import { NucleotideCode } from './elements.js';

/** All of a protocell's real surviving RNA content, concatenated into one
 * symbol stream — the raw material every one of its founder's genes gets
 * built from. Order follows `candidate.rnas` (insertion order into the
 * vesicle's member set); there's no principled reason to sort it, and an
 * arbitrary-but-deterministic order is exactly as real as any other. */
function flattenRnaSymbols(candidate: BootstrapCandidate): NucleotideCode[] {
  const symbols: NucleotideCode[] = [];
  for (const r of candidate.rnas) symbols.push(...r.sequence);
  return symbols;
}

/** Draws `count` real genes out of a symbol stream, wrapping back to the
 * start once it runs out. A short-lived protocell might only have a
 * handful of real nucleotides total (`MIN_TEMPLATE_LENGTH` is just 6,
 * well under one `GENE_LENGTH`-10 gene) — wrapping means every founder
 * still gets a full, valid gene sequence built entirely from its own real
 * content, just re-read more than once, rather than ever padding with
 * invented symbols. `symbols` is guaranteed non-empty here: a candidate
 * only exists because `isBootstrapEligible` already required a live
 * replicator RNA inside the vesicle. */
function drawGenesFromSymbols(symbols: readonly NucleotideCode[], count: number): Gene[] {
  const genes: Gene[] = [];
  let cursor = 0;
  for (let g = 0; g < count; g++) {
    const gene: NucleotideCode[] = [];
    for (let i = 0; i < GENE_LENGTH; i++) {
      gene.push(symbols[cursor % symbols.length]);
      cursor++;
    }
    genes.push(gene);
  }
  return genes;
}

export interface TranslatedFounder {
  sequence: GeneSequence;
  originVesicleId: number;
}

export function translateBootstrapCandidate(candidate: BootstrapCandidate): TranslatedFounder {
  const strength: Record<CatalysisClass, number> = {
    replicase: 0,
    peptidyl: 0,
    lipidsynthase: 0,
    protease: 0,
  };
  for (const p of candidate.peptides) {
    if (p.fold.isCatalyst && p.fold.catalysisClass) {
      strength[p.fold.catalysisClass] += p.fold.catalysisStrength;
    }
  }
  for (const r of candidate.rnas) {
    if (r.fold.isRibozyme) strength.replicase += r.fold.catalysisStrength;
  }

  let chloroplastLean = Math.round(strength.peptidyl * 3);
  let mouthLean = Math.round(strength.protease * 3);
  const armorLean = Math.round(strength.lipidsynthase * 2);
  const flagellaLean = 1 + (strength.replicase > 0.15 ? 1 : 0);
  const eyeLean = 1; // minimal sensing from the start — a totally blind founder starves before selection gets a say

  // A founder that can neither eat nor photosynthesize is a guaranteed,
  // uninteresting extinction — not a real evolutionary outcome, just a
  // translation-layer failure to seed anything workable.
  if (chloroplastLean === 0 && mouthLean === 0) chloroplastLean = 1;

  const organelleGeneCount = Math.min(TRAIT_LIMITS.maxOrganelles, flagellaLean + mouthLean + chloroplastLean + eyeLean + armorLean);

  const rnaSymbols = flattenRnaSymbols(candidate);
  const totalGenes = CORE_GENE_COUNT + organelleGeneCount;
  const genes = drawGenesFromSymbols(rnaSymbols, totalGenes);

  // Bootstrap founders start asexual — sexual reproduction is a later
  // evolutionary innovation, not a Stage 0 starting point — overriding
  // just that one real-but-arbitrary locus rather than the rest of the
  // RNA-derived sequence.
  genes[LOCUS.reproductionMode] = encodeUnit(0.25, GENE_LENGTH);

  // The catalyst-lean counts decided *how many* organelle genes this
  // founder gets; the genes themselves are real RNA-derived content, so
  // whatever kinds they actually decode to is what the protocell's own
  // chemistry produced — not guaranteed to match the lean. Preserve just
  // the one hard viability guarantee the original stat-translation had:
  // a founder needs at least one way to get energy. If real content
  // happened to decode to zero mouths and zero chloroplasts, patch the
  // single most-redundant-looking organelle gene into a chloroplast
  // rather than leaving a founder that starves on arrival no matter what
  // it does.
  const organelleGenes = genes.slice(CORE_GENE_COUNT);
  const decoded = decodeOrganelles({ genes: organelleGenes });
  const hasEnergyIntake = decoded.some((o) => o.kind === 'mouth' || o.kind === 'chloroplast');
  if (!hasEnergyIntake && organelleGenes.length > 0) {
    const patchIdx = CORE_GENE_COUNT + (organelleGenes.length - 1);
    genes[patchIdx] = encodeOrganelleGene({ kind: 'chloroplast', angle: 0, size: 1 });
  }

  const sequence: GeneSequence = { genes };

  return {
    sequence,
    originVesicleId: candidate.vesicleId,
  };
}
