import { NeuralNet } from './nn.js';
import { Rng } from './rng.js';
import { BRAIN_TOPOLOGY, Diet, ReproductionMode } from './types.js';

/** Hard bounds so mutation can't drift traits into absurd/degenerate territory. */
export const TRAIT_LIMITS = {
  size: { min: 0.5, max: 3.2 },
  maxSpeed: { min: 0.4, max: 3.5 },
  senseRadius: { min: 40, max: 320 },
  visionAngle: { min: 40, max: 360 }, // degrees; 360 = fully omnidirectional
  mouthSize: { min: 0.5, max: 2.0 }, // bite size / capture-reach multiplier
  maxAge: { min: 400, max: 2400 },
};

export interface Genome {
  diet: Diet;
  reproductionMode: ReproductionMode;
  size: number; // body radius scale
  maxSpeed: number; // world units / tick at full thrust
  senseRadius: number; // vision *range* for sensing food/threats/mates
  visionAngle: number; // degrees; vision *cone* — eyes are a FOV x range budget
  mouthSize: number; // bite/eating efficiency and max relative prey size
  maxAge: number; // lifespan in ticks before death of old age
  hue: number; // 0-360, cosmetic + lets you track lineages visually
  brain: NeuralNet;
}

export interface GenomeOverrides {
  size?: number;
  maxSpeed?: number;
  senseRadius?: number;
  visionAngle?: number;
  mouthSize?: number;
  maxAge?: number;
  hue?: number;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export function randomGenome(
  diet: Diet,
  rng: Rng,
  overrides: GenomeOverrides = {},
  reproductionMode: ReproductionMode = 'asexual',
): Genome {
  return {
    diet,
    reproductionMode,
    size: overrides.size ?? rng.range(TRAIT_LIMITS.size.min, 1.6),
    maxSpeed: overrides.maxSpeed ?? rng.range(0.8, 2.2),
    senseRadius: overrides.senseRadius ?? rng.range(100, 220),
    visionAngle: overrides.visionAngle ?? rng.range(120, 360),
    mouthSize: overrides.mouthSize ?? rng.range(0.7, 1.3),
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
    // Reproduction mode is a species-level choice you make in the Designer,
    // not something that drifts on its own — a mutating mode would strand
    // sexual-mode offspring in an asexual-only lineage or vice versa.
    reproductionMode: parent.reproductionMode,
    size: jitter(parent.size, TRAIT_LIMITS.size.min, TRAIT_LIMITS.size.max),
    maxSpeed: jitter(parent.maxSpeed, TRAIT_LIMITS.maxSpeed.min, TRAIT_LIMITS.maxSpeed.max),
    senseRadius: jitter(parent.senseRadius, TRAIT_LIMITS.senseRadius.min, TRAIT_LIMITS.senseRadius.max),
    visionAngle: jitter(parent.visionAngle, TRAIT_LIMITS.visionAngle.min, TRAIT_LIMITS.visionAngle.max),
    mouthSize: jitter(parent.mouthSize, TRAIT_LIMITS.mouthSize.min, TRAIT_LIMITS.mouthSize.max),
    maxAge: jitter(parent.maxAge, TRAIT_LIMITS.maxAge.min, TRAIT_LIMITS.maxAge.max),
    hue: (parent.hue + (rng.bool(traitMutRate) ? rng.gaussian(0, 8) : 0) + 360) % 360,
    brain: parent.brain.mutate(rng, 0.12, 0.35),
  };
}

/** Uniform crossover of two same-lineage parents (for sexual reproduction).
 * Every trait — including the brain's weights — is independently taken from
 * one parent or the other; mutateGenome() is applied on top of the result
 * by the caller, same as with an asexual child. */
export function crossoverGenome(a: Genome, b: Genome, rng: Rng): Genome {
  const pick = <T,>(x: T, y: T): T => (rng.bool(0.5) ? x : y);
  return {
    diet: pick(a.diet, b.diet),
    reproductionMode: pick(a.reproductionMode, b.reproductionMode),
    size: pick(a.size, b.size),
    maxSpeed: pick(a.maxSpeed, b.maxSpeed),
    senseRadius: pick(a.senseRadius, b.senseRadius),
    visionAngle: pick(a.visionAngle, b.visionAngle),
    mouthSize: pick(a.mouthSize, b.mouthSize),
    maxAge: pick(a.maxAge, b.maxAge),
    hue: pick(a.hue, b.hue),
    brain: NeuralNet.crossover(a.brain, b.brain, rng),
  };
}
