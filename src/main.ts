import { Renderer } from './render/renderer.js';
import { Diet, ReproductionMode } from './sim/types.js';
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

el<HTMLButtonElement>('btn-food').addEventListener('click', () => {
  world.addFoodBurst(50);
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
const fSpeed = el<HTMLInputElement>('f-speed');
const fSense = el<HTMLInputElement>('f-sense');
const fVision = el<HTMLInputElement>('f-vision');
const fMouth = el<HTMLInputElement>('f-mouth');
const fAge = el<HTMLInputElement>('f-age');
const fHue = el<HTMLInputElement>('f-hue');
const fCount = el<HTMLInputElement>('f-count');
const fName = el<HTMLInputElement>('f-name');
const hueSwatch = el<HTMLDivElement>('hue-swatch');

function refreshDesignerLabels(): void {
  el('v-size').textContent = Number(fSize.value).toFixed(2);
  el('v-speed').textContent = Number(fSpeed.value).toFixed(2);
  el('v-sense').textContent = `${fSense.value} u`;
  el('v-vision').textContent = `${fVision.value}°`;
  el('v-mouth').textContent = Number(fMouth.value).toFixed(2);
  el('v-age').textContent = fAge.value;
  el('v-hue').textContent = `${fHue.value}°`;
  el('v-count').textContent = fCount.value;
  hueSwatch.style.background = `hsl(${fHue.value}, 65%, 45%)`;
}
[fSize, fSpeed, fSense, fVision, fMouth, fAge, fHue, fCount].forEach((input) =>
  input.addEventListener('input', refreshDesignerLabels),
);
refreshDesignerLabels();

el<HTMLButtonElement>('btn-release').addEventListener('click', () => {
  const diet = (document.querySelector('input[name="diet"]:checked') as HTMLInputElement)?.value as Diet;
  const reproductionMode = (document.querySelector('input[name="repro"]:checked') as HTMLInputElement)
    ?.value as ReproductionMode;
  const name = fName.value.trim() || 'Unnamed Species';
  world.addSpecies(
    {
      diet,
      reproductionMode,
      size: Number(fSize.value),
      maxSpeed: Number(fSpeed.value),
      senseRadius: Number(fSense.value),
      visionAngle: Number(fVision.value),
      mouthSize: Number(fMouth.value),
      maxAge: Number(fAge.value),
      hue: Number(fHue.value),
    },
    Number(fCount.value),
    { name, isPlayerDesigned: true },
  );
});

// --- HUD + stats panel ----------------------------------------------------
const hudTick = el('hud-tick');
const hudPop = el('hud-pop');
const hudGen = el('hud-gen');

const sPop = el('s-pop');
const sHerb = el('s-herb');
const sCarn = el('s-carn');
const sOmni = el('s-omni');
const sPlant = el('s-plant');
const sMeat = el('s-meat');
const sSexual = el('s-sexual');
const sAsexual = el('s-asexual');
const sGen = el('s-gen');

const chartPop = el<HTMLCanvasElement>('chart-pop');
const chartSize = el<HTMLCanvasElement>('chart-size');
const chartSpeed = el<HTMLCanvasElement>('chart-speed');
const chartSense = el<HTMLCanvasElement>('chart-sense');
const chartVision = el<HTMLCanvasElement>('chart-vision');
const chartMouth = el<HTMLCanvasElement>('chart-mouth');
const cPopVal = el('c-pop-val');
const cSizeVal = el('c-size-val');
const cSpeedVal = el('c-speed-val');
const cSenseVal = el('c-sense-val');
const cVisionVal = el('c-vision-val');
const cMouthVal = el('c-mouth-val');

function updateHudAndStats(): void {
  const live = world.getLiveStats();

  hudTick.textContent = String(live.tick);
  hudPop.textContent = String(live.population);
  hudGen.textContent = String(live.maxGeneration);

  sPop.textContent = String(live.population);
  sHerb.textContent = String(live.herbivores);
  sCarn.textContent = String(live.carnivores);
  sOmni.textContent = String(live.omnivores);
  sPlant.textContent = String(live.plantFood);
  sMeat.textContent = String(live.meatFood);
  sSexual.textContent = String(live.sexual);
  sAsexual.textContent = String(live.asexual);
  sGen.textContent = String(live.maxGeneration);

  const history = world.history;
  if (history.length > 1) {
    drawSparkline(chartPop, history.map((h) => h.population), '#4f8cff');
    drawSparkline(chartSize, history.map((h) => h.avgSize), '#5ad46a');
    drawSparkline(chartSpeed, history.map((h) => h.avgSpeed), '#f5a623');
    drawSparkline(chartSense, history.map((h) => h.avgSense), '#c77dff');
    drawSparkline(chartVision, history.map((h) => h.avgVisionAngle), '#ffd166');
    drawSparkline(chartMouth, history.map((h) => h.avgMouthSize), '#ef476f');
    cPopVal.textContent = String(live.population);
    cSizeVal.textContent = live.avgSize.toFixed(2);
    cSpeedVal.textContent = live.avgSpeed.toFixed(2);
    cSenseVal.textContent = live.avgSense.toFixed(0);
    cVisionVal.textContent = `${live.avgVisionAngle.toFixed(0)}°`;
    cMouthVal.textContent = live.avgMouthSize.toFixed(2);
  }
}

// --- main loop --------------------------------------------------------
function frame(): void {
  if (!paused) {
    for (let i = 0; i < speed; i++) world.update(1);
  }
  renderer.draw(world, { showVision });
  updateHudAndStats();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
