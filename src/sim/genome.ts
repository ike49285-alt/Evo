// The genome. This is the center of the whole sim: every organism's body
// plan (what it's shaped like, what it can do physically) AND its behavior
// (the brain weights driving movement) live here, together, as one
// heritable unit. Nothing about an organism's capabilities is hard-coded
// outside of what its genome encodes.

import { Rng } from './rng.js';
import { clamp } from './types.js';
import { WEIGHT_COUNT, randomWeights, mutateWeights, crossoverWeights } from './nn.js';

export type OrganelleType = 'mouth' | 'chloroplast' | 'flagellum' | 'eye' | 'armor';

export const ORGANELLE_TYPES: readonly OrganelleType[] = [
  'mouth',
  'chloroplast',
  'flagellum',
  'eye',
  'armor',
];

/**
 * Organelle types genomes can actually express right now. Plants-only
 * phase: mouths are switched off here — nowhere else. Every mouth-gated
 * behavior downstream (predation, threat-sensing, carrion-eating in
 * world.ts) stays fully implemented; it just goes inert on its own once
 * nothing in the dish can ever have biteRadius > 0. Re-adding 'mouth' to
 * this list is the entire "bring back animals" step.
 */
export const ACTIVE_ORGANELLE_TYPES: readonly OrganelleType[] = ORGANELLE_TYPES.filter(
  (t) => t !== 'mouth',
);

/** One organelle mounted on the chassis rim. */
export interface Organelle {
  type: OrganelleType;
  /** Angle around the chassis rim, radians. */
  angle: number;
  /** Distance from chassis center, as a fraction of chassis radius (0..~1.4). */
  distance: number;
  /** Organelle's own size — bigger costs more upkeep but does more. */
  size: number;
}

export interface BodyPlan {
  /** Chassis radius. Bigger chassis = more mass = more base upkeep. */
  radius: number;
  organelles: Organelle[];
}

export interface Brain {
  weights: Float32Array;
}

export interface Genome {
  bodyPlan: BodyPlan;
  brain: Brain;
  /** Hue 0-360, drifts slightly on mutation so lineages are visually trackable. */
  hue: number;
}

// ---- Tunables -------------------------------------------------------------

export const MIN_CHASSIS_RADIUS = 3;
export const MAX_CHASSIS_RADIUS = 14;
export const MIN_ORGANELLE_SIZE = 0.5;
export const MAX_ORGANELLE_SIZE = 4;
export const MAX_ORGANELLES = 12;

// ---- Genesis ----------------------------------------------------------

/**
 * A brand new random genome. `bias` nudges the organelle mix toward a
 * starting archetype (e.g. photosynthesizer- or hunter-leaning) purely as
 * a seed-population convenience — nothing downstream treats these as
 * fixed species. Mutation can turn either into anything.
 */
export function randomGenome(
  rng: Rng,
  bias: Partial<Record<OrganelleType, number>> = {},
): Genome {
  const radius = rng.range(MIN_CHASSIS_RADIUS, MIN_CHASSIS_RADIUS + 4);
  const organelleCount = rng.int(2, 5);
  const organelles: Organelle[] = [];
  for (let i = 0; i < organelleCount; i++) {
    organelles.push(randomOrganelle(rng, bias));
  }
  return {
    bodyPlan: { radius, organelles },
    brain: { weights: randomWeights(rng) },
    hue: rng.range(0, 360),
  };
}

function randomOrganelle(rng: Rng, bias: Partial<Record<OrganelleType, number>>): Organelle {
  const type = weightedPickType(rng, bias);
  return {
    type,
    angle: rng.range(0, Math.PI * 2),
    distance: rng.range(0.6, 1.1),
    size: rng.range(MIN_ORGANELLE_SIZE, MAX_ORGANELLE_SIZE * 0.5),
  };
}

function weightedPickType(rng: Rng, bias: Partial<Record<OrganelleType, number>>): OrganelleType {
  const weights = ACTIVE_ORGANELLE_TYPES.map((t) => Math.max(0.001, bias[t] ?? 1));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng.range(0, total);
  for (let i = 0; i < ACTIVE_ORGANELLE_TYPES.length; i++) {
    r -= weights[i];
    if (r <= 0) return ACTIVE_ORGANELLE_TYPES[i];
  }
  return ACTIVE_ORGANELLE_TYPES[ACTIVE_ORGANELLE_TYPES.length - 1];
}

// ---- Mutation -----------------------------------------------------------

export interface MutationRates {
  /** Per-weight chance to perturb a brain weight. */
  brainRate: number;
  brainStdDev: number;
  /** Chance the chassis radius shifts a little. */
  chassisRate: number;
  chassisStdDev: number;
  /** Chance to add a new organelle. */
  addOrganelleRate: number;
  /** Chance to remove an existing organelle. */
  removeOrganelleRate: number;
  /** Per-organelle chance to tweak its angle/distance/size. */
  tweakOrganelleRate: number;
  /** Chance the hue drifts. */
  hueRate: number;
}

export const DEFAULT_MUTATION_RATES: MutationRates = {
  brainRate: 0.08,
  brainStdDev: 0.4,
  chassisRate: 0.15,
  chassisStdDev: 0.8,
  addOrganelleRate: 0.06,
  removeOrganelleRate: 0.05,
  tweakOrganelleRate: 0.25,
  hueRate: 0.3,
};

