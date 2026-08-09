import { Cell } from './cell.js';
import { createFood } from './food.js';
import { NeuralNet } from './nn.js';
import { Rng } from './rng.js';
import { BRAIN_TOPOLOGY } from './types.js';
function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
}
export class World {
    constructor(width, height, seed) {
        this.cells = [];
        this.plantFood = [];
        this.meatFood = [];
        this.lineages = new Map();
        this.history = [];
        this.tick = 0;
        // --- tunables -----------------------------------------------------
        this.maxPopulation = 320;
        this.maxPlantFood = 700;
        this.plantSpawnRate = 2.5; // pellets per tick
        this.plantEnergy = 18;
        this.predationSizeRatio = 0.88; // prey must be <= predator.size * this
        this.statsSampleInterval = 10;
        this.maxHistory = 400;
        this.nextLineageId = 1;
        this.plantSpawnAccumulator = 0;
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
        this.addSpecies({ diet: 'herbivore', size: 1.0, maxSpeed: 1.4, senseRadius: 150, maxAge: 1000, hue: 125 }, 24, { name: 'Wild Grazers', spread: true });
        this.addSpecies({ diet: 'carnivore', size: 1.35, maxSpeed: 1.8, senseRadius: 190, maxAge: 900, hue: 4 }, 10, { name: 'Wild Hunters', spread: true });
        // seed the dish with an initial spread of plant food so grazers don't starve immediately
        for (let i = 0; i < this.maxPlantFood * 0.6; i++) {
            this.plantFood.push(createFood('plant', this.rng.range(20, this.width - 20), this.rng.range(20, this.height - 20), this.plantEnergy));
        }
    }
    /** Releases a new population built from a fixed body template (as designed
     * in the editor) with independently-randomized brains. Returns the new
     * lineage id. */
    addSpecies(template, count, opts = {}) {
        const lineageId = this.nextLineageId++;
        this.lineages.set(lineageId, {
            id: lineageId,
            name: opts.name ?? `Species ${lineageId}`,
            diet: template.diet,
            hue: template.hue,
            isPlayerDesigned: !!opts.isPlayerDesigned,
            createdTick: this.tick,
        });
        const clusterX = this.rng.range(this.width * 0.2, this.width * 0.8);
        const clusterY = this.rng.range(this.height * 0.2, this.height * 0.8);
        for (let i = 0; i < count; i++) {
            if (this.cells.length >= this.maxPopulation)
                break;
            const genome = {
                diet: template.diet,
                size: template.size,
                maxSpeed: template.maxSpeed,
                senseRadius: template.senseRadius,
                maxAge: template.maxAge,
                hue: template.hue,
                brain: NeuralNet.random(BRAIN_TOPOLOGY, this.rng),
            };
            const x = opts.spread
                ? this.rng.range(20, this.width - 20)
                : clamp(clusterX + this.rng.gaussian(0, 90), 20, this.width - 20);
            const y = opts.spread
                ? this.rng.range(20, this.height - 20)
                : clamp(clusterY + this.rng.gaussian(0, 90), 20, this.height - 20);
            // Deliberately well below reproduceThreshold (0.42 * maxEnergy) so a
            // freshly released population has to forage before it can reproduce,
            // instead of instantly doubling on tick one.
            const startEnergy = 18 * template.size;
            this.cells.push(new Cell(genome, x, y, lineageId, 0, startEnergy, !!opts.isPlayerDesigned));
        }
        return lineageId;
    }
    addFoodBurst(count) {
        for (let i = 0; i < count && this.plantFood.length < this.maxPlantFood; i++) {
            this.plantFood.push(createFood('plant', this.rng.range(20, this.width - 20), this.rng.range(20, this.height - 20), this.plantEnergy));
        }
    }
    /** Advances the simulation by one fixed tick. */
    update(dt) {
        this.spawnFood(dt);
        for (const cell of this.cells) {
            if (!cell.alive)
                continue;
            const inputs = this.buildInputs(cell);
            const outputs = cell.think(inputs);
            cell.act(outputs, dt, this.width, this.height);
            cell.metabolize(dt);
        }
        this.handleEating();
        this.handlePredation();
        this.handleReproduction();
        this.cleanupDead();
        this.tick += dt;
        if (Math.floor(this.tick) % this.statsSampleInterval === 0) {
            this.pushStatsSnapshot();
        }
    }
    getLiveStats() {
        let herbivores = 0;
        let carnivores = 0;
        let omnivores = 0;
        let sumSize = 0;
        let sumSpeed = 0;
        let sumSense = 0;
        let sumAge = 0;
        let maxGeneration = 0;
        for (const c of this.cells) {
            if (c.genome.diet === 'herbivore')
                herbivores++;
            else if (c.genome.diet === 'carnivore')
                carnivores++;
            else
                omnivores++;
            sumSize += c.genome.size;
            sumSpeed += c.genome.maxSpeed;
            sumSense += c.genome.senseRadius;
            sumAge += c.age;
            if (c.generation > maxGeneration)
                maxGeneration = c.generation;
        }
        const n = this.cells.length || 1;
        return {
            tick: Math.floor(this.tick),
            population: this.cells.length,
            herbivores,
            carnivores,
            omnivores,
            avgSize: sumSize / n,
            avgSpeed: sumSpeed / n,
            avgSense: sumSense / n,
            avgAge: sumAge / n,
            maxGeneration,
            plantFood: this.plantFood.length,
            meatFood: this.meatFood.length,
        };
    }
    pushStatsSnapshot() {
        this.history.push(this.getLiveStats());
        if (this.history.length > this.maxHistory)
            this.history.shift();
    }
    spawnFood(dt) {
        this.plantSpawnAccumulator += this.plantSpawnRate * dt;
        while (this.plantSpawnAccumulator >= 1 && this.plantFood.length < this.maxPlantFood) {
            this.plantSpawnAccumulator -= 1;
            this.plantFood.push(createFood('plant', this.rng.range(20, this.width - 20), this.rng.range(20, this.height - 20), this.plantEnergy));
        }
    }
    /** Builds the fixed 11-value sensor vector consumed by Cell/NeuralNet. */
    buildInputs(cell) {
        const sr = cell.genome.senseRadius;
        const wantsPlant = cell.genome.diet !== 'carnivore';
        const wantsMeat = cell.genome.diet !== 'herbivore';
        let foodDx = 0;
        let foodDy = 0;
        let foodDist = 1;
        let bestFoodD = sr;
        if (wantsPlant) {
            for (const f of this.plantFood) {
                const dx = f.x - cell.x;
                const dy = f.y - cell.y;
                const d = Math.hypot(dx, dy);
                if (d < bestFoodD) {
                    bestFoodD = d;
                    foodDx = dx / sr;
                    foodDy = dy / sr;
                    foodDist = d / sr;
                }
            }
        }
        if (wantsMeat) {
            for (const f of this.meatFood) {
                const dx = f.x - cell.x;
                const dy = f.y - cell.y;
                const d = Math.hypot(dx, dy);
                if (d < bestFoodD) {
                    bestFoodD = d;
                    foodDx = dx / sr;
                    foodDy = dy / sr;
                    foodDist = d / sr;
                }
            }
            for (const other of this.cells) {
                if (other === cell || !other.alive)
                    continue;
                if (other.genome.size >= cell.genome.size * this.predationSizeRatio)
                    continue;
                const dx = other.x - cell.x;
                const dy = other.y - cell.y;
                const d = Math.hypot(dx, dy);
                if (d < bestFoodD) {
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
        for (const other of this.cells) {
            if (other === cell || !other.alive)
                continue;
            if (other.genome.diet === 'herbivore')
                continue;
            if (cell.genome.size >= other.genome.size * this.predationSizeRatio)
                continue;
            const dx = other.x - cell.x;
            const dy = other.y - cell.y;
            const d = Math.hypot(dx, dy);
            if (d < bestThreatD) {
                bestThreatD = d;
                threatDx = dx / sr;
                threatDy = dy / sr;
                threatDist = d / sr;
            }
        }
        const energyNorm = clamp(cell.energy / cell.maxEnergy, 0, 1);
        const speedNorm = cell.genome.maxSpeed > 0 ? cell.speed / cell.genome.maxSpeed : 0;
        const marginX = Math.min(cell.x, this.width - cell.x);
        const marginY = Math.min(cell.y, this.height - cell.y);
        const wallSignX = cell.x < this.width / 2 ? 1 : -1;
        const wallSignY = cell.y < this.height / 2 ? 1 : -1;
        const wallUrgencyX = clamp(1 - marginX / sr, 0, 1) * wallSignX;
        const wallUrgencyY = clamp(1 - marginY / sr, 0, 1) * wallSignY;
        // A per-individual oscillator ("run and tumble" drive). Without it, a
        // cell with nothing nearby sees an almost constant input vector, so a
        // random brain settles into a fixed turn output and just orbits in a
        // tiny circle forever — it can never stumble onto food. This gives
        // every genome, however naive, some baseline ability to wander and
        // explore, which is what natural selection needs to have something to
        // act on in the first place.
        const wander = Math.sin(cell.age * 0.05 + cell.id * 0.7321);
        return [
            foodDx,
            foodDy,
            foodDist,
            threatDx,
            threatDy,
            threatDist,
            energyNorm,
            speedNorm,
            wallUrgencyX,
            wallUrgencyY,
            wander,
            1, // bias
        ];
    }
    handleEating() {
        for (const cell of this.cells) {
            if (!cell.alive)
                continue;
            const rr = cell.radius;
            if (cell.genome.diet !== 'carnivore') {
                for (let i = this.plantFood.length - 1; i >= 0; i--) {
                    const f = this.plantFood[i];
                    const d = Math.hypot(f.x - cell.x, f.y - cell.y);
                    if (d < rr + f.radius) {
                        cell.eat(f.energy);
                        this.plantFood.splice(i, 1);
                    }
                }
            }
            if (cell.genome.diet !== 'herbivore') {
                for (let i = this.meatFood.length - 1; i >= 0; i--) {
                    const f = this.meatFood[i];
                    const d = Math.hypot(f.x - cell.x, f.y - cell.y);
                    if (d < rr + f.radius) {
                        cell.eat(f.energy);
                        this.meatFood.splice(i, 1);
                    }
                }
            }
        }
    }
    handlePredation() {
        for (const predator of this.cells) {
            if (!predator.alive || predator.genome.diet === 'herbivore')
                continue;
            for (const prey of this.cells) {
                if (prey === predator || !prey.alive)
                    continue;
                if (prey.genome.size >= predator.genome.size * this.predationSizeRatio)
                    continue;
                const d = Math.hypot(prey.x - predator.x, prey.y - predator.y);
                if (d < predator.radius + prey.radius * 0.6) {
                    const bite = prey.energy * 0.6;
                    predator.eat(bite);
                    const corpseEnergy = prey.energy * 0.4;
                    if (corpseEnergy > 0.5)
                        this.meatFood.push(createFood('meat', prey.x, prey.y, corpseEnergy));
                    prey.alive = false;
                    break; // one successful strike per predator per tick
                }
            }
        }
    }
    handleReproduction() {
        if (this.cells.length >= this.maxPopulation)
            return;
        const newborns = [];
        for (const cell of this.cells) {
            if (this.cells.length + newborns.length >= this.maxPopulation)
                break;
            if (cell.canReproduce())
                newborns.push(cell.reproduce(this.rng));
        }
        if (newborns.length)
            this.cells.push(...newborns);
    }
    cleanupDead() {
        const survivors = [];
        for (const cell of this.cells) {
            if (!cell.alive)
                continue; // already corpsed by handlePredation
            if (cell.isDead()) {
                this.meatFood.push(createFood('meat', cell.x, cell.y, Math.max(4, cell.genome.size * 8)));
                continue;
            }
            survivors.push(cell);
        }
        this.cells = survivors;
    }
}
