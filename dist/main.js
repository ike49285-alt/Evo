import { Renderer } from './render/renderer.js';
import { deriveEnergyCapturePower, derivePredationPower, genomeFromSequence, randomGenome } from './sim/genome.js';
import { World } from './sim/world.js';
import { cloneGeneSequence, CORE_GENE_COUNT, decodeCoreTraits, decodeProteinGene, LOCUS, validateGeneSequence, } from './sim/genes.js';
import { NUCLEOTIDE_CODES } from './chem/elements.js';
import { CATALYSIS_CLASSES } from './chem/polymer.js';
import { Origin } from './chem/origin.js';
import { translateBootstrapCandidate } from './chem/bridge.js';
import { drawSparkline, drawScatter, drawRadarChart } from './ui/chart.js';
import { defaultTreeCamera, drawTree, hitTestTree, panTreeCamera, zoomTreeCameraAt, } from './ui/treeview.js';
import { drawSpeciesTree } from './ui/speciestree.js';
import { exportSave, importSave, loadGame, saveGame } from './save.js';
import { offerRunDownload } from './download.js';
// The dish at the default population cap. Everything else scales off these.
const BASE_POP_CAP = 320;
const BASE_WORLD_WIDTH = 2400;
const BASE_WORLD_HEIGHT = 1500;
const BASE_SUNLIGHT = 24;
/** Dish dimensions for a given population cap, holding *density* constant.
 *
 * This is the single most important number in the scaling work and it is
 * not cosmetic. Sense radius reaches 320, so in a 2400x1500 dish one
 * organism's senses already cover ~9% of the world: pack more organisms
 * into the same box and every one of them sees proportionally more
 * neighbours, which makes the sensing pass quadratic. Measured on a fixed
 * dish, per-organism cost went 0.97us at 500 -> 2.02us at 2,000 -> 6.83us
 * at 8,000. Scaling the area alongside the population instead held it at
 * 0.72 / 1.00 / 1.12us.
 *
 * So the population cap and the world size are one knob, not two, and this
 * is where they are tied together. */
function worldSizeFor(cap) {
    const k = Math.sqrt(Math.max(1, cap) / BASE_POP_CAP);
    return { width: Math.round(BASE_WORLD_WIDTH * k), height: Math.round(BASE_WORLD_HEIGHT * k) };
}
/** Total light for a given cap. Population turns out to track energy input
 * almost exactly linearly and to barely notice the cap at all — measured,
 * sunlight 24/96/216/384 produced 189/1049/2137/3843 organisms. Raising the
 * cap without raising this just buys a ceiling nothing ever reaches. */
function sunlightFor(cap) {
    return BASE_SUNLIGHT * (Math.max(1, cap) / BASE_POP_CAP);
}
/** Builds a world sized and lit for the current cap. */
function makeWorld(cap) {
    const { width, height } = worldSizeFor(cap);
    const w = new World(width, height, Date.now() & 0xffffffff);
    w.maxPopulation = cap;
    w.sunlightCapacity = sunlightFor(cap);
    return w;
}
// Phase B: the pool's own coordinate space now spans the whole dish,
// not a small sub-rectangle within it — Origin is constructed at
// WORLD_WIDTH/HEIGHT directly (see the seedPrimordialSoup calls below).
// The initial matter dose still concentrates into one dense patch
// (origin.ts's own seedPrimordialSoup — the same "concentration
// problem" bondRadius's comment there documents), just relocated inside
// Origin itself rather than expressed as a smaller Origin living inside
// a bigger World. POOL_OFFSET is always {0,0} now that the two spaces
// are coextensive by construction — kept as a named constant (not
// deleted) since Renderer.draw() and autoBootstrap() below both already
// thread it through as their one seam for Origin-space -> World-space
// translation, and reintroducing it later would cost more than keeping
// it costs now.
const POOL_OFFSET = { x: 0, y: 0 };
// Stage 0 — the primordial pool, the vent, vesicles, and the abiogenesis
// bootstrap that turned a protocell into a founder — is retired by default:
// the stage was judged not to earn its complexity. Nothing is deleted.
// Flip SOUP_DEFAULT, or load the page with ?soup=1, and the whole thing
// comes back exactly as it was; ?soup=0 forces it off even if the default
// ever flips back.
//
// Worth being precise about what is NOT retired here, because the folder
// name misleads: src/chem/polymer.ts's foldPeptide and elements.ts's
// CODON_TABLE are not soup code. They are how a gene becomes a capability
// at all (decodeProteinGene -> foldPeptide -> catalysisClass ->
// classPowerCache -> every derive* in genome.ts), and they also drive
// speciation, founder viability and every organism the renderer draws.
// Those stay running in both modes.
const SOUP_DEFAULT = false;
const soupParam = new URLSearchParams(window.location.search).get('soup');
const SOUP_ENABLED = soupParam === null ? SOUP_DEFAULT : soupParam === '1';
function el(id) {
    const found = document.getElementById(id);
    if (!found)
        throw new Error(`Missing element #${id}`);
    return found;
}
// --- in-page confirmation ------------------------------------------------
// Deliberately not window.confirm(): this app also ships bundled as a
// single-file Artifact, rendered inside a sandboxed iframe — and native
// browser dialogs are commonly blocked or silently return `false` in
// that context (mobile Safari in particular). A blocked confirm() made
// Reset World look completely broken: `if (!confirm(...)) return;` bails
// out instantly and silently the moment confirm() can't actually show
// anything, with no error and no visible dialog to explain why nothing
// happened. This is a real DOM-built substitute, immune to that.
const confirmOverlay = el('confirm-overlay');
const confirmMessage = el('confirm-message');
const confirmOkBtn = el('confirm-ok');
const confirmCancelBtn = el('confirm-cancel');
function confirmDialog(message) {
    confirmMessage.textContent = message;
    confirmOverlay.hidden = false;
    return new Promise((resolve) => {
        const cleanup = (result) => {
            confirmOverlay.hidden = true;
            confirmOkBtn.removeEventListener('click', onOk);
            confirmCancelBtn.removeEventListener('click', onCancel);
            confirmOverlay.removeEventListener('click', onOverlayClick);
            resolve(result);
        };
        const onOk = () => cleanup(true);
        const onCancel = () => cleanup(false);
        const onOverlayClick = (e) => {
            if (e.target === confirmOverlay)
                cleanup(false);
        };
        confirmOkBtn.addEventListener('click', onOk);
        confirmCancelBtn.addEventListener('click', onCancel);
        confirmOverlay.addEventListener('click', onOverlayClick);
    });
}
// --- one continuous world --------------------------------------------
// Origins (the chemistry — see src/chem/) and the Dish (the organelle/
// Virtunism ecosystem) are two engines, but one world: the primordial
// pool's coordinate space spans the whole dish (see POOL_OFFSET, always
// {0,0} now — Phase B), not a separate screen or even a distinguished
// sub-rectangle within it anymore; its matter just starts concentrated
// into one dense patch (see origin.ts's seedPrimordialSoup) rather than
// spread evenly. A protocell that clears the bootstrap bar spawns its
// founders automatically, right where it bootstrapped, with no button to
// click and nowhere else to teleport to — see autoBootstrap() below.
//
// Both engines' state autosaves to localStorage every 5s (see save.ts)
// and gets restored here on load if a save exists — a page reload or an
// accidentally-closed tab doesn't cost you a run.
const restored = loadGame();
/** A pool for the current mode. With Stage 0 retired this is a genuinely
 * empty, vent-less Origin: the constructor is public and separate from the
 * seedPrimordialSoup factory, so "no soup" costs nothing but an unused
 * object — and keeps `origin` non-null at every call site, so no null checks
 * leak through the rest of the file. Since frame() also stops calling
 * origin.update() in that mode, nothing is ever injected and it stays
 * empty. */
function makePool(width, height) {
    const seed = Date.now() & 0xffffffff;
    return SOUP_ENABLED
        ? Origin.seedPrimordialSoup(width, height, seed)
        : new Origin(width, height, seed, /* ventEnabled */ false);
}
// World first, then a pool sized to match it — makePool needs real
// dimensions and `world` is not in scope until it exists.
let world = restored.status === 'loaded' ? restored.world : makeWorld(BASE_POP_CAP);
let origin = restored.status === 'loaded' ? restored.origin : makePool(world.width, world.height);
const BOOT_SEED_COUNT = 12;
/** Stocks a brand-new dish with one starting population.
 *
 * With Stage 0 retired, nothing else ever puts life into the world: World's
 * constructor deliberately builds an empty dish (see its own comment on why
 * there is no hand-designed starter species), and with no pool to bootstrap
 * from, "empty" would mean empty forever — the player would open the app to
 * a dead dish and have to find the Designer tab to start anything.
 *
 * Uses exactly the path the Designer's own Release button drives, so a
 * seeded founder is the same kind of thing a player-released one is:
 * randomGenome runs ensureEnergyCapable, so it is guaranteed a real route to
 * feed itself rather than a random loadout that might starve immediately.
 *
 * Deliberately only ever called for a *fresh* dish — first boot with no
 * save, and Reset. Never on extinction: a dish that dies stays dead, which
 * is the promise the closed loop makes everywhere else. */
function seedStartingPopulation() {
    world.addSpeciesFromSequence(randomGenome(world.rng).sequence, BOOT_SEED_COUNT);
}
// `restored.status`, not a null check: loadGame returns an outcome object
// now, so `restored === null` was silently always false and the dish booted
// empty — no founders, no life, nothing to explain why.
if (!SOUP_ENABLED && restored.status !== 'loaded')
    seedStartingPopulation();
