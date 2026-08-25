import { Renderer } from './render/renderer.js';
import { ReproductionMode } from './sim/types.js';
import { deriveEnergyCapturePower, derivePredationPower, randomGenome } from './sim/genome.js';
import { World, SpeciesSummary } from './sim/world.js';
import { CATALYSIS_CLASSES } from './chem/polymer.js';
import { Origin } from './chem/origin.js';
import { translateBootstrapCandidate } from './chem/bridge.js';
import { drawSparkline, drawScatter, drawRadarChart, ScatterPoint } from './ui/chart.js';
import { drawTree, hitTestTree, TreeNodeScreenPos } from './ui/treeview.js';
import { loadGame, saveGame } from './save.js';

const WORLD_WIDTH = 2400;
const WORLD_HEIGHT = 1500;
// A small, concentrated "primordial pool" rather than a thin ocean — real
// dilute-solution prebiotic chemistry runs into a genuine, well-known
// "concentration problem" (see origin.ts's bondRadius comment); a denser
// pool is the same fix real hypotheses reach for (tide pools, mineral
// surfaces, evaporating basins concentrating solutes) rather than a purely
// game-y shortcut. It's a *region within* the same dish, not a separate
// world — see renderer.ts's drawPool and POOL_OFFSET below.
const ORIGIN_WIDTH = 800;
const ORIGIN_HEIGHT = 500;
const POOL_OFFSET = { x: (WORLD_WIDTH - ORIGIN_WIDTH) / 2, y: WORLD_HEIGHT - ORIGIN_HEIGHT - 100 };

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element #${id}`);
  return found as T;
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
const confirmOverlay = el<HTMLDivElement>('confirm-overlay');
const confirmMessage = el('confirm-message');
const confirmOkBtn = el<HTMLButtonElement>('confirm-ok');
const confirmCancelBtn = el<HTMLButtonElement>('confirm-cancel');

function confirmDialog(message: string): Promise<boolean> {
  confirmMessage.textContent = message;
  confirmOverlay.hidden = false;
  return new Promise((resolve) => {
    const cleanup = (result: boolean) => {
      confirmOverlay.hidden = true;
      confirmOkBtn.removeEventListener('click', onOk);
      confirmCancelBtn.removeEventListener('click', onCancel);
      confirmOverlay.removeEventListener('click', onOverlayClick);
      resolve(result);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onOverlayClick = (e: MouseEvent) => {
      if (e.target === confirmOverlay) cleanup(false);
    };
    confirmOkBtn.addEventListener('click', onOk);
    confirmCancelBtn.addEventListener('click', onCancel);
    confirmOverlay.addEventListener('click', onOverlayClick);
  });
}

// --- one continuous world --------------------------------------------
// Origins (the chemistry — see src/chem/) and the Dish (the organelle/
// Virtunism ecosystem) are two engines, but one world: the primordial pool
// is a real region within the same dish (see POOL_OFFSET), not a separate
// screen. A protocell that clears the bootstrap bar spawns its founders
// automatically, right at the pool, with no button to click and nowhere
// else to teleport to — see autoBootstrap() in the main loop.
//
// Both engines' state autosaves to localStorage every 5s (see save.ts)
// and gets restored here on load if a save exists — a page reload or an
// accidentally-closed tab doesn't cost you a run.
const restored = loadGame();
let origin = restored?.origin ?? Origin.seedPrimordialSoup(ORIGIN_WIDTH, ORIGIN_HEIGHT, Date.now() & 0xffffffff);
let world = restored?.world ?? new World(WORLD_WIDTH, WORLD_HEIGHT, Date.now() & 0xffffffff);

const canvas = el<HTMLCanvasElement>('sim-canvas');
const renderer = new Renderer(canvas);

let paused = false;
let speed = 1;

// --- resize / camera -------------------------------------------------
function handleResize(): void {
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
const activePointers = new Map<number, { x: number; y: number }>();
let lastPinchDist: number | null = null;

function canvasPoint(e: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function pinchState(): { midX: number; midY: number; dist: number } | null {
  if (activePointers.size !== 2) return null;
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
  } catch {
    // ignored — see above
  }
  activePointers.set(e.pointerId, canvasPoint(e));
  // A second finger landing establishes the pinch's starting distance —
  // the very next pointermove diffs against this instead of jumping.
  lastPinchDist = pinchState()?.dist ?? null;
});

canvas.addEventListener('pointermove', (e) => {
  if (!activePointers.has(e.pointerId)) return;
  const prev = activePointers.get(e.pointerId)!;
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
    return;
  }

  if (activePointers.size === 1) {
    renderer.panByScreenDelta(next.x - prev.x, next.y - prev.y);
  }
});

