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
// continuous world — there's no separate screen to remember anymore.)
const SAVE_VERSION = 2;

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