const canvas = el('sim-canvas');
const renderer = new Renderer(canvas);
let paused = false;
let speed = 1;
// --- resize / camera -------------------------------------------------
function handleResize() {
    renderer.resize();
}
window.addEventListener('resize', handleResize);
handleResize();
renderer.fitToWorld(world);
// Drag-to-pan (mouse, or one finger) and pinch-to-zoom (two fingers) share
// one pointer-tracking map keyed by pointerId — a pinch is two
// independent pointers moving at once, not a single gesture object the
// way native browser chrome hands it to you, so it has to be built from
// the raw Pointer Events stream. touch-action: none on #sim-canvas (see
// style.css) is what actually stops the browser's own page pinch-zoom/
// pan from claiming these touches before this code ever sees them —
// without it, a real gap: there was no pinch handling here at all, so a
// two-finger gesture had nothing but the browser's native page-zoom to
// fall back to, which is exactly "zoom works on the page, not the box."
const activePointers = new Map();
let lastPinchDist = null;
// Tap-to-select on the dish: a pointerdown that lifts (pointerup) close to
// where it went down, with only one pointer ever down during that whole
// gesture, selects whatever individual is under it — layered onto the
// same pointer stream pan/pinch already track above, not a second
// independent listener that could race it. TAP_MAX_SCREEN_DIST is in
// screen pixels, not world units: how far your finger/mouse actually
// moved on the glass is what separates a tap from a drag, not how far
// that maps to in world space at the current zoom.
const TAP_MAX_SCREEN_DIST = 6;
let tapCandidate = null;
function canvasPoint(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}
function pinchState() {
    if (activePointers.size !== 2)
        return null;
    const [a, b] = [...activePointers.values()];
    return { midX: (a.x + b.x) / 2, midY: (a.y + b.y) / 2, dist: Math.hypot(a.x - b.x, a.y - b.y) };
}
canvas.addEventListener('pointerdown', (e) => {
    // Capture is a nice-to-have (keeps a drag/pinch tracking correctly even
    // if a finger slides past the canvas edge) — not required for the
    // tracking logic below to work at all, so a capture failure shouldn't
    // be able to take the whole gesture system down with it. Real
    // headless-verified failure mode, not a defensive guess: synthetic
    // pointer events (and apparently some real-world edge cases too) can
    // make setPointerCapture throw "no active pointer with the given id",
    // and an uncaught throw here aborted the rest of this handler —
    // activePointers never got the new pointer, silently desyncing every
    // pinch/pan computed from it afterward.
    try {
        canvas.setPointerCapture(e.pointerId);
    }
    catch {
        // ignored — see above
    }
    const point = canvasPoint(e);
    activePointers.set(e.pointerId, point);
    // A second finger landing establishes the pinch's starting distance —
    // the very next pointermove diffs against this instead of jumping.
    lastPinchDist = pinchState()?.dist ?? null;
    // A tap candidate only survives as the *sole* pointer down — a second
    // finger landing (pinch start) cancels it immediately, same as real
    // movement does in pointermove below.
    tapCandidate = activePointers.size === 1 ? { pointerId: e.pointerId, x: point.x, y: point.y } : null;
});
canvas.addEventListener('pointermove', (e) => {
    if (!activePointers.has(e.pointerId))
        return;
    const prev = activePointers.get(e.pointerId);
    const next = canvasPoint(e);
    activePointers.set(e.pointerId, next);
    const pinch = pinchState();
    if (pinch) {
        // Two fingers down: pinch-to-zoom, anchored at their midpoint — the
        // touch equivalent of the wheel handler's cursor-anchored zoom below.
        // Single-finger panning is suspended for the duration of a pinch;
        // recomputing both from the same two points at once just fights.
        if (lastPinchDist !== null && lastPinchDist > 0) {
            renderer.zoomAt(pinch.midX, pinch.midY, pinch.dist / lastPinchDist);
        }
        lastPinchDist = pinch.dist;
        tapCandidate = null;
        return;
    }
    if (activePointers.size === 1) {
        renderer.panByScreenDelta(next.x - prev.x, next.y - prev.y);
    }
    // Moved far enough on the glass that this reads as a drag, not a tap.
    // Reaching here means activePointers.size is 1 (the pinch branch above
    // already returned otherwise), so e.pointerId is necessarily the one
    // tapCandidate, if any, is tracking.
    if (tapCandidate && Math.hypot(next.x - tapCandidate.x, next.y - tapCandidate.y) > TAP_MAX_SCREEN_DIST) {
        tapCandidate = null;
    }
});
function releasePointer(e) {
    activePointers.delete(e.pointerId);
    // Dropping back to one finger (or zero) needs a fresh pinch baseline
    // next time a second finger lands, not a stale distance from before.
    lastPinchDist = pinchState()?.dist ?? null;
}
/** Nearest alive cell whose body (plus a fixed screen-space tap
 * tolerance, converted to world units by the current zoom so the
 * tappable margin around a small/zoomed-out cell stays a usable size on
 * screen) contains the tapped world point. Linear scan over world.cells —
 * runs once per completed tap, not per frame, so population size doesn't
 * matter the way it would in the render loop. */
const TAP_HIT_PAD_SCREEN = 6;
function hitTestDish(worldX, worldY) {
    const padWorld = TAP_HIT_PAD_SCREEN / renderer.camera.zoom;
    let best = null;
    let bestD = Infinity;
    for (const cell of world.cells) {
        if (!cell.alive)
            continue;
        const d = Math.hypot(cell.x - worldX, cell.y - worldY);
        if (d <= cell.radius + padWorld && d < bestD) {
            bestD = d;
            best = cell.id;
        }
    }
    return best;
}
function handleDishTap(sx, sy) {
    const worldPt = renderer.screenToWorld(sx, sy);
    // The manual-spawn tool (Chemistry tab, wired further down) hijacks
    // dish taps while armed — placing chemistry takes priority over
    // selecting an individual, and doesn't fall through to hit-testing.
    // Unreachable with Stage 0 retired (the tab is hidden, so nothing can arm
    // it), but gated rather than left as a live branch into a pool that is
    // never simulated.
    if (SOUP_ENABLED && spawnArmed) {
        placeManualSpawn(worldPt.x, worldPt.y);
        return;
    }
    const hit = hitTestDish(worldPt.x, worldPt.y);
    // Tapping empty water is a no-op, not a deselect — mirrors the tree
    // canvas's own click handler below: Clear (Tree tab) is the one
    // deliberate way to deselect, shared by both since they drive the same
    // selectedIndividualId.
    if (hit !== null)
        selectIndividual(hit);
}
canvas.addEventListener('pointerup', (e) => {
    // A completed tap: this pointer is the one tapCandidate has been
    // tracking, and it never moved past the drag threshold or got
    // cancelled by a pinch — see pointerdown/pointermove above. Uses the
    // *down* position (not wherever it lifted) — by construction the two
    // are always within TAP_MAX_SCREEN_DIST of each other by this point.
    if (tapCandidate && tapCandidate.pointerId === e.pointerId) {
        handleDishTap(tapCandidate.x, tapCandidate.y);
    }
    tapCandidate = null;
    releasePointer(e);
});
canvas.addEventListener('pointercancel', (e) => {
    // A cancelled gesture (the browser/OS took it over, e.g. a scroll) is
    // never a completed tap.
    tapCandidate = null;
    releasePointer(e);
});
canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    renderer.zoomAt(e.clientX - rect.left, e.clientY - rect.top, factor);
}, { passive: false });
// --- top bar controls --------------------------------------------------
const btnPlay = el('btn-play');
btnPlay.addEventListener('click', () => {
    paused = !paused;
    btnPlay.textContent = paused ? 'Play' : 'Pause';
});
document.querySelectorAll('.speed-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.speed-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        speed = Number(btn.dataset.speed) || 1;
    });
});
el('btn-fit').addEventListener('click', () => {
    renderer.fitToWorld(world);
});
// Population cap — live-adjustable while the right value is still being
// worked out (see World.maxPopulation's comment), rather than a constant
// that needs a rebuild to try a new number. Not part of the save format
// yet (a deliberate, temporary-tool scope choice) — a page reload goes
// back to World's own default until this setting earns a permanent home.
const popCapInput = el('pop-cap-input');
popCapInput.value = String(world.maxPopulation);
/** The cap the input currently asks for, clamped and normalised. */
function currentPopCap() {
    const parsed = Math.round(Number(popCapInput.value));
    return Math.min(20000, Math.max(20, Number.isFinite(parsed) ? parsed : world.maxPopulation));
}
/** Applies the cap to the *running* world. Deliberately only the ceiling
 * and the light budget: the dish's physical dimensions cannot change under
 * a population that is already standing in it, so a resize waits for the
 * next world (Reset, or a fresh boot) — see makeWorld. */
function applyPopCap() {
    const clamped = currentPopCap();
    popCapInput.value = String(clamped);
    world.maxPopulation = clamped;
    world.sunlightCapacity = sunlightFor(clamped);
}
popCapInput.addEventListener('change', applyPopCap);
el('btn-reset').addEventListener('click', async () => {
    const ok = await confirmDialog(SOUP_ENABLED
        ? 'Reset the whole world — wipe the pool and every evolved lineage, and start over from scratch?'
        : 'Reset the whole world — wipe every evolved lineage and start over from a freshly stocked dish?');
    if (!ok)
        return;
    // Sized and lit for whatever the cap is set to now — this is where a
    // changed population cap actually takes physical effect, because a live
    // world cannot be resized underneath its own inhabitants.
    world = makeWorld(currentPopCap());
    origin = makePool(world.width, world.height);
    // A reset is a fresh dish, so with Stage 0 retired it needs restocking for
    // the same reason first boot does — otherwise Reset hands the player a
    // permanently empty world.
    if (!SOUP_ENABLED)
        seedStartingPopulation();
    applyPopCap(); // the cap is a topbar-level setting, not per-world state — a reset shouldn't silently drop it back to the default
    renderer.fitToWorld(world);
    selectIndividual(null);
    // Session-level bookkeeping that isn't part of origin/world themselves
    // still needs a real reset here, or a reset after Stage 0 had already
    // retired (the common case — retirement fires in a few thousand ticks,
    // so most real reset clicks happen after it) hands the brand-new,
    // empty pool a `stage0Retired = true` it never earned: the fresh
    // world's own population is 0, so updateStage0Retirement()'s extinction
    // check would normally un-latch it on the very next tick anyway, but
    // that's an accident of the current threshold logic, not something to
    // depend on — reset explicitly instead of hoping the next tick's check
    // happens to cover it.
    stage0Retired = false;
    sustainedAboveThresholdTicks = 0;
    totalBootstraps = 0;
    osRetiredNotice.style.display = 'none';
    // Persist the reset immediately rather than waiting for the next 5s
    // autosave tick — a real bug, not a hypothetical: reload the page
    // inside that window (easy to do right after a deliberate reset, e.g.
    // to double-check it "took") and loadGame() hands back the *previous*
    // save, since the fresh empty world was never written to storage yet.
    // From the player's side that reads as "I hit Reset and my old
    // population just came back" — indistinguishable from Reset silently
    // not working at all.
    saveGame(origin, world);
});
let showVision = false;
const btnVision = el('btn-vision');
btnVision.addEventListener('click', () => {
    showVision = !showVision;
    btnVision.classList.toggle('active', showVision);
});
// --- tab rail (Designer / Species / Ecosystem / Chemistry / Tree) --------
let activeTab = 'designer';
document.querySelectorAll('#tab-rail .tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('#tab-rail .tab-btn').forEach((b) => {
            b.classList.remove('active');
            b.setAttribute('aria-selected', 'false');
        });
        document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
        btn.classList.add('active');
        btn.setAttribute('aria-selected', 'true');
        activeTab = btn.dataset.tab;
        el(`tab-${activeTab}`).classList.add('active');
        // Arriving at the Species tab must populate it immediately, whatever the
        // tick happens to be — and while paused the tick never moves again, which
        // is precisely how the old panel came to render nothing at all on a
        // paused dish. Declared later in the file; this runs on a click, long
        // after the module has finished loading.
        if (activeTab === 'species')
            refreshSpeciesSummaries(true);
    });
});
// With Stage 0 retired, the Chemistry tab and the pool-only HUD readout are
// hidden rather than removed from the markup. That is not squeamishness:
// el() throws on a missing id, and roughly twenty `os-*` lookups (including
// osRetiredNotice, at module scope) run at startup — deleting the panel
// while leaving those lookups would be a hard boot crash rather than a
// quiet no-op. Hiding keeps every id resolvable and makes re-enabling the
// stage a pure flag flip with nothing to restore.
if (!SOUP_ENABLED) {
    document.querySelector('#tab-rail .tab-btn[data-tab="chemistry"]')?.setAttribute('hidden', '');
    el('tab-chemistry').hidden = true;
}
// --- designer form (random-seed test tool) ---------------------------------
// No body-plan fields anymore — there's no organelle catalog left to
// hand-pick from, every functional part is a real folded protein (see
// sim/genome.ts). This just releases a population founded on a fresh
// randomGenome() — a way to seed a test population on demand rather than
// wait on a natural bootstrap, not a design surface.
const fCount = el('f-count');
const fName = el('f-name');
function refreshDesignerLabels() {
    el('v-count').textContent = fCount.value;
}
fCount.addEventListener('input', refreshDesignerLabels);
refreshDesignerLabels();
el('btn-release').addEventListener('click', () => {
    const reproductionMode = document.querySelector('input[name="repro"]:checked')
        ?.value;
    const name = fName.value.trim() || 'Unnamed Species';
    const seed = randomGenome(world.rng, reproductionMode);
    world.addSpeciesFromSequence(seed.sequence, Number(fCount.value), { name, isPlayerDesigned: true });
});
// Referenced by handleDishTap() above, defined here — a closure reading
// this at call time (well after the whole module has finished loading
// and every listener is registered), not at definition time, so the
// forward reference is safe.
let spawnArmed = null;
const spawnPolymerFields = el('spawn-polymer-fields');
const fSpawnLength = el('f-spawn-length');
const fSpawnForce = el('f-spawn-force');
const spawnForceLabel = el('spawn-force-label');
const btnSpawnArm = el('btn-spawn-arm');
function currentSpawnKind() {
    return document.querySelector('input[name="spawn-kind"]:checked')?.value;
}
function refreshSpawnFields() {
    const kind = currentSpawnKind();
    const isPolymer = kind === 'peptide' || kind === 'rna';
    spawnPolymerFields.style.display = isPolymer ? '' : 'none';
    spawnForceLabel.textContent = kind === 'rna' ? 'Force ribozyme' : 'Force catalytic';
    el('v-spawn-length').textContent = fSpawnLength.value;
}
document
    .querySelectorAll('input[name="spawn-kind"]')
    .forEach((r) => r.addEventListener('change', refreshSpawnFields));
