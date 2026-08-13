/** Asexual: solo mutated clone. Sexual: needs a same-lineage mate in
 * physical contact — the two genomes are crossed over, then mutated. */
export type ReproductionMode = 'asexual' | 'sexual';

/**
 * The physical parts a virtunism can grow. There's no separate "diet" gene
 * — what it eats (or doesn't) falls out of which of these it's carrying:
 * chloroplasts photosynthesize (the "plant" path), mouths let it eat plant
 * matter, carrion, or smaller virtunisms (the "animal" path), and a
 * virtunism can carry both, either, or neither.
 */
export type OrganelleKind = 'flagellum' | 'mouth' | 'chloroplast' | 'eye' | 'armor' | 'bud';

export interface Organelle {
  kind: OrganelleKind;
  angle: number; // radians, position around the rim relative to its own heading
  size: number; // 0.5-1.5, evolvable — bigger costs more but does more
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
  organelleSize: { min: 0.5, max: 1.5 },
  maxOrganelles: 10, // total slots across every kind (bud included)
};

export const ORGANELLE_COLORS: Record<OrganelleKind, string> = {
  flagellum: 'rgba(230, 240, 255, 0.55)',
  mouth: 'rgba(10, 15, 25, 0.8)',
  chloroplast: '#3fae5a',
  eye: '#fefefe',
  armor: '#9aa7bd',
  bud: '#ff8fd6',
};
