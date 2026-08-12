import { Renderer } from './render/renderer.js';
import { OriginRenderer } from './render/originRenderer.js';
import { ReproductionMode } from './sim/types.js';
import { StarterLoadout, TRAIT_LIMITS, deriveMouthPower, deriveChloroplastPower } from './sim/genome.js';
import { World } from './sim/world.js';
import { Origin } from './chem/origin.js';
import { translateBootstrapCandidate } from './chem/bridge.js';
import { drawSparkline, drawScatter, ScatterPoint } from './ui/chart.js';
import { drawTree, hitTestTree, TreeNodeScreenPos } from './ui/treeview.js';
import { loadGame, saveGame, Stage } from './save.js';

const WORLD_WIDTH = 2400;
const WORLD_HEIGHT = 1500;
// A small, concentrated "tide pool" rather than a thin ocean — real
// dilute-solution prebiotic chemistry runs into a genuine, well-known
// "concentration problem" (see origin.ts's bondRadius comment); a denser
// pool is the same fix real hypotheses reach for (tide pools, mineral
// surfaces, evaporating basins concentrating solutes) rather than a purely
// game-y shortcut.
const ORIGIN_WIDTH = 800;
const ORIGIN_HEIGHT = 500;

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element #${id}`);
  return found as T;
}

// --- two coexisting top-level stages ---------------------------------
// Origins is where life actually starts (see src/chem/) — the Dish (the
// original organelle/Virtunism ecosystem) begins completely empty, and
// only gets founders either by bootstrapping a stabilized protocell out
// of Origins or by hand-designing one in the Designer tab. Both engines
// keep ticking in the background regardless of which is on screen, so
// switching tabs doesn't pause the one you're not looking at.
//
// Both engines' state autosaves to localStorage every 5s (see save.ts)
// and gets restored here on load if a save exists — a page reload or an
// accidentally-closed tab doesn't cost you a run.
const restored = loadGame();
let stage: Stage = restored?.stage ?? 'origins';
document.body.dataset.stage = stage; // don't rely solely on the static HTML attribute for this

const originCanvas = el<HTMLCanvasElement>('origins-canvas');
const originRenderer = new OriginRenderer(originCanvas);
let origin = restored?.origin ?? Origin.seedPrimordialSoup(ORIGIN_WIDTH, ORIGIN_HEIGHT, Date.now() & 0xffffffff);

const canvas = el<HTMLCanvasElement>('sim-canvas');
const renderer = new Renderer(canvas);
let world = restored?.world ?? new World(WORLD_WIDTH, WORLD_HEIGHT, Date.now() & 0xffffffff);

let paused = false;
let speed = 1;

// --- resize / camera -------------------------------------------------
function handleResize(): void {
  renderer.resize();
  originRenderer.resize();
}
window.addEventListener('resize', handleResize);
handleResize();
renderer.fitToWorld(world);
originRenderer.fitToWorld(origin);

function setupPanZoom(canvasEl: HTMLCanvasElement, target: { panByScreenDelta(dx: number, dy: number): void; zoomAt(x: number, y: number, f: number): void }): void {
  let dragging = false;
  let lastPointer = { x: 0, y: 0 };
  canvasEl.addEventListener('pointerdown', (e) => {
    dragging = true;
    lastPointer = { x: e.clientX, y: e.clientY };
    canvasEl.setPointerCapture(e.pointerId);
  });
  canvasEl.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastPointer.x;
    const dy = e.clientY - lastPointer.y;
    lastPointer = { x: e.clientX, y: e.clientY };
    target.panByScreenDelta(dx, dy);
  });
  window.addEventListener('pointerup', () => {
    dragging = false;
  });
  canvasEl.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const rect = canvasEl.getBoundingClientRect();
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      target.zoomAt(e.clientX - rect.left, e.clientY - rect.top, factor);
    },
    { passive: false },
  );
}
setupPanZoom(canvas, renderer);
setupPanZoom(originCanvas, originRenderer);

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
  if (stage === 'dish') renderer.fitToWorld(world);
  else originRenderer.fitToWorld(origin);
});

el<HTMLButtonElement>('btn-reset').addEventListener('click', () => {
  world = new World(WORLD_WIDTH, WORLD_HEIGHT, Date.now() & 0xffffffff);
  renderer.fitToWorld(world);
  selectedIndividualId = null;
});

el<HTMLButtonElement>('btn-reset-origins').addEventListener('click', () => {
  origin = Origin.seedPrimordialSoup(ORIGIN_WIDTH, ORIGIN_HEIGHT, Date.now() & 0xffffffff);
  originRenderer.fitToWorld(origin);
});

let showVision = false;
const btnVision = el<HTMLButtonElement>('btn-vision');
btnVision.addEventListener('click', () => {
  showVision = !showVision;
  btnVision.classList.toggle('active', showVision);
});

