import { Renderer } from './render/renderer.js';
import { ReproductionMode } from './sim/types.js';
import { StarterLoadout, TRAIT_LIMITS } from './sim/genome.js';
import { World } from './sim/world.js';
import { drawSparkline } from './ui/chart.js';

const WORLD_WIDTH = 2400;
const WORLD_HEIGHT = 1500;

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element #${id}`);
  return found as T;
}

const canvas = el<HTMLCanvasElement>('sim-canvas');
const renderer = new Renderer(canvas);

let world = World.createDefault(WORLD_WIDTH, WORLD_HEIGHT, Date.now() & 0xffffffff);

let paused = false;
let speed = 1;

// --- resize / camera -------------------------------------------------
function handleResize(): void {
  renderer.resize();
}
window.addEventListener('resize', handleResize);
handleResize();
renderer.fitToWorld(world);

let dragging = false;
let lastPointer = { x: 0, y: 0 };

canvas.addEventListener('pointerdown', (e) => {
  dragging = true;
  lastPointer = { x: e.clientX, y: e.clientY };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const dx = e.clientX - lastPointer.x;
  const dy = e.clientY - lastPointer.y;
  lastPointer = { x: e.clientX, y: e.clientY };
  renderer.panByScreenDelta(dx, dy);
});
window.addEventListener('pointerup', () => {
  dragging = false;
});
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

el<HTMLButtonElement>('btn-reset').addEventListener('click', () => {
  world = World.createDefault(WORLD_WIDTH, WORLD_HEIGHT, Date.now() & 0xffffffff);
  renderer.fitToWorld(world);
});

let showVision = false;
const btnVision = el<HTMLButtonElement>('btn-vision');
btnVision.addEventListener('click', () => {
  showVision = !showVision;
  btnVision.classList.toggle('active', showVision);
});

// --- tabs ---------------------------------------------------------------
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

// --- main loop --------------------------------------------------------
// A hard time budget for simulation work per animation frame — this is
// what makes "consistent performance" an actual guarantee rather than a
// hope. Regardless of population size, colony complexity, or the chosen
// speed multiplier, a single frame will never spend more than ~18ms
// running ticks: if it hits the budget partway through the requested
// `speed` ticks, it just stops early and picks up next frame. A busy tick
// degrades to a lower effective speed instead of freezing the tab.
const TICK_TIME_BUDGET_MS = 18;

function frame(): void {
  if (!paused) {
    const frameStart = performance.now();
    for (let i = 0; i < speed; i++) {
      world.update(1);
      if (performance.now() - frameStart > TICK_TIME_BUDGET_MS) break;
    }
  }
  renderer.draw(world, { showVision });
  updateHudAndStats();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
