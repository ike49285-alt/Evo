// DOM wiring + the time-budgeted game loop. Nothing simulation-specific
// lives here beyond calling World.tick() — see sim/world.ts for the model.

import { World } from './sim/world.js';
import { Renderer, ViewTransform } from './render/renderer.js';
import { randomGenome } from './sim/genome.js';
import { Rng } from './sim/rng.js';

const DISH_WIDTH = 2400;
const DISH_HEIGHT = 1600;
const TICK_DT = 1 / 30; // fixed sim step, seconds
const FRAME_BUDGET_MS = 18; // never spend more than this per frame on ticks

const canvas = document.getElementById('dish') as HTMLCanvasElement;
const renderer = new Renderer(canvas);

let world = new World(DISH_WIDTH, DISH_HEIGHT, Date.now() & 0xffffffff);
// Plants-only phase: mouths are disabled in genome.ts (ACTIVE_ORGANELLE_TYPES),
// so a "hunter" founder bias wouldn't produce a hunter right now. One plant
// population until animals come back.
world.seed(28, 0);

const view: ViewTransform = { offsetX: 0, offsetY: 0, zoom: 1 };

let playing = true;
let speedMultiplier = 1;
let showVision = false;

// ---- Canvas sizing ----------------------------------------------------

function resizeCanvas(): void {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  const ctx = canvas.getContext('2d');
  if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

function fitView(): void {
  const rect = canvas.getBoundingClientRect();
  const zoom = Math.min(rect.width / DISH_WIDTH, rect.height / DISH_HEIGHT) * 0.95;
  view.zoom = zoom;
  view.offsetX = (rect.width - DISH_WIDTH * zoom) / 2;
  view.offsetY = (rect.height - DISH_HEIGHT * zoom) / 2;
}
fitView();

// ---- Pan / zoom ---------------------------------------------------------

let dragging = false;
let lastPx = 0;
let lastPy = 0;

canvas.addEventListener('pointerdown', (e) => {
  dragging = true;
  lastPx = e.clientX;
  lastPy = e.clientY;
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  view.offsetX += e.clientX - lastPx;
  view.offsetY += e.clientY - lastPy;
  lastPx = e.clientX;
  lastPy = e.clientY;
});
canvas.addEventListener('pointerup', () => (dragging = false));
canvas.addEventListener('pointercancel', () => (dragging = false));

canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const worldXBefore = (mx - view.offsetX) / view.zoom;
    const worldYBefore = (my - view.offsetY) / view.zoom;
    const factor = Math.exp(-e.deltaY * 0.001);
    view.zoom = Math.min(6, Math.max(0.08, view.zoom * factor));
    view.offsetX = mx - worldXBefore * view.zoom;
    view.offsetY = my - worldYBefore * view.zoom;
  },
  { passive: false },
);

// ---- Controls -----------------------------------------------------------

const playPauseBtn = document.getElementById('play-pause') as HTMLButtonElement;
const resetBtn = document.getElementById('reset-dish') as HTMLButtonElement;
const fitBtn = document.getElementById('fit-view') as HTMLButtonElement;
const visionBtn = document.getElementById('toggle-vision') as HTMLButtonElement;
const speedBtns = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-speed]'));
const addSpeciesBtn = document.getElementById('add-species') as HTMLButtonElement;

playPauseBtn.addEventListener('click', () => {
  playing = !playing;
  playPauseBtn.textContent = playing ? '⏸ Pause' : '▶ Play';
});

resetBtn.addEventListener('click', () => {
  world = new World(DISH_WIDTH, DISH_HEIGHT, Date.now() & 0xffffffff);
  world.seed(28, 0);
});

fitBtn.addEventListener('click', fitView);

visionBtn.addEventListener('click', () => {
  showVision = !showVision;
  visionBtn.classList.toggle('active', showVision);
});

for (const btn of speedBtns) {
  btn.addEventListener('click', () => {
    speedMultiplier = Number(btn.dataset.speed);
    for (const b of speedBtns) b.classList.toggle('active', b === btn);
  });
}

addSpeciesBtn.addEventListener('click', () => {
  // A fresh random genome dropped into the dish — the "Designer" entry
  // point. A real body-plan editor is the natural next step; for now this
  // is the "release a new species" action the README describes.
  const rng = new Rng((Date.now() * 2654435761) & 0xffffffff);
  world.spawnFounder(randomGenome(rng));
});

// ---- HUD -----------------------------------------------------------------

const hud = document.getElementById('hud') as HTMLDivElement;

function updateHud(frameMs: number): void {
  const s = world.stats;
  hud.textContent =
    `pop ${s.population}  |  carrion ${s.carrionCount}  |  ` +
    `avg mass ${s.avgMass.toFixed(1)}  |  gen ${s.avgGeneration.toFixed(1)} (max ${s.highestGeneration})  |  ` +
    `tick ${Math.floor(s.tick)}  |  frame ${frameMs.toFixed(1)}ms`;
}

// ---- Game loop -----------------------------------------------------------

let lastFrameTime = performance.now();

function frame(now: number): void {
  const frameStart = performance.now();
  const wallDt = Math.min(0.25, (now - lastFrameTime) / 1000);
  lastFrameTime = now;

  if (playing) {
    let ticksToRun = Math.max(1, Math.round(wallDt / TICK_DT * speedMultiplier));
    while (ticksToRun-- > 0) {
      world.tick(TICK_DT);
      if (performance.now() - frameStart > FRAME_BUDGET_MS) break; // degrade speed, don't freeze the tab
    }
  }

  renderer.render(world, view, showVision);
  updateHud(performance.now() - frameStart);

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