function releasePointer(e: PointerEvent): void {
  activePointers.delete(e.pointerId);
  // Dropping back to one finger (or zero) needs a fresh pinch baseline
  // next time a second finger lands, not a stale distance from before.
  lastPinchDist = pinchState()?.dist ?? null;
}
canvas.addEventListener('pointerup', releasePointer);
canvas.addEventListener('pointercancel', releasePointer);

canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    renderer.zoomAt(e.clientX - rect.left, e.clientY - rect.top, factor);
  },
  { passive: false },
);

// --- top bar controls --------------------------------------------------
const btnPlay = el<HTMLButtonElement>('btn-play');
btnPlay.addEventListener('click', () => {
  paused = !paused;
  btnPlay.textContent = paused ? 'Play' : 'Pause';
});

document.querySelectorAll<HTMLButtonElement>('.speed-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.speed-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    speed = Number(btn.dataset.speed) || 1;
  });
});

el<HTMLButtonElement>('btn-fit').addEventListener('click', () => {
  renderer.fitToWorld(world);
});

// Population cap — live-adjustable while the right value is still being
// worked out (see World.maxPopulation's comment), rather than a constant
// that needs a rebuild to try a new number. Not part of the save format
// yet (a deliberate, temporary-tool scope choice) — a page reload goes
// back to World's own default until this setting earns a permanent home.
const popCapInput = el<HTMLInputElement>('pop-cap-input');
popCapInput.value = String(world.maxPopulation);
function applyPopCap(): void {
  const parsed = Math.round(Number(popCapInput.value));
  const clamped = Math.min(20000, Math.max(20, Number.isFinite(parsed) ? parsed : world.maxPopulation));
  popCapInput.value = String(clamped);
  world.maxPopulation = clamped;
}
popCapInput.addEventListener('change', applyPopCap);

el<HTMLButtonElement>('btn-reset').addEventListener('click', async () => {
  const ok = await confirmDialog('Reset the whole world — wipe the pool and every evolved lineage, and start over from scratch?');
  if (!ok) return;
  origin = Origin.seedPrimordialSoup(ORIGIN_WIDTH, ORIGIN_HEIGHT, Date.now() & 0xffffffff);
  world = new World(WORLD_WIDTH, WORLD_HEIGHT, Date.now() & 0xffffffff);
  applyPopCap(); // the cap is a topbar-level setting, not per-world state — a reset shouldn't silently drop it back to the default
  renderer.fitToWorld(world);
  selectedIndividualId = null;
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
const btnVision = el<HTMLButtonElement>('btn-vision');
btnVision.addEventListener('click', () => {
  showVision = !showVision;
  btnVision.classList.toggle('active', showVision);
});

// --- tab rail (Designer / Species / Ecosystem / Chemistry / Tree) --------
let activeTab = 'designer';
document.querySelectorAll<HTMLButtonElement>('#tab-rail .tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#tab-rail .tab-btn').forEach((b) => {
      b.classList.remove('active');
      b.setAttribute('aria-selected', 'false');
    });
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');
    activeTab = btn.dataset.tab!;
    el(`tab-${activeTab}`).classList.add('active');
  });
});

// --- designer form (random-seed test tool) ---------------------------------
// No body-plan fields anymore — there's no organelle catalog left to
// hand-pick from, every functional part is a real folded protein (see
// sim/genome.ts). This just releases a population founded on a fresh
// randomGenome() — a way to seed a test population on demand rather than
// wait on a natural bootstrap, not a design surface.
const fCount = el<HTMLInputElement>('f-count');
const fName = el<HTMLInputElement>('f-name');

function refreshDesignerLabels(): void {
  el('v-count').textContent = fCount.value;
}
fCount.addEventListener('input', refreshDesignerLabels);
refreshDesignerLabels();

el<HTMLButtonElement>('btn-release').addEventListener('click', () => {
  const reproductionMode = (document.querySelector('input[name="repro"]:checked') as HTMLInputElement)
    ?.value as ReproductionMode;
  const name = fName.value.trim() || 'Unnamed Species';
  const seed = randomGenome(world.rng, reproductionMode);
  world.addSpeciesFromSequence(seed.sequence, Number(fCount.value), { name, isPlayerDesigned: true });
});

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

