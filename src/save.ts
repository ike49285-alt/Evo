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
 *
 * Two properties of this file are load-bearing, and both were learned the
 * hard way — by losing a 100,000-tick run:
 *
 * 1. **A save must fit.** iOS Safari caps localStorage at 5 MB per origin
 *    and counts it as UTF-16 — two bytes per character — so the real
 *    budget is ~2.5 million characters, not 5 million. A 5,000-tick dish
 *    used to serialize to 2.62 M characters, i.e. 5.0 MB against a 5 MB
 *    limit: sitting exactly on the ceiling. Every autosave was throwing
 *    QuotaExceededError. See genome.ts and nn.ts for the two changes that
 *    brought that to 0.74 M characters (1.4 MB as UTF-16).
 *
 * 2. **A save must never fail quietly.** That failure was invisible
 *    because this file caught the error and logged a console warning, and
 *    nobody reads a console on a phone. saveGame now reports its outcome
 *    to the caller, which puts it on screen (see main.ts).
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
// v7: Origin gained the hydrothermal vent (vent/ventDebt/ventInjected —
// see origin.ts's ventFluxPerTick comment). A v6 save would deserialize
// with vent=undefined rather than a real point or explicit null —
// moveParticles()'s `if (this.vent)` guard happens to degrade gracefully
// (falsy, so the current term is just skipped), but ventDebt/ventInjected
// would be undefined too, and spawnVentFlux() would throw the moment it
// ran (`this.ventDebt += undefined` -> NaN propagating silently is the
// more likely failure than a clean crash) — a real, if delayed and
// confusing, corruption rather than the clean discard this bump gives
// instead.
// v8: not a shape change (Origin's width/height/vent were already plain
// serialized fields, so a v7 save still deserializes without error) —
// bumped anyway on a "pool identity changed" basis. The pool's
// coordinate space now spans the whole dish and its matter concentrates
// into one patch (see origin.ts's seedPrimordialSoup) instead of living
// in a small fixed sub-rectangle. Without this bump, a resumed v7 save
// would silently keep running the old small pool forever (its own
// serialized width/height/vent override whatever main.ts would
// otherwise construct) while a freshly reset world gets the new
// full-dish pool — a confusing, silent divergence between "resumed" and
// "fresh" with no crash to signal it, not the kind of corruption v5-v7
// guarded against but a real footgun on this experimental branch
// nonetheless. Given this branch is unshipped, the cost of forcing a
// clean restart is low.)
// v9: genomes stopped serializing derived state (proteins, the class
// caches, the decoded core traits — all recomputed from the gene sequence
// by genomeFromSequence), the gene sequence packs to one string per gene
// instead of an array of single-character strings, and brain weights
// encode as exact base64 instead of full-precision doubles. Together a
// 3.55x reduction, which is what moved the file off the iOS ceiling
// described at the top of this file.
//
// **This is the first version that migrates instead of discarding.** Every
// bump above threw the player's run away. That is survivable at a hundred
// ticks and not at a hundred thousand. deserializeGenome and
// NeuralNet.fromJSON both read the old shape as well as the new one, so a
// v8 save loads with no transform at all — the only thing that had to
// change was this file's willingness to try.
//
// Worth noting *why* that became possible, since it is the durable lesson
// rather than a one-off: the fields v9 stopped writing are exactly the
// derived ones, and derived fields are the ones most likely to change as
// the model grows. v5 above exists only because the class caches were
// being serialized. A field that is never written can never invalidate a
// save.
// v10: lineage records gained life history — peak population, an extinction
// tick, and a final stats snapshot — so the Species panel can show a species
// that is no longer alive. The same change makes an extinct lineage drop its
// referenceSequence, which is what keeps that history affordable: the
// sequence is 95% of a record's weight and is unreachable once the last
// member dies (see LineageInfo.referenceSequence).
//
// This is not a cosmetic bump. Before it, `lineages` grew without bound at
// full weight, and once speciation actually started firing it was measured at
// 64% of a 20,000-tick save and on a straight line through the iOS storage
// ceiling somewhere around tick 60,000 — the same silent autosave failure
// that cost a hundred thousand ticks once already. A v9 save migrates rather
// than being discarded, and sheds its dead weight on the first load, which is
// most valuable precisely for the longest runs.
const SAVE_VERSION = 10;

/** Versions this build can still read. A save at one of these loads
 * directly; deserializeGenome absorbs the genome shape difference and
 * World.deserialize backfills the lineage life-history fields v10 added.
 * Anything older is a genuine break — v3 and v4 changed what a gene *means*,
 * so an old sequence would decode into a different creature entirely — and is
 * discarded, but loudly, never silently. */
const MIGRATABLE_VERSIONS = new Set([8, 9]);

interface SaveFile {
  version: number;
  savedAt: number;
  origin: SerializedOrigin;
  world: SerializedWorld;
}

