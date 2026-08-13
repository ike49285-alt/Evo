/**
 * The handoff from Stage 0 (chemistry) to the Virtunism dish: once a
 * protocell in Origin clears the bootstrap bar (see vesicle.ts's
 * isBootstrapEligible), its own real surviving RNA content becomes a
 * founding GeneSequence directly — no heuristic translation layer in
 * between. This got dramatically simpler than an earlier version once
 * genome.ts stopped decoding genes into a fixed organelle catalog: there's
 * nothing left to *lean* a founder's protein-gene count toward (no
 * chloroplast/mouth/armor buckets to aim for), so this just wraps the
 * protocell's real RNA into as many real protein genes as its own content
 * actually supports, then lets translation + folding (see sim/genes.ts,
 * chem/polymer.ts) decide what those genes are actually good for — same as
 * every other genome in this dish.
 *
 * The genetic thread is literal: `sim/genes.ts`'s `Gene` is
 * `NucleotideCode[]`, the exact same 4-letter alphabet Stage 0's RNA is
 * made of. A founder's genes here are chunks of its ancestral protocell's
 * surviving RNA nucleotide sequence, read through the same codon table
 * and folded by the same function every other virtunism's genes are.
 * "From abiogenesis through evolving life" is an unbroken molecular
 * sequence, not a resemblance.
 */
import { encodeUnit, prioritizeFounderGenes, trimToProteinCap } from '../sim/genome.js';
import { CORE_GENE_COUNT, decodeProteinGene, Gene, GENE_LENGTH, GeneSequence, LOCUS, PROTEIN_GENE_LENGTH } from '../sim/genes.js';
import { TRAIT_LIMITS } from '../sim/types.js';
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

/** Draws `count` genes of `geneLength` symbols each out of a symbol
 * stream, wrapping back to the start once it runs out. A short-lived
 * protocell might only have a handful of real nucleotides total
 * (`MIN_TEMPLATE_LENGTH` is just 6) — wrapping means every founder still
 * gets a full, valid gene sequence built entirely from its own real
 * content, just re-read more than once, rather than ever padding with
 * invented symbols. `symbols` is guaranteed non-empty here: a candidate
 * only exists because `isBootstrapEligible` already required a live
 * replicator RNA inside the vesicle. */
function drawGenesFromSymbols(symbols: readonly NucleotideCode[], count: number, geneLength: number, cursorStart = 0): { genes: Gene[]; cursor: number } {
  const genes: Gene[] = [];
  let cursor = cursorStart;
  for (let g = 0; g < count; g++) {
    const gene: NucleotideCode[] = [];
    for (let i = 0; i < geneLength; i++) {
      gene.push(symbols[cursor % symbols.length]);
      cursor++;
    }
    genes.push(gene);
  }
  return { genes, cursor };
}

export interface TranslatedFounder {
  sequence: GeneSequence;
  originVesicleId: number;
}