fSpawnLength.addEventListener('input', refreshSpawnFields);
refreshSpawnFields();
btnSpawnArm.addEventListener('click', () => {
    // Toggle, not single-shot — an eyedropper-style tool the user can drop
    // several items with while hunting for the right vesicle, rather than
    // re-arming before every placement.
    spawnArmed = spawnArmed ? null : currentSpawnKind();
    btnSpawnArm.classList.toggle('active', spawnArmed !== null);
    btnSpawnArm.textContent = spawnArmed ? 'Placing… (tap button to stop)' : 'Place on Dish';
});
/** Places whatever's configured in the manual-spawn panel at a world
 * point. Inset 1px from the dish edge so a freshly-placed free particle
 * never lands exactly on the boundary and gets immediately wall-
 * despawned by moveParticles() (origin.ts) on the very next tick. */
function placeManualSpawn(worldX, worldY) {
    if (!spawnArmed)
        return;
    const at = {
        x: Math.min(Math.max(worldX, 1), world.width - 1),
        y: Math.min(Math.max(worldY, 1), world.height - 1),
    };
    switch (spawnArmed) {
        case 'aa':
        case 'nt':
        case 'lipid':
        case 'energy':
            origin.spawnManualParticle(spawnArmed, at);
            break;
        case 'peptide':
            origin.spawnManualPeptide(at, Number(fSpawnLength.value), fSpawnForce.checked);
            break;
        case 'rna':
            origin.spawnManualRna(at, Number(fSpawnLength.value), fSpawnForce.checked);
            break;
    }
}
// --- Origins: automatic bootstrap into the wider dish --------------------
// No button, no screen change — a protocell that clears the bar just
// starts existing as an ordinary founding lineage, spawned right where its
// vesicle actually was in the pool. A single protocell is one lucky origin
// event, not a designed species, so it gets a small founding handful (not
// the Designer's larger release) — small enough to feel like "this one
// thing made it," large enough not to be a coin-flip extinction the moment
// it starts (see world.ts's seedBaseSpecies note on knife-edge founders).
const BOOTSTRAP_FOUNDER_COUNT = 4;
let totalBootstraps = 0;
function autoBootstrap() {
    while (origin.bootstrapCandidates.length > 0) {
        const candidate = origin.bootstrapCandidates.shift();
        if (!candidate)
            break;
        const translated = translateBootstrapCandidate(candidate);
        world.addSpeciesFromSequence(translated.sequence, BOOTSTRAP_FOUNDER_COUNT, {
            isPlayerDesigned: false,
            spawnCenter: { x: POOL_OFFSET.x + candidate.x, y: POOL_OFFSET.y + candidate.y },
        });
        totalBootstraps++;
    }
}
// --- Stage 0 retirement -----------------------------------------------
// A fresh abiogenesis event has effectively no real chance of taking root
// once the dish already has an established population several
// generations deep — a brand-new protocell is competing against a
// population that's had many generations of selection to get good at
// staying alive, in a dish that's likely already near capacity. Past
// that point, running the pool is pure sunk compute (and, once
// rich-mode chemistry exists, compute that population actually wants).
// Once the dish's own population has stayed at or above
// STAGE0_RETIREMENT_POP_THRESHOLD for STAGE0_RETIREMENT_SUSTAIN_TICKS
// consecutive ticks, the pool is declared established and stops
// simulating.
//
// This is *not* an unconditional one-way latch, though — a real headless
// run caught why: if the dish's population later collapses to true
// extinction (0), staying retired forever leaves the whole world
// permanently dead with no possible recovery, which is a strictly worse
// outcome than spending compute on a pool that might not pay off. So
// retirement un-latches the moment population hits 0, handing the compute
// budget back to abiogenesis — the one thing that can still put life back
// in an empty dish. (An earlier version tried to derive this purely from
// world.history so it would round-trip through save/reload for free, but
// a stale trailing window made it flicker: right after a resume, the
// window was still full of pre-crash high-population samples, so it
// would immediately re-retire before origin.update() got a real chance to
// bootstrap anything. A live in-memory counter avoids that; the tradeoff
// is it doesn't persist across a reload, so a reload shortly after
// retirement re-observes the population for a while before re-retiring —
// harmless, just some redundant pool compute, never a hidden bug.)
const STAGE0_RETIREMENT_POP_THRESHOLD = 30;
const STAGE0_RETIREMENT_SUSTAIN_TICKS = 3000;
let stage0Retired = false;
let sustainedAboveThresholdTicks = 0;
const osRetiredNotice = el('os-retired-notice');
function updateStage0Retirement() {
    if (world.cells.length === 0) {
        sustainedAboveThresholdTicks = 0;
        if (stage0Retired) {
            stage0Retired = false;
            osRetiredNotice.style.display = 'none';
            console.info('Evo: Stage 0 (primordial pool) resumed — the dish went fully extinct, so abiogenesis gets another shot.');
        }
        return;
    }
    if (stage0Retired)
        return;
    sustainedAboveThresholdTicks = world.cells.length >= STAGE0_RETIREMENT_POP_THRESHOLD ? sustainedAboveThresholdTicks + 1 : 0;
    if (sustainedAboveThresholdTicks >= STAGE0_RETIREMENT_SUSTAIN_TICKS) {
        stage0Retired = true;
        osRetiredNotice.style.display = '';
        console.info('Evo: Stage 0 (primordial pool) retired — the dish sustained its own population, so the pool stopped simulating.');
    }
}
// --- chemistry stats panel ------------------------------------------------
function updateChemistryPanel() {
    const s = origin.getStats();
    el('os-tick').textContent = String(s.tick);
    el('os-bootstraps').textContent = String(totalBootstraps);
    el('os-aa').textContent = String(s.freeAminoAcids);
    el('os-nt').textContent = String(s.freeNucleotides);
    el('os-lipid').textContent = String(s.freeLipids);
    el('os-energy').textContent = String(s.freeEnergy);
    el('os-peptides').textContent = String(s.peptideCount);
    el('os-catalysts').textContent = String(s.catalystCount);
    el('os-longpep').textContent = String(s.longestPeptide);
    el('os-rna').textContent = String(s.rnaCount);
    el('os-ribozymes').textContent = String(s.ribozymeCount);
    el('os-longrna').textContent = String(s.longestRna);
    el('os-vesicles').textContent = String(s.vesicleCount);
    el('os-replevents').textContent = String(s.totalReplicationEvents);
    // Live-progress detail (chance estimate + closest-to-bootstrap block) —
    // hidden once Stage 0 has retired, same as the retired-notice pattern:
    // there's nothing live left to estimate once the pool stopped ticking.
    el('os-live-progress').style.display = stage0Retired ? 'none' : '';
    if (!stage0Retired) {
        const progress = origin.getBootstrapProgress();
        el('os-ready').textContent = String(progress.bootstrapReady);
        const pct = origin.estimateBootstrapChance(10000) * 100;
        el('os-chance').textContent = pct > 0 && pct < 1 ? `${pct.toFixed(1)}%` : `${Math.round(pct)}%`;
        const leading = progress.leading;
        el('os-closest-catalyst').textContent = leading ? (leading.hasActiveCatalyst ? 'yes' : 'no') : '—';
        el('os-closest-replicator').textContent = leading ? (leading.hasReplicatorNow ? 'yes' : 'no') : '—';
        el('os-closest-replication').textContent = leading ? `${Math.min(2, leading.replicationEvents)} / 2` : '—';
        el('os-closest-division').textContent = leading ? `${Math.min(1, leading.divisionsSoFar)} / 1 (${leading.lipidCount} lipids)` : '—';
    }
}
// --- HUD + stats panel ----------------------------------------------------
const sTick = el('s-tick');
const sPerf = el('s-perf');
const sPop = el('s-pop');
const sSpecies = el('s-species');
const sGen = el('s-gen');
const sColonies = el('s-colonies');
const sColonySize = el('s-colonysize');
const sSolo = el('s-solo');
const sMeat = el('s-meat');
const sRepro = el('s-repro');
const sMouths = el('s-mouths');
const sEyes = el('s-eyes');
const sArmor = el('s-armor');
const chartMorphs = el('chart-morphs');
const chartPop = el('chart-pop');
const chartSize = el('chart-size');
const chartSpeed = el('chart-speed');
const chartSense = el('chart-sense');
const chartFlagella = el('chart-flagella');
const chartChloro = el('chart-chloro');
const cPopVal = el('c-pop-val');
const cSizeVal = el('c-size-val');
const cSpeedVal = el('c-speed-val');
const cSenseVal = el('c-sense-val');
const cFlagellaVal = el('c-flagella-val');
const cChloroVal = el('c-chloro-val');
function updateStatsPanels() {
    const live = world.getLiveStats();
    sTick.textContent = String(live.tick);
    // With Stage 0 retired the frame cost is the world's alone — origin.update()
    // never runs, so folding in its stale lastTickMs would report time nothing
    // spends.
    sPerf.textContent = SOUP_ENABLED
        ? `${(world.perf.lastTickMs + origin.perf.lastTickMs).toFixed(2)}ms`
        : `${world.perf.lastTickMs.toFixed(2)}ms`;
    sPop.textContent = String(live.population);
    // Distinct lineages actually represented among living individuals right
    // now — world.lineages itself never shrinks (it's the permanent
    // phylogenetic record, extinct branches included), so counting *that*
    // would only ever go up. This is the number that actually answers "how
    // many species exist in the dish right now."
    sSpecies.textContent = String(new Set(world.cells.map((c) => c.lineageId)).size);
    sGen.textContent = String(live.maxGeneration);
    sColonies.textContent = String(live.colonies);
    sColonySize.textContent = live.avgColonySize.toFixed(1);
    sSolo.textContent = String(live.soloCells);
    sMeat.textContent = String(live.meatFood);
    sRepro.textContent = `${live.sexual} / ${live.asexual}`;
    sMouths.textContent = live.avgPredation.toFixed(2);
    sEyes.textContent = live.avgSensors.toFixed(2);
    sArmor.textContent = live.avgStructure.toFixed(2);
    // Morph scatter: one dot per virtunism, not an average — shows a
    // population actually splitting into distinct body plans (e.g. an
    // energy-capture-leaning cluster vs. a predation-leaning cluster)
    // instead of hiding the split behind a single blended mean.
    const morphPoints = world.cells.map((c) => ({
        x: c.genome.size,
        y: derivePredationPower(c.genome) - deriveEnergyCapturePower(c.genome),
        colorHsl: `hsl(${c.genome.hue}, 65%, 55%)`,
        ring: c.isPlayerDesigned,
    }));
    drawScatter(chartMorphs, morphPoints, {
        xLabel: 'size',
        yLabel: 'diet: energy capture ←→ predation',
    });
    const history = world.history;
    if (history.length > 1) {
        // A coherent cyan/green family — kept out of amber (--accent-2 is
        // reserved for genetic/species identity, not decorative chart
        // variety) and off the old blue/purple mix that didn't come from any
        // particular idea.
        drawSparkline(chartPop, history.map((h) => h.population), '#2fe6c4');
        drawSparkline(chartSize, history.map((h) => h.avgSize), '#4fe6a3');
        drawSparkline(chartSpeed, history.map((h) => h.avgSpeed), '#6fe67d');
        drawSparkline(chartSense, history.map((h) => h.avgSense), '#3fd0e6');
        drawSparkline(chartFlagella, history.map((h) => h.avgMotor), '#8fe66a');
        drawSparkline(chartChloro, history.map((h) => h.avgEnergyCapture), '#2fb894');
        cPopVal.textContent = String(live.population);
        cSizeVal.textContent = live.avgSize.toFixed(2);
        cSpeedVal.textContent = live.avgSpeed.toFixed(2);
        cSenseVal.textContent = live.avgSense.toFixed(0);
        cFlagellaVal.textContent = live.avgMotor.toFixed(2);
        cChloroVal.textContent = live.avgEnergyCapture.toFixed(2);
    }
}
// --- species panel ----------------------------------------------------
// A phylogeny of species, drawn on canvas, with the card behind a tap.
//
// This replaced a scrolling list of DOM cards, and the reason is worth
// keeping: that list was rebuilt wholesale — `replaceChildren()` then a fresh
// element per species — on the simulation's own stats cadence. With a single
// species that is six nodes and nobody notices. Once speciation actually
// started firing it became twenty to fifty cards, several hundred nodes,
// rebuilt as often as several times a second, and a tap needs pointerdown and
// pointerup on the *same* element: the card was being destroyed under the
// player's finger, so taps silently never landed while scrolling — which the
// compositor handles without the main thread — kept working. Measured before
// the change: an instant tap opened a card 5/5 times, a realistic 250ms one
// 1/5, and the element survived the press 0/5.
//
// The same gate failed in the other direction too. Keying the refresh on
// `tick % statsSampleInterval` meant a *paused* dish never refreshed at all,
// so opening this tab while paused showed nothing, permanently. Measured: 0
// cards rendered while paused.
//
// A canvas has neither problem. Nothing is replaced, so nothing can be
// replaced under a finger, and the redraw is one draw call per frame whatever
// the species count — the same treatment the Tree of Life tab already gets.
const speciesTreeCanvas = el('chart-species-tree');
const speciesTreeEmpty = el('species-tree-empty');
const speciesShowExtinct = el('species-show-extinct');
const speciesCamera = defaultTreeCamera();
let speciesPositions = new Map();
let selectedLineageId = null;
/** The summaries the tab is currently drawing from, refreshed on the stats
 * cadence rather than per frame — building them is an O(population) pass, and
 * unlike the old card list nothing about *drawing* depends on how fresh they
 * are. Cached so the per-frame redraw is pure canvas work. */