function autoBootstrap(): void {
  while (origin.bootstrapCandidates.length > 0) {
    const candidate = origin.bootstrapCandidates.shift();
    if (!candidate) break;
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

function updateStage0Retirement(): void {
  if (world.cells.length === 0) {
    sustainedAboveThresholdTicks = 0;
    if (stage0Retired) {
      stage0Retired = false;
      osRetiredNotice.style.display = 'none';
      console.info('Evo: Stage 0 (primordial pool) resumed — the dish went fully extinct, so abiogenesis gets another shot.');
    }
    return;
  }
  if (stage0Retired) return;
  sustainedAboveThresholdTicks = world.cells.length >= STAGE0_RETIREMENT_POP_THRESHOLD ? sustainedAboveThresholdTicks + 1 : 0;
  if (sustainedAboveThresholdTicks >= STAGE0_RETIREMENT_SUSTAIN_TICKS) {
    stage0Retired = true;
    osRetiredNotice.style.display = '';
    console.info('Evo: Stage 0 (primordial pool) retired — the dish sustained its own population, so the pool stopped simulating.');
  }
}

// --- chemistry stats panel ------------------------------------------------
function updateChemistryPanel(): void {
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
const hudTick = el('hud-tick');
const hudPop = el('hud-pop');
const hudGen = el('hud-gen');
const hudVesicles = el('hud-vesicles');
const hudPerf = el('hud-perf');

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

const chartMorphs = el<HTMLCanvasElement>('chart-morphs');
const chartPop = el<HTMLCanvasElement>('chart-pop');
const chartSize = el<HTMLCanvasElement>('chart-size');
const chartSpeed = el<HTMLCanvasElement>('chart-speed');
const chartSense = el<HTMLCanvasElement>('chart-sense');
const chartFlagella = el<HTMLCanvasElement>('chart-flagella');
const chartChloro = el<HTMLCanvasElement>('chart-chloro');
const cPopVal = el('c-pop-val');
const cSizeVal = el('c-size-val');
const cSpeedVal = el('c-speed-val');
const cSenseVal = el('c-sense-val');
const cFlagellaVal = el('c-flagella-val');
const cChloroVal = el('c-chloro-val');

function updateHudAndStats(): void {
  const live = world.getLiveStats();

  hudTick.textContent = String(live.tick);
  hudPop.textContent = String(live.population);
  hudGen.textContent = String(live.maxGeneration);
  hudVesicles.textContent = String(origin.vesicles.size);
  hudPerf.textContent = `${(world.perf.lastTickMs + origin.perf.lastTickMs).toFixed(2)}ms`;

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
  const morphPoints: ScatterPoint[] = world.cells.map((c) => ({
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
// One card per currently-living lineage — a proper home for species
// identity instead of a line of text you only see by clicking a Tree of
// Life node. Rebuilding the card list is real DOM work, not just text
// updates, so it's throttled to the same cadence world.history samples at
// (statsSampleInterval ticks) and skipped entirely while the tab isn't
// active.
const speciesList = el<HTMLDivElement>('species-list');
let lastSpeciesRefreshTick = -1;

function updateSpeciesPanel(): void {
  if (activeTab !== 'species') return;
  const tick = Math.floor(world.tick);
  if (tick === lastSpeciesRefreshTick || tick % world.statsSampleInterval !== 0) return;
  lastSpeciesRefreshTick = tick;

  const species = world.getLivingSpecies();
  speciesList.replaceChildren();
  if (species.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'species-empty';
    empty.textContent = "Nothing alive yet — the pool hasn't bootstrapped a founder.";
    speciesList.appendChild(empty);
    return;
  }

  for (const s of species) {
    const card = document.createElement('div');
    card.className = 'species-card';
    card.style.borderLeftColor = `hsl(${s.hue}, 60%, 50%)`;
    card.style.cursor = 'pointer';
    card.addEventListener('click', () => openSpeciesModal(s));

    const head = document.createElement('div');
    head.className = 'species-card-head';
    const swatch = document.createElement('span');
    swatch.className = 'species-swatch';
    swatch.style.background = `hsl(${s.hue}, 60%, 45%)`;
    const name = document.createElement('span');
    name.className = 'species-name';
    name.textContent = s.name; // player-entered text — textContent only, never innerHTML
    head.append(swatch, name);

    const pop = document.createElement('div');
    pop.className = 'species-pop';
    pop.textContent = `${s.population} alive · gen ${s.maxGeneration}${s.dominantClass ? ` · mostly ${s.dominantClass}` : ''}`;

    const traits = document.createElement('div');
    traits.className = 'species-traits';
    traits.textContent = `size ${s.avgSize.toFixed(2)} · speed ${s.avgSpeed.toFixed(2)} · sense ${s.avgSense.toFixed(0)}`;

    card.append(head, pop, traits);

    if (s.parentName !== null) {
      const lineage = document.createElement('div');
      lineage.className = 'species-lineage';
      const parentEm = document.createElement('em');
      parentEm.textContent = s.parentName;
      lineage.append('diverged from ', parentEm);
      card.appendChild(lineage);
    }
    speciesList.appendChild(card);
  }

  // Keep an already-open modal live while its species is still around —
  // reads the same fresh SpeciesSummary array this refresh just built,
  // not a stale snapshot from the moment it was opened.
  if (openedSpeciesLineageId !== null) {
    const stillAlive = species.find((sp) => sp.lineageId === openedSpeciesLineageId);
    if (stillAlive) renderSpeciesModal(stillAlive);
    else closeSpeciesModal();
  }
}

// --- species stat-star modal --------------------------------------------
const speciesModal = el<HTMLDivElement>('species-modal');
const speciesModalClose = el<HTMLButtonElement>('species-modal-close');
const speciesModalSwatch = el('species-modal-swatch');
const speciesModalName = el('species-modal-name');
const speciesModalMeta = el('species-modal-meta');
const speciesModalRadar = el<HTMLCanvasElement>('species-modal-radar');
const speciesModalTraits = el('species-modal-traits');
const speciesModalLineage = el('species-modal-lineage');
let openedSpeciesLineageId: number | null = null;

function renderSpeciesModal(s: SpeciesSummary): void {
  speciesModalSwatch.style.background = `hsl(${s.hue}, 60%, 45%)`;
  speciesModalName.textContent = s.name; // player-entered text — textContent only, never innerHTML
  speciesModalMeta.textContent = `${s.population} alive · gen ${s.maxGeneration}${s.dominantClass ? ` · mostly ${s.dominantClass}` : ''}`;
  speciesModalTraits.textContent = `size ${s.avgSize.toFixed(2)} · speed ${s.avgSpeed.toFixed(2)} · sense ${s.avgSense.toFixed(0)}`;
  speciesModalLineage.replaceChildren();
  if (s.parentName !== null) {
    const parentEm = document.createElement('em');
    parentEm.textContent = s.parentName;
    speciesModalLineage.append('diverged from ', parentEm);
  }
  drawRadarChart(
    speciesModalRadar,
    CATALYSIS_CLASSES.map((cls) => ({ label: cls, value: s.avgClassPower[cls] })),
    s.hue,
  );
}

function openSpeciesModal(s: SpeciesSummary): void {
  openedSpeciesLineageId = s.lineageId;
  renderSpeciesModal(s);
  speciesModal.hidden = false;
}

function closeSpeciesModal(): void {
  openedSpeciesLineageId = null;
  speciesModal.hidden = true;
}

speciesModalClose.addEventListener('click', closeSpeciesModal);
speciesModal.addEventListener('click', (e) => {
  if (e.target === speciesModal) closeSpeciesModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !speciesModal.hidden) closeSpeciesModal();
});

// --- tree of life -----------------------------------------------------
const treeCanvas = el<HTMLCanvasElement>('chart-tree');
const treeInfo = el('tree-info');

let selectedIndividualId: number | null = null;
let treePositions = new Map<number, TreeNodeScreenPos>();

function describeSelection(): void {
  treeInfo.replaceChildren();
  if (selectedIndividualId === null) return;
  const node = world.treeNodes.get(selectedIndividualId);
  if (!node) {
    selectedIndividualId = null;
    return;
  }
  const lineageName = world.lineages.get(node.lineageId)?.name ?? `Species ${node.lineageId}`;
  const parents =
    node.parentId === null
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

treeCanvas.addEventListener('click', (e) => {
  const rect = treeCanvas.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * treeCanvas.width;
  const y = ((e.clientY - rect.top) / rect.height) * treeCanvas.height;
  const hit = hitTestTree(treePositions, x, y);
  if (hit !== null) {
    selectedIndividualId = hit;
    describeSelection();
  }
});

el<HTMLButtonElement>('tree-clear').addEventListener('click', () => {
  selectedIndividualId = null;
  describeSelection();
});

function updateTree(): void {
  if (activeTab !== 'tree') return;
  treePositions = drawTree(treeCanvas, world.treeNodes, { selectedId: selectedIndividualId });
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

function frame(): void {
  if (!paused) {
    const frameStart = performance.now();
    for (let i = 0; i < speed; i++) {
      if (!stage0Retired) {
        origin.update(1);
        autoBootstrap();
      }
      world.update(1);
      updateStage0Retirement();
      if (performance.now() - frameStart > TICK_TIME_BUDGET_MS) break;
    }
  }
  renderer.draw(world, origin, POOL_OFFSET, { showVision, highlightId: selectedIndividualId, hidePool: stage0Retired });
  updateHudAndStats();
  updateChemistryPanel();
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
setInterval(() => saveGame(origin, world), 5000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) saveGame(origin, world);
});
window.addEventListener('beforeunload', () => saveGame(origin, world));
