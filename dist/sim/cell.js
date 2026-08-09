import { crossoverGenome, mutateGenome } from './genome.js';
let nextCellId = 1;
function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
}
/**
 * A single organism. Cell only knows how to move itself, burn energy, and
 * reproduce — it has no idea what's around it. World does the sensing
 * (spatial queries) and hands Cell a finished input vector so this class
 * stays a plain, testable state machine.
 */
export class Cell {
    constructor(genome, x, y, lineageId, generation, energy, isPlayerDesigned = false) {
        this.speed = 0; // current scalar speed, 0..genome.maxSpeed
        this.age = 0; // ticks
        this.reproCooldown = 0;
        this.alive = true;
        this.id = nextCellId++;
        this.genome = genome;
        this.x = x;
        this.y = y;
        this.heading = Math.random() * Math.PI * 2;
        this.energy = energy;
        this.lineageId = lineageId;
        this.generation = generation;
        this.isPlayerDesigned = isPlayerDesigned;
    }
    get radius() {
        return 5 + this.genome.size * 5;
    }
    get maxEnergy() {
        return 60 * this.genome.size;
    }
    get reproduceThreshold() {
        return this.maxEnergy * 0.42;
    }
    /** Sexual mode gets a lower bar than asexual's reproduceThreshold — a
     * mating event already costs two ready individuals instead of one, so
     * making each of them individually harder to ready up on top of that
     * would make sexual reproduction strictly worse than asexual rather than
     * a genuine alternative with its own trade-offs. */
    get matingThreshold() {
        return this.maxEnergy * 0.3;
    }
    /** Runs the brain forward pass on a pre-built sensor vector. */
    think(inputs) {
        return this.genome.brain.forward(inputs);
    }
    /** Applies brain outputs [turn, thrust] to move the cell for one tick. */
    act(outputs, dt, worldWidth, worldHeight) {
        const turnOut = clamp(outputs[0] ?? 0, -1, 1);
        const thrustOut = clamp(outputs[1] ?? 0, 0, 1);
        const maxTurnRate = 0.2; // radians per tick
        this.heading += turnOut * maxTurnRate * dt;
        this.speed = thrustOut * this.genome.maxSpeed;
        this.x += Math.cos(this.heading) * this.speed * dt;
        this.y += Math.sin(this.heading) * this.speed * dt;
        // Bounce off the dish walls rather than clipping through them.
        const r = this.radius;
        if (this.x < r) {
            this.x = r;
            this.heading = Math.PI - this.heading;
        }
        else if (this.x > worldWidth - r) {
            this.x = worldWidth - r;
            this.heading = Math.PI - this.heading;
        }
        if (this.y < r) {
            this.y = r;
            this.heading = -this.heading;
        }
        else if (this.y > worldHeight - r) {
            this.y = worldHeight - r;
            this.heading = -this.heading;
        }
    }
    /** Burns upkeep + movement energy and ages the cell by one tick. */
    metabolize(dt) {
        const size = this.genome.size;
        // Tuned so a completely naive (random-brain) cell can survive to roughly
        // its max age on passive upkeep alone — evolution needs enough runway to
        // improve foraging before generation zero simply runs out the clock.
        // Wider eyes (visionAngle) and a bigger mouth are genuine upkeep costs,
        // not free stat boosts — that's what gives evolution a reason to trade
        // them off against each other instead of just maxing everything out.
        const visionCost = 0.0007 * (this.genome.visionAngle / 360);
        const mouthCost = 0.003 * this.genome.mouthSize * this.genome.mouthSize;
        const upkeep = (0.002 + 0.005 * size * size + 0.0008 * (this.genome.senseRadius / 100) + visionCost + mouthCost) * dt;
        const moveCost = 0.005 * this.speed * size * dt;
        this.energy -= upkeep + moveCost;
        this.age += dt;
        if (this.reproCooldown > 0)
            this.reproCooldown = Math.max(0, this.reproCooldown - dt);
    }
    eat(energy) {
        this.energy = Math.min(this.maxEnergy, this.energy + energy);
    }
    canReproduce() {
        return (this.alive &&
            this.genome.reproductionMode === 'asexual' &&
            this.reproCooldown <= 0 &&
            this.energy >= this.reproduceThreshold);
    }
    /** Ready to mate: same energy/cooldown bar as asexual reproduction, but
     * gated to sexual-mode cells — actually pairing up is World's job. */
    canMate() {
        return (this.alive &&
            this.genome.reproductionMode === 'sexual' &&
            this.reproCooldown <= 0 &&
            this.energy >= this.matingThreshold);
    }
    /** Splits off a mutated child, paying an energy cost from the parent. */
    reproduce(rng) {
        const childGenome = mutateGenome(this.genome, rng);
        const childEnergy = this.energy * 0.5;
        this.energy *= 0.5;
        this.reproCooldown = 50;
        const angle = rng.range(0, Math.PI * 2);
        const dist = this.radius * 2.2;
        return new Cell(childGenome, this.x + Math.cos(angle) * dist, this.y + Math.sin(angle) * dist, this.lineageId, this.generation + 1, childEnergy, this.isPlayerDesigned);
    }
    isDead() {
        return this.energy <= 0 || this.age >= this.genome.maxAge;
    }
}
/**
 * Sexual reproduction: crosses over both parents' genomes (traits and brain
 * weights each independently drawn from one parent or the other), mutates
 * the result, and splits the energy cost between both parents. Requires the
 * two cells to already be touching — World is responsible for finding
 * eligible, nearby pairs.
 */
export function mateCells(a, b, rng) {
    const childGenome = mutateGenome(crossoverGenome(a.genome, b.genome, rng), rng);
    // Each parent pays a quarter of its own energy — together that's half an
    // "average parent", the same total investment as an asexual split, just
    // shared two ways instead of paid solo.
    const shareA = a.energy * 0.25;
    const shareB = b.energy * 0.25;
    a.energy -= shareA;
    b.energy -= shareB;
    // Same order as the asexual cooldown — finding a mate at all is already
    // its own tax on throughput, no need to tax it twice.
    a.reproCooldown = 55;
    b.reproCooldown = 55;
    const angle = rng.range(0, Math.PI * 2);
    const dist = (a.radius + b.radius) * 0.6;
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    return new Cell(childGenome, midX + Math.cos(angle) * dist, midY + Math.sin(angle) * dist, a.lineageId, Math.max(a.generation, b.generation) + 1, shareA + shareB, a.isPlayerDesigned || b.isPlayerDesigned);
}
