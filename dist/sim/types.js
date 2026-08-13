/** Brain input/output layout — keep in sync with World.buildInputs() and Virtunism.act(). */
export const BRAIN_TOPOLOGY = { inputs: 15, hidden: 10, outputs: 2 };
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
export const CATALYSIS_CLASS_COLORS = {
    motor: 'rgba(230, 240, 255, 0.55)',
    protease: 'rgba(10, 15, 25, 0.8)',
    peptidyl: '#3fae5a',
    photoreceptor: '#fefefe',
    lipidsynthase: '#9aa7bd',
    replicase: '#ff8fd6',
};
