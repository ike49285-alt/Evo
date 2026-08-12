/**
 * Save/restore for both engines at once, to a single localStorage key.
 * Everything actually simulated (particles, virtunisms, lineages, the
 * ancestry tree, rng state, id counters) round-trips exactly — see each
 * engine's own `serialize()`/`deserialize()` (Origin in chem/origin.ts,
 * World in sim/world.ts) for what that covers and why the pieces that
 * need special handling (circular bond-tree refs, Sets, Float32Arrays,
 * process-global id counters) need it. Camera position and UI toggles
 * (paused, speed, which tab is open) are deliberately *not* saved — those
 * are session preferences, not simulation state, and resetting them on
 * reload is the expected, unsurprising behavior.
 */
import { Origin } from './chem/origin.js';
import { World } from './sim/world.js';
const SAVE_KEY = 'evo-save-v1';
// Bumping this on any future breaking change to the serialized shape is
// the whole safety net — an old save that doesn't match just gets
// discarded (fresh start) instead of half-loading into a corrupt state.
const SAVE_VERSION = 1;
export function saveGame(origin, world, stage) {
    try {
        const payload = {
            version: SAVE_VERSION,
            savedAt: Date.now(),
            stage,
            origin: origin.serialize(),
            world: world.serialize(),
        };
        localStorage.setItem(SAVE_KEY, JSON.stringify(payload));
    }
    catch (e) {
        // Quota exceeded, storage disabled (private browsing in some
        // browsers), or something unserializable slipped in — none of these
        // should ever crash the running sim, just skip this save attempt.
        console.warn('Evo: autosave failed', e);
    }
}
export function loadGame() {
    try {
        const raw = localStorage.getItem(SAVE_KEY);
        if (!raw)
            return null;
        const data = JSON.parse(raw);
        if (data.version !== SAVE_VERSION)
            return null;
        return {
            origin: Origin.deserialize(data.origin),
            world: World.deserialize(data.world),
            stage: data.stage === 'dish' ? 'dish' : 'origins',
        };
    }
    catch (e) {
        console.warn('Evo: saved game was unreadable, starting fresh', e);
        return null;
    }
}
export function clearSave() {
    try {
        localStorage.removeItem(SAVE_KEY);
    }
    catch {
        // ignore — nothing to clean up if storage isn't available at all
    }
}