// --- stage switcher -----------------------------------------------------
function switchStage(next: Stage): void {
  stage = next;
  document.body.dataset.stage = stage;
  document.querySelectorAll('.stage-btn').forEach((b) => b.classList.toggle('active', (b as HTMLElement).dataset.stage === stage));
  document.querySelectorAll('.stage-view').forEach((v) => v.classList.remove('active'));
  el(`${stage}-stage`).classList.add('active');
  // A canvas that was display:none reports zero size, so its backing
  // buffer and camera fit need to be redone the moment it becomes visible.
  handleResize();
  if (stage === 'dish') renderer.fitToWorld(world);
  else originRenderer.fitToWorld(origin);
}

document.querySelectorAll<HTMLButtonElement>('.stage-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchStage(btn.dataset.stage as Stage));
});

// A restored save might have left off on the Dish — the static HTML/CSS
// always assumes Origins is the active view on load, so sync it here.
if (stage === 'dish') switchStage('dish');

// --- sub-tabs (Designer / Ecosystem, inside the Dish stage) ------------
document.querySelectorAll<HTMLButtonElement>('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    el(`tab-${btn.dataset.tab}`).classList.add('active');
  });
});

// --- designer form --------------------------------------------------------
const fSize = el<HTMLInputElement>('f-size');
const fSense = el<HTMLInputElement>('f-sense');
const fAge = el<HTMLInputElement>('f-age');
const fHue = el<HTMLInputElement>('f-hue');
const fCount = el<HTMLInputElement>('f-count');
const fName = el<HTMLInputElement>('f-name');
const hueSwatch = el<HTMLDivElement>('hue-swatch');

const fFlagella = el<HTMLInputElement>('f-flagella');
const fMouths = el<HTMLInputElement>('f-mouths');
const fChloroplasts = el<HTMLInputElement>('f-chloroplasts');
const fEyes = el<HTMLInputElement>('f-eyes');
const fArmor = el<HTMLInputElement>('f-armor');
const fBud = el<HTMLInputElement>('f-bud');
const organelleInputs = [fFlagella, fMouths, fChloroplasts, fEyes, fArmor];

function refreshDesignerLabels(): void {
  el('v-size').textContent = Number(fSize.value).toFixed(2);
  el('v-sense').textContent = `${fSense.value} u`;
  el('v-age').textContent = fAge.value;
  el('v-hue').textContent = `${fHue.value}°`;
  el('v-count').textContent = fCount.value;
  hueSwatch.style.background = `hsl(${fHue.value}, 65%, 45%)`;

  const total = organelleInputs.reduce((sum, input) => sum + Number(input.value), 0) + (fBud.checked ? 1 : 0);
  el('v-organelle-total').textContent = `${total} / ${TRAIT_LIMITS.maxOrganelles}`;
}
[fSize, fSense, fAge, fHue, fCount, ...organelleInputs, fBud].forEach((input) =>
  input.addEventListener('input', refreshDesignerLabels),
);
refreshDesignerLabels();

el<HTMLButtonElement>('btn-release').addEventListener('click', () => {
  const reproductionMode = (document.querySelector('input[name="repro"]:checked') as HTMLInputElement)
    ?.value as ReproductionMode;
  const name = fName.value.trim() || 'Unnamed Species';
  const loadout: StarterLoadout = {
    flagella: Number(fFlagella.value),
    mouths: Number(fMouths.value),
    chloroplasts: Number(fChloroplasts.value),
    eyes: Number(fEyes.value),
    armor: Number(fArmor.value),
    bud: fBud.checked,
  };
  world.addSpecies(
    {
      reproductionMode,
      size: Number(fSize.value),
      senseRadius: Number(fSense.value),
      maxAge: Number(fAge.value),
      hue: Number(fHue.value),
      loadout,
    },
    Number(fCount.value),
    { name, isPlayerDesigned: true },
  );
});

// --- Origins: bootstrap into the Dish ------------------------------------
const btnBootstrap = el<HTMLButtonElement>('btn-bootstrap');
const bootstrapHint = el('bootstrap-hint');
const FOUNDER_COUNT = 16; // a single evolved lineage still needs a real founding population in the Dish's own genetics — see world.ts's seedBaseSpecies note on why knife-edge-minimal founders keep failing

btnBootstrap.addEventListener('click', () => {
  const candidate = origin.bootstrapCandidates.pop();
  if (!candidate) return;
  const translated = translateBootstrapCandidate(candidate);
  world.addSpecies(translated.template, FOUNDER_COUNT, { name: translated.name, isPlayerDesigned: false });
  switchStage('dish');
});

function updateOriginsPanel(): void {
  const s = origin.getStats();
  el('ohud-tick').textContent = String(s.tick);
  el('ohud-vesicles').textContent = String(s.vesicleCount);
  el('ohud-ready').textContent = String(origin.bootstrapCandidates.length);
  el('ohud-perf').textContent = `${origin.perf.lastTickMs.toFixed(2)}ms`;

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

  const ready = origin.bootstrapCandidates.length;
  btnBootstrap.disabled = ready === 0;
  bootstrapHint.textContent =
    ready > 0
      ? `${ready} protocell${ready === 1 ? '' : 's'} ready — click to release its evolved chemistry as a founding species in the Dish.`
      : 'No protocell has stabilized yet — one needs an active catalyst, at least two completed self-replication events, and to have survived a division with a replicator still inside. Once one qualifies, this releases its evolved chemistry as a founding species in the Dish.';
}

