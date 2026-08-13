import { Renderer } from './render/renderer.js';
import { ReproductionMode } from './sim/types.js';
import { deriveEnergyCapturePower, derivePredationPower, randomGenome } from './sim/genome.js';
import { World } from './sim/world.js';
import { Origin } from './chem/origin.js';
import { translateBootstrapCandidate } from './chem/bridge.js';
import { drawSparkline, drawScatter, ScatterPoint } from './ui/chart.js';
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
  if (!confirm('Reset the whole world — wipe the pool and every evolved lineage, and start over from scratch?')) return;
  origin = Origin.seedPrimordialSoup(ORIGIN_WIDTH, ORIGIN_HEIGHT, Date.now() & 0xffffffff);
  world = new World(WORLD_WIDTH, WORLD_HEIGHT, Date.now() & 0xffffffff);
  renderer.fitToWorld(world);
  selectedIndividualId = null;
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
}

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
  // lineageName can be player-entered text (Designer tab's free-text name
  // field) — build it as a separate node via textContent, never
  // interpolate it into innerHTML.
  const nameSpan = document.createElement('span');
  nameSpan.className = 'specimen-name';
  nameSpan.textContent = lineageName;
  treeInfo.append(`#${node.id} · `, nameSpan, ` · gen ${node.generation} · born t${node.birthTick} · ${parents} · ${status}${speciation}`);
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
      origin.update(1);
      world.update(1);
      autoBootstrap();
      if (performance.now() - frameStart > TICK_TIME_BUDGET_MS) break;
    }
  }
  renderer.draw(world, origin, POOL_OFFSET, { showVision, highlightId: selectedIndividualId });
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
