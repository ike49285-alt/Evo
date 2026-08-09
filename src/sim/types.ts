export type Diet = 'herbivore' | 'carnivore' | 'omnivore';

/** Asexual: solo mutated clone. Sexual: needs a same-lineage mate in
 * physical contact — the two genomes are crossed over, then mutated. */
export type ReproductionMode = 'asexual' | 'sexual';

export interface Vec2 {
  x: number;
  y: number;
}

/** Brain input/output layout — keep in sync with World.buildInputs() and Cell.act(). */
export const BRAIN_TOPOLOGY = { inputs: 15, hidden: 10, outputs: 2 } as const;

export const DIET_COLORS: Record<Diet, string> = {
  herbivore: '#5ad46a',
  carnivore: '#ff5c5c',
  omnivore: '#f5a623',
};
