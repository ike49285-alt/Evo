import { NeuralNet } from './nn.js';
import { Rng } from './rng.js';
import { BRAIN_TOPOLOGY, Organelle, OrganelleKind, ReproductionMode } from './types.js';

/** Hard bounds so mutation can't drift traits into absurd/degenerate territory. */
export const TRAIT_LIMITS = {
  size: { min: 0.5, max: 3.2 },
  senseRadius: { min: 40, max: 320 },
  maxAge: { min: 400, max: 2400 },
  organelleSize: { min: 0.5, max: 1.5 },
  maxOrganelles: 10, // total slots across every kind (bud included)
};

const ORGANELLE_KINDS: OrganelleKind[] = ['flagellum', 'mouth', 'chloroplast', 'eye', 'armor'];

export interface Genome {
  reproductionMode: ReproductionMode;
  size: number; // chassis scale — base body radius/energy budget, independent of organelles
  senseRadius: number; // detection *range*; organelle "eyes" separately control detection *angle*
  maxAge: number; // lifespan in ticks before death of old age
  hue: number; // 0-360, cosmetic + lets you track lineages visually
  organelles: Organelle[];
  brain: NeuralNet;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

// ---- derived physical stats (computed from organelles, not stored) --------

function organellesOf(genome: Genome, kind: OrganelleKind): Organelle[] {
  return genome.organelles.filter((o) => o.kind === kind);
}

function powerOf(genome: Genome, kind: OrganelleKind): number {
  let sum = 0;
  for (const o of genome.organelles) if (o.kind === kind) sum += o.size;
  return sum;
}

/** Top speed a cell's flagella can push it to. Zero flagella = nearly
 * sessile (a real strategy for a photosynthesizer that doesn't need to
 * chase anything), not literally frozen. */
export function deriveMaxSpeed(genome: Genome): number {
  return 0.05 + Math.sqrt(powerOf(genome, 'flagellum')) * 0.85;
}

/** More flagella spread around the rim = a more maneuverable body. */
export function deriveTurnRate(genome: Genome): number {
  return 0.08 + Math.min(0.25, organellesOf(genome, 'flagellum').length * 0.03);
}

export function deriveFlagellaPower(genome: Genome): number {
  return powerOf(genome, 'flagellum');
}

export function deriveMouthCount(genome: Genome): number {
  return organellesOf(genome, 'mouth').length;
}

export function deriveMouthPower(genome: Genome): number {
  return powerOf(genome, 'mouth');
}

/** Passive energy/tick from ambient light — the "plant" income stream. */
export function derivePhotosynthesis(genome: Genome): number {
  return powerOf(genome, 'chloroplast') * 0.05;
}

export function deriveChloroplastPower(genome: Genome): number {
  return powerOf(genome, 'chloroplast');
}

/** Armor makes a cell read as effectively bigger/tougher to predators
 * without paying full chassis-size energy cost for the same protection. */
export function deriveArmorBonus(genome: Genome): number {
  return 1 + powerOf(genome, 'armor') * 0.15;
}

export function deriveArmorMitigation(genome: Genome): number {
  return Math.min(0.5, powerOf(genome, 'armor') * 0.12);
}

export function deriveEyes(genome: Genome): Organelle[] {
  return organellesOf(genome, 'eye');
}

export function hasBud(genome: Genome): boolean {
  return genome.organelles.some((o) => o.kind === 'bud');
}

// ---- construction & evolution ----------------------------------------------

export interface StarterLoadout {
  flagella?: number;
  mouths?: number;
  chloroplasts?: number;
  eyes?: number;
  armor?: number;
  bud?: boolean;
}

/** Builds an evenly-spaced starter organelle ring from simple per-kind
 * counts — this is what the Designer UI hands to World.addSpecies(). */
export function buildOrganelles(loadout: StarterLoadout): Organelle[] {
  const list: { kind: OrganelleKind }[] = [];
  for (let i = 0; i < (loadout.flagella ?? 0); i++) list.push({ kind: 'flagellum' });
  for (let i = 0; i < (loadout.mouths ?? 0); i++) list.push({ kind: 'mouth' });
  for (let i = 0; i < (loadout.chloroplasts ?? 0); i++) list.push({ kind: 'chloroplast' });
  for (let i = 0; i < (loadout.eyes ?? 0); i++) list.push({ kind: 'eye' });
  for (let i = 0; i < (loadout.armor ?? 0); i++) list.push({ kind: 'armor' });
  if (loadout.bud) list.push({ kind: 'bud' });

  return list.slice(0, TRAIT_LIMITS.maxOrganelles).map((o, i, arr) => ({
    kind: o.kind,
    angle: (i / Math.max(1, arr.length)) * Math.PI * 2,
    size: 1.0,
  }));
}

export function randomGenome(rng: Rng, reproductionMode: ReproductionMode = 'asexual'): Genome {
  const count = rng.int(2, 6);
  const organelles: Organelle[] = [];
  for (let i = 0; i < count; i++) {
    organelles.push({
      kind: rng.pick(ORGANELLE_KINDS),
      angle: rng.range(0, Math.PI * 2),
      size: rng.range(TRAIT_LIMITS.organelleSize.min, TRAIT_LIMITS.organelleSize.max),
    });
  }
  return {
    reproductionMode,
    size: rng.range(TRAIT_LIMITS.size.min, 1.6),
    senseRadius: rng.range(100, 220),
    maxAge: rng.range(700, 1400),
    hue: rng.range(0, 360),
    organelles,
    brain: NeuralNet.random(BRAIN_TOPOLOGY, rng),
  };
}

/** Produces a mutated child genome from a parent. Parent is untouched. */
export function mutateGenome(parent: Genome, rng: Rng): Genome {
  const traitMutRate = 0.35;
  const traitStrength = 0.08;

  const jitter = (value: number, min: number, max: number): number => {
    if (!rng.bool(traitMutRate)) return value;
    const delta = rng.gaussian(0, value * traitStrength);
    return clamp(value + delta, min, max);
  };

  return {
    reproductionMode: parent.reproductionMode,
    size: jitter(parent.size, TRAIT_LIMITS.size.min, TRAIT_LIMITS.size.max),
    senseRadius: jitter(parent.senseRadius, TRAIT_LIMITS.senseRadius.min, TRAIT_LIMITS.senseRadius.max),
    maxAge: jitter(parent.maxAge, TRAIT_LIMITS.maxAge.min, TRAIT_LIMITS.maxAge.max),
    hue: (parent.hue + (rng.bool(traitMutRate) ? rng.gaussian(0, 8) : 0) + 360) % 360,
    organelles: mutateOrganelles(parent.organelles, rng),
    brain: parent.brain.mutate(rng, 0.12, 0.35),
  };
}

function mutateOrganelles(organelles: readonly Organelle[], rng: Rng): Organelle[] {
  let next = organelles.map((o) => ({ ...o }));

  // Jitter each existing organelle's angle/size a little.
  next = next.map((o) => {
    const angle = rng.bool(0.3) ? o.angle + rng.gaussian(0, 0.25) : o.angle;
    const size = rng.bool(0.3)
      ? clamp(o.size + rng.gaussian(0, 0.1), TRAIT_LIMITS.organelleSize.min, TRAIT_LIMITS.organelleSize.max)
      : o.size;
    return { ...o, angle, size };
  });

  // Rarely lose a random organelle — a real structural regression.
  if (next.length > 0 && rng.bool(0.05)) {
    next.splice(rng.int(0, next.length - 1), 1);
  }

  // Rarely grow a new one — a real structural innovation. A cell can only
  // ever carry one bud gland; it's a capability switch, not a stat to stack.
  if (next.length < TRAIT_LIMITS.maxOrganelles && rng.bool(0.06)) {
    const kind = rng.pick(ORGANELLE_KINDS);
    const alreadyHasBud = next.some((o) => o.kind === 'bud');
    if (kind !== 'bud' || !alreadyHasBud) {
      next.push({ kind, angle: rng.range(0, Math.PI * 2), size: rng.range(0.7, 1.1) });
    }
  }
  // Very rare: grow the bud gland itself, letting a lineage discover
  // multicellularity even if you didn't design it in.
  if (next.length < TRAIT_LIMITS.maxOrganelles && !next.some((o) => o.kind === 'bud') && rng.bool(0.01)) {
    next.push({ kind: 'bud', angle: 0, size: 1 });
  }

  return next;
}

/** Uniform-ish crossover of two same-lineage parents (for sexual
 * reproduction). Continuous traits and the brain are drawn per-field from
 * one parent or the other; organelles are pooled from both parents and a
 * random subset (capped at maxOrganelles) is kept, biased toward the
 * shorter parent's count so bodies don't balloon every generation. */
export function crossoverGenome(a: Genome, b: Genome, rng: Rng): Genome {
  const pick = <T,>(x: T, y: T): T => (rng.bool(0.5) ? x : y);

  const pool = [...a.organelles, ...b.organelles];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const targetCount = clamp(
    Math.round((a.organelles.length + b.organelles.length) / 2),
    0,
    TRAIT_LIMITS.maxOrganelles,
  );
  const organelles: Organelle[] = [];
  let usedBud = false;
  for (const o of pool) {
    if (organelles.length >= targetCount) break;
    if (o.kind === 'bud') {
      if (usedBud) continue;
      usedBud = true;
    }
    organelles.push({ ...o });
  }

  return {
    reproductionMode: pick(a.reproductionMode, b.reproductionMode),
    size: pick(a.size, b.size),
    senseRadius: pick(a.senseRadius, b.senseRadius),
    maxAge: pick(a.maxAge, b.maxAge),
    hue: pick(a.hue, b.hue),
    organelles,
    brain: NeuralNet.crossover(a.brain, b.brain, rng),
  };
}
