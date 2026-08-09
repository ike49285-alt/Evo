export type Diet = 'herbivore' | 'carnivore' | 'omnivore';

export interface Vec2 {
  x: number;
  y: number;
}

/** Brain input/output layout — keep in sync with World.buildInputs() and Cell.act(). */
export const BRAIN_TOPOLOGY = { inputs: 12, hidden: 8, outputs: 2 } as const;

export const DIET_COLORS: Record<Diet, string> = {
  herbivore: '#5ad46a',
  carnivore: '#ff5c5c',
  omnivore: '#f5a623',
};
