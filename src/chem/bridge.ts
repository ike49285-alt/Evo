/**
 * The handoff from Stage 0 (chemistry) to the existing organelle/Virtunism
 * dish: once a protocell in Origin clears the bootstrap bar (see
 * vesicle.ts's isBootstrapEligible), this turns *what it actually evolved*
 * — which catalyst classes its peptides settled into, how big it grew —
 * into a founder SpeciesTemplate for World.addSpecies().
 *
 * This mapping is a deliberate, documented translation, not a claim that
 * real biology works this way mechanistically (that gap — an actual
 * genetic code, ribosomal translation, a full metabolic network — is
 * exactly the part NOTES.md's honesty section would want flagged, not
 * quietly assumed). Each rule below is at least analogically grounded in
 * what the catalyst class actually *does* in the Stage 0 sim:
 *
 *  - `peptidyl` catalysts build biomass from raw monomers + ambient
 *    energy — the closest thing this soup has to anabolism, so they seed
 *    chloroplasts (the dish's own "energy in, biomass out" organelle).
 *  - `protease` catalysts break external polymers down into usable
 *    pieces — literal digestion, so they seed mouths.
 *  - `lipidsynthase` catalysts work at the membrane — structural
 *    upkeep, so they seed armor.
 *  - `replicase` catalysts are what made heredity possible at all; they
 *    don't map to a body part, they map to *how many* founders this
 *    lineage gets to start with and a small mobility baseline, since a
 *    lineage that solved replication well earns a real head start.
 */
import { TRAIT_LIMITS } from '../sim/genome.js';
import { SpeciesTemplate } from '../sim/world.js';
import { CatalysisClass } from './polymer.js';
import { BootstrapCandidate } from './origin.js';

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** Cheap deterministic hash so the same evolved sequence always produces
 * the same cosmetic hue — reproducible, not re-randomized on every call. */
function hashToUnit(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

export interface TranslatedFounder {
  template: SpeciesTemplate;
  name: string;
  originVesicleId: number;
}

export function translateBootstrapCandidate(candidate: BootstrapCandidate): TranslatedFounder {
  const strength: Record<CatalysisClass, number> = {
    replicase: 0,
    peptidyl: 0,
    lipidsynthase: 0,
    protease: 0,
  };
  for (const p of candidate.peptides) {
    if (p.fold.isCatalyst && p.fold.catalysisClass) {
      strength[p.fold.catalysisClass] += p.fold.catalysisStrength;
    }
  }
  for (const r of candidate.rnas) {
    if (r.fold.isRibozyme) strength.replicase += r.fold.catalysisStrength;
  }

  let chloroplasts = Math.round(strength.peptidyl * 3);
  let mouths = Math.round(strength.protease * 3);
  const armor = Math.round(strength.lipidsynthase * 2);
  const flagella = 1 + (strength.replicase > 0.15 ? 1 : 0);
  const eyes = 1; // minimal sensing from the start — a totally blind founder starves before selection gets a say

  // A founder that can neither eat nor photosynthesize is a guaranteed,
  // uninteresting extinction — not a real evolutionary outcome, just a
  // translation-layer failure to seed anything workable. If the evolved
  // catalyst mix genuinely didn't produce either, default to the weaker
  // (photosynthesis) fallback rather than silently dropping the founder.
  if (chloroplasts === 0 && mouths === 0) chloroplasts = 1;

  const totalOrganelles = flagella + mouths + chloroplasts + eyes + armor;
  const scale = totalOrganelles > TRAIT_LIMITS.maxOrganelles ? TRAIT_LIMITS.maxOrganelles / totalOrganelles : 1;
  const loadout = {
    flagella: Math.max(1, Math.round(flagella * scale)),
    mouths: Math.round(mouths * scale),
    chloroplasts: Math.round(chloroplasts * scale),
    eyes,
    armor: Math.round(armor * scale),
  };

  const hashSeed = candidate.peptides.map((p) => p.sequence.join('')).join('|') + candidate.rnas.map((r) => r.sequence.join('')).join('|');
  const hue = hashToUnit(hashSeed || String(candidate.vesicleId)) * 360;
  const size = clamp(0.7 + candidate.radius / 40, TRAIT_LIMITS.size.min, 1.8);
  const senseRadius = clamp(110 + eyes * 30, TRAIT_LIMITS.senseRadius.min, 260);
  const maxAge = clamp(700 + candidate.lipidCount * 4, TRAIT_LIMITS.maxAge.min, 1600);

  const name = `Protocell-${candidate.vesicleId}`;

  return {
    name,
    originVesicleId: candidate.vesicleId,
    template: {
      reproductionMode: 'asexual', // sexual reproduction is a later evolutionary innovation, not a Stage 0 starting point
      size,
      senseRadius,
      maxAge,
      hue,
      loadout,
    },
  };
}