let speciesSummaries = [];
let lastSpeciesSampleTick = -1;
function refreshSpeciesSummaries(force) {
    const tick = Math.floor(world.tick);
    // `force` is what makes this work while paused: a paused dish has a frozen
    // tick, so the cadence check alone would never fire again. Tab switches and
    // toggle changes force it.
    if (!force && (tick === lastSpeciesSampleTick || tick % world.statsSampleInterval !== 0))
        return;
    lastSpeciesSampleTick = tick;
    speciesSummaries = world.getSpeciesSummaries(speciesShowExtinct.checked);
    // Keep an already-open card current, including watching it die: a species
    // that goes extinct while its card is open stays open and switches to its
    // final recorded figures, rather than the card vanishing mid-read.
    if (openedSpeciesLineageId !== null) {
        const shown = speciesSummaries.find((sp) => sp.lineageId === openedSpeciesLineageId);
        if (shown)
            renderSpeciesModal(shown);
        else
            closeSpeciesModal();
    }
}
/** Living lineages plus the ancestors that connect them, or everything that
 * ever existed. The ancestor walk is what keeps the default view a real tree
 * rather than a row of disconnected survivors — an extinct parent is still
 * the reason two living species are related. */
function speciesTreeNodes() {
    const byId = new Map();
    for (const s of speciesSummaries)
        byId.set(s.lineageId, s);
    const keep = new Set();
    if (speciesShowExtinct.checked) {
        for (const s of speciesSummaries)
            keep.add(s.lineageId);
    }
    else {
        for (const s of speciesSummaries) {
            if (s.isExtinct)
                continue;
            let cur = s.lineageId;
            while (cur !== null && byId.has(cur) && !keep.has(cur)) {
                keep.add(cur);
                cur = byId.get(cur).parentLineageId;
            }
        }
    }
    const nodes = new Map();
    for (const id of keep) {
        const s = byId.get(id);
        if (!s)
            continue;
        nodes.set(id, {
            id: s.lineageId,
            name: s.name,
            hue: s.hue,
            parentId: s.parentLineageId,
            createdTick: s.createdTick,
            extinctTick: s.extinctTick,
            isExtinct: s.isExtinct,
            population: s.population,
            peakPopulation: s.peakPopulation,
            isPlayerDesigned: s.isPlayerDesigned,
        });
    }
    return nodes;
}
function updateSpeciesPanel() {
    if (activeTab !== 'species')
        return;
    refreshSpeciesSummaries(false);
    const nodes = speciesTreeNodes();
    const empty = nodes.size === 0;
    speciesTreeEmpty.hidden = !empty;
    if (empty) {
        speciesTreeEmpty.textContent = speciesShowExtinct.checked
            ? 'No species yet — nothing has ever lived in this dish.'
            : 'Nothing alive right now. Tick "Show extinct" to see what used to be here, or release a species from the Designer tab.';
    }
    speciesPositions = drawSpeciesTree(speciesTreeCanvas, nodes, {
        selectedId: selectedLineageId,
        camera: speciesCamera,
        nowTick: Math.floor(world.tick),
    });
}
/** Opens the card for whatever species a tap landed on. Shared by the tree
 * and by nothing else — but kept separate from the modal itself so the
 * selection ring and the modal can never disagree about what is open. */
function selectSpecies(lineageId) {
    const s = speciesSummaries.find((sp) => sp.lineageId === lineageId);
    if (!s)
        return;
    selectedLineageId = lineageId;
    openSpeciesModal(s);
}
// --- species stat-star modal --------------------------------------------
const speciesModal = el('species-modal');
const speciesModalClose = el('species-modal-close');
const speciesModalSwatch = el('species-modal-swatch');
const speciesModalName = el('species-modal-name');
const speciesModalMeta = el('species-modal-meta');
const speciesModalRadar = el('species-modal-radar');
const speciesModalTraits = el('species-modal-traits');
const speciesModalLineage = el('species-modal-lineage');
let openedSpeciesLineageId = null;
function renderSpeciesModal(s) {
    speciesModalSwatch.style.background = `hsl(${s.hue}, 60%, 45%)`;
    speciesModalName.textContent = s.name; // player-entered text — textContent only, never innerHTML
    // Peak is the number that gives a dead end its scale — plenty of species
    // exist for a few hundred ticks and never exceed the handful they started
    // with, and "12 alive" alone cannot tell you whether this one was ever more
    // than that. Null means a run older than the field: shown as unknown rather
    // than as a fabricated zero.
    const peak = s.peakPopulation === null ? 'peak unknown' : `peak ${s.peakPopulation}`;
    const status = s.isExtinct
        ? s.extinctTick === null
            ? 'extinct · died before this was recorded'
            : `extinct · died t${s.extinctTick}`
        : `${s.population} alive`;
    speciesModalMeta.textContent =
        `${status} · ${peak} · born t${Math.round(s.createdTick)} · gen ${s.maxGeneration}` +
            `${s.dominantClass ? ` · mostly ${s.dominantClass}` : ''}`;
    // An extinct species' figures are its last sample while alive, not a live
    // reading, and saying so is the difference between a record and a lie.
    const traitPrefix = s.statsAreLastRecorded ? 'last recorded — ' : '';
    speciesModalTraits.textContent = s.maxGeneration === 0 && s.isExtinct && s.peakPopulation === null
        ? 'No measurements survive for this species.'
        : `${traitPrefix}size ${s.avgSize.toFixed(2)} · speed ${s.avgSpeed.toFixed(2)} · sense ${s.avgSense.toFixed(0)}`;
    speciesModalLineage.replaceChildren();
    if (s.parentName !== null) {
        const parentEm = document.createElement('em');
        parentEm.textContent = s.parentName;
        speciesModalLineage.append('diverged from ', parentEm);
    }
    drawRadarChart(speciesModalRadar, 
    // A v9-migrated extinct record has no class powers at all; an empty
    // profile draws as a real point at the centre rather than throwing.
    CATALYSIS_CLASSES.map((cls) => ({ label: cls, value: s.avgClassPower[cls] ?? 0 })), s.hue);
}
function openSpeciesModal(s) {
    openedSpeciesLineageId = s.lineageId;
    renderSpeciesModal(s);
    speciesModal.hidden = false;
}
function closeSpeciesModal() {
    openedSpeciesLineageId = null;
    // Drops the tree's selection ring with it, so the highlighted node and the
    // open card are never out of step.
    selectedLineageId = null;
    speciesModal.hidden = true;
}
speciesModalClose.addEventListener('click', closeSpeciesModal);
speciesModal.addEventListener('click', (e) => {
    if (e.target === speciesModal)
        closeSpeciesModal();
});
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !speciesModal.hidden)
        closeSpeciesModal();
});
// --- tree of life + individual detail -----------------------------------
// One selection variable for the whole app — dish taps (see handleDishTap
// above), tree-node clicks, ancestry parent-links inside the detail panel
// below, and Clear all funnel through selectIndividual() so there is
// exactly one place that keeps selectedIndividualId, the one-liner
// (#tree-info), and the full detail panel in sync. There is no separate
// tab for this — it lives in the existing Tree of Life panel (#tab-tree),
// appended below the tree canvas.
const treeCanvas = el('chart-tree');
const treeInfo = el('tree-info');
const treeDetail = el('tree-detail');
let selectedIndividualId = null;
let treePositions = new Map();
let detailRefs = null;
// `${id}:${'alive'|'gone'}` for whatever the detail panel was last fully
// rebuilt for — the panel's *structure* (identity header, protein list,
// gene list, brain summary, radar canvas, alive-vs-historical layout)
// only ever needs to change when the selection itself changes, a live
// selection dies, or — since the Tree tab's gene editor — a living
// individual's genome is actually replaced mid-life
// (Virtunism.replaceGenome). That last case is tracked separately by
// lastRenderedGenome below rather than folded into this string, because
// it isn't a property of the *selection*; every other frame just updates
// the small live-vitals set above in place.
let lastDetailSignature = null;
// The exact Genome object the panel was last built from. genomeFromSequence
// always returns a *fresh* object, so reference identity is an exact,
// allocation-free "is this panel still describing this genome?" test — and
// unlike a hand-bumped epoch counter, a future caller that swaps a genome
// some other way can't forget to bump it.
let lastRenderedGenome = null;
let geneDraft = null;
// Which individuals the player has hand-edited this session. Deliberately
// session-only and NOT saved: Virtunism.isPlayerDesigned is readonly *and*
// is inherited by every descendant, so reusing it would retroactively
// relabel a whole lineage; and persisting a new flag would change
// SerializedVirtunism's shape and cost a SAVE_VERSION bump, invalidating
// every existing save. That's the same call save.ts already makes for
// paused/speed/camera — provenance worth showing while you can still see
// it, not worth breaking saves over.
const handEditedIds = new Set();
/** The single owner of the "this draft no longer has a live individual to
 * land on" rule — its individual died, or the selection moved on. Called
 * at the top of refreshSelectionUI() so every frame enforces it, not just
 * the paths that happen to go through selectIndividual(). */
function discardDraftIfOrphaned(live) {
    if (geneDraft !== null && (live === null || live.id !== geneDraft.individualId))
        geneDraft = null;
}
function selectIndividual(id) {
    // Discard an in-progress gene edit whose individual is no longer the
    // selected one. Doing it here covers every route into a new selection in
    // one place — tree-node clicks, dish taps, ancestry links, Clear, and
    // Reset World (which calls selectIndividual(null)).
    if (geneDraft !== null && geneDraft.individualId !== id)
        geneDraft = null;
    selectedIndividualId = id;
    refreshSelectionUI();
}
/** The live Virtunism for the current selection, if it still has one —
 * null once World.cleanupDead() has actually removed it (the tree node
 * itself can outlive the individual — see TreeNode's own doc comment on
 * liveCount). O(population), same cost class as buildInputs' own
 * per-cell grid queries — called at most a couple of times per frame,
 * only while something's selected. */
