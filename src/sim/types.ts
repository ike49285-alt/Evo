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

export const ORGANELLE_COLORS: Record<OrganelleKind, string> = {
  flagellum: 'rgba(230, 240, 255, 0.55)',
  mouth: 'rgba(10, 15, 25, 0.8)',
  chloroplast: '#3fae5a',
  eye: '#fefefe',
  armor: '#9aa7bd',
  bud: '#ff8fd6',
};
