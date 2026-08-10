import { Virtunism, mateVirtunisms } from './virtunism.js';
import { createFood } from './food.js';
import { buildOrganelles, deriveArmorMitigation, deriveFlagellaPower, deriveMaxSpeed, deriveMouthPower, hasBud, } from './genome.js';
import { NeuralNet } from './nn.js';
import { Rng } from './rng.js';
import { BRAIN_TOPOLOGY } from './types.js';
import { SpatialGrid } from './grid.js';
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
        this.tick = 0;
        // --- tunables -----------------------------------------------------
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
        this.predationSizeRatio = 0.88; // prey must be <= predator.size * this
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
    static createDefault(width, height, seed) {
        const world = new World(width, height, seed);
        world.seedBaseSpecies();
        return world;
    }
    seedBaseSpecies() {
        // Pure photosynthesizers — no mouth at all, so sunlight (via their
        // chloroplasts) is their *only* possible energy source. Bud-capable
        // so colonies form on their own without you having to design one
        // first. These are the base of the food chain: the only other way
        // energy enters the dish is by eating one of these (or their carrion).
        this.addSpecies({
            reproductionMode: 'asexual',
            size: 0.9,
            senseRadius: 150,
            maxAge: 1000,
            hue: 125,
            loadout: { flagella: 2, chloroplasts: 3, eyes: 1, bud: true },
        }, 18, { name: 'Wild Grazers', spread: true });
        // Solitary mobile predators — no chloroplasts, so every calorie has to
        // come from hunting live prey or scavenging carrion. Deliberately
        // light starting loadout (no armor yet, one eye) — every organelle is
        // upkeep the founding generation's still-random brains have to earn
        // back purely by catching things, so a leaner body buys more
        // generations to actually evolve a decent chase before starving out.
        this.addSpecies({
            reproductionMode: 'asexual',
            size: 1.55,
            senseRadius: 190,
            maxAge: 900,
            hue: 4,
            loadout: { flagella: 3, mouths: 1, eyes: 1 },
        }, 22, { name: 'Wild Hunters', spread: true });
    }
    /** Releases a new population built from a fixed body template (as
     * designed in the editor) with independently-randomized brains and a
     * little starting variation on each individual's organelle layout.
     * Returns the new lineage id. */
    addSpecies(template, count, opts = {}) {
        const lineageId = this.nextLineageId++;
        this.lineages.set(lineageId, {
            id: lineageId,
            name: opts.name ?? `Species ${lineageId}`,
            hue: template.hue,
            isPlayerDesigned: !!opts.isPlayerDesigned,
            createdTick: this.tick,
        });
        const baseOrganelles = buildOrganelles(template.loadout);
        const clusterX = this.rng.range(this.width * 0.2, this.width * 0.8);
        const clusterY = this.rng.range(this.height * 0.2, this.height * 0.8);
        const jitterPct = (value, pct) => Math.max(0.01, value * (1 + this.rng.gaussian(0, pct)));
        for (let i = 0; i < count; i++) {
            if (this.cells.length >= this.maxPopulation)
                break;
            const genome = {
                reproductionMode: template.reproductionMode,
                size: jitterPct(template.size, 0.03),
                senseRadius: jitterPct(template.senseRadius, 0.03),
                maxAge: jitterPct(template.maxAge, 0.08),
                hue: template.hue,
                organelles: baseOrganelles.map((o) => ({
                    kind: o.kind,
                    angle: o.angle + this.rng.gaussian(0, 0.08),
                    size: clamp(o.size + this.rng.gaussian(0, 0.04), 0.5, 1.5),
                })),
                brain: NeuralNet.random(BRAIN_TOPOLOGY, this.rng),
            };
            const x = opts.spread
                ? this.rng.range(20, this.width - 20)
                : clamp(clusterX + this.rng.gaussian(0, 90), 20, this.width - 20);
            const y = opts.spread
                ? this.rng.range(20, this.height - 20)
                : clamp(clusterY + this.rng.gaussian(0, 90), 20, this.height - 20);
            // Deliberately well below both reproduceThreshold (0.42 * maxEnergy)
            // and the lower sexual matingThreshold (0.3 * maxEnergy) so a freshly
            // released population always has to forage first.
            const startEnergy = 12 * template.size;
            this.cells.push(new Virtunism(genome, x, y, lineageId, 0, startEnergy, this.rng, !!opts.isPlayerDesigned));
        }
        return lineageId;
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
        for (const cell of this.cells) {
            if (cell.alive)
                cell.metabolize(dt);
        }
        this.applyPhotosynthesis(dt);
        // Rebuild with post-movement positions for contact-driven systems.
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
        let sumFlagella = 0;
        let sumMouths = 0;
        let sumChloroplasts = 0;
        let sumEyes = 0;
        let sumArmor = 0;
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
            for (const o of c.genome.organelles) {
                if (o.kind === 'flagellum')
                    sumFlagella += o.size;
                else if (o.kind === 'mouth')
                    sumMouths += o.size;
                else if (o.kind === 'chloroplast')
                    sumChloroplasts += o.size;
                else if (o.kind === 'eye')
                    sumEyes += 1;
                else if (o.kind === 'armor')
                    sumArmor += o.size;
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
            avgFlagella: sumFlagella / n,
            avgMouths: sumMouths / n,
            avgChloroplasts: sumChloroplasts / n,
            avgEyes: sumEyes / n,
            avgArmor: sumArmor / n,
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
     * narrow always-on "chemoreception" cone plus the union of whatever eye
     * organelles it's grown, each mounted at its own angle relative to its
     * heading with a width set by that eye's size. */
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
        for (const eye of cell.genome.organelles) {
            if (eye.kind !== 'eye')
                continue;
            const halfWidth = (((50 + eye.size * 40) * Math.PI) / 180) * 0.5;
            if (within(eye.angle, halfWidth))
                return true;
        }
        return false;
    }
    /** How far a predator's mouth investment stretches its max-prey-size
     * threshold — a bigger mouth can tackle relatively bigger prey. */
    predatorReach(predator) {
        return clamp(0.7 + deriveMouthPower(predator.genome) * 0.15, 0.7, 1.4);
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
            if (wantsMate &&
                other.lineageId === cell.lineageId &&
                other.genome.reproductionMode === 'sexual' &&
                other.canMate() &&
                d < bestMateD &&
                this.inFOV(cell, other.x, other.y)) {
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
            const power = deriveFlagellaPower(m.genome);
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
        // Cascade positions from root down through the bond tree.
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
            const transfer = (parent.energy - cell.energy) * rate * dt;
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
            const reach = cell.radius + (deriveMouthPower(cell.genome) - 1) * 4;
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
            const reach = predator.radius + 6 + (deriveMouthPower(predator.genome) - 1) * 4;
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
                    const mitigation = deriveArmorMitigation(prey.genome);
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
        const lineageCounts = new Map();
        for (const c of this.cells)
            lineageCounts.set(c.lineageId, (lineageCounts.get(c.lineageId) ?? 0) + 1);
        const lineageCap = this.maxPopulation * this.maxLineageShare;
        const roomFor = (lineageId) => (lineageCounts.get(lineageId) ?? 0) < lineageCap;
        const grow = (lineageId) => {
            lineageCounts.set(lineageId, (lineageCounts.get(lineageId) ?? 0) + 1);
        };
        // Sexual pairing: two same-lineage, mating-ready virtunisms produce one
        // crossed-over child once they're within sensing range of each other —
        // always ejected as a free virtunism (sexual reproduction is the
        // "spread to a new lineage" path).
        for (const a of this.cells) {
            if (this.cells.length + newborns.length >= this.maxPopulation)
                break;
            if (mated.has(a.id) || !a.canMate() || !roomFor(a.lineageId))
                continue;
            const meetRange = a.genome.senseRadius;
            const candidates = this.virtunismGrid.queryRadius(a.x, a.y, meetRange);
            for (const b of candidates) {
                if (b === a || mated.has(b.id) || !b.canMate())
                    continue;
                if (b.lineageId !== a.lineageId)
                    continue;
                const d = Math.hypot(b.x - a.x, b.y - a.y);
                const range = Math.max(a.genome.senseRadius, b.genome.senseRadius);
                if (d < range && (this.inFOV(a, b.x, b.y) || this.inFOV(b, a.x, a.y))) {
                    newborns.push(mateVirtunisms(a, b, this.rng));
                    mated.add(a.id);
                    mated.add(b.id);
                    grow(a.lineageId);
                    break;
                }
            }
        }
        // Asexual: a virtunism with a bud organelle grows its colony (if
        // there's room); everyone else ejects a free-floating clone.
        for (const cell of this.cells) {
            if (this.cells.length + newborns.length >= this.maxPopulation)
                break;
            if (!cell.canReproduce() || !roomFor(cell.lineageId))
                continue;
            if (hasBud(cell.genome)) {
                const root = this.findColonyRoot(cell);
                if (this.collectColonyMembers(root).length < this.maxColonySize) {
                    newborns.push(cell.budOffspring(this.rng));
                    grow(cell.lineageId);
                    continue;
                }
            }
            newborns.push(cell.reproduce(this.rng));
            grow(cell.lineageId);
        }
        if (newborns.length)
            this.cells.push(...newborns);
    }
    cleanupDead() {
        const survivors = [];
        for (const cell of this.cells) {
            if (!cell.alive) {
                cell.detachFromColony(); // already corpsed by handlePredation
                continue;
            }
            if (cell.isDead()) {
                this.spawnMeat(cell.x, cell.y, Math.max(4, cell.genome.size * 8));
                cell.detachFromColony();
                continue;
            }
            survivors.push(cell);
        }
        this.cells = survivors;
    }
}