function findLiveSelected() {
    if (selectedIndividualId === null)
        return null;
    return world.cells.find((c) => c.id === selectedIndividualId) ?? null;
}
function describeSelection() {
    treeInfo.replaceChildren();
    if (selectedIndividualId === null)
        return;
    const node = world.treeNodes.get(selectedIndividualId);
    if (!node) {
        selectedIndividualId = null;
        return;
    }
    const lineageName = world.lineages.get(node.lineageId)?.name ?? `Species ${node.lineageId}`;
    const parents = node.parentId === null
        ? 'founder'
        : node.secondParentId !== null
            ? `of #${node.parentId} & #${node.secondParentId}`
            : `of #${node.parentId}`;
    const status = node.alive ? 'alive' : 'extinct branch';
    const speciation = node.isSpeciationEvent ? ' · 🔀 new species' : '';
    const dnaTransition = node.isDnaTransition ? ' · 🧬 DNA heredity' : '';
    // lineageName can be player-entered text (Designer tab's free-text name
    // field) — build it as a separate node via textContent, never
    // interpolate it into innerHTML.
    const nameSpan = document.createElement('span');
    nameSpan.className = 'specimen-name';
    nameSpan.textContent = lineageName;
    treeInfo.append(`#${node.id} · `, nameSpan, ` · gen ${node.generation} · born t${node.birthTick} · ${parents} · ${status}${speciation}${dnaTransition}`);
}
function pctLabel(ratio) {
    return `${(ratio * 100).toFixed(1)}%`;
}
function fillWidth(ratio) {
    return `${Math.min(100, Math.max(0, ratio * 100))}%`;
}
function addStatBlock(container, label, value) {
    const stat = document.createElement('div');
    stat.className = 'stat';
    const labelEl = document.createElement('span');
    labelEl.className = 'stat-label';
    labelEl.textContent = label;
    const valueEl = document.createElement('span');
    valueEl.textContent = value;
    stat.append(labelEl, valueEl);
    container.appendChild(stat);
    return valueEl;
}
function addBarRow(container, label) {
    const row = document.createElement('div');
    row.className = 'tree-detail-bar-row';
    const labelRow = document.createElement('div');
    labelRow.className = 'tree-detail-bar-label';
    const labelText = document.createElement('span');
    labelText.textContent = label;
    const labelValue = document.createElement('span');
    labelRow.append(labelText, labelValue);
    const track = document.createElement('div');
    track.className = 'tree-detail-bar-track';
    const fill = document.createElement('div');
    fill.className = 'tree-detail-bar-fill';
    track.appendChild(fill);
    row.append(labelRow, track);
    container.appendChild(row);
    return { fill, labelValue };
}
function addSectionTitle(container, text) {
    const h = document.createElement('div');
    h.className = 'tree-detail-section-title';
    h.textContent = text;
    container.appendChild(h);
}
/** A clickable link to another tree node's id — reuses selectIndividual()
 * so following a parent/child link is exactly the same selection path as
 * a tree-canvas click or a dish tap. Falls back to plain (unclickable)
 * text in the defensive case an id somehow isn't in world.treeNodes —
 * shouldn't happen (a node's parent always outlives it), but this is a
 * display helper, not a place to throw on an invariant violation. */
function ancestryLink(id, label) {
    if (!world.treeNodes.has(id))
        return document.createTextNode(label);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tree-detail-parent-link';
    btn.textContent = label;
    btn.addEventListener('click', () => selectIndividual(id));
    return btn;
}
function buildParentsLine(node) {
    const p = document.createElement('p');
    p.className = 'tree-detail-empty-hint';
    p.append('Parent: ');
    if (node.parentId === null) {
        p.append('none — a founder');
    }
    else {
        p.append(ancestryLink(node.parentId, `#${node.parentId}`));
        if (node.secondParentId !== null)
            p.append(' & ', ancestryLink(node.secondParentId, `#${node.secondParentId}`));
    }
    return p;
}
/** Real per-protein detail: the actual translated amino-acid sequence
 * plus its real fold result (chem/polymer.ts's PeptideFold) — not a
 * summary, the same data Virtunism/World read to derive every
 * capability. */
function buildProteinList(proteins) {
    const list = document.createElement('div');
    list.className = 'protein-list';
    if (proteins.length === 0) {
        const p = document.createElement('p');
        p.className = 'tree-detail-empty-hint';
        p.textContent = 'No protein-coding genes at all.';
        list.appendChild(p);
        return list;
    }
    proteins.forEach((p, i) => {
        const row = document.createElement('div');
        row.className = 'protein-row';
        const head = document.createElement('div');
        head.className = 'protein-row-head';
        const cls = document.createElement('span');
        cls.className = 'protein-class';
        cls.textContent = p.fold.catalysisClass
            ? `#${i + 1} ${p.fold.catalysisClass}${p.fold.isCatalyst ? ` — strength ${p.fold.catalysisStrength.toFixed(2)}` : ''}`
            : `#${i + 1} no function`;
        const meta = document.createElement('span');
        meta.textContent =
            `${p.fold.folded ? 'folded' : 'unfolded'} · stability ${p.fold.stability.toFixed(2)} · contacts ${p.fold.contacts} · ` +
                `${p.sequence.length} aa · mount ${((p.angle * 180) / Math.PI).toFixed(0)}°`;
        head.append(cls, meta);
        const seq = document.createElement('div');
        seq.className = 'protein-seq';
        seq.textContent = p.sequence.join('');
        row.append(head, seq);
        list.appendChild(row);
    });
    return list;
}
function buildBrainSummary(brain) {
    const p = document.createElement('p');
    p.className = 'tree-detail-empty-hint';
    const avgAbs = (arr) => arr.reduce((s, v) => s + Math.abs(v), 0) / (arr.length || 1);
    const totalParams = brain.w1.length + brain.b1.length + brain.w2.length + brain.b2.length;
    p.textContent =
        `${brain.topology.inputs} sensor inputs → ${brain.topology.hidden} hidden units (tanh) → ` +
            `${brain.topology.outputs} outputs (turn, thrust) · ${totalParams} weights/biases total · ` +
            `avg |weight| ${((avgAbs(brain.w1) + avgAbs(brain.w2)) / 2).toFixed(3)}`;
    return p;
}
const CORE_GENE_LABELS = Object.entries(LOCUS)
    .sort((a, b) => a[1] - b[1])
    .map(([name]) => name);
/** The real, raw heritable sequence — every core-trait locus plus every
 * protein-coding gene, exactly as genes.ts decodes/translates it. One
 * string per gene, not one DOM node per nucleotide symbol — cheap even
 * for a genome carrying many protein genes. */
function buildGeneList(sequence) {
    const list = document.createElement('div');
    list.className = 'gene-list';
    sequence.genes.forEach((gene, i) => {
        const row = document.createElement('div');
        row.className = 'gene-row';
        const label = document.createElement('span');
        label.className = 'gene-label';
        label.textContent = i < CORE_GENE_COUNT ? `${CORE_GENE_LABELS[i]}:` : `protein ${i - CORE_GENE_COUNT + 1}:`;
        row.append(label, gene.join(''));
        list.appendChild(row);
    });
    return list;
}
/** Cycles a nucleotide A -> U -> G -> C -> A, in NUCLEOTIDE_CODES' own
 * order so a chip's cycle matches every other place the alphabet is
 * listed. Cycling *within* the alphabet at a fixed position is also what
 * makes the editor structurally incapable of producing an invalid
 * sequence — validateGeneSequence on Apply is a guard against future
 * callers, not against this one. */
function nextNucleotide(symbol) {
    return NUCLEOTIDE_CODES[(NUCLEOTIDE_CODES.indexOf(symbol) + 1) % NUCLEOTIDE_CODES.length];
}
function geneLabel(i) {
    return i < CORE_GENE_COUNT ? CORE_GENE_LABELS[i] : `protein ${i - CORE_GENE_COUNT + 1}`;
}
function changedGeneCount(draft) {
    let n = 0;
    for (let i = 0; i < draft.sequence.genes.length; i++) {
        if (draft.sequence.genes[i].join('') !== draft.baseline[i])
            n++;
    }
    return n;
}
/** What the expanded gene decodes to under the draft, against what the
 * individual is still actually running (cell.genome is untouched until
 * Apply). This is the whole payoff of expanding only one gene at a time:
 * the room a full chip grid would have eaten pays for showing the player
 * what their edit actually *does* — including the very common case where
 * it does nothing, because decodeUnit is a sum over symbol indices and so
 * is order-independent (genes.ts), which makes a great many edits
 * genuinely synonymous. Without this line those edits look broken. */
function describeGeneEdit(cell, draft, i) {
    if (i < CORE_GENE_COUNT) {
        const name = CORE_GENE_LABELS[i];
        const was = cell.genome[name];
        const now = decodeCoreTraits(draft.sequence)[name];
        const fmt = (v) => typeof v === 'number' ? (Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(2)) : v;
        return was === now ? `${name} ${fmt(was)} · unchanged` : `${name} ${fmt(was)} → ${fmt(now)}`;
    }
    const protein = decodeProteinGene(draft.sequence.genes[i]);
    const fn = protein.fold.catalysisClass
        ? `${protein.fold.catalysisClass}${protein.fold.isCatalyst ? ` · strength ${protein.fold.catalysisStrength.toFixed(2)}` : ''}`
        : 'no function';
    return `${fn} · ${protein.fold.folded ? 'folded' : 'unfolded'} · ${protein.sequence.length} aa`;
}
/** Commits a draft onto the living individual. Everything risky about the
 * whole feature is concentrated here, in order: validate; deep-copy so the
 * applied sequence shares no array with the draft the UI still holds *or*
 * with the lineage's speciation baseline (LineageInfo.referenceSequence is
 * literally the same object a founder or a just-speciated cell carries —
 * an in-place write would pin the cell's distance from its own baseline at
 * 0 and silently disable speciation for the lineage); build through the
 * ordinary genomeFromSequence pipeline, carrying `brain` and `isDna`
 * across by hand because neither is encoded in the sequence; then let
 * Virtunism.replaceGenome repair the birth-time invariants.
 *
 * Speciation is deliberately NOT forced here. World.checkSpeciation runs
 * only at the individual's next reproduction, so a big enough edit founds
 * a new species naturally, exactly the way ordinary drift already does. */
function applyGeneEdit(container, cell) {
    const draft = geneDraft;
    if (draft === null || draft.individualId !== cell.id)
        return;
    const reason = validateGeneSequence(draft.sequence);
    if (reason !== null) {
        draft.error = reason;
        renderGeneSection(container, cell);
        return;
    }
    const genome = genomeFromSequence(cloneGeneSequence(draft.sequence), cell.genome.brain, cell.genome.isDna);
    cell.replaceGenome(genome);
    // TreeNode.hue is snapshotted at birth (World.recordBirth) and is what
    // the tree view draws each node from, while the dish renderer reads
    // genome.hue live — so without this a hue edit recolors the dish dot and
    // not the tree dot. World.checkSpeciation already rewrites node.hue
    // post-birth, so this is an established thing to do, not a new seam.
    const treeNode = world.treeNodes.get(cell.id);
    if (treeNode)
        treeNode.hue = genome.hue;
    handEditedIds.add(cell.id);
    geneDraft = null;
    // No explicit rebuild: refreshSelectionUI runs every frame and its
    // genome-identity check picks this up, so there stays exactly one
    // full-rebuild path rather than two that can disagree.
}
/** Fills the "Raw gene sequence" section — read-only by default, or the
 * editor once the player has opened a draft on this individual. Rebuilt in
 * place (into the same container) rather than by rebuilding the whole
 * detail panel, so toggling edit mode doesn't reset the panel's scroll or
 * needlessly re-make the radar canvas.
 *
 * Only ever expands ONE gene into chips at a time. A full genome is 5 core
 * genes of 10 symbols plus up to 16 protein genes of 60 — over a thousand
 * chips if every symbol got its own node, against the ~60 elements this
 * panel's read-only list costs today, which is precisely what
 * buildGeneList's own comment says it avoids. One gene at a time caps the
 * worst case at 60 chips, keeps that promise intact for every collapsed
 * row, matches how editing actually happens (you change one locus, then
 * look at what it did), and needs no event delegation — which this
 * codebase has nowhere else. */