export function translateBootstrapCandidate(candidate: BootstrapCandidate): TranslatedFounder {
  const rnaSymbols = flattenRnaSymbols(candidate);

  // How many real protein genes this founder gets is purely a function of
  // how much real RNA content it actually has — a lineage that grew a
  // longer, richer set of replicators earns a bigger genome, with no
  // catalyst-class heuristic deciding the count anymore. Floored at 1 (a
  // founder needs at least one protein-coding gene to have any function
  // at all) and capped the same way every genome's protein count is.
  const proteinGeneCount = Math.min(TRAIT_LIMITS.maxProteins, Math.max(1, Math.floor(rnaSymbols.length / PROTEIN_GENE_LENGTH)));

  const core = drawGenesFromSymbols(rnaSymbols, CORE_GENE_COUNT, GENE_LENGTH);
  const proteins = drawGenesFromSymbols(rnaSymbols, proteinGeneCount, PROTEIN_GENE_LENGTH, core.cursor);
  const genes = [...core.genes, ...proteins.genes];

  // Bootstrap founders start asexual — sexual reproduction is a later
  // evolutionary innovation, not a Stage 0 starting point — overriding
  // just that one real-but-arbitrary locus rather than the rest of the
  // RNA-derived sequence.
  genes[LOCUS.reproductionMode] = encodeUnit(0.25, GENE_LENGTH);

  // The one hard viability guarantee worth keeping: a founder needs a
  // real, *reachable* way to get energy, or it's a guaranteed,
  // uninteresting extinction — not a real evolutionary outcome, just bad
  // luck in which RNA chunks happened to translate into which proteins.
  // Headless-verified this needs to be stricter than "has a peptidyl or
  // protease protein": a predator that can't move can't reliably catch
  // anything (genome.ts's randomGenome hit this exact failure mode —
  // real predation power, zero motor power, nothing to eat and no way to
  // go find something — see NOTES.md). Passive energy-capture doesn't
  // need mobility, so it alone is enough; predation only counts alongside
  // real motor power. If real content didn't clear that bar, patch the
  // single most-redundant-looking protein gene by pointing its cursor
  // read at a different offset — still entirely real RNA content, just a
  // different real slice of it, tried until one clears the bar or the
  // attempts run out and the founder is released as translated (a real
  // failure mode, not hidden). A short-lived protocell's finite real RNA
  // content means these attempts aren't fully independent draws the way
  // a random genome's are (only so many distinct cursor offsets exist in
  // a short symbol stream), so this is a best effort, not the same
  // statistical guarantee genome.ts's randomGenome gets — matched to it
  // in cap and mechanism regardless (see genome.ts's ensureEnergyCapable
  // for the actual calibration numbers this cap is set from).
  //
  // Tracked incrementally (not re-decoded from the whole `genes` array on
  // every attempt) for the same reason genome.ts's ensureEnergyCapable
  // is: re-scanning the full accumulated gene list each attempt is
  // quadratic in the attempt count for no reason, and that stopped being
  // free once the cap needed to grow by an order of magnitude (see
  // genome.ts).
  let hasEnergyCapture = false;
  let hasPredation = false;
  let hasMotor = false;
  const scan = (gene: Gene): void => {
    const cls = decodeProteinGene(gene).fold.catalysisClass;
    if (cls === 'peptidyl') hasEnergyCapture = true;
    else if (cls === 'protease') hasPredation = true;
    else if (cls === 'motor') hasMotor = true;
  };
  for (const gene of proteins.genes) scan(gene);
  const isViable = (): boolean => hasEnergyCapture || (hasPredation && hasMotor);

  // Appends fresh genes (never overwrites an existing one) — an earlier
  // version overwrote the same last slot on every attempt and a real
  // headless run caught it destroying a founder's one working protein
  // that happened to live in that slot, with no guaranteed replacement.
  // Appending means existing capability can only be added to, never
  // lost. Search headroom is deliberately *not* capped by
  // TRAIT_LIMITS.maxProteins here — genome.ts's randomGenome hit the
  // same issue capped this way: with a typical starting protein count
  // already using up most of the headroom to the cap, nowhere near
  // enough real attempts ever actually ran. Search freely, then trim back
  // down to the cap afterward — reordered first via genome.ts's
  // prioritizeFounderGenes so the specific gene(s) that made isViable()
  // true sort ahead of every other merely-functional gene the search
  // turned up along the way (lipidsynthase/replicase/photoreceptor don't
  // help this founder and shouldn't get trim priority over the one that
  // does — see prioritizeFounderGenes's comment for the real bug this
  // fixes), then genome.ts's trimToProteinCap for the actual cap-down.
  // Matched to genome.ts's MAX_FOUNDER_REROLL_ATTEMPTS (see its comment
  // for the actual measured hit rates and the cap-vs-success sweep that
  // picked 1200) — a bootstrap founder's attempts aren't fully
  // independent draws the way a random genome's are (finite real RNA
  // content means only so many distinct cursor offsets exist in a short
  // symbol stream), so this is a best effort at the same cap, not an
  // identical statistical guarantee.
  //
  // The offset advances by a single nucleotide each attempt, not by a
  // whole PROTEIN_GENE_LENGTH — a real headless run caught why that
  // matters: advancing by exactly one gene-length each time re-reads the
  // *same* window whenever rnaSymbols.length shares a large common
  // factor with PROTEIN_GENE_LENGTH (e.g. any RNA length that's a clean
  // multiple of 60 collapsed to a period of 1 — every "attempt" drew the
  // identical gene, so 1200 attempts had the search power of one).
  // Shifting by a single nucleotide instead gives up to
  // `rnaSymbols.length` genuinely different reading-frame offsets before
  // anything repeats — a real biological analog too (frameshifted/
  // alternative-frame reading of the same transcript produces a
  // completely different downstream codon partition, not a resemblance).
  // Capped at rnaSymbols.length attempts: once every distinct offset has
  // been tried, further attempts are guaranteed repeats, so there's no
  // reason to spend up to 1200 iterations cycling the same handful of
  // reads for a short-lived protocell with little real RNA content.
  const MAX_REROLL_ATTEMPTS = Math.min(1200, rnaSymbols.length);
  let attemptCursor = proteins.cursor;
  for (let attempt = 0; attempt < MAX_REROLL_ATTEMPTS && !isViable(); attempt++) {
    const patch = drawGenesFromSymbols(rnaSymbols, 1, PROTEIN_GENE_LENGTH, attemptCursor);
    genes.push(patch.genes[0]);
    scan(patch.genes[0]);
    attemptCursor += 1;
  }

  const coreGenes = genes.slice(0, CORE_GENE_COUNT);
  const proteinGenes = prioritizeFounderGenes(genes.slice(CORE_GENE_COUNT));
  return {
    sequence: trimToProteinCap({ genes: [...coreGenes, ...proteinGenes] }),
    originVesicleId: candidate.vesicleId,
  };
}
