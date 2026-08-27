/**
 * Save/restore for both engines at once, to a single localStorage key.
 * Everything actually simulated (particles, virtunisms, lineages, the
 * ancestry tree, rng state, id counters) round-trips exactly — see each
 * engine's own `serialize()`/`deserialize()` (Origin in chem/origin.ts,
 * World in sim/world.ts) for what that covers and why the pieces that
 * need special handling (circular bond-tree refs, Sets, Float32Arrays,
 * process-global id counters) need it. Camera position and UI toggles
 * (paused, speed) are deliberately *not* saved — those are session
 * preferences, not simulation state, and resetting them on reload is the
 * expected, unsurprising behavior.
 */
import { Origin, SerializedOrigin } from './chem/origin.js';
import { World, SerializedWorld } from './sim/world.js';

const SAVE_KEY = 'evo-save-v2';
// Bumping this on any future breaking change to the serialized shape is
// the whole safety net — an old save that doesn't match just gets
// discarded (fresh start) instead of half-loading into a corrupt state.
// (v2: dropped the `stage` field when Origins/Dish merged into one
// continuous world — there's no separate screen to remember anymore.
// v3: real gene-sequence genomes replaced the flat trait struct —
// LineageInfo now requires a referenceSequence a v2 save wouldn't have
// (checkSpeciation would crash on it), and the gene decode itself changed
// from positional to sum-based, so even an old sequence that happened to
// still have the right shape would silently decode to a different
// phenotype than what was actually saved.
// v4: organelles (a fixed kind/angle/size catalog) replaced entirely by
// real protein genes (translated through a codon table, folded, and read
// for real emergent function) — Genome.organelles doesn't exist anymore
// (it's Genome.proteins, a different shape), and protein-coding genes are
// PROTEIN_GENE_LENGTH symbols instead of the old organelle genes'
// GENE_LENGTH, so a v3 sequence wouldn't even decode to the right gene
// boundaries, let alone the right meaning.
// v5: Genome gained classPowerCache/classCountCache (a real-headless-
// profile-driven perf fix — see genome.ts's comment on Genome — computed
// once at construction instead of re-scanning genome.proteins on every
// classPower()/hasClass() call). serializeGenome spreads the whole
// Genome object as-is, so these ride along for free on a *new* save, but
// a v4 save predates them entirely — deserializing one would hand
// classPower()/hasClass() `undefined[cls]` and crash immediately, not
// silently misbehave, so this has to be a hard version bump like the
// others rather than something patched over on load.
// v6: Genome gained isDna (the RNA->DNA heredity transition — see
// genome.ts's DNA_TRANSITION_THRESHOLD). A v5 save's genomes would
// deserialize with isDna undefined, which is falsy and wouldn't crash —
// but it would silently treat an already-DNA lineage as freshly RNA again
// (losing its earned lower mutation rate) rather than erroring, exactly
// the "half-loads into a corrupt-but-plausible state" failure mode this
// version bump exists to prevent.
// v7: Origin gained the hydrothermal vent (vent/ventDebt/ventBaseline —
// see origin.ts's ventFluxPerTick comment). A v6 save would deserialize
// with vent=undefined rather than a real point or explicit null —
// moveParticles()'s `if (this.vent)` guard happens to degrade gracefully
// (falsy, so the current term is just skipped), but ventDebt/ventBaseline
// would be undefined too, and spawnVentFlux() would throw the moment it
// ran (`this.ventDebt += undefined` -> NaN propagating silently is the
// more likely failure than a clean crash) — a real, if delayed and
// confusing, corruption rather than the clean discard this bump gives
// instead.)
const SAVE_VERSION = 7;

interface SaveFile {
  version: number;
  savedAt: number;
  origin: SerializedOrigin;
  world: SerializedWorld;
}

export function saveGame(origin: Origin, world: World): void {
  try {
    const payload: SaveFile = {
      version: SAVE_VERSION,
      savedAt: Date.now(),
      origin: origin.serialize(),
      world: world.serialize(),
    };
    localStorage.setItem(SAVE_KEY, JSON.stringify(payload));
  } catch (e) {
    // Quota exceeded, storage disabled (private browsing in some
    // browsers), or something unserializable slipped in — none of these
    // should ever crash the running sim, just skip this save attempt.
    console.warn('Evo: autosave failed', e);
  }
}

export function loadGame(): { origin: Origin; world: World } | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as SaveFile;
    if (data.version !== SAVE_VERSION) return null;
    return {
      origin: Origin.deserialize(data.origin),
      world: World.deserialize(data.world),
    };
  } catch (e) {
    console.warn('Evo: saved game was unreadable, starting fresh', e);
    return null;
  }
}

export function clearSave(): void {
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch {
    // ignore — nothing to clean up if storage isn't available at all
  }
}