function renderGeneSection(container, cell) {
    container.replaceChildren();
    const draft = geneDraft !== null && geneDraft.individualId === cell.id ? geneDraft : null;
    const rerender = () => renderGeneSection(container, cell);
    const title = document.createElement('div');
    title.className = 'tree-detail-section-title';
    title.textContent = 'Raw gene sequence';
    const status = document.createElement('span');
    status.className = 'gene-edit-status';
    title.appendChild(status);
    container.appendChild(title);
    const toolbar = document.createElement('div');
    toolbar.className = 'gene-edit-toolbar';
    container.appendChild(toolbar);
    if (draft === null) {
        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'btn';
        editBtn.textContent = 'Edit genes';
        editBtn.addEventListener('click', () => {
            geneDraft = {
                individualId: cell.id,
                sequence: cloneGeneSequence(cell.genome.sequence),
                baseline: cell.genome.sequence.genes.map((g) => g.join('')),
                expandedIndex: null,
                error: null,
            };
            rerender();
        });
        toolbar.appendChild(editBtn);
        container.appendChild(buildGeneList(cell.genome.sequence));
        return;
    }
    const applyBtn = document.createElement('button');
    applyBtn.type = 'button';
    applyBtn.className = 'btn primary';
    applyBtn.textContent = 'Apply changes';
    applyBtn.addEventListener('click', () => applyGeneEdit(container, cell));
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => {
        geneDraft = null;
        rerender();
    });
    toolbar.append(applyBtn, cancelBtn);
    /** Title count + Apply's enabled state, refreshed on every chip click
     * without re-rendering anything (see GeneDraft's doc comment). */
    const refreshEditStatus = () => {
        const n = changedGeneCount(draft);
        status.textContent = n === 0 ? ' · editing' : ` · editing · ${n} gene${n === 1 ? '' : 's'} changed`;
        applyBtn.disabled = n === 0;
    };
    refreshEditStatus();
    const hint = document.createElement('p');
    hint.className = 'tree-detail-empty-hint';
    hint.textContent =
        'Click a gene to open it, then click a symbol to cycle A → U → G → C. ' +
            'Nothing in the dish changes until you press Apply. The dish keeps running — ' +
            'pause from the top bar if you want time.';
    container.appendChild(hint);
    if (draft.error !== null) {
        const err = document.createElement('p');
        err.className = 'gene-edit-error';
        err.textContent = draft.error;
        container.appendChild(err);
    }
    const list = document.createElement('div');
    // `editing` scopes the row layout to edit mode only, so the read-only
    // list keeps exactly the block/break-all rendering it has always had.
    list.className = 'gene-list editing';
    draft.sequence.genes.forEach((gene, i) => {
        const row = document.createElement('div');
        row.className = 'gene-row';
        const expanded = draft.expandedIndex === i;
        if (gene.join('') !== draft.baseline[i])
            row.classList.add('edited');
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'gene-row-toggle';
        toggle.textContent = `${expanded ? '▾' : '▸'} ${geneLabel(i)}:`;
        toggle.addEventListener('click', () => {
            draft.expandedIndex = expanded ? null : i;
            rerender();
        });
        row.appendChild(toggle);
        if (!expanded) {
            const seq = document.createElement('span');
            seq.className = 'gene-seq';
            seq.textContent = gene.join('') + (row.classList.contains('edited') ? '  (edited)' : '');
            row.appendChild(seq);
        }
        else {
            const chips = document.createElement('div');
            chips.className = 'gene-chips';
            const preview = document.createElement('div');
            preview.className = 'gene-preview';
            preview.textContent = describeGeneEdit(cell, draft, i);
            gene.forEach((symbol, j) => {
                const chip = document.createElement('button');
                chip.type = 'button';
                chip.className = 'gene-chip';
                chip.textContent = symbol;
                if (symbol !== draft.baseline[i][j])
                    chip.classList.add('changed');
                chip.addEventListener('click', () => {
                    const next = nextNucleotide(gene[j]);
                    gene[j] = next;
                    // Targeted updates only — one array slot, one chip, the row's
                    // marker, the preview and the header count. Re-rendering the
                    // section on every click would rebuild 60 chips and lose focus.
                    chip.textContent = next;
                    chip.classList.toggle('changed', next !== draft.baseline[i][j]);
                    row.classList.toggle('edited', gene.join('') !== draft.baseline[i]);
                    preview.textContent = describeGeneEdit(cell, draft, i);
                    refreshEditStatus();
                });
                chips.appendChild(chip);
            });
            row.append(chips, preview);
        }
        list.appendChild(row);
    });
    container.appendChild(list);
}
/** Rebuilds the full detail panel for a selection that's no longer
 * alive — World's tree node can outlive the Virtunism it describes
 * (cleanupDead() removes the individual itself, but the tree keeps the
 * node as long as a living descendant traces back through it, per
 * liveCount). There's no genome, position, energy, or brain left to
 * show — a real, honest degraded view of only what the tree itself still
 * remembers, not a fabrication of the rest. */
function renderHistoricalDetail(node) {
    const wrap = document.createElement('div');
    const head = document.createElement('div');
    head.className = 'tree-detail-head';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'specimen-name';
    nameSpan.textContent = world.lineages.get(node.lineageId)?.name ?? `Species ${node.lineageId}`;
    const statusEl = document.createElement('span');
    statusEl.className = 'tree-detail-status extinct';
    statusEl.textContent = ' · no longer alive';
    head.append(`#${node.id} `, nameSpan, statusEl);
    wrap.appendChild(head);
    const hint = document.createElement('p');
    hint.className = 'tree-detail-empty-hint';
    hint.textContent =
        "This individual's own body — genome, position, proteins, brain — is gone; it was removed once it died. " +
            'Only its tree-of-life record remains, below. Select a living individual (in the dish, or a lit node in the tree) for a full profile.';
    wrap.appendChild(hint);
    addSectionTitle(wrap, 'Ancestry');
    const vitals = document.createElement('div');
    vitals.className = 'stat-grid';
    addStatBlock(vitals, 'Generation', String(node.generation));
    addStatBlock(vitals, 'Born (tick)', String(node.birthTick));
    addStatBlock(vitals, 'Living descendants', String(node.liveCount));
    addStatBlock(vitals, 'Player-designed', node.isPlayerDesigned ? 'yes' : 'no');
    wrap.appendChild(vitals);
    wrap.appendChild(buildParentsLine(node));
    if (node.children.length > 0) {
        const childrenP = document.createElement('p');
        childrenP.className = 'tree-detail-empty-hint';
        childrenP.append('Children: ');
        node.children.forEach((childId, i) => {
            if (i > 0)
                childrenP.append(', ');
            childrenP.append(ancestryLink(childId, `#${childId}`));
        });
        wrap.appendChild(childrenP);
    }
    treeDetail.replaceChildren(wrap);
}
/** Rebuilds the full detail panel for a currently-alive selection. Builds
 * (and attaches to the live DOM) everything that's fixed for this
 * individual's whole life — identity, ancestry, an (initially empty) six-
 * class capability radar canvas (drawn lazily by updateTree(), not here
 * — see its own comment on why), per-protein detail, brain summary, raw
 * gene sequence — then returns refs to the handful of nodes that do need
 * refreshing every frame (position, age/energy/reproduction bars). */
function renderLiveDetail(node, cell) {
    const wrap = document.createElement('div');
    const head = document.createElement('div');
    head.className = 'tree-detail-head';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'specimen-name';
    nameSpan.textContent = world.lineages.get(node.lineageId)?.name ?? `Species ${node.lineageId}`;
    const statusEl = document.createElement('span');
    statusEl.className = 'tree-detail-status';
    head.append(`#${node.id} `, nameSpan, statusEl);
    if (handEditedIds.has(cell.id)) {
        const editedMark = document.createElement('span');
        editedMark.className = 'gene-edit-status';
        editedMark.textContent = ' · hand-edited';
        head.appendChild(editedMark);
    }
    wrap.appendChild(head);
    wrap.appendChild(buildParentsLine(node));
    const vitals = document.createElement('div');
    vitals.className = 'stat-grid';
    const posEl = addStatBlock(vitals, 'Position (x, y)', '');
    addStatBlock(vitals, 'Generation', String(cell.generation));
    addStatBlock(vitals, 'Reproduction mode', cell.genome.reproductionMode);
    addStatBlock(vitals, 'Heredity', cell.genome.isDna ? 'DNA' : 'RNA');
    addStatBlock(vitals, 'Size (chassis)', cell.genome.size.toFixed(2));
    addStatBlock(vitals, 'Sense radius', cell.genome.senseRadius.toFixed(0));
    addStatBlock(vitals, 'Colony', cell.attachedTo ? 'bonded member' : cell.attachedChildren.length > 0 ? `root, ${cell.attachedChildren.length} bud(s)` : 'solo');
    addStatBlock(vitals, 'Chemistry mode', cell.richMode ? 'rich (stochastic)' : 'cheap (deterministic)');
    wrap.appendChild(vitals);
    const ageBar = addBarRow(wrap, 'Age / lifespan');
    const energyBar = addBarRow(wrap, 'Energy / capacity');
    const reproBar = addBarRow(wrap, cell.genome.reproductionMode === 'sexual' ? 'Toward mating threshold' : 'Toward reproduction threshold');
    const reproStatusEl = document.createElement('p');
    reproStatusEl.className = 'tree-detail-empty-hint';
    wrap.appendChild(reproStatusEl);
    addSectionTitle(wrap, 'Capability profile');
    const radarCanvas = document.createElement('canvas');
    radarCanvas.className = 'tree-detail-radar';
    wrap.appendChild(radarCanvas);
    addSectionTitle(wrap, `Proteins (${cell.genome.proteins.length})`);
    wrap.appendChild(buildProteinList(cell.genome.proteins));
    addSectionTitle(wrap, 'Brain');
    wrap.appendChild(buildBrainSummary(cell.genome.brain));
    // Its own container rather than appended straight onto `wrap`, so the
    // gene editor can re-render just this subtree (entering/cancelling edit
    // mode, expanding a gene) without rebuilding the whole panel.
    const geneSection = document.createElement('div');
    geneSection.className = 'gene-section';
    wrap.appendChild(geneSection);
    renderGeneSection(geneSection, cell);
    // Attach before the radar is ever drawn — drawRadarChart sizes itself
    // from the canvas's real laid-out clientWidth/clientHeight, which reads
    // 0 for a canvas that isn't actually in the document yet (or whose
    // panel is currently display:none — see updateTree()'s own comment on
    // why the radar is only ever actually drawn there, not here).
    treeDetail.replaceChildren(wrap);
    return {
        statusEl,
        posEl,
        ageBarFill: ageBar.fill,
        ageBarLabel: ageBar.labelValue,
        energyBarFill: energyBar.fill,
        energyBarLabel: energyBar.labelValue,
        reproBarFill: reproBar.fill,
        reproBarLabel: reproBar.labelValue,
        reproStatusEl,
        radarCanvas,
        geneSection,
    };
}
/** The cheap, every-frame half of keeping a live selection current —
 * everything here is a real number that actually changes tick to tick;
 * everything that doesn't (genome, proteins, brain, ancestry) was already
 * built once by renderLiveDetail() above and is left untouched. */
