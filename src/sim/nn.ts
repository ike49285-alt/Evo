// The brain: a tiny fixed-topology feedforward net. Its weights are the
// "behavior genes" half of a genome — see genome.ts. Topology is fixed
// (organelle counts don't resize it) so any two genomes can crossover
// cleanly; what organelles like eyes change is what the *inputs mean*
// (range/arc), not how many there are.

import { Rng } from './rng.js';

export const INPUT_COUNT = 13;
export const HIDDEN_COUNT = 10;
export const OUTPUT_COUNT = 2; // [turn (-1..1), thrust (0..1)]

export const WEIGHT_COUNT =
  INPUT_COUNT * HIDDEN_COUNT + HIDDEN_COUNT + // input -> hidden, + hidden biases
  HIDDEN_COUNT * OUTPUT_COUNT + OUTPUT_COUNT; // hidden -> output, + output biases

/** Sensor layout `sense()` (in organism.ts) must fill, in order. */
export const enum Sensor {
  Bias = 0,
  Energy = 1,
  FoodDirX = 2,
  FoodDirY = 3,
  FoodDist = 4,
  ThreatDirX = 5,
  ThreatDirY = 6,
  ThreatDist = 7,
  MateDirX = 8,
  MateDirY = 9,
  MateDist = 10,
  VelX = 11,
  VelY = 12,
}

export const enum Output {
  Turn = 0,
  Thrust = 1,
}

function tanh(x: number): number {
  // Math.tanh exists in ES2020 but this avoids relying on it in older
  // engines and is branch-free.
  const e2x = Math.exp(2 * x);
  return (e2x - 1) / (e2x + 1);
}

export function randomWeights(rng: Rng): Float32Array {
  const w = new Float32Array(WEIGHT_COUNT);
  for (let i = 0; i < w.length; i++) w[i] = rng.range(-1, 1);
  return w;
}

/**
 * Runs the net forward. `weights` layout:
 *   [0 .. IN*HID)              input->hidden weight matrix, row-major (hidden idx outer)
 *   [IN*HID .. IN*HID+HID)     hidden biases
 *   [.. + HID*OUT)             hidden->output weight matrix, row-major (output idx outer)
 *   [.. + OUT)                 output biases
 */
export function forward(weights: Float32Array, inputs: Float32Array): Float32Array {
  const hidden = new Float32Array(HIDDEN_COUNT);
  let wi = 0;
  for (let h = 0; h < HIDDEN_COUNT; h++) {
    let sum = 0;
    for (let i = 0; i < INPUT_COUNT; i++) sum += weights[wi++] * inputs[i];
    hidden[h] = sum;
  }
  const biasBase = INPUT_COUNT * HIDDEN_COUNT;
  for (let h = 0; h < HIDDEN_COUNT; h++) hidden[h] = tanh(hidden[h] + weights[biasBase + h]);

  const outputs = new Float32Array(OUTPUT_COUNT);
  wi = biasBase + HIDDEN_COUNT;
  for (let o = 0; o < OUTPUT_COUNT; o++) {
    let sum = 0;
    for (let h = 0; h < HIDDEN_COUNT; h++) sum += weights[wi++] * hidden[h];
    outputs[o] = sum;
  }
  const outBiasBase = wi;
  outputs[Output.Turn] = tanh(outputs[Output.Turn] + weights[outBiasBase]);
  // Thrust in [0,1]: sigmoid, not tanh — reverse thrust isn't a real action.
  const rawThrust = outputs[Output.Thrust] + weights[outBiasBase + 1];
  outputs[Output.Thrust] = 1 / (1 + Math.exp(-rawThrust));
  return outputs;
}

export function mutateWeights(weights: Float32Array, rng: Rng, rate: number, stdDev: number): Float32Array {
  const out = new Float32Array(weights.length);
  for (let i = 0; i < weights.length; i++) {
    out[i] = rng.chance(rate) ? weights[i] + rng.gaussian(stdDev) : weights[i];
  }
  return out;
}

/** Uniform crossover: each weight comes from parent A or B with equal odds. */
export function crossoverWeights(a: Float32Array, b: Float32Array, rng: Rng): Float32Array {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = rng.chance(0.5) ? a[i] : b[i];
  return out;
}