export function mutateGenome(genome: Genome, rng: Rng, rates: MutationRates = DEFAULT_MUTATION_RATES): Genome {
  let radius = genome.bodyPlan.radius;
  if (rng.chance(rates.chassisRate)) {
    radius = clamp(radius + rng.gaussian(rates.chassisStdDev), MIN_CHASSIS_RADIUS, MAX_CHASSIS_RADIUS);
  }

  let organelles = genome.bodyPlan.organelles.map((o) => {
    if (!rng.chance(rates.tweakOrganelleRate)) return o;
    return {
      type: o.type,
      angle: o.angle + rng.gaussian(0.4),
      distance: clamp(o.distance + rng.gaussian(0.12), 0.3, 1.4),
      size: clamp(o.size + rng.gaussian(0.5), MIN_ORGANELLE_SIZE, MAX_ORGANELLE_SIZE),
    };
  });

  if (organelles.length < MAX_ORGANELLES && rng.chance(rates.addOrganelleRate)) {
    organelles = [...organelles, randomOrganelle(rng, {})];
  }
  if (organelles.length > 0 && rng.chance(rates.removeOrganelleRate)) {
    const idx = rng.int(0, organelles.length - 1);
    organelles = organelles.slice(0, idx).concat(organelles.slice(idx + 1));
  }

  const hue = rng.chance(rates.hueRate) ? (genome.hue + rng.gaussian(15) + 360) % 360 : genome.hue;

  return {
    bodyPlan: { radius, organelles },
    brain: { weights: mutateWeights(genome.brain.weights, rng, rates.brainRate, rates.brainStdDev) },
    hue,
  };
}

// ---- Crossover (sexual reproduction) -------------------------------------

export function crossoverGenome(a: Genome, b: Genome, rng: Rng): Genome {
  const radius = rng.chance(0.5) ? a.bodyPlan.radius : b.bodyPlan.radius;
  // Organelle set: pick each parent's organelles with 50% odds per-organelle
  // (a simple, order-independent recombination — body plans aren't aligned
  // loci like the fixed-topology brain is).
  const pool = [...a.bodyPlan.organelles, ...b.bodyPlan.organelles];
  const organelles = pool.filter(() => rng.chance(0.5)).slice(0, MAX_ORGANELLES);
  const weights = crossoverWeights(a.brain.weights, b.brain.weights, rng);
  const hue = rng.chance(0.5) ? a.hue : b.hue;
  return { bodyPlan: { radius, organelles }, brain: { weights }, hue };
}

// ---- Derived physical stats ------------------------------------------------

export interface DerivedStats {
  /** Total mass — chassis area + organelle areas. Drives drag & upkeep. */
  mass: number;
  /** Base metabolic upkeep per tick, before movement cost. */
  baseUpkeep: number;
  /** Max forward thrust force available (from flagella). */
  thrustForce: number;
  /** Turn agility — higher mass makes turning slower. */
  agility: number;
  /** Combined photosynthesis rate (energy/tick at full sunlight budget). */
  photoRate: number;
  /** Bite radius for eating (0 if no mouth). */
  biteRadius: number;
  /** Max prey mass this organism's mouth can take on (0 if no mouth). */
  maxPreyMass: number;
  /** Vision range, in world units. */
  visionRange: number;
  /** Total half-arc of combined vision cones, radians (0 if no eyes). */
  visionArc: number;
  /** Defense multiplier: incoming bite damage/odds scaled by 1/(1+armor). */
  armor: number;
  /** Outer radius for rendering/collision — chassis + longest organelle reach. */
  hullRadius: number;
  /** Energy cost to build one offspring (roughly proportional to body cost). */
  reproCost: number;
}

const UPKEEP_PER_MASS = 0.0025;
const ORGANELLE_UPKEEP: Record<OrganelleType, number> = {
  mouth: 0.006,
  chloroplast: 0.003,
  flagellum: 0.007,
  eye: 0.004,
  armor: 0.0045,
};

export function deriveStats(genome: Genome): DerivedStats {
  const { radius, organelles } = genome.bodyPlan;
  let mass = radius * radius * 0.05;
  let upkeep = 0;
  let thrustForce = 0;
  let photoRate = 0;
  let biteRadius = 0;
  let maxPreyMass = 0;
  let visionRange = 0;
  let visionArc = 0;
  let armor = 0;
  let hullRadius = radius;

  for (const o of organelles) {
    const area = o.size * o.size;
    mass += area * 0.4;
    upkeep += ORGANELLE_UPKEEP[o.type] * area;
    hullRadius = Math.max(hullRadius, radius * o.distance + o.size);

    switch (o.type) {
      case 'flagellum':
        thrustForce += o.size * 0.9;
        break;
      case 'chloroplast':
        photoRate += o.size * 0.5;
        break;
      case 'mouth':
        biteRadius = Math.max(biteRadius, radius * 0.5 + o.size * 1.5);
        maxPreyMass += o.size * 6;
        break;
      case 'eye':
        visionRange = Math.max(visionRange, 60 + o.size * 25);
        visionArc += 0.35 + o.size * 0.08;
        break;
      case 'armor':
        armor += o.size * 0.35;
        break;
    }
  }

  const baseUpkeep = 0.02 + mass * UPKEEP_PER_MASS + upkeep;
  const agility = 3.2 / (1 + mass * 0.06);
  const reproCost = 4 + mass * 1.6 + organelles.length * 0.8;

  return {
    mass,
    baseUpkeep,
    thrustForce,
    agility,
    photoRate,
    biteRadius,
    maxPreyMass,
    visionRange,
    visionArc: Math.min(visionArc, Math.PI * 2),
    armor,
    hullRadius,
    reproCost,
  };
}

export { WEIGHT_COUNT };
