import { deserializeVirtunisms, getNextVirtunismId, mateVirtunisms, setNextVirtunismId, Virtunism, } from './virtunism.js';
import { createFood, getNextFoodId, setNextFoodId } from './food.js';
import { deriveMaxSpeed, deriveMotorPower, derivePredationPower, deriveStructureMitigation, genomeFromSequence, hasBud } from './genome.js';
import { decodeCoreTraits, geneticDistance, genomeDistance, mutateGeneSequence } from './genes.js';
import { generateSpeciesName } from './speciesNames.js';
import { NeuralNet } from './nn.js';
import { Rng } from './rng.js';
import { BRAIN_TOPOLOGY } from './types.js';
import { SpatialGrid } from './grid.js';
import { CATALYSIS_CLASSES } from '../chem/polymer.js';
function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
}
export class World {
    constructor(width, height, seed) {
        this.cells = [];
        this.meatFood = [];
        this.lineages = new Map();
        this.history = [];
        this.perf = { lastTickMs: 0 };
        /** The tree-of-life data source — see TreeNode's doc comment for why this
         * doesn't grow without bound over a long run. */
        this.treeNodes = new Map();
        this.tick = 0;
        // --- tunables -----------------------------------------------------
        // Not readonly — live-adjustable from the topbar's "Pop cap" input
        // while the right value is still being worked out, rather than a
        // recompile-to-test constant.
        this.maxPopulation = 320;
        this.maxColonySize = 14;
        // There is no ambient "plant food" resource — sunlight (chloroplast
        // organelles) is the only energy this dish generates from nothing.
        // Carrion is the only discrete food item left, and even that isn't a
        // free lunch: it only exists because something died. Left uncapped it
        // would still accumulate without bound over a long run (a slow,
        // easy-to-miss performance leak as much as a realism gap), so it decays
        // and is hard-capped as a backstop.
        this.maxMeatFood = 260;
        this.meatDecayTicks = 500;
        // Sunlight itself is unlimited, but this dish's *usable* share of it
        // isn't — real photosynthesizers compete for light and nutrients the
        // same way animals compete for prey. Without this, chloroplasts have no
        // carrying capacity at all (unlike animals, which are naturally capped
        // by how much prey exists) and photosynthesizers just grow to fill the
        // entire population cap, leaving predators no room to ever reproduce.
        // When total demand exceeds this budget, every photosynthesizer's
        // income is scaled down proportionally — a shared-resource ceiling, not
        // a per-species quota.
        this.sunlightCapacity = 24;
        // The shared population cap has the same monopolization problem as
        // unlimited sunlight would: whichever lineage has the most individuals
        // wins the most reproduction attempts each tick and structurally starves
        // everyone else of the *room* to reproduce, even if those others are
        // metabolically fine. This is a soft territorial ceiling per lineage —
        // no single one can eat the whole population cap — so a slow-growing
        // predator population isn't crowded out of existing at all by a fast-
        // growing photosynthesizer one.
        this.maxLineageShare = 0.65;
        // Genetic-distance threshold (see genes.ts's geneticDistance, 0..1-ish
        // scale) past which a diverged individual founds its own species rather
        // than staying counted under its parent lineage. An earlier 0.22 (picked
        // from an offline single-lineage ensemble average — 30 trials/generation
        // count, ~0.13 at 10 generations, ~0.31 at 50) turned out badly wrong at
        // population scale: headless-verified at 126 speciation events in 20k
        // ticks (avg gap 132 ticks) against a capped, continuously-reproducing
        // 320-individual population — an ensemble *average* doesn't see that
        // hundreds of reproduction attempts per tick means even a modest per-
        // individual chance of crossing a low bar fires constantly in aggregate.
        // Recalibrated with a direct population-scale sweep instead (same 320-
        // cap scenario, 20k ticks each): 0.22 -> 126 events/first@3479, 0.28 ->
        // 21/first@15484, 0.32 -> 25/first@10332, 0.36 -> 9/first@16031, avg gap
        // 485. 0.34 sits in that rare-but-reachable band — first event doesn't
        // land until a population's had real sustained generations to drift
        // through, not the first few hundred ticks. Note for future reading:
        // this will still show recurring events in a long enough run even at a
        // high threshold — a promoted lineage's reference resets to 0 distance,
        // and geneticDistance itself saturates (doesn't grow unboundedly), so
        // *any* threshold below the saturation ceiling is eventually crossed by
        // a deep-enough lineage again. That's an inherent property of a bounded-
        // metric random walk with reference-reset, not a bug — the tuning
        // question is the steady-state cadence, not eliminating recurrence.
        this.speciationThreshold = 0.34;
        // How far two genomes may diverge and still interbreed. This replaced a
        // flat `b.lineageId !== a.lineageId` test, which made reproductive
        // isolation an administrative fact rather than a biological one: two
        // individuals were incapable of breeding because a bookkeeping integer
        // differed, no matter how similar their genomes actually were. Worse, in
        // combination with the old ordering of checkSpeciation it made speciation
        // *sterilising* — an individual promoted to a new lineage found itself
        // the sole member of its species, unable to breed with the siblings it
        // was genetically all but identical to.
        //
        // Deliberately NOT hard-wired to speciationThreshold even though 0.34 is
        // its swept value. They measure different things — speciation compares an
        // individual against its lineage's fixed reference sequence, this compares
        // two living individuals against each other — and the metric's protein
        // term normalises by a pair-dependent maxTotal (genes.ts), so no bound
        // relating the two follows from the one holding. Swept independently; see
        // NOTES.md for the table.
        this.mateCompatibilityThreshold = 0.34;
        // What recombination buys: sexual offspring take point mutations (and
        // brain-weight mutations) at this fraction of the asexual rate. Without
        // it, a sexual child paid the full asexual mutational load *on top of*
        // crossover — both costs, neither benefit — which is not the trade real
        // biology makes. Composes with the DNA ratchet's own multiplier rather
        // than overriding it; see mutateGenome. SWEPT — NOTES.md carries the
        // table, including the arms that failed.
        this.sexualPointMutationMultiplier = 0.7;
        // Below this population, a newborn gets real per-tick internal
        // chemistry (Virtunism.runInternalChemistry — stochastic expression
        // noise, not a frozen fold-derived constant); at or above it, a
        // newborn gets the cheap, deterministic, already-verified-at-scale
        // formulas instead. Decided once, at birth, from the population at
        // that moment — not re-evaluated later, so individuals born early keep
        // richMode for their whole life even after the population grows past
        // this line (see Virtunism.richMode's own doc comment). First-pass
        // number, not yet swept the way e.g. speciationThreshold was — chosen
        // so the rich phase covers genuine early-founder-population scale
        // without ever approaching maxPopulation, where the per-tick cost of
        // richMode individuals would start to matter. See NOTES.md.
        this.richChemistryPopulationThreshold = 60;
        this.predationSizeRatio = 0.88; // prey must be <= predator.size * this
        // See resolveCrowding()'s own comment for the full mechanism. Kept
        // under 1 deliberately: resolving the full overlap in one tick risks a
        // pair pushing straight through each other and swapping sides
        // (oscillation) when several units are mutually overlapping at once;
        // 0.5 still visibly thins a crowd within a handful of ticks.
        this.separationStrength = 0.5;
        this.statsSampleInterval = 10;
        this.maxHistory = 400;
        // Grid cell sizes: virtunismGrid is sized for the typical sensing range
        // (a few hundred units); carrionGrid is much finer since eating/
        // predation contact is a short-range check. Both are rebuilt fresh each
        // tick (or twice, for virtunisms — see update()) rather than maintained
        // incrementally.
        this.virtunismGrid = new SpatialGrid(110);
        this.carrionGrid = new SpatialGrid(50);
        this.nextLineageId = 1;
        this.width = width;
        this.height = height;
        this.rng = new Rng(seed);
    }
    /**
     * There is no hand-designed starter species anymore — no hard-coded
     * loadout catalog to build one from. A dish starts genuinely empty:
     * life enters either by actually evolving out of the primordial pool
     * (see chem/bridge.ts + main.ts's autoBootstrap), or via the Designer
     * tab's random-seed release (a fresh randomGeneSequence, not a
     * hand-picked body plan — see main.ts). Nothing here stops a lineage
     * from drifting toward bigger and more predatory, or more armored, or
     * anything else evolution and selection actually find — there's no
     * fixed "species" concept to prevent it, and now there's no fixed
     * starting point to anchor it either.
     */
    /** Releases a new population founded directly from an already-real gene
     * sequence, skipping the loadout->buildOrganelles->encode round trip —
     * the bootstrap path (see chem/bridge.ts), where a founder's genes are
     * built from its ancestral protocell's own surviving RNA content rather
     * than a hand-designed phenotype. Returns the new lineage id. */
    addSpeciesFromSequence(sequence, count, opts = {}) {
        const lineageId = this.nextLineageId++;
        const traits = decodeCoreTraits(sequence);
        this.lineages.set(lineageId, {
            id: lineageId,
            name: opts.name ?? generateSpeciesName(sequence),
            hue: traits.hue,
            isPlayerDesigned: !!opts.isPlayerDesigned,
            createdTick: this.tick,
            referenceSequence: sequence,
            parentLineageId: null,
        });
        const clusterX = opts.spawnCenter?.x ?? this.rng.range(this.width * 0.2, this.width * 0.8);
        const clusterY = opts.spawnCenter?.y ?? this.rng.range(this.height * 0.2, this.height * 0.8);
        for (let i = 0; i < count; i++) {
            if (this.cells.length >= this.maxPopulation)
                break;
            // The founding sequence itself becomes the first founder unchanged;
            // the rest each get one real mutation off it — the same starting-
            // variation role addSpecies's per-field jitter plays, just expressed
            // as an actual heritable mutation instead of a continuous nudge.
            const founderSequence = i === 0 ? sequence : mutateGeneSequence(sequence, this.rng);
            const genome = genomeFromSequence(founderSequence, NeuralNet.random(BRAIN_TOPOLOGY, this.rng));
            const x = opts.spread
                ? this.rng.range(20, this.width - 20)
                : clamp(clusterX + this.rng.gaussian(0, 90), 20, this.width - 20);
            const y = opts.spread
                ? this.rng.range(20, this.height - 20)
                : clamp(clusterY + this.rng.gaussian(0, 90), 20, this.height - 20);
            const startEnergy = 12 * genome.size;
            const richMode = this.cells.length < this.richChemistryPopulationThreshold;
            const founder = new Virtunism(genome, x, y, lineageId, 0, startEnergy, this.rng, !!opts.isPlayerDesigned, richMode);
            this.cells.push(founder);
            // No parent to compare against for a root — a founder that happens
            // to start above DNA_TRANSITION_THRESHOLD (rare, but possible via
            // ensureEnergyCapable's search or a hand-designed genome) is itself
            // the transition event for its lineage.
            this.recordBirth(founder, null, null, genome.isDna);
        }
        return lineageId;
    }
    /** Registers a new individual as a tree-of-life node and links it under
     * its parent(s), propagating the +1 live-count up to the root so every
     * ancestor knows it still has a living descendant. `parentId: null`
     * marks a root (a founder released via addSpeciesFromSequence).
     * `isDnaTransition` is computed by the caller, which already has the
     * real parent/child Genome objects in scope — true only when this
     * individual is the first in its lineage to carry isDna, not on every
     * ordinary birth into an already-DNA lineage. */
    recordBirth(child, parentId, secondParentId, isDnaTransition) {
        const node = {
            id: child.id,
            parentId,
            secondParentId,
            lineageId: child.lineageId,
            generation: child.generation,
            hue: child.genome.hue,
            isPlayerDesigned: child.isPlayerDesigned,
            birthTick: Math.floor(this.tick),
            alive: true,
            liveCount: 1,
            children: [],
            isSpeciationEvent: false,
            isDnaTransition,
        };
        this.treeNodes.set(child.id, node);
        if (parentId === null)
            return;
        const parent = this.treeNodes.get(parentId);
        if (!parent)
            return; // defensive — should always exist while it has a living child
        parent.children.push(child.id);
        let cur = parent;
        while (cur) {
            cur.liveCount += 1;
            cur = cur.parentId !== null ? this.treeNodes.get(cur.parentId) : undefined;
        }
    }
    /** Measures a cell's genome against its lineage's reference sequence and,
     * if it's drifted past `speciationThreshold`, promotes it to found a
     * brand-new species right there rather than staying counted under its
     * parent lineage. Called just before an individual actually reproduces
     * (not at birth) — a one-off mutant that never manages to pass anything
     * on shouldn't get to register as a "species" that immediately goes
     * extinct with it; only a genome that's about to prove itself by
     * reproducing gets to found one. */
    checkSpeciation(cell) {
        const lineage = this.lineages.get(cell.lineageId);
        if (!lineage)
            return; // defensive — every live cell's lineage should exist
        const distance = geneticDistance(cell.genome.sequence, lineage.referenceSequence);
        if (distance < this.speciationThreshold)
            return;
        const newLineageId = this.nextLineageId++;
        this.lineages.set(newLineageId, {
            id: newLineageId,
            name: generateSpeciesName(cell.genome.sequence),
            hue: cell.genome.hue,
            isPlayerDesigned: false,
            createdTick: this.tick,
            referenceSequence: cell.genome.sequence,
            parentLineageId: cell.lineageId,
        });
        cell.lineageId = newLineageId;
        const node = this.treeNodes.get(cell.id);
        if (node) {
            node.lineageId = newLineageId;
            node.isSpeciationEvent = true;
            node.hue = cell.genome.hue;
        }
    }
    /** Marks a tree node as no longer alive, then compacts from there upward
     * (see `compactFrom`) — the actual mechanism that keeps `treeNodes`
     * bounded to roughly "current population + branch points" regardless of
     * total ticks run, not just the dead-end pruning by itself. */
    recordDeath(individual) {
        const node = this.treeNodes.get(individual.id);
        if (!node || !node.alive)
            return;
        node.alive = false;
        let cur = node;
        while (cur) {
            cur.liveCount -= 1;
            cur = cur.parentId !== null ? this.treeNodes.get(cur.parentId) : undefined;
        }
        this.compactFrom(node.id);
    }
    /**
     * Walks upward from a just-died node, applying two collapses:
     *  1. A node with liveCount 0 (nothing alive left in its subtree) has
     *     nothing left to connect — delete it and keep walking up.
     *  2. A *dead* node with exactly one remaining child is a redundant
     *     waypoint — a single unbranched step of "this lineage existed, then
     *     had one descendant" that a tree-of-life view doesn't need to show
     *     individually (only where lineages actually branch or a currently-
     *     alive individual sits). Splice it out: reattach its one child
     *     directly to its own parent.
     * Without step 2, a long-running population in genealogical steady
     * state accumulates one retained "spine" node per birth/death cycle
     * forever — bounded by turnover count, not by population size, which
     * defeats the point. With it, only actual branch points and currently-
     * alive individuals stick around, which *is* bounded by population size
     * (verified: population holds steady while treeNodes.size stays flat
     * over tens of thousands of ticks — see tree_bound_check.mjs).
     * Both collapses only ever need to look at the single node just touched
     * — once a node doesn't qualify for either, nothing further up could
     * have changed, so it's safe to stop.
     */
    compactFrom(startId) {
        let curId = startId;
        while (curId !== null) {
            const cur = this.treeNodes.get(curId);
            if (!cur)
                return;
            if (cur.liveCount === 0) {
                const parentId = cur.parentId;
                if (parentId !== null) {
                    const parent = this.treeNodes.get(parentId);
                    if (parent)
                        parent.children = parent.children.filter((id) => id !== cur.id);
                }
                this.treeNodes.delete(cur.id);
                curId = parentId;
                continue;
            }
            if (!cur.alive && cur.children.length === 1) {
                const onlyChildId = cur.children[0];
                const onlyChild = this.treeNodes.get(onlyChildId);
                const parentId = cur.parentId;
                if (onlyChild)
                    onlyChild.parentId = parentId;
                if (parentId !== null) {
                    const parent = this.treeNodes.get(parentId);
                    if (parent) {
                        const idx = parent.children.indexOf(cur.id);
                        if (idx !== -1)
                            parent.children[idx] = onlyChildId;
                    }
                }
                this.treeNodes.delete(cur.id);
            }
            return;
        }
    }
    /** Advances the simulation by one fixed tick. */
    update(dt) {
        const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
        this.decayMeatFood();
        this.carrionGrid.rebuild(this.meatFood);
        // Sense + think using positions from *before* this tick's movement (a
        // consistent "everyone sees the world as it was a moment ago" model).
        this.virtunismGrid.rebuild(this.cells.filter((c) => c.alive));
        for (const cell of this.cells) {
            if (!cell.alive)
                continue;
            const inputs = this.buildInputs(cell);
            cell.think(inputs);
        }
        // Movement: solo virtunisms act individually; colony roots move the
        // whole bonded tree as one rigid body and cascade positions to every
        // member.
        for (const cell of this.cells) {
            if (!cell.alive || cell.attachedTo !== null)
                continue;
            if (cell.attachedChildren.length > 0) {
                this.moveColonyRigid(cell, dt);
            }
            else {
                cell.act(cell.lastOutputs, dt, this.width, this.height);
            }
        }
        // Rebuild so resolveCrowding() below queries this tick's actual
        // post-movement positions, not the pre-movement snapshot from the top
        // of this method.
        this.virtunismGrid.rebuild(this.cells.filter((c) => c.alive));
        this.resolveCrowding();
        for (const cell of this.cells) {
            if (cell.alive) {
                cell.runInternalChemistry(dt, this.rng); // no-op for cheap-mode cells
                cell.metabolize(dt);
            }
        }
        this.applyPhotosynthesis(dt);
        // Rebuild with post-separation positions for contact-driven systems.
        this.virtunismGrid.rebuild(this.cells.filter((c) => c.alive));
        this.handleEating();
        this.handlePredation();
        this.diffuseColonyEnergy(dt);
        this.handleReproduction();
        this.cleanupDead();
        this.tick += dt;
        if (Math.floor(this.tick) % this.statsSampleInterval === 0) {
            this.pushStatsSnapshot();
        }
        const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
        this.perf.lastTickMs = t1 - t0;
    }
    getLiveStats() {
        let sexual = 0;
        let asexual = 0;
        let sumSize = 0;
        let sumSpeed = 0;
        let sumSense = 0;
        let sumMotor = 0;
        let sumPredation = 0;
        let sumEnergyCapture = 0;
        let sumSensors = 0;
        let sumStructure = 0;
        let sumAge = 0;
        let maxGeneration = 0;
        let colonies = 0;
        let soloCells = 0;
        let colonyMemberTotal = 0;
        for (const c of this.cells) {
            if (c.genome.reproductionMode === 'sexual')
                sexual++;
            else
                asexual++;
            sumSize += c.genome.size;
            sumSpeed += deriveMaxSpeed(c.genome);
            sumSense += c.genome.senseRadius;
            for (const p of c.genome.proteins) {
                const strength = p.fold.catalysisStrength;
                if (p.fold.catalysisClass === 'motor')
                    sumMotor += strength;
                else if (p.fold.catalysisClass === 'protease')
                    sumPredation += strength;
                else if (p.fold.catalysisClass === 'peptidyl')
                    sumEnergyCapture += strength;
                else if (p.fold.catalysisClass === 'photoreceptor')
                    sumSensors += 1;
                else if (p.fold.catalysisClass === 'lipidsynthase')
                    sumStructure += strength;
            }
            sumAge += c.age;
            if (c.generation > maxGeneration)
                maxGeneration = c.generation;
            if (c.attachedTo === null) {
                if (c.attachedChildren.length > 0) {
                    colonies++;
                    colonyMemberTotal += this.collectColonyMembers(c).length;
                }
                else {
                    soloCells++;
                }
            }
        }
        const n = this.cells.length || 1;
        return {
            tick: Math.floor(this.tick),
            population: this.cells.length,
            sexual,
            asexual,
            colonies,
            soloCells,
            avgColonySize: colonies > 0 ? colonyMemberTotal / colonies : 0,
            avgSize: sumSize / n,
            avgSpeed: sumSpeed / n,
            avgSense: sumSense / n,
            avgMotor: sumMotor / n,
            avgPredation: sumPredation / n,
            avgEnergyCapture: sumEnergyCapture / n,
            avgSensors: sumSensors / n,
            avgStructure: sumStructure / n,
            avgAge: sumAge / n,
            maxGeneration,
            meatFood: this.meatFood.length,
        };
    }
    pushStatsSnapshot() {
        this.history.push(this.getLiveStats());
        if (this.history.length > this.maxHistory)
            this.history.shift();
    }
    /** One entry per lineage actually represented among *living* individuals
     * right now, mirroring getLiveStats()'s single-pass style — the
     * read-only aggregation the Species panel renders from. Not
     * sampled/cached: cheap (same O(population) cost as getLiveStats()),
     * and callers already throttle how often they call it. */
    getLivingSpecies() {
        const zeroClassPower = () => {
            const r = {};
            for (const cls of CATALYSIS_CLASSES)
                r[cls] = 0;
            return r;
        };
        const acc = new Map();
        for (const c of this.cells) {
            let a = acc.get(c.lineageId);
            if (!a) {
                a = { population: 0, maxGeneration: 0, sumSize: 0, sumSpeed: 0, sumSense: 0, classCounts: {}, sumClassPower: zeroClassPower() };
                acc.set(c.lineageId, a);
            }
            a.population++;
            a.sumSize += c.genome.size;
            a.sumSpeed += deriveMaxSpeed(c.genome);
            a.sumSense += c.genome.senseRadius;
            if (c.generation > a.maxGeneration)
                a.maxGeneration = c.generation;
            for (const p of c.genome.proteins) {
                const cls = p.fold.catalysisClass;
                if (cls === null)
                    continue;
                a.classCounts[cls] = (a.classCounts[cls] ?? 0) + 1;
            }
            for (const cls of CATALYSIS_CLASSES)
                a.sumClassPower[cls] += c.genome.classPowerCache[cls];
        }
        const result = [];
        for (const [lineageId, a] of acc) {
            const info = this.lineages.get(lineageId);
            if (!info)
                continue; // every live cell's lineage is recorded at founding time
            const parent = info.parentLineageId !== null ? this.lineages.get(info.parentLineageId) : undefined;
            let dominant = null;
            let dominantCount = 0;
            for (const cls in a.classCounts) {
                const count = a.classCounts[cls];
                if (count > dominantCount) {
                    dominant = cls;
                    dominantCount = count;
                }
            }
            result.push({
                lineageId,
                name: info.name,
                hue: info.hue,
                isPlayerDesigned: info.isPlayerDesigned,
                createdTick: info.createdTick,
                parentLineageId: info.parentLineageId,
                parentName: parent?.name ?? null,
                population: a.population,
                maxGeneration: a.maxGeneration,
                avgSize: a.sumSize / a.population,
                avgSpeed: a.sumSpeed / a.population,
                avgSense: a.sumSense / a.population,
                dominantClass: dominant,
                avgClassPower: Object.fromEntries(CATALYSIS_CLASSES.map((cls) => [cls, a.sumClassPower[cls] / a.population])),
            });
        }
        result.sort((x, y) => y.population - x.population);
        return result;
    }
    /** Adds a carrion pellet, oldest-first-evicting if that would push the
     * standing amount over the cap — a predation/death spike (a colony wiped
     * out at once, say) can't make the meat pile grow without bound. */
    spawnMeat(x, y, energy) {
        if (this.meatFood.length >= this.maxMeatFood)
            this.meatFood.shift();
        this.meatFood.push(createFood(x, y, energy, Math.floor(this.tick)));
    }
    /** Removes carrion that's been sitting long enough to rot away — the
     * actual fix for meat food's unbounded growth, not just the cap. */
    decayMeatFood() {
        if (this.meatFood.length === 0)
            return;
        const cutoff = this.tick - this.meatDecayTicks;
        this.meatFood = this.meatFood.filter((f) => f.bornTick > cutoff);
    }
    /** True if world point (tx, ty) falls inside cell's field of view — a
     * narrow always-on "chemoreception" cone plus the union of whatever
     * photoreceptor-class proteins it's grown, each mounted at its own
     * gene-encoded angle relative to its heading with a width set by that
     * protein's real fold-derived catalytic strength. */
    inFOV(cell, tx, ty) {
        const angleToTarget = Math.atan2(ty - cell.y, tx - cell.x);
        const within = (mountAngle, halfWidth) => {
            let diff = angleToTarget - (cell.heading + mountAngle);
            diff = Math.atan2(Math.sin(diff), Math.cos(diff));
            return Math.abs(diff) <= halfWidth;
        };
        const baselineHalf = ((50 * Math.PI) / 180) * 0.5;
        if (within(0, baselineHalf))
            return true;
        for (const p of cell.genome.proteins) {
            if (p.fold.catalysisClass !== 'photoreceptor')
                continue;
            const halfWidth = (((50 + p.fold.catalysisStrength * 40) * Math.PI) / 180) * 0.5;
            if (within(p.angle, halfWidth))
                return true;
        }
        return false;
    }
    /** How far a predator's mouth investment stretches its max-prey-size
     * threshold — a bigger mouth can tackle relatively bigger prey. */
    predatorReach(predator) {
        return clamp(0.7 + derivePredationPower(predator.genome) * 0.15, 0.7, 1.4);
    }
    /** Builds the fixed sensor vector consumed by Virtunism/NeuralNet (see
     * BRAIN_TOPOLOGY.inputs). A mouthed virtunism's only food sources are
     * carrion and other virtunisms (predation) — there's no ambient food
     * resource, so "prey" covers everything from a photosynthesizer smaller
     * than you to a fresh corpse. Candidates come from the spatial grid
     * (only nearby buckets), not the whole population. */
    buildInputs(cell) {
        const sr = cell.genome.senseRadius;
        const canEat = cell.canEat;
        let foodDx = 0;
        let foodDy = 0;
        let foodDist = 1;
        let bestFoodD = sr;
        if (canEat) {
            const nearbyCarrion = this.carrionGrid.queryRadius(cell.x, cell.y, sr);
            for (const f of nearbyCarrion) {
                const dx = f.x - cell.x;
                const dy = f.y - cell.y;
                const d = Math.hypot(dx, dy);
                if (d < bestFoodD && this.inFOV(cell, f.x, f.y)) {
                    bestFoodD = d;
                    foodDx = dx / sr;
                    foodDy = dy / sr;
                    foodDist = d / sr;
                }
            }
            const nearbyCells = this.virtunismGrid.queryRadius(cell.x, cell.y, sr);
            for (const other of nearbyCells) {
                if (other === cell || !other.alive)
                    continue;
                if (other.effectiveDefenseSize >= cell.genome.size * this.predationSizeRatio * this.predatorReach(cell))
                    continue;
                const dx = other.x - cell.x;
                const dy = other.y - cell.y;
                const d = Math.hypot(dx, dy);
                if (d < bestFoodD && this.inFOV(cell, other.x, other.y)) {
                    bestFoodD = d;
                    foodDx = dx / sr;
                    foodDy = dy / sr;
                    foodDist = d / sr;
                }
            }
        }
        let threatDx = 0;
        let threatDy = 0;
        let threatDist = 1;
        let bestThreatD = sr;
        let mateDx = 0;
        let mateDy = 0;
        let mateDist = 1;
        let bestMateD = sr;
        const wantsMate = cell.genome.reproductionMode === 'sexual';
        const nearbyForThreatAndMate = this.virtunismGrid.queryRadius(cell.x, cell.y, sr);
        for (const other of nearbyForThreatAndMate) {
            if (other === cell || !other.alive)
                continue;
            const dx = other.x - cell.x;
            const dy = other.y - cell.y;
            const d = Math.hypot(dx, dy);
            if (other.canEat &&
                cell.effectiveDefenseSize < other.genome.size * this.predationSizeRatio * this.predatorReach(other) &&
                d < bestThreatD &&
                this.inFOV(cell, other.x, other.y)) {
                bestThreatD = d;
                threatDx = dx / sr;
                threatDy = dy / sr;
                threatDist = d / sr;
            }
            // The mate-seeking sense has to agree with the rule that actually
            // decides matings, or the brain spends its life steering toward
            // partners it cannot breed with. This used to test lineage equality,
            // matching handleReproduction's old lineage gate; now that mating is
            // decided by real divergence, so is this. genomeDistance last, for the
            // same reason as there — it is the expensive test, and it only runs on
            // a candidate that has already passed everything cheaper.
            if (wantsMate &&
                other.genome.reproductionMode === 'sexual' &&
                other.canMate() &&
                d < bestMateD &&
                this.inFOV(cell, other.x, other.y) &&
                genomeDistance(cell.genome, other.genome) <= this.mateCompatibilityThreshold) {
                bestMateD = d;
                mateDx = dx / sr;
                mateDy = dy / sr;
                mateDist = d / sr;
            }
        }
        const energyNorm = clamp(cell.energy / cell.maxEnergy, 0, 1);
        const maxSpeed = deriveMaxSpeed(cell.genome);
        const speedNorm = maxSpeed > 0 ? cell.speed / maxSpeed : 0;
        const marginX = Math.min(cell.x, this.width - cell.x);
        const marginY = Math.min(cell.y, this.height - cell.y);
        const wallSignX = cell.x < this.width / 2 ? 1 : -1;
        const wallSignY = cell.y < this.height / 2 ? 1 : -1;
        const wallUrgencyX = clamp(1 - marginX / sr, 0, 1) * wallSignX;
        const wallUrgencyY = clamp(1 - marginY / sr, 0, 1) * wallSignY;
        // A per-individual oscillator ("run and tumble" drive) — without it a
        // virtunism with nothing nearby sees an almost constant input vector
        // and a random brain settles into a fixed turn output, orbiting a tiny
        // circle forever. Gives every genome some baseline ability to explore.
        const wander = Math.sin(cell.age * 0.05 + cell.id * 0.7321);
        return [
            foodDx,
            foodDy,
            foodDist,
            threatDx,
            threatDy,
            threatDist,
            mateDx,
            mateDy,
            mateDist,
            energyNorm,
            speedNorm,
            wallUrgencyX,
            wallUrgencyY,
            wander,
            1, // bias
        ];
    }
    collectColonyMembers(root) {
        const members = [];
        const stack = [root];
        while (stack.length) {
            const cell = stack.pop();
            members.push(cell);
            for (const child of cell.attachedChildren)
                stack.push(child);
        }
        return members;
    }
    /** Moves an entire bonded colony as one rigid body: every member's brain
     * cast a [turn, thrust] vote this tick (cached in lastOutputs); votes are
     * pooled weighted by each member's own flagella investment, so
     * heavily-flagellated members steer more than a bare passenger would. The
     * colony's top speed comes from its *pooled* flagella power (with
     * diminishing returns), same shape as a solo virtunism's but bigger.
     * After integrating the root, every other member is repositioned from
     * its fixed parent-relative joint. */
    moveColonyRigid(root, dt) {
        const members = this.collectColonyMembers(root);
        let turnSum = 0;
        let thrustSum = 0;
        let weightSum = 0;
        let totalFlagellaPower = 0;
        for (const m of members) {
            const power = deriveMotorPower(m.genome);
            totalFlagellaPower += power;
            if (power <= 0)
                continue;
            const turnOut = clamp(m.lastOutputs[0] ?? 0, -1, 1);
            const thrustOut = clamp(m.lastOutputs[1] ?? 0, 0, 1);
            turnSum += turnOut * power;
            thrustSum += thrustOut * power;
            weightSum += power;
        }
        const avgTurn = weightSum > 0 ? turnSum / weightSum : 0;
        const avgThrust = weightSum > 0 ? thrustSum / weightSum : 0;
        const colonyMaxSpeed = 0.05 + Math.sqrt(totalFlagellaPower) * 0.85;
        const colonyTurnRate = 0.06 + Math.min(0.22, members.length * 0.02);
        root.heading += avgTurn * colonyTurnRate * dt;
        root.speed = avgThrust * colonyMaxSpeed;
        root.x += Math.cos(root.heading) * root.speed * dt;
        root.y += Math.sin(root.heading) * root.speed * dt;
        root.clampToBounds(this.width, this.height, true);
        this.cascadeColonyPositions(root);
    }
    /** Repositions every bonded descendant from `root`'s current position —
     * the rigid-body half of colony movement, shared by moveColonyRigid()
     * (after the root's own thrust/heading integration) and
     * resolveCrowding() (after a separation nudge to the root) so both
     * callers reposition children from exactly the same fixed
     * parent-relative joints, never independently. */
    cascadeColonyPositions(root) {
        const stack = [root];
        while (stack.length) {
            const cell = stack.pop();
            for (const child of cell.attachedChildren) {
                const worldAngle = cell.heading + child.localAngle;
                child.x = cell.x + Math.cos(worldAngle) * child.localDist;
                child.y = cell.y + Math.sin(worldAngle) * child.localDist;
                child.heading = worldAngle;
                child.clampToBounds(this.width, this.height, false);
                stack.push(child);
            }
        }
    }
    /** Soft separation: nothing in this sim has ever pushed two overlapping
     * virtunisms apart (only the outer world walls are clamped against), so
     * a favorable spot with nothing else limiting density can accumulate a
     * crowd stacked far past what the space actually holds. A colony must
     * move as one rigid unit, never deform — its members' positions are
     * fixed parent-relative joints (cascadeColonyPositions()), not
     * independently movable — so this resolves overlap once per *unit*
     * (a solo virtunism, or an entire bonded colony via its root), not per
     * member: every member's overlap against anything *outside* its own
     * unit contributes to one shared push, averaged across the unit's
     * member count (so a large colony doesn't get an outsized net shove
     * just because it has more members individually detecting overlap),
     * applied to the root, then cascaded down exactly like ordinary
     * movement. Resolves only half the measured overlap per tick — under
     * 1.0 guarantees a pair can never push straight through each other and
     * swap sides (no oscillation), while still visibly thinning a crowd
     * within a handful of ticks rather than snapping positions instantly. */
    resolveCrowding() {
        for (const root of this.cells) {
            if (!root.alive || root.attachedTo !== null)
                continue;
            const members = this.collectColonyMembers(root);
            let pushX = 0;
            let pushY = 0;
            for (const m of members) {
                const nearby = this.virtunismGrid.queryRadius(m.x, m.y, m.radius + 40);
                for (const o of nearby) {
                    if (!o.alive || o === m)
                        continue;
                    if (this.findColonyRoot(o) === root)
                        continue; // same unit -- bonded, not repelling
                    const dist = Math.hypot(o.x - m.x, o.y - m.y);
                    if (dist <= 0)
                        continue; // exact-coincident pair -- vanishingly rare, self-resolves once anything else nudges either one
                    const overlap = m.radius + o.radius - dist;
                    if (overlap <= 0)
                        continue;
                    pushX += ((m.x - o.x) / dist) * overlap;
                    pushY += ((m.y - o.y) / dist) * overlap;
                }
            }
            if (pushX === 0 && pushY === 0)
                continue;
            root.x += (pushX / members.length) * this.separationStrength;
            root.y += (pushY / members.length) * this.separationStrength;
            this.cascadeColonyPositions(root);
            root.clampToBounds(this.width, this.height, false);
        }
    }
    /** Slowly equalizes energy across each bonded parent-child joint — how a
     * colony shares resources, letting e.g. a flagella-heavy propulsion
     * member survive on income harvested by its photosynthetic/mouthed
     * neighbors. */
    diffuseColonyEnergy(dt) {
        const rate = 0.08;
        for (const cell of this.cells) {
            if (!cell.alive || !cell.attachedTo || !cell.attachedTo.alive)
                continue;
            const parent = cell.attachedTo;
            const wanted = (parent.energy - cell.energy) * rate * dt;
            // Capped by the *receiver's* remaining headroom, in whichever
            // direction the flow runs. This was an unclamped `+=` on both sides,
            // which meant a colony could push a small-genomed member above its
            // own maxEnergy and park it there — the same free ride the
            // photosynthesis clamp closes, arriving through a different pipe.
            // The cap is applied to `wanted` before either side is touched so
            // the transfer stays exactly conserved: whatever the receiver is
            // allowed to take is precisely what the donor gives up.
            const headroom = wanted > 0 ? cell.maxEnergy - cell.energy : parent.maxEnergy - parent.energy;
            const transfer = Math.sign(wanted) * Math.min(Math.abs(wanted), Math.max(0, headroom));
            parent.energy -= transfer;
            cell.energy += transfer;
        }
    }
    /** Grants photosynthesis income, throttled by a dish-wide sunlight
     * budget shared across every chloroplast-bearing virtunism. If total
     * demand is under budget everyone gets their full uncontested share
     * (the common case at low population); once it isn't, income scales
     * down proportionally for all of them — the mechanism that gives
     * photosynthesizers an actual carrying capacity instead of growing to
     * fill the entire population cap. */
    applyPhotosynthesis(dt) {
        let totalDemand = 0;
        for (const cell of this.cells) {
            if (cell.alive)
                totalDemand += cell.baseSunlightDemand;
        }
        if (totalDemand <= 0)
            return;
        const availability = Math.min(1, this.sunlightCapacity / totalDemand);
        for (const cell of this.cells) {
            if (cell.alive)
                cell.photosynthesize(dt, availability);
        }
    }
    /** Carrion is the only discrete food item in the dish — everything else
     * a mouthed virtunism eats, it has to catch alive (see handlePredation). */
    handleEating() {
        for (const cell of this.cells) {
            if (!cell.alive || !cell.canEat)
                continue;
            const reach = cell.radius + (derivePredationPower(cell.genome) - 1) * 4;
            const yieldMult = cell.biteYield;
            const nearbyCarrion = this.carrionGrid.queryRadius(cell.x, cell.y, reach + 10);
            for (const f of nearbyCarrion) {
                const d = Math.hypot(f.x - cell.x, f.y - cell.y);
                if (d >= reach + f.radius)
                    continue;
                const idx = this.meatFood.indexOf(f);
                if (idx === -1)
                    continue; // already eaten by someone else this pass
                cell.eat(f.energy * yieldMult);
                this.meatFood.splice(idx, 1);
            }
        }
    }
    handlePredation() {
        for (const predator of this.cells) {
            if (!predator.alive || !predator.canEat)
                continue;
            // A flat "lunge" bonus on top of body/mouth reach — without it, a
            // baseline one-mouth predator has a genuinely tiny catch radius, and
            // early-generation (still-random-brained) hunters need *some* margin
            // to survive on lucky catches long enough for real chase behavior to
            // evolve. Same lesson as foraging and mate-finding before it: a
            // mechanic that's only winnable once you're already good at it never
            // gets the chance to be learned at all.
            const reach = predator.radius + 6 + (derivePredationPower(predator.genome) - 1) * 4;
            const nearby = this.virtunismGrid.queryRadius(predator.x, predator.y, reach + 30);
            for (const prey of nearby) {
                if (prey === predator || !prey.alive)
                    continue;
                if (prey.effectiveDefenseSize >= predator.genome.size * this.predationSizeRatio * this.predatorReach(predator))
                    continue;
                const d = Math.hypot(prey.x - predator.x, prey.y - predator.y);
                if (d < reach + prey.radius * 0.9) {
                    // A deliberately modest fraction — real trophic pyramids only
                    // pass roughly a tenth of prey biomass up a level. Too generous
                    // here and predators can outbreed their own prey base faster
                    // than it can recover, overshoot, and crash the whole dish (prey
                    // hunted to extinction, then predators starve with nothing
                    // left) instead of settling into an oscillating equilibrium.
                    const mitigation = deriveStructureMitigation(prey.genome);
                    const bite = prey.energy * 0.35 * clamp(predator.biteYield, 0.4, 1.6) * (1 - mitigation);
                    predator.eat(bite);
                    const corpseEnergy = Math.max(0, prey.energy - bite);
                    if (corpseEnergy > 0.5)
                        this.spawnMeat(prey.x, prey.y, corpseEnergy);
                    prey.alive = false;
                    prey.detachFromColony();
                    break; // one successful strike per predator per tick
                }
            }
        }
    }
    findColonyRoot(cell) {
        let root = cell;
        while (root.attachedTo)
            root = root.attachedTo;
        return root;
    }
    handleReproduction() {
        if (this.cells.length >= this.maxPopulation)
            return;
        const newborns = [];
        const mated = new Set();
        // Same birth-time rule as addSpeciesFromSequence: decided once, off
        // the population size at the moment of birth (existing cells plus
        // whatever's already been born this tick), never re-evaluated later.
        const richModeNow = () => this.cells.length + newborns.length < this.richChemistryPopulationThreshold;
        const lineageCounts = new Map();
        for (const c of this.cells)
            lineageCounts.set(c.lineageId, (lineageCounts.get(c.lineageId) ?? 0) + 1);
        const lineageCap = this.maxPopulation * this.maxLineageShare;
        const roomFor = (lineageId) => (lineageCounts.get(lineageId) ?? 0) < lineageCap;
        const grow = (lineageId) => {
            lineageCounts.set(lineageId, (lineageCounts.get(lineageId) ?? 0) + 1);
        };
        // Sexual pairing: two mating-ready, *genetically compatible* virtunisms
        // produce one crossed-over child once they're within sensing range of
        // each other — always ejected as a free virtunism (sexual reproduction
        // is the "spread to a new lineage" path). The pairing is anisogamous:
        // one of the two funds the offspring at full asexual cost and the other
        // contributes gametes, so a sexual birth consumes two adults' cooldowns
        // to produce the one child an asexual birth produces from one. That is
        // the twofold cost of sex, and it arises from the mechanism rather than
        // from a penalty constant.
        for (const a of this.cells) {
            if (this.cells.length + newborns.length >= this.maxPopulation)
                break;
            if (mated.has(a.id) || !a.canMate() || !roomFor(a.lineageId))
                continue;
            const meetRange = a.genome.senseRadius;
            const candidates = this.virtunismGrid.queryRadius(a.x, a.y, meetRange);
            for (const b of candidates) {
                // Ordered cheapest test first, deliberately. The compatibility test
                // is the most expensive thing in this loop and it sits last, so it
                // only ever runs on a pair that has already cleared readiness,
                // range and field of view — a few per tick rather than
                // O(cells x candidates).
                if (b === a || mated.has(b.id) || !b.canMate())
                    continue;
                const dx = b.x - a.x;
                const dy = b.y - a.y;
                const range = Math.max(a.genome.senseRadius, b.genome.senseRadius);
                if (dx * dx + dy * dy >= range * range)
                    continue;
                if (!this.inFOV(a, b.x, b.y) && !this.inFOV(b, a.x, a.y))
                    continue;
                if (genomeDistance(a.genome, b.genome) > this.mateCompatibilityThreshold)
                    continue;
                // Captured before checkSpeciation runs below, and used for both the
                // child's lineage and the population cap. `roomFor` above was tested
                // against this same pre-speciation id, so growing a *different*
                // (post-speciation) counter would leave the two permanently
                // disagreeing about how full a lineage is.
                // Role assignment. Both partners have already cleared the one
                // shared reproduction bar (canMate), so both could have funded a
                // child; the coin decides which actually does. That is what makes
                // a mating consume two would-be parents to produce the single
                // offspring one of them would have produced alone.
                //
                // Neither "whoever is `a`" nor "whoever has more energy" would do.
                // `this.cells` is birth-ordered and the spatial grid preserves
                // insertion order, so the outer-loop individual is systematically
                // the *oldest* eligible one in the dish: making it pay would tax age
                // rather than sex. Picking by energy instead ties the investment to
                // whoever is currently fittest, which is defensible biology
                // (condition-dependent sex allocation) but confounds the mutation-
                // rate sweep by correlating the cost with fitness. A coin between
                // qualified candidates keeps the cost of sex measuring the cost of
                // sex. A heritable mating type is the principled long-term answer
                // and is a much larger change — it needs a sixth core locus, which
                // shifts every LOCUS index, changes what every existing gene
                // sequence means, and (since geneticDistance divides its core term
                // by CORE_GENE_COUNT) would invalidate the swept speciationThreshold
                // and force a save-format bump. Separate project; noted in NOTES.md
                // so it isn't quietly re-proposed as a small tweak.
                const eggIsA = this.rng.bool(0.5);
                const egg = eggIsA ? a : b;
                const sperm = eggIsA ? b : a;
                // The child joins the EGG's lineage — maternal inheritance, matching
                // which parent actually provisions it. Using the outer-loop
                // individual's lineage instead would look neutral and would not be:
                // `a` is systematically the oldest eligible cell in the dish (see the
                // role-assignment note above), so the child's species label would
                // track age rather than parentage — the same positional bias the coin
                // exists to avoid.
                //
                // Captured before checkSpeciation runs below, and used for the
                // child's lineage, the tree edge and the population cap alike. The
                // cap has to be tested against the lineage actually about to grow,
                // and `roomFor(a.lineageId)` in the outer loop cannot know yet which
                // of the pair that will be — so it is re-tested here.
                const childLineageId = egg.lineageId;
                if (!roomFor(childLineageId))
                    continue;
                const child = mateVirtunisms(egg, sperm, this.rng, richModeNow(), childLineageId, this.sexualPointMutationMultiplier);
                newborns.push(child);
                // Neither parent already having isDna is what makes this the
                // real transition moment, not just ordinary inheritance — see
                // crossoverGenome's comment on why two RNA parents can still
                // produce a DNA child via recombination.
                const isDnaTransition = child.genome.isDna && !a.genome.isDna && !b.genome.isDna;
                this.recordBirth(child, egg.id, sperm.id, isDnaTransition);
                mated.add(a.id);
                mated.add(b.id);
                grow(childLineageId);
                // After the mating, never before it. Run first (as it was), it
                // reassigned a.lineageId while the old rule required partners to
                // share one — so the instant an individual speciated it became
                // reproductively isolated from the entire population it had just
                // been a member of, and the only same-lineage partner it would ever
                // have was the child it was in the middle of conceiving. Both
                // parents are checked: either may have drifted past threshold, and
                // there is no reason only the outer-loop one should get to found a
                // species.
                this.checkSpeciation(a);
                this.checkSpeciation(b);
                break;
            }
        }
        // Asexual: a virtunism with a bud organelle grows its colony (if
        // there's room); everyone else ejects a free-floating clone.
        for (const cell of this.cells) {
            if (this.cells.length + newborns.length >= this.maxPopulation)
                break;
            if (!cell.canReproduce() || !roomFor(cell.lineageId))
                continue;
            this.checkSpeciation(cell);
            if (hasBud(cell.genome)) {
                const root = this.findColonyRoot(cell);
                if (this.collectColonyMembers(root).length < this.maxColonySize) {
                    const child = cell.budOffspring(this.rng, richModeNow());
                    newborns.push(child);
                    this.recordBirth(child, cell.id, null, child.genome.isDna && !cell.genome.isDna);
                    grow(cell.lineageId);
                    continue;
                }
            }
            {
                const child = cell.reproduce(this.rng, richModeNow());
                newborns.push(child);
                this.recordBirth(child, cell.id, null, child.genome.isDna && !cell.genome.isDna);
                grow(cell.lineageId);
            }
        }
        if (newborns.length)
            this.cells.push(...newborns);
    }
    cleanupDead() {
        const survivors = [];
        for (const cell of this.cells) {
            if (!cell.alive) {
                cell.detachFromColony(); // already corpsed by handlePredation
                this.recordDeath(cell);
                continue;
            }
            if (cell.isDead()) {
                this.spawnMeat(cell.x, cell.y, Math.max(4, cell.genome.size * 8));
                cell.detachFromColony();
                this.recordDeath(cell);
                continue;
            }
            survivors.push(cell);
        }
        this.cells = survivors;
    }
    // --- save/restore --------------------------------------------------------
    // Everything here is plain, JSON-safe data except Maps (flattened to
    // arrays) and each Virtunism (which has its own serialize() — see
    // virtunism.ts for why that one needs a real method instead of just
    // spreading fields). The process-global id counters (Virtunism, Food)
    // are captured too, so a freshly-created individual after a restore can
    // never collide with one that's still alive in the restored population.
    serialize() {
        return {
            width: this.width,
            height: this.height,
            tick: this.tick,
            rngState: this.rng.getState(),
            nextLineageId: this.nextLineageId,
            nextVirtunismId: getNextVirtunismId(),
            nextFoodId: getNextFoodId(),
            cells: this.cells.map((c) => c.serialize()),
            meatFood: this.meatFood,
            lineages: [...this.lineages.values()],
            history: this.history,
            treeNodes: [...this.treeNodes.values()],
        };
    }
    static deserialize(data) {
        const world = new World(data.width, data.height, 0);
        world.rng = Rng.fromState(data.rngState);
        world.tick = data.tick;
        world.nextLineageId = data.nextLineageId;
        setNextVirtunismId(data.nextVirtunismId);
        setNextFoodId(data.nextFoodId);
        world.cells = deserializeVirtunisms(data.cells);
        world.meatFood = data.meatFood;
        world.lineages = new Map(data.lineages.map((l) => [l.id, l]));
        world.history = data.history;
        for (const node of data.treeNodes)
            world.treeNodes.set(node.id, node);
        return world;
    }
}