/** What a save attempt did. Returned rather than swallowed so the UI can
 * show it — see this file's header on why that is not optional. */
export type SaveOutcome =
  | { ok: true; bytes: number }
  | { ok: false; outOfSpace: boolean; message: string };

/** What a load attempt found. `discarded` carries a reason, so a player
 * whose old run could not be read is told, rather than being handed a
 * fresh empty dish with no explanation. */
export type LoadOutcome =
  | { status: 'loaded'; origin: Origin; world: World; migratedFrom: number | null }
  | { status: 'empty' }
  | { status: 'discarded'; reason: string };

/** Serializes both engines to one localStorage key. Never throws — a
 * failed save must not take down a running simulation — but it does
 * *report*, which is the entire difference between this and the version
 * that lost a 100k-tick run. */
export function saveGame(origin: Origin, world: World): SaveOutcome {
  let json: string;
  try {
    json = buildSave(origin, world);
  } catch (e) {
    return { ok: false, outOfSpace: false, message: `Could not package the save: ${describe(e)}` };
  }
  try {
    localStorage.setItem(SAVE_KEY, json);
    return { ok: true, bytes: json.length };
  } catch (e) {
    if (isQuotaError(e)) {
      // Its own case because the remedy is nothing like any other
      // failure's: the run is fine, the browser is full, and the player
      // needs to export before they lose it.
      return {
        ok: false,
        outOfSpace: true,
        message: `Out of browser storage (this run needs ${Math.round(json.length / 1024)} KB). Export it to keep it.`,
      };
    }
    return { ok: false, outOfSpace: false, message: `Storage unavailable: ${describe(e)}` };
  }
}

function buildSave(origin: Origin, world: World): string {
  const payload: SaveFile = {
    version: SAVE_VERSION,
    savedAt: Date.now(),
    origin: origin.serialize(),
    world: world.serialize(),
  };
  return JSON.stringify(payload);
}

/** localStorage's out-of-space signal is not one thing. The standard name
 * is QuotaExceededError, Firefox has historically thrown
 * NS_ERROR_DOM_QUOTA_REACHED, and both have used code 22 or 1014.
 * Misclassifying it means reporting a full disk as a generic error and
 * sending the player looking in entirely the wrong place. */
function isQuotaError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const code = (e as { code?: number }).code;
  return (
    e.name === 'QuotaExceededError' ||
    e.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    code === 22 ||
    code === 1014
  );
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function loadGame(): LoadOutcome {
  let raw: string | null;
  try {
    raw = localStorage.getItem(SAVE_KEY);
  } catch (e) {
    return { status: 'discarded', reason: `Could not read browser storage: ${describe(e)}` };
  }
  if (!raw) return { status: 'empty' };
  return readSave(raw);
}

/** Shared by loadGame and importSave, so a pasted save goes through
 * exactly the same validation and migration as a stored one. There is
 * deliberately no second, weaker route into the simulation. */
function readSave(raw: string): LoadOutcome {
  let data: SaveFile;
  try {
    data = JSON.parse(raw) as SaveFile;
  } catch {
    return { status: 'discarded', reason: 'That is not an Evo save — it is not valid JSON.' };
  }
  if (!data || typeof data.version !== 'number' || !data.world || !data.origin) {
    return { status: 'discarded', reason: 'That is not an Evo save — it has no world or pool data in it.' };
  }
  if (data.version !== SAVE_VERSION && !MIGRATABLE_VERSIONS.has(data.version)) {
    return {
      status: 'discarded',
      reason: `That save is version ${data.version}. This build reads version ${SAVE_VERSION} and can convert ` +
        `${[...MIGRATABLE_VERSIONS].join(', ')} — version ${data.version} is too old to convert.`,
    };
  }
  try {
    return {
      status: 'loaded',
      origin: Origin.deserialize(data.origin),
      world: World.deserialize(data.world),
      migratedFrom: data.version === SAVE_VERSION ? null : data.version,
    };
  } catch (e) {
    return { status: 'discarded', reason: `The save could not be rebuilt: ${describe(e)}` };
  }
}

/** The whole run as text, for the player to keep somewhere the browser
 * cannot evict. Built from live state rather than read back out of
 * storage, so exporting still works when storage is the broken thing —
 * which is precisely when it is needed. */
export function exportSave(origin: Origin, world: World): string {
  return buildSave(origin, world);
}

/** Loads a pasted or opened save. Validates completely before returning,
 * so a bad paste reports a reason instead of half-loading into a broken
 * dish. Does not touch storage — the caller saves once the new world is
 * actually installed. */
export function importSave(text: string): LoadOutcome {
  const trimmed = text.trim();
  if (!trimmed) return { status: 'discarded', reason: 'Nothing to import — the box is empty.' };
  return readSave(trimmed);
}

export function clearSave(): void {
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch {
    // ignore — nothing to clean up if storage isn't available at all
  }
}