function updateLiveVitals(refs, cell) {
    refs.statusEl.textContent = ' · alive';
    refs.posEl.textContent = `${cell.x.toFixed(0)}, ${cell.y.toFixed(0)}`;
    const ageRatio = cell.age / cell.genome.maxAge;
    refs.ageBarLabel.textContent = `${Math.floor(cell.age)} / ${Math.round(cell.genome.maxAge)} ticks (${pctLabel(ageRatio)})`;
    refs.ageBarFill.style.width = fillWidth(ageRatio);
    // Energy is clamped to maxEnergy on the way *up* by eat() and
    // photosynthesize(), by World.diffuseColonyEnergy on the colony transfer
    // path, and at every birth site by settleNewborn; and on the way *down*
    // by Virtunism.replaceGenome (the gene editor can shrink maxEnergy out
    // from under a cell that's already full). So this ratio stays <= 1.
    //
    // It did not used to. Three of those five clamps are new: photosynthesis
    // income, colony diffusion and newborn provisioning were all unclamped,
    // and this comment was simply false — measured at 7.1-36.5% of samples
    // over the ceiling depending on seed, peaking at 7.5x.
    const energyRatio = cell.energy / cell.maxEnergy;
    refs.energyBarLabel.textContent = `${cell.energy.toFixed(1)} / ${cell.maxEnergy.toFixed(1)} (${pctLabel(energyRatio)})`;
    refs.energyBarFill.style.width = fillWidth(energyRatio);
    // Real percentage toward the reproduction bar. There is one bar now,
    // shared by both modes — see Virtunism.canMate on why sexual no longer
    // gets a cheaper one. Not clamped in the label, so a genuinely over-ready
    // individual (energy above threshold, still on cooldown) shows a real
    // >100%; only the bar's fill width is capped. The bar also rises with age
    // past maturity (senescence), so a healthy old cell can drift back below
    // 100% without losing any energy.
    const isSexual = cell.genome.reproductionMode === 'sexual';
    const reproRatio = cell.energy / cell.effectiveReproduceThreshold;
    refs.reproBarLabel.textContent = pctLabel(reproRatio);
    refs.reproBarFill.style.width = fillWidth(reproRatio);
    const ready = isSexual ? cell.canMate() : cell.canReproduce();
    const immatureFor = Math.ceil(cell.maturityAge - cell.age);
    refs.reproStatusEl.textContent =
        immatureFor > 0
            ? `Immature: ${immatureFor} ticks to maturity.`
            : cell.reproCooldown > 0
                ? `On cooldown: ${Math.ceil(cell.reproCooldown)} ticks remaining.`
                : ready
                    ? isSexual
                        ? 'Ready to mate — needs a compatible partner in range.'
                        : 'Ready to reproduce right now.'
                    : 'Still building up energy.';
}
/** The full-breakout panel's single entry point — called on every
 * selection change (tap/click/Clear, synchronously via selectIndividual)
 * *and* unconditionally every frame (see frame() below), the same "just
 * always run it, it's cheap" precedent updateStatsPanels() already sets
 * for work that needs to stay current regardless of which tab is active
 * — this is what makes tapping a cell in the dish populate this panel
 * silently even while a different tab is showing. */
