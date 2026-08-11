// DOM wiring + the time-budgeted game loop. Nothing simulation-specific
// lives here beyond calling World.tick() — see sim/world.ts for the model.

import { World } from './sim/world.js';
import { Renderer, ViewTransform } from './render/renderer.js';

const DISH_WIDTH = 2400;
const DISH_HEIGHT = 1600;
const TICK_DT = 1 / 30; // fixed sim step, seconds
const FRAME_BUDGET_MS = 18; // never spend more than this per frame on ticks
const SOUP_BURST_SIZE = 60; // amino acids added by the "+ Soup" button
const SAVE_KEY = 'evo-save-v1';
const AUTOSAVE_INTERVAL_MS = 5000;

const canvas = document.getElementById('dish') as HTMLCanvasElement;
const renderer = new Renderer(canvas);

/** Loads a previously-saved dish from localStorage, if one exists and
 *  parses cleanly. Corrupt/incompatible saves are treated as no save —
 *  logged, not thrown, so a bad save can never brick the page. */
function loadSavedWorld(): World | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (data?.version !== 1) return null;
    const loaded = World.deserialize(data);
    console.log(`Evo: resumed saved dish (tick ${Math.floor(loaded.stats.tick)}, pop ${loaded.organisms.length}).`);
    return loaded;
  } catch (err) {
    console.warn('Evo: saved dish failed to load, starting fresh.', err);
    return null;
  }
}

function saveWorld(): void {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(world.serialize()));
  } catch (err) {
    // Most likely quota exceeded — a very dense, long-running dish's JSON
    // can get large. Not fatal: the sim keeps running, it just won't
    // resume from this point. Logged so it's visible in devtools, not
    // silently lost.
    console.warn('Evo: failed to save dish.', err);
  }
}

// No seeded life. The dish starts as pure primordial soup — amino acids
// drifting, nothing alive — and every organism from here on had to
// spontaneously condense out of chemistry (see World.tickChemistry /
// sim/chemistry.ts). A run can go a long time without a single spark. That's
// not a bug to paper over. Unless a save exists, in which case: pick up
// exactly where it left off.
let world = loadSavedWorld() ?? new World(DISH_WIDTH, DISH_HEIGHT, Date.now() & 0xffffffff);

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
const addSoupBtn = document.getElementById('add-soup') as HTMLButtonElement;

playPauseBtn.addEventListener('click', () => {
  playing = !playing;
  playPauseBtn.textContent = playing ? '⏸ Pause' : '▶ Play';
});

resetBtn.addEventListener('click', () => {
  world = new World(DISH_WIDTH, DISH_HEIGHT, Date.now() & 0xffffffff);
  // A reset should mean a genuinely fresh dish, not "fresh until the next
  // autosave tick silently brings the old one back."
  localStorage.removeItem(SAVE_KEY);
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

addSoupBtn.addEventListener('click', () => {
  // No more direct species-dropping — that bypassed abiogenesis entirely.
  // This just adds raw material; whatever it becomes has to condense on
  // its own, same as everything else in the dish.
  world.injectSoup(SOUP_BURST_SIZE);
});

// ---- HUD -----------------------------------------------------------------

const hud = document.getElementById('hud') as HTMLDivElement;

function updateHud(frameMs: number): void {
  const s = world.stats;
  hud.textContent =
    `pop ${s.population}  |  sparks ${s.sparkCount}  |  ` +
    `soup ${s.aminoAcidCount} aa / ${s.proteinCount} protein  |  ` +
    `colonies ${s.colonyCount} (largest ${s.largestColony})  |  ` +
    `carrion ${s.carrionCount}  |  avg mass ${s.avgMass.toFixed(1)}  |  ` +
    `gen ${s.avgGeneration.toFixed(1)} (max ${s.highestGeneration})  |  ` +
    `tick ${Math.floor(s.tick)}  |  frame ${frameMs.toFixed(1)}ms`;
}

// ---- Save / resume --------------------------------------------------------
// Autosave on an interval, plus best-effort saves at the moments a tab is
// actually likely to disappear (switched away from, closed) — the interval
// alone could miss up to AUTOSAVE_INTERVAL_MS of progress otherwise.

setInterval(saveWorld, AUTOSAVE_INTERVAL_MS);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) saveWorld();
});
window.addEventListener('beforeunload', saveWorld);

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
