import { AminoAcidCode } from '../chem/elements.js';
import { CatalysisClass, PeptideFold } from '../chem/polymer.js';

export { CatalysisClass, PeptideFold };

/** Asexual: solo mutated clone, costing the parent half its body.
 *
 * Sexual: needs a *genetically compatible* mate in physical contact —
 * compatibility is measured by real divergence (World's
 * mateCompatibilityThreshold), not by a shared lineage label as it once
 * was — and the two genomes are crossed over, then mutated at a reduced
 * rate, recombination standing in for some of the mutational load rather
 * than being charged on top of it. The pairing is anisogamous: one partner
 * takes the egg role and pays the same half-body an asexual parent pays,
 * the other pays a token share — but both must clear the same bar first.
 * See Virtunism.canMate. */
export type ReproductionMode = 'asexual' | 'sexual';

/**
 * A virtunism's real functional part: a real amino-acid sequence,
 * translated through the actual genetic code and folded by the exact
 * same mechanism Stage 0's prebiotic chemistry uses (chem/polymer.ts's
 * foldPeptide — see sim/genes.ts's decodeProteinGene). There is no fixed
 * catalog of "kinds" here — whatever functional class the fold's real
 * surface chemistry produces (or none, if it doesn't fold into anything
 * useful) *is* the capability. What it eats, how fast it moves, how well
 * it senses, and whether it can bud a colony all fall out of aggregating
 * these across a genome's whole protein-gene run (see genome.ts's
 * classPower).
 */
export interface ProteinPhenotype {
  sequence: AminoAcidCode[]; // real translated sequence, post-STOP truncation
  fold: PeptideFold; // isCatalyst / catalysisClass / catalysisStrength — all real, from the fold
  // radians, mount position around the rim relative to heading. No
  // biological analog (real genes don't encode "a position on the cell")
  // — a Stage-1 rendering/vision-cone convenience, but still a
  // deterministic, heritable, mutable function of the gene's own content.
  angle: number;
}

export interface Vec2 {
  x: number;
  y: number;
}

/** Brain input/output layout — keep in sync with World.buildInputs() and Virtunism.act(). */
export const BRAIN_TOPOLOGY = { inputs: 15, hidden: 10, outputs: 2 } as const;

/** Hard bounds so mutation can't drift decoded traits into absurd/
 * degenerate territory. Lives here (not genome.ts) so both genome.ts and
 * genes.ts can import it without a circular dependency between them —
 * genome.ts re-exports it for backward compatibility. */
export const TRAIT_LIMITS = {
  size: { min: 0.5, max: 3.2 },
  senseRadius: { min: 40, max: 320 },
  maxAge: { min: 400, max: 2400 },
  // Headless-verified this needs real headroom, not just a round number:
  // real codon-translated amino-acid sequences fold catalytic at ~6-7%
  // (vs. ~11% for uniform-random sampling — the genetic code's real
  // degeneracy skews residue frequency away from uniform), so a genome
  // needs meaningfully more than a handful of protein genes for a decent
  // chance any are actually functional. One-time fold cost at
  // construction, not per-tick, so the extra headroom is cheap.
  maxProteins: 16,
};

/** Rendering-only palette, keyed by real functional class instead of a
 * hard-coded organelle kind. */
export const CATALYSIS_CLASS_COLORS: Record<CatalysisClass, string> = {
  motor: 'rgba(230, 240, 255, 0.55)',
  protease: 'rgba(10, 15, 25, 0.8)',
  peptidyl: '#3fae5a',
  photoreceptor: '#fefefe',
  lipidsynthase: '#9aa7bd',
  replicase: '#ff8fd6',
};
