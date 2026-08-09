import { NeuralNet } from './nn.js';
import { Rng } from './rng.js';
import { BRAIN_TOPOLOGY, Diet } from './types.js';

/** Hard bounds so mutation can't drift traits into absurd/degenerate territory. */
export const TRAIT_LIMITS = {
  size: { min: 0.5, max: 3.2 },
  maxSpeed: { min: 0.4, max: 3.5 },
  senseRadius: { min: 40, max: 320 },
  maxAge: { min: 400, max: 2400 },
};

export interface Genome {
  diet: Diet;
  size: number; // body radius scale
  maxSpeed: number; // world units / tick at full thrust
  senseRadius: number; // vision range for sensing food/threats
  maxAge: number; // lifespan in ticks before death of old age
  hue: number; // 0-360, cosmetic + lets you track lineages visually
  brain: NeuralNet;
}

export interface GenomeOverrides {
  size?: number;
  maxSpeed?: number;
  senseRadius?: number;
  maxAge?: number;
  hue?: number;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export function randomGenome(diet: Diet, rng: Rng, overrides: GenomeOverrides = {}): Genome {
  return {
    diet,
    size: overrides.size ?? rng.range(TRAIT_LIMITS.size.min, 1.6),
    maxSpeed: overrides.maxSpeed ?? rng.range(0.8, 2.2),
    senseRadius: overrides.senseRadius ?? rng.range(100, 220),
    maxAge: overrides.maxAge ?? rng.range(700, 1400),
    hue: overrides.hue ?? rng.range(0, 360),
    brain: NeuralNet.random(BRAIN_TOPOLOGY, rng),
  };
}

/** Produces a mutated child genome from a parent. Parent is untouched. */
export function mutateGenome(parent: Genome, rng: Rng): Genome {
  const traitMutRate = 0.35; // chance any given trait shifts this generation
  const traitStrength = 0.08; // as a fraction of the trait's own value

  const jitter = (value: number, min: number, max: number): number => {
    if (!rng.bool(traitMutRate)) return value;
    const delta = rng.gaussian(0, value * traitStrength);
    return clamp(value + delta, min, max);
  };

  // Diet very rarely mutates — lets rare evolutionary transitions happen
  // (e.g. a herbivore lineage discovering omnivory) without species melting
  // into each other every generation.
  let diet = parent.diet;
  if (rng.bool(0.01)) {
    const options: Diet[] = ['herbivore', 'omnivore', 'carnivore'];
    diet = rng.pick(options);
  }

  return {
    diet,
    size: jitter(parent.size, TRAIT_LIMITS.size.min, TRAIT_LIMITS.size.max),
    maxSpeed: jitter(parent.maxSpeed, TRAIT_LIMITS.maxSpeed.min, TRAIT_LIMITS.maxSpeed.max),
    senseRadius: jitter(parent.senseRadius, TRAIT_LIMITS.senseRadius.min, TRAIT_LIMITS.senseRadius.max),
    maxAge: jitter(parent.maxAge, TRAIT_LIMITS.maxAge.min, TRAIT_LIMITS.maxAge.max),
    hue: (parent.hue + (rng.bool(traitMutRate) ? rng.gaussian(0, 8) : 0) + 360) % 360,
    brain: parent.brain.mutate(rng, 0.12, 0.35),
  };
}