// --- HUD + stats panel ----------------------------------------------------
const hudTick = el('hud-tick');
const hudPop = el('hud-pop');
const hudGen = el('hud-gen');
const hudPerf = el('hud-perf');

const sPop = el('s-pop');
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
  hudPerf.textContent = `${world.perf.lastTickMs.toFixed(2)}ms`;

  sPop.textContent = String(live.population);
  sGen.textContent = String(live.maxGeneration);
  sColonies.textContent = String(live.colonies);
  sColonySize.textContent = live.avgColonySize.toFixed(1);
  sSolo.textContent = String(live.soloCells);
  sMeat.textContent = String(live.meatFood);
  sRepro.textContent = `${live.sexual} / ${live.asexual}`;
  sMouths.textContent = live.avgMouths.toFixed(2);
  sEyes.textContent = live.avgEyes.toFixed(2);
  sArmor.textContent = live.avgArmor.toFixed(2);

  // Morph scatter: one dot per virtunism, not an average — shows a
  // population actually splitting into distinct body plans (e.g. a
  // plant-leaning cluster vs. a predator-leaning cluster) instead of
  // hiding the split behind a single blended mean.
  const morphPoints: ScatterPoint[] = world.cells.map((c) => ({
    x: c.genome.size,
    y: deriveMouthPower(c.genome) - deriveChloroplastPower(c.genome),
    colorHsl: `hsl(${c.genome.hue}, 65%, 55%)`,
    ring: c.isPlayerDesigned,
  }));
  drawScatter(chartMorphs, morphPoints, {
    xLabel: 'size',
    yLabel: 'diet: chloroplast ←→ mouth',
  });

  const history = world.history;
  if (history.length > 1) {
    drawSparkline(chartPop, history.map((h) => h.population), '#4f8cff');
    drawSparkline(chartSize, history.map((h) => h.avgSize), '#5ad46a');
    drawSparkline(chartSpeed, history.map((h) => h.avgSpeed), '#f5a623');
    drawSparkline(chartSense, history.map((h) => h.avgSense), '#c77dff');
    drawSparkline(chartFlagella, history.map((h) => h.avgFlagella), '#cdd8ee');
    drawSparkline(chartChloro, history.map((h) => h.avgChloroplasts), '#3fae5a');
    cPopVal.textContent = String(live.population);
    cSizeVal.textContent = live.avgSize.toFixed(2);
    cSpeedVal.textContent = live.avgSpeed.toFixed(2);
    cSenseVal.textContent = live.avgSense.toFixed(0);
    cFlagellaVal.textContent = live.avgFlagella.toFixed(2);
    cChloroVal.textContent = live.avgChloroplasts.toFixed(2);
  }
}

// --- tree of life -----------------------------------------------------
const treeDrawer = el<HTMLDivElement>('tree-drawer');
const treeTab = el<HTMLButtonElement>('tree-tab');
const treeCanvas = el<HTMLCanvasElement>('chart-tree');
const treeInfo = el('tree-info');

let treeDrawerOpen = false;
let selectedIndividualId: number | null = null;
let treePositions = new Map<number, TreeNodeScreenPos>();

treeTab.addEventListener('click', () => {
  treeDrawerOpen = !treeDrawerOpen;
  treeDrawer.classList.toggle('open', treeDrawerOpen);
  treeTab.classList.toggle('active', treeDrawerOpen);
  // The dish canvas shares the remaining vertical space with this drawer,
  // so its pixel size actually changes when the drawer opens/closes.
  handleResize();
});

function describeSelection(): void {
  if (selectedIndividualId === null) {
    treeInfo.textContent = '';
    return;
  }
  const node = world.treeNodes.get(selectedIndividualId);
  if (!node) {
    treeInfo.textContent = '';
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
  treeInfo.textContent = `#${node.id} · ${lineageName} · gen ${node.generation} · born t${node.birthTick} · ${parents} · ${status}`;
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
  if (!treeDrawerOpen) return;
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
// engines share this one budget — Origins keeps evolving in the
// background while you're watching the Dish, and vice versa.
const TICK_TIME_BUDGET_MS = 18;

function frame(): void {
  if (!paused) {
    const frameStart = performance.now();
    for (let i = 0; i < speed; i++) {
      origin.update(1);
      world.update(1);
      if (performance.now() - frameStart > TICK_TIME_BUDGET_MS) break;
    }
  }
  if (stage === 'dish') {
    renderer.draw(world, { showVision, highlightId: selectedIndividualId });
    updateHudAndStats();
    updateTree();
  } else {
    originRenderer.draw(origin);
    updateOriginsPanel();
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// --- autosave ------------------------------------------------------------
// Every 5s, plus a best-effort save the moment the tab is hidden/closed
// (covers the common "closed the tab before the next 5s tick" case that a
// bare interval alone would miss — `visibilitychange` fires reliably on
// tab close/switch, `beforeunload` is a backstop for browsers that skip it).
setInterval(() => saveGame(origin, world, stage), 5000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) saveGame(origin, world, stage);
});
window.addEventListener('beforeunload', () => saveGame(origin, world, stage));
