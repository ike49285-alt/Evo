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
    organelleSize: { min: 0.5, max: 1.5 },
    maxOrganelles: 10, // total slots across every kind (bud included)
};
export const ORGANELLE_COLORS = {
    flagellum: 'rgba(230, 240, 255, 0.55)',
    mouth: 'rgba(10, 15, 25, 0.8)',
    chloroplast: '#3fae5a',
    eye: '#fefefe',
    armor: '#9aa7bd',
    bud: '#ff8fd6',
};
