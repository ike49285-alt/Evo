import { Renderer } from './render/renderer.js';
import { TRAIT_LIMITS, deriveMouthPower, deriveChloroplastPower } from './sim/genome.js';
import { World } from './sim/world.js';
import { Origin } from './chem/origin.js';
import { translateBootstrapCandidate } from './chem/bridge.js';
import { drawSparkline, drawScatter } from './ui/chart.js';
import { drawTree, hitTestTree } from './ui/treeview.js';
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
function el(id) {
    const found = document.getElementById(id);
    if (!found)
        throw new Error(`Missing element #${id}`);
    return found;
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
let dragging = false;
let lastPointer = { x: 0, y: 0 };
canvas.addEventListener('pointerdown', (e) => {
    dragging = true;
    lastPointer = { x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
    if (!dragging)
        return;
    const dx = e.clientX - lastPointer.x;
    const dy = e.clientY - lastPointer.y;
    lastPointer = { x: e.clientX, y: e.clientY };
    renderer.panByScreenDelta(dx, dy);
});
window.addEventListener('pointerup', () => {
    dragging = false;
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
el('btn-reset').addEventListener('click', () => {
    if (!confirm('Reset the whole world — wipe the pool and every evolved lineage, and start over from scratch?'))
        return;
    origin = Origin.seedPrimordialSoup(ORIGIN_WIDTH, ORIGIN_HEIGHT, Date.now() & 0xffffffff);
    world = new World(WORLD_WIDTH, WORLD_HEIGHT, Date.now() & 0xffffffff);
    renderer.fitToWorld(world);
    selectedIndividualId = null;
});
let showVision = false;
const btnVision = el('btn-vision');
btnVision.addEventListener('click', () => {
    showVision = !showVision;
    btnVision.classList.toggle('active', showVision);
});
// --- sidebar tabs (Designer / Ecosystem / Chemistry) --------------------
document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
        document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
        btn.classList.add('active');
        el(`tab-${btn.dataset.tab}`).classList.add('active');
    });
});
// --- designer form --------------------------------------------------------
const fSize = el('f-size');
const fSense = el('f-sense');
const fAge = el('f-age');
const fHue = el('f-hue');
const fCount = el('f-count');
const fName = el('f-name');
const hueSwatch = el('hue-swatch');
const fFlagella = el('f-flagella');
const fMouths = el('f-mouths');
const fChloroplasts = el('f-chloroplasts');
const fEyes = el('f-eyes');
const fArmor = el('f-armor');
const fBud = el('f-bud');
const organelleInputs = [fFlagella, fMouths, fChloroplasts, fEyes, fArmor];
function refreshDesignerLabels() {
    el('v-size').textContent = Number(fSize.value).toFixed(2);
    el('v-sense').textContent = `${fSense.value} u`;
    el('v-age').textContent = fAge.value;
    el('v-hue').textContent = `${fHue.value}°`;
    el('v-count').textContent = fCount.value;
    hueSwatch.style.background = `hsl(${fHue.value}, 65%, 45%)`;
    const total = organelleInputs.reduce((sum, input) => sum + Number(input.value), 0) + (fBud.checked ? 1 : 0);
    el('v-organelle-total').textContent = `${total} / ${TRAIT_LIMITS.maxOrganelles}`;
}
[fSize, fSense, fAge, fHue, fCount, ...organelleInputs, fBud].forEach((input) => input.addEventListener('input', refreshDesignerLabels));
refreshDesignerLabels();
el('btn-release').addEventListener('click', () => {
    const reproductionMode = document.querySelector('input[name="repro"]:checked')
        ?.value;
    const name = fName.value.trim() || 'Unnamed Species';
    const loadout = {
        flagella: Number(fFlagella.value),
        mouths: Number(fMouths.value),
        chloroplasts: Number(fChloroplasts.value),
        eyes: Number(fEyes.value),
        armor: Number(fArmor.value),
        bud: fBud.checked,
    };
    world.addSpecies({
        reproductionMode,
        size: Number(fSize.value),
        senseRadius: Number(fSense.value),
        maxAge: Number(fAge.value),
        hue: Number(fHue.value),
        loadout,
    }, Number(fCount.value), { name, isPlayerDesigned: true });
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
function autoBootstrap() {
    while (origin.bootstrapCandidates.length > 0) {
        const candidate = origin.bootstrapCandidates.shift();
        if (!candidate)
            break;
        const translated = translateBootstrapCandidate(candidate);
        world.addSpecies(translated.template, BOOTSTRAP_FOUNDER_COUNT, {
            name: translated.name,
            isPlayerDesigned: false,
            spawnCenter: { x: POOL_OFFSET.x + candidate.x, y: POOL_OFFSET.y + candidate.y },
        });
        totalBootstraps++;
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
}
// --- HUD + stats panel ----------------------------------------------------
const hudTick = el('hud-tick');
const hudPop = el('hud-pop');
const hudGen = el('hud-gen');
const hudVesicles = el('hud-vesicles');
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
function updateHudAndStats() {
    const live = world.getLiveStats();
    hudTick.textContent = String(live.tick);
    hudPop.textContent = String(live.population);
    hudGen.textContent = String(live.maxGeneration);
    hudVesicles.textContent = String(origin.vesicles.size);
    hudPerf.textContent = `${(world.perf.lastTickMs + origin.perf.lastTickMs).toFixed(2)}ms`;
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
    const morphPoints = world.cells.map((c) => ({
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
const treeDrawer = el('tree-drawer');
const treeTab = el('tree-tab');
const treeCanvas = el('chart-tree');
const treeInfo = el('tree-info');
let treeDrawerOpen = false;
let selectedIndividualId = null;
let treePositions = new Map();
treeTab.addEventListener('click', () => {
    treeDrawerOpen = !treeDrawerOpen;
    treeDrawer.classList.toggle('open', treeDrawerOpen);
    treeTab.classList.toggle('active', treeDrawerOpen);
    // The dish canvas shares the remaining vertical space with this drawer,
    // so its pixel size actually changes when the drawer opens/closes.
    handleResize();
});
function describeSelection() {
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
    const parents = node.parentId === null
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
el('tree-clear').addEventListener('click', () => {
    selectedIndividualId = null;
    describeSelection();
});
function updateTree() {
    if (!treeDrawerOpen)
        return;
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
function frame() {
    if (!paused) {
        const frameStart = performance.now();
        for (let i = 0; i < speed; i++) {
            origin.update(1);
            world.update(1);
            autoBootstrap();
            if (performance.now() - frameStart > TICK_TIME_BUDGET_MS)
                break;
        }
    }
    renderer.draw(world, origin, POOL_OFFSET, { showVision, highlightId: selectedIndividualId });
    updateHudAndStats();
    updateChemistryPanel();
    updateTree();
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
    if (document.hidden)
        saveGame(origin, world);
});
window.addEventListener('beforeunload', () => saveGame(origin, world));