function refreshSelectionUI() {
    describeSelection();
    if (selectedIndividualId === null) {
        geneDraft = null;
        if (lastDetailSignature !== null) {
            treeDetail.replaceChildren();
            lastDetailSignature = null;
            lastRenderedGenome = null;
            detailRefs = null;
        }
        return;
    }
    const node = world.treeNodes.get(selectedIndividualId);
    if (!node) {
        // Pruned out from under the selection entirely (no living descendant
        // left anywhere) — describeSelection() above already cleared
        // selectedIndividualId for this case.
        geneDraft = null;
        treeDetail.replaceChildren();
        lastDetailSignature = null;
        lastRenderedGenome = null;
        detailRefs = null;
        return;
    }
    const live = findLiveSelected();
    discardDraftIfOrphaned(live);
    const signature = `${node.id}:${live ? 'alive' : 'gone'}`;
    // A genome swap on the *same*, still-living individual (the gene editor's
    // Apply) changes the stat blocks, protein list, radar and gene list, none
    // of which the per-frame vitals path touches — so it needs the same full
    // rebuild a selection change does, even though the signature is unchanged.
    const genomeChanged = live !== null && live.genome !== lastRenderedGenome;
    if (signature !== lastDetailSignature || genomeChanged) {
        // Preserve scroll only for an in-place genome swap on the same
        // individual: the gene section sits at the bottom of a scrolling panel,
        // so rebuilding under the player's cursor would otherwise yank them back
        // to the top the instant they hit Apply. A selection *change* should
        // still land at the top, as it always has.
        const keepScroll = signature === lastDetailSignature;
        const prevScroll = treeDetail.scrollTop;
        lastDetailSignature = signature;
        if (live) {
            detailRefs = renderLiveDetail(node, live);
            updateLiveVitals(detailRefs, live);
        }
        else {
            renderHistoricalDetail(node);
            detailRefs = null;
        }
        lastRenderedGenome = live?.genome ?? null;
        // Best-effort, and honestly imperfect: assigning scrollTop straight after
        // replaceChildren is clamped against a layout that has not caught up with
        // the new content, so a deeply-scrolled panel comes back somewhat higher
        // than it was (measured: 2834 -> 2178 against a real maximum of 2688).
        // Re-applying on the next animation frame was tried and does not help, so
        // this stays the simple version rather than dressed up as fixed. It still
        // does the job that matters — the panel keeps its place instead of
        // snapping to the top the instant you press Apply.
        if (keepScroll)
            treeDetail.scrollTop = prevScroll;
    }
    else if (detailRefs && live) {
        updateLiveVitals(detailRefs, live);
    }
}
// --- tree pan / zoom -------------------------------------------------------
// Mirrors the dish canvas's own gestures (drag to pan, wheel or pinch to zoom,
// anchored on the cursor) rather than inventing a second interaction model.
// The tree is redrawn from its layout every frame, so zooming re-rasterises at
// native resolution instead of magnifying a bitmap — and the leaf budget grows
// with zoom, so collapsed clades genuinely open up as you go in.
const treeCamera = defaultTreeCamera();
// Pointer id -> last CSS-pixel position, so one finger pans and two pinch.
const treePointers = new Map();
let treePinchDist = 0;
let treeDragMoved = 0;
const treeCssPoint = (e) => {
    const rect = treeCanvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
};
const treeSize = () => ({
    w: Math.max(1, treeCanvas.clientWidth),
    h: Math.max(1, treeCanvas.clientHeight),
});
treeCanvas.addEventListener('pointerdown', (e) => {
    treeCanvas.setPointerCapture(e.pointerId);
    treePointers.set(e.pointerId, treeCssPoint(e));
    if (treePointers.size === 1)
        treeDragMoved = 0;
    if (treePointers.size === 2) {
        const [a, b] = [...treePointers.values()];
        treePinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    }
});
treeCanvas.addEventListener('pointermove', (e) => {
    const prev = treePointers.get(e.pointerId);
    if (!prev)
        return;
    const next = treeCssPoint(e);
    treePointers.set(e.pointerId, next);
    const { w, h } = treeSize();
    if (treePointers.size >= 2) {
        const [a, b] = [...treePointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (treePinchDist > 0 && dist > 0) {
            zoomTreeCameraAt(treeCamera, (a.x + b.x) / 2, (a.y + b.y) / 2, dist / treePinchDist, w, h);
        }
        treePinchDist = dist;
        treeDragMoved = Infinity; // a pinch is never a tap
        return;
    }
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    treeDragMoved += Math.hypot(dx, dy);
    panTreeCamera(treeCamera, dx, dy, w, h);
});
const endTreePointer = (e) => {
    treePointers.delete(e.pointerId);
    if (treePointers.size < 2)
        treePinchDist = 0;
};
treeCanvas.addEventListener('pointerup', (e) => {
    // A drag that barely moved is a tap. Same threshold the dish uses, so a
    // slightly shaky tap still selects rather than silently panning.
    if (treeDragMoved < 6) {
        const { x, y } = treeCssPoint(e);
        const hit = hitTestTree(treePositions, x, y);
        if (hit !== null)
            selectIndividual(hit);
    }
    endTreePointer(e);
});
treeCanvas.addEventListener('pointercancel', endTreePointer);
treeCanvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const { x, y } = treeCssPoint(e);
    const { w, h } = treeSize();
    zoomTreeCameraAt(treeCamera, x, y, e.deltaY < 0 ? 1.12 : 1 / 1.12, w, h);
}, { passive: false });
el('tree-fit').addEventListener('click', () => {
    const fresh = defaultTreeCamera();
    treeCamera.cx = fresh.cx;
    treeCamera.cy = fresh.cy;
    treeCamera.zoom = fresh.zoom;
});
el('tree-clear').addEventListener('click', () => selectIndividual(null));
// --- species tree pan / zoom ---------------------------------------------
// Deliberately the same gestures as the dish and the Tree of Life canvas
// (drag to pan, wheel or pinch to zoom, anchored on the pointer), driving the
// same camera helpers — a third interaction model for a third canvas would be
// gratuitous.
const speciesPointers = new Map();
let speciesPinchDist = 0;
let speciesDragMoved = 0;
const speciesCssPoint = (e) => {
    const rect = speciesTreeCanvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
};
const speciesSize = () => ({
    w: Math.max(1, speciesTreeCanvas.clientWidth),
    h: Math.max(1, speciesTreeCanvas.clientHeight),
});
speciesTreeCanvas.addEventListener('pointerdown', (e) => {
    // Same defensive capture as the dish canvas: a synthetic or otherwise odd
    // pointer can make setPointerCapture throw, and an uncaught throw here
    // would abort the rest of the handler and silently desync every gesture
    // computed from the pointer map afterward.
    try {
        speciesTreeCanvas.setPointerCapture(e.pointerId);
    }
    catch {
        // ignored — see above
    }
    speciesPointers.set(e.pointerId, speciesCssPoint(e));
    if (speciesPointers.size === 1)
        speciesDragMoved = 0;
    if (speciesPointers.size === 2) {
        const [a, b] = [...speciesPointers.values()];
        speciesPinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    }
});
speciesTreeCanvas.addEventListener('pointermove', (e) => {
    const prev = speciesPointers.get(e.pointerId);
    if (!prev)
        return;
    const next = speciesCssPoint(e);
    speciesPointers.set(e.pointerId, next);
    const { w, h } = speciesSize();
    if (speciesPointers.size >= 2) {
        const [a, b] = [...speciesPointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (speciesPinchDist > 0 && dist > 0) {
            zoomTreeCameraAt(speciesCamera, (a.x + b.x) / 2, (a.y + b.y) / 2, dist / speciesPinchDist, w, h);
        }
        speciesPinchDist = dist;
        speciesDragMoved = Infinity; // a pinch is never a tap
        return;
    }
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    speciesDragMoved += Math.hypot(dx, dy);
    panTreeCamera(speciesCamera, dx, dy, w, h);
});
const endSpeciesPointer = (e) => {
    speciesPointers.delete(e.pointerId);
    if (speciesPointers.size < 2)
        speciesPinchDist = 0;
};
speciesTreeCanvas.addEventListener('pointerup', (e) => {
    // A drag that barely moved is a tap — same 6px threshold the dish and the
    // other tree use, so a slightly shaky finger still selects. Note there is
    // no hold-duration component: unlike the card list this replaced, the tap
    // target is a canvas that is never torn down, so how long the finger rests
    // on it cannot matter.
    if (speciesDragMoved < 6) {
        const { x, y } = speciesCssPoint(e);
        const hit = hitTestTree(speciesPositions, x, y);
        if (hit !== null)
            selectSpecies(hit);
    }
    endSpeciesPointer(e);
});
speciesTreeCanvas.addEventListener('pointercancel', endSpeciesPointer);
speciesTreeCanvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const { x, y } = speciesCssPoint(e);
    const { w, h } = speciesSize();
    zoomTreeCameraAt(speciesCamera, x, y, e.deltaY < 0 ? 1.12 : 1 / 1.12, w, h);
}, { passive: false });
el('species-fit').addEventListener('click', () => {
    const fresh = defaultTreeCamera();
    speciesCamera.cx = fresh.cx;
    speciesCamera.cy = fresh.cy;
    speciesCamera.zoom = fresh.zoom;
});
// Forced, not left to the tick cadence: toggling has to take effect on a
// paused dish too, and the extinct set is not in the cached summaries.
speciesShowExtinct.addEventListener('change', () => refreshSpeciesSummaries(true));
function updateTree() {
    if (activeTab !== 'tree')
        return;
    treePositions = drawTree(treeCanvas, world.treeNodes, {
        selectedId: selectedIndividualId,
        camera: treeCamera,
    });
    // The radar canvas is only ever drawn here, gated the same way the
    // tree canvas itself already is — a canvas sizes itself from its real
    // laid-out clientWidth/clientHeight (see drawRadarChart), which is 0
    // while #tab-tree is display:none (any tab but this one). Deferring
    // the actual draw to the one place already known to run only while
    // this panel is genuinely visible means a selection made from another
    // tab (see handleDishTap) still shows a correctly-sized radar the
    // instant the user switches here — no stale 1x1 canvas from an earlier
    // build.
    if (detailRefs) {
        const live = findLiveSelected();
        if (live) {
            drawRadarChart(detailRefs.radarCanvas, CATALYSIS_CLASSES.map((cls) => ({ label: cls, value: live.genome.classPowerCache[cls] })), live.genome.hue);
        }
    }
}
// --- main loop --------------------------------------------------------
// A hard time budget for simulation work per animation frame — this is
// what makes "consistent performance" an actual guarantee rather than a
// hope. Regardless of population size, colony complexity, or the chosen
// speed multiplier, a single frame will never spend more than ~18ms
// running ticks: if it hits the budget partway through the requested
// `speed` ticks, it just stops early and picks up next frame. A busy tick
// degrades to a lower effective speed instead of freezing the tab. Both
// engines share this one budget and always run together — there's no
// screen to be "away from" that would pause one of them.
const TICK_TIME_BUDGET_MS = 18;
function frame() {
    if (!paused) {
        const frameStart = performance.now();
        for (let i = 0; i < speed; i++) {
            if (SOUP_ENABLED && !stage0Retired) {
                origin.update(1);
                autoBootstrap();
            }
            world.update(1);
            // Stage-0 retirement is a property of the pool, so it has nothing to
            // track when the pool is retired outright. Skipping it is also what
            // makes extinction final in that mode: its own extinction branch is
            // the only thing in the app that ever revived a dead dish.
            if (SOUP_ENABLED)
                updateStage0Retirement();
            if (performance.now() - frameStart > TICK_TIME_BUDGET_MS)
                break;
        }
    }
    renderer.draw(world, origin, POOL_OFFSET, {
        showVision,
        highlightId: selectedIndividualId,
        hidePool: !SOUP_ENABLED || stage0Retired,
    });
    updateStatsPanels();
    if (SOUP_ENABLED)
        updateChemistryPanel();
    refreshSelectionUI();
    updateTree();
    updateSpeciesPanel();
    requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
// --- autosave ------------------------------------------------------------
// Every 5s, plus a best-effort save the moment the tab is hidden/closed
// (covers the common "closed the tab before the next 5s tick" case that a
// bare interval alone would miss — `visibilitychange` fires reliably on
// tab close/switch, `beforeunload` is a backstop for browsers that skip it).
// --- save data: export, import, and the status readout --------------------
const saveAlert = el('save-alert');
const saveAlertMsg = el('save-alert-msg');
const saveModal = el('save-modal');
const saveModalStatus = el('save-modal-status');
const saveImportText = el('save-import-text');
function openSaveModal() {
    setSaveModalStatus('', null);
    saveImportText.value = '';
    saveModal.hidden = false;
}
function setSaveModalStatus(message, kind) {
    saveModalStatus.textContent = message;
    saveModalStatus.classList.toggle('good', kind === 'good');
    saveModalStatus.classList.toggle('bad', kind === 'bad');
}
el('btn-save-data').addEventListener('click', openSaveModal);
el('save-alert-export').addEventListener('click', openSaveModal);
el('save-modal-close').addEventListener('click', () => { saveModal.hidden = true; });
saveModal.addEventListener('click', (e) => {
    if (e.target === saveModal)
        saveModal.hidden = true;
});
el('save-copy').addEventListener('click', async () => {
    const text = exportSave(origin, world);
    const kb = Math.round(text.length / 1024);
    try {
        await navigator.clipboard.writeText(text);
        setSaveModalStatus(`Copied ${kb} KB. Paste it somewhere you trust — a note, an email to yourself.`, 'good');
    }
    catch {
        // The async Clipboard API needs a secure context and a permission
        // that a sandboxed iframe may not grant. Falling back to selecting
        // the text in the box gives the player a manual copy that always
        // works, rather than a dead button.
        saveImportText.value = text;
        saveImportText.focus();
        saveImportText.select();
        setSaveModalStatus(`Could not reach the clipboard, so the run (${kb} KB) is selected in the box below — copy it manually.`, 'bad');
    }
});
const saveDownloadBtn = el('save-download');
saveDownloadBtn.addEventListener('click', async () => {
    // Which route this actually takes depends on where the page is running —
    // see download.ts, which owns that decision. What matters here is that the
    // status line reports what happened rather than what was attempted: the
    // version this replaced always said "Download started", including inside
    // the Artifact where a download provably could not start.
    const filename = `evo-tick-${Math.floor(world.tick)}.json`;
    // Disabled across the await so a second tap cannot open a competing save
    // prompt — the capability allows only one undecided prompt at a time and
    // rejects the rest as rate-limited, which would read as a failure the
    // player caused themselves.
    saveDownloadBtn.disabled = true;
    setSaveModalStatus('Preparing the run…', null);
    try {
        const outcome = await offerRunDownload(filename, exportSave(origin, world));
        switch (outcome.status) {
            case 'saved':
                setSaveModalStatus(outcome.via === 'viewer'
                    ? `Saved as ${filename}.`
                    : `Download started (${filename}). If nothing appeared, use "Copy run" instead — some browsers block this.`, outcome.via === 'viewer' ? 'good' : null);
                break;
            case 'declined':
                // Not an error, and deliberately not styled as one: the player was
                // asked and said no.
                setSaveModalStatus('Save cancelled.', null);
                break;
            case 'failed':
                setSaveModalStatus(outcome.message, 'bad');
                break;
        }
    }
    finally {
        saveDownloadBtn.disabled = false;
    }
});
el('save-import').addEventListener('click', async () => {
    const outcome = importSave(saveImportText.value);
    if (outcome.status !== 'loaded') {
        setSaveModalStatus(outcome.status === 'empty' ? 'Nothing to restore — paste a run first.' : outcome.reason, 'bad');
        return;
    }
    const ok = await confirmDialog(`Restore that run (tick ${outcome.world.tick}, ${outcome.world.cells.length} alive)? Your current dish will be replaced.`);
    if (!ok)
        return;
    installWorld(outcome.origin, outcome.world);
    saveModal.hidden = true;
});
/** Swaps in a world that came from somewhere other than this session, and
 * repairs the same session-level state Reset World has to repair. Kept
 * beside the import button rather than folded into it because a restore
 * and a reset are the same operation as far as the surrounding UI is
 * concerned — anything one of them has to fix up, the other does too. */
function installWorld(nextOrigin, nextWorld) {
    origin = nextOrigin;
    world = nextWorld;
    applyPopCap();
    renderer.fitToWorld(world);
    selectIndividual(null);
    stage0Retired = false;
    sustainedAboveThresholdTicks = 0;
    osRetiredNotice.style.display = 'none';
    // Written through immediately for the same reason Reset does it: a
    // reload inside the next 5s window would otherwise hand back the run
    // this one just replaced.
    attemptSave();
}
/** Everything the UI needs to answer "is my run actually safe?" — which,
 * before this existed, it could not. */
let lastSaveAt = null;
let lastSaveFailure = null;
/** Measured from here until the first successful save, so "autosave has
 * never run" is detectable at boot rather than only after one has. */
const pageLoadedAt = Date.now();
/** Single funnel for every save in the app, so no call site can save
 * without its result reaching the screen. */
function attemptSave() {
    const outcome = saveGame(origin, world);
    if (outcome.ok) {
        lastSaveAt = Date.now();
        lastSaveFailure = null;
    }
    else {
        lastSaveFailure = outcome.message;
        // Still logged, for anyone who does have a console open — but the
        // console is no longer the only place this appears.
        console.warn('Evo: save failed —', outcome.message);
    }
    renderSaveStatus();
}
/** Autosave runs every 5s, so nothing should ever be this old. Past this
 * the interval itself has stopped rather than a write being refused — a
 * silent failure, and the more dangerous of the two, since nothing throws. */
const SAVE_STALE_MS = 20000;
/** The dish carries no save readout any more (the stat overlay it lived in
 * was covering a third of the screen on a phone and was removed), so the
 * banner is the whole of the save UI now. It stays silent while things
 * work and speaks up when they don't, which is the right shape for
 * something you should never have to look at.
 *
 * Because the calm "saved 4s ago" line is gone, staleness has to escalate
 * to the banner too. A rejected write throws and is caught; a dead
 * interval does neither, and would otherwise be invisible — which is
 * exactly the class of failure that lost a 100k-tick run in the first
 * place. */
function renderSaveStatus() {
    if (lastSaveFailure !== null) {
        saveAlertMsg.textContent = lastSaveFailure;
        saveAlert.hidden = false;
        return;
    }
    const since = Date.now() - (lastSaveAt ?? pageLoadedAt);
    if (since > SAVE_STALE_MS) {
        saveAlertMsg.textContent = lastSaveAt === null
            ? 'Autosave has not run since this page opened. Export your run to keep it.'
            : `Nothing has saved for ${Math.round(since / 1000)}s. Export your run to keep it.`;
        saveAlert.hidden = false;
        return;
    }
    saveAlert.hidden = true;
}
// --- autosave ------------------------------------------------------------
// Every 5s, plus a best-effort save the moment the tab is hidden or closed.
//
// All three listeners are deliberate and none is redundant.
// `visibilitychange` is the one that actually fires on iOS when the player
// swipes away or locks the phone. `pagehide` covers the bfcache path that
// `beforeunload` misses and is the reliable close signal on Safari, where
// `beforeunload` is unreliable to the point of being decorative — which
// matters, because this app is run from an iPhone home-screen shortcut.
// `beforeunload` stays for desktop browsers that skip the other two.
setInterval(attemptSave, 5000);
// Refresh the "saved Ns ago" reading between saves, so a stalled autosave
// shows as a climbing number rather than a frozen, reassuring one.
setInterval(renderSaveStatus, 1000);
document.addEventListener('visibilitychange', () => {
    if (document.hidden)
        attemptSave();
});
window.addEventListener('pagehide', attemptSave);
window.addEventListener('beforeunload', attemptSave);
renderSaveStatus();
// How the boot-time load actually went. Both branches used to be silent:
// an unreadable save just became an empty dish with no explanation, which
// is indistinguishable from "the game forgot my run for no reason".
if (restored.status === 'discarded') {
    // Opened rather than logged, because the paste box in this dialog is
    // exactly what the player needs next if they kept a backup.
    openSaveModal();
    setSaveModalStatus(`Your saved run could not be loaded, so this is a fresh dish. ${restored.reason}`, 'bad');
}
else if (restored.status === 'loaded' && restored.migratedFrom !== null) {
    console.info(`Evo: migrated a version ${restored.migratedFrom} save forward.`);
    // Rewrite immediately in the current format rather than waiting for the
    // next autosave tick. The old format is ~3.5x larger and was the thing
    // overflowing storage in the first place, so leaving it sitting there
    // for another five seconds is the one window where the migration could
    // still fail for lack of room.
    attemptSave();
}
