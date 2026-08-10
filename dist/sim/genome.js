import { NeuralNet } from './nn.js';
import { BRAIN_TOPOLOGY } from './types.js';
/** Hard bounds so mutation can't drift traits into absurd/degenerate territory. */
export const TRAIT_LIMITS = {
    size: { min: 0.5, max: 3.2 },
    senseRadius: { min: 40, max: 320 },
    maxAge: { min: 400, max: 2400 },
    organelleSize: { min: 0.5, max: 1.5 },
    maxOrganelles: 10, // total slots across every kind (bud included)
};
const ORGANELLE_KINDS = ['flagellum', 'mouth', 'chloroplast', 'eye', 'armor'];
function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
}
// ---- derived physical stats (computed from organelles, not stored) --------
function organellesOf(genome, kind) {
    return genome.organelles.filter((o) => o.kind === kind);
}
function powerOf(genome, kind) {
    let sum = 0;
    for (const o of genome.organelles)
        if (o.kind === kind)
            sum += o.size;
    return sum;
}
/** Top speed a cell's flagella can push it to. Zero flagella = nearly
 * sessile (a real strategy for a photosynthesizer that doesn't need to
 * chase anything), not literally frozen. */
export function deriveMaxSpeed(genome) {
    return 0.05 + Math.sqrt(powerOf(genome, 'flagellum')) * 0.85;
}
/** More flagella spread around the rim = a more maneuverable body. */
export function deriveTurnRate(genome) {
    return 0.08 + Math.min(0.25, organellesOf(genome, 'flagellum').length * 0.03);
}
export function deriveFlagellaPower(genome) {
    return powerOf(genome, 'flagellum');
}
export function deriveMouthCount(genome) {
    return organellesOf(genome, 'mouth').length;
}
export function deriveMouthPower(genome) {
    return powerOf(genome, 'mouth');
}
/** Passive energy/tick from ambient light — the "plant" income stream. */
export function derivePhotosynthesis(genome) {
    return powerOf(genome, 'chloroplast') * 0.05;
}
export function deriveChloroplastPower(genome) {
    return powerOf(genome, 'chloroplast');
}
/** Armor makes a cell read as effectively bigger/tougher to predators
 * without paying full chassis-size energy cost for the same protection. */
export function deriveArmorBonus(genome) {
    return 1 + powerOf(genome, 'armor') * 0.15;
}
export function deriveArmorMitigation(genome) {
    return Math.min(0.5, powerOf(genome, 'armor') * 0.12);
}
export function deriveEyes(genome) {
    return organellesOf(genome, 'eye');
}
export function hasBud(genome) {
    return genome.organelles.some((o) => o.kind === 'bud');
}
/** Builds an evenly-spaced starter organelle ring from simple per-kind
 * counts — this is what the Designer UI hands to World.addSpecies(). */
export function buildOrganelles(loadout) {
    const list = [];
    for (let i = 0; i < (loadout.flagella ?? 0); i++)
        list.push({ kind: 'flagellum' });
    for (let i = 0; i < (loadout.mouths ?? 0); i++)
        list.push({ kind: 'mouth' });
    for (let i = 0; i < (loadout.chloroplasts ?? 0); i++)
        list.push({ kind: 'chloroplast' });
    for (let i = 0; i < (loadout.eyes ?? 0); i++)
        list.push({ kind: 'eye' });
    for (let i = 0; i < (loadout.armor ?? 0); i++)
        list.push({ kind: 'armor' });
    if (loadout.bud)
        list.push({ kind: 'bud' });
    return list.slice(0, TRAIT_LIMITS.maxOrganelles).map((o, i, arr) => ({
        kind: o.kind,
        angle: (i / Math.max(1, arr.length)) * Math.PI * 2,
        size: 1.0,
    }));
}
export function randomGenome(rng, reproductionMode = 'asexual') {
    const count = rng.int(2, 6);
    const organelles = [];
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
export function mutateGenome(parent, rng) {
    const traitMutRate = 0.35;
    const traitStrength = 0.08;
    const jitter = (value, min, max) => {
        if (!rng.bool(traitMutRate))
            return value;
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
function mutateOrganelles(organelles, rng) {
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
export function crossoverGenome(a, b, rng) {
    const pick = (x, y) => (rng.bool(0.5) ? x : y);
    const pool = [...a.organelles, ...b.organelles];
    for (let i = pool.length - 1; i > 0; i--) {
        const j = rng.int(0, i);
        [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const targetCount = clamp(Math.round((a.organelles.length + b.organelles.length) / 2), 0, TRAIT_LIMITS.maxOrganelles);
    const organelles = [];
    let usedBud = false;
    for (const o of pool) {
        if (organelles.length >= targetCount)
            break;
        if (o.kind === 'bud') {
            if (usedBud)
                continue;
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
