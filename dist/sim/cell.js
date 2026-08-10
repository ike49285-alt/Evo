import { crossoverGenome, deriveArmorBonus, deriveMaxSpeed, deriveMouthCount, deriveMouthPower, deriveTurnRate, derivePhotosynthesis, mutateGenome, } from './genome.js';
let nextCellId = 1;
function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
}
/**
 * A single organism. Cell only knows how to move itself, burn energy, and
 * reproduce — it has no idea what's around it. World does the sensing
 * (spatial queries) and hands Cell a finished input vector so this class
 * stays a plain, testable state machine.
 *
 * Cells can also be *bonded*: attachedTo/attachedChildren form a tree of
 * cells that move as a single colony (see World's colony-movement pass).
 * localAngle/localDist are the fixed joint to this cell's immediate parent
 * in that tree — irrelevant for a cell with no attachedTo.
 */
export class Cell {
    constructor(genome, x, y, lineageId, generation, energy, isPlayerDesigned = false) {
        this.speed = 0; // current scalar speed, 0..deriveMaxSpeed(genome)
        this.age = 0; // ticks
        this.reproCooldown = 0;
        this.alive = true;
        // bond-tree state (multicellularity)
        this.attachedTo = null;
        this.attachedChildren = [];
        this.localAngle = 0; // relative to attachedTo's heading, fixed at bud time
        this.localDist = 0; // fixed at bud time
        // scratch: this tick's brain output, cached so colony movement can pool
        // every member's vote without re-running the network.
        this.lastOutputs = [0, 0];
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
        return 5 + this.genome.size * 5 + this.genome.organelles.length * 0.55;
    }
    get maxEnergy() {
        return 60 * this.genome.size + this.genome.organelles.length * 3;
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
    get isColonyMember() {
        return this.attachedTo !== null || this.attachedChildren.length > 0;
    }
    /** Runs the brain forward pass on a pre-built sensor vector. */
    think(inputs) {
        const outputs = this.genome.brain.forward(inputs);
        this.lastOutputs = outputs;
        return outputs;
    }
    /** Applies brain outputs [turn, thrust] to move a *solo* (unbonded) cell
     * for one tick. Colony members are moved instead by World's rigid
     * colony-movement pass — see moveColonyRigid(). */
    act(outputs, dt, worldWidth, worldHeight) {
        const turnOut = clamp(outputs[0] ?? 0, -1, 1);
        const thrustOut = clamp(outputs[1] ?? 0, 0, 1);
        const maxTurnRate = deriveTurnRate(this.genome);
        this.heading += turnOut * maxTurnRate * dt;
        this.speed = thrustOut * deriveMaxSpeed(this.genome);
        this.x += Math.cos(this.heading) * this.speed * dt;
        this.y += Math.sin(this.heading) * this.speed * dt;
        this.clampToBounds(worldWidth, worldHeight, true);
    }
    /** Keeps the cell inside the dish. `bounce` reflects heading off the wall
     * (used for solo cells); colony members just get clamped positionally,
     * since their heading is dictated by the colony's joint geometry. */
    clampToBounds(worldWidth, worldHeight, bounce) {
        const r = this.radius;
        if (this.x < r) {
            this.x = r;
            if (bounce)
                this.heading = Math.PI - this.heading;
        }
        else if (this.x > worldWidth - r) {
            this.x = worldWidth - r;
            if (bounce)
                this.heading = Math.PI - this.heading;
        }
        if (this.y < r) {
            this.y = r;
            if (bounce)
                this.heading = -this.heading;
        }
        else if (this.y > worldHeight - r) {
            this.y = worldHeight - r;
            if (bounce)
                this.heading = -this.heading;
        }
    }
    /** Burns upkeep + movement energy, gains photosynthesis income, and ages
     * the cell by one tick. Every organelle has a real running cost — a
     * bigger loadout is never free, it's a bet that what it does is worth
     * what it burns. */
    metabolize(dt) {
        const size = this.genome.size;
        const organelles = this.genome.organelles;
        let flagellaPower = 0;
        let mouthPower = 0;
        let chloroplastPower = 0;
        let eyeCount = 0;
        let armorPower = 0;
        for (const o of organelles) {
            if (o.kind === 'flagellum')
                flagellaPower += o.size;
            else if (o.kind === 'mouth')
                mouthPower += o.size;
            else if (o.kind === 'chloroplast')
                chloroplastPower += o.size;
            else if (o.kind === 'eye')
                eyeCount += 1;
            else if (o.kind === 'armor')
                armorPower += o.size;
        }
        const baseUpkeep = 0.002 + 0.005 * size * size + 0.0008 * (this.genome.senseRadius / 100);
        const organelleUpkeep = 0.0035 * flagellaPower + 0.0025 * mouthPower + 0.0015 * chloroplastPower + 0.0006 * eyeCount + 0.002 * armorPower;
        const moveCost = 0.005 * this.speed * size;
        this.energy -= (baseUpkeep + organelleUpkeep + moveCost) * dt;
        this.energy += derivePhotosynthesis(this.genome) * dt;
        this.age += dt;
        if (this.reproCooldown > 0)
            this.reproCooldown = Math.max(0, this.reproCooldown - dt);
    }
    eat(energy) {
        this.energy = Math.min(this.maxEnergy, this.energy + energy);
    }
    /** How much energy a bite yields, scaled by total mouth investment. */
    get biteYield() {
        return 0.4 + deriveMouthPower(this.genome) * 0.5;
    }
    get canEat() {
        return deriveMouthCount(this.genome) > 0;
    }
    /** Effective size for predation purposes — armor counts without costing
     * full chassis growth. */
    get effectiveDefenseSize() {
        return this.genome.size * deriveArmorBonus(this.genome);
    }
    canReproduce() {
        return (this.alive &&
            this.genome.reproductionMode === 'asexual' &&
            this.reproCooldown <= 0 &&
            this.energy >= this.reproduceThreshold);
    }
    canMate() {
        return (this.alive &&
            this.genome.reproductionMode === 'sexual' &&
            this.reproCooldown <= 0 &&
            this.energy >= this.matingThreshold);
    }
    /** Splits off a mutated, energy-costed child genome — shared by both the
     * "eject a free cell" and "bud an attached cell" reproduction paths. */
    spawnChildGenome(rng) {
        const genome = mutateGenome(this.genome, rng);
        const childEnergy = this.energy * 0.5;
        this.energy *= 0.5;
        this.reproCooldown = 50;
        return { genome, energy: childEnergy };
    }
    /** Asexual reproduction that ejects a fully independent, free-floating
     * child nearby. */
    reproduce(rng) {
        const { genome, energy } = this.spawnChildGenome(rng);
        const angle = rng.range(0, Math.PI * 2);
        const dist = this.radius * 2.2;
        return new Cell(genome, this.x + Math.cos(angle) * dist, this.y + Math.sin(angle) * dist, this.lineageId, this.generation + 1, energy, this.isPlayerDesigned);
    }
    /** Asexual reproduction that instead buds a child permanently attached to
     * this cell — how colonies grow. Requires this cell to carry a bud
     * organelle (checked by the caller). */
    budOffspring(rng) {
        const { genome, energy } = this.spawnChildGenome(rng);
        const siblingCount = this.attachedChildren.length;
        const child = new Cell(genome, this.x, this.y, this.lineageId, this.generation + 1, energy, this.isPlayerDesigned);
        child.attachedTo = this;
        // Spread siblings out around this cell rather than stacking on one spot.
        child.localAngle = (siblingCount / 5) * Math.PI * 2 + rng.range(-0.3, 0.3);
        child.localDist = this.radius + child.radius + 1;
        this.attachedChildren.push(child);
        return child;
    }
    isDead() {
        return this.energy <= 0 || this.age >= this.genome.maxAge;
    }
    /** Removes this cell from its bond tree (on death or predation). Any
     * children become independent colony roots rather than vanishing with
     * their parent — a predator eating one member doesn't wipe the colony. */
    detachFromColony() {
        if (this.attachedTo) {
            this.attachedTo.attachedChildren = this.attachedTo.attachedChildren.filter((c) => c !== this);
        }
        for (const child of this.attachedChildren) {
            child.attachedTo = null;
        }
        this.attachedTo = null;
        this.attachedChildren = [];
    }
}
/**
 * Sexual reproduction: crosses over both parents' genomes (traits, brain
 * weights, and organelles each independently drawn from one parent or the
 * other), mutates the result, and splits the energy cost between both
 * parents. Always produces a free-floating cell — sexual reproduction is
 * the "spread genes to a new lineage" path; budding (asexual + bud
 * organelle) is the "grow this colony" path. Requires the two cells to
 * already be within sensing range of each other.
 */
export function mateCells(a, b, rng) {
    const childGenome = mutateGenome(crossoverGenome(a.genome, b.genome, rng), rng);
    const shareA = a.energy * 0.25;
    const shareB = b.energy * 0.25;
    a.energy -= shareA;
    b.energy -= shareB;
    a.reproCooldown = 55;
    b.reproCooldown = 55;
    const angle = rng.range(0, Math.PI * 2);
    const dist = (a.radius + b.radius) * 0.6;
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    return new Cell(childGenome, midX + Math.cos(angle) * dist, midY + Math.sin(angle) * dist, a.lineageId, Math.max(a.generation, b.generation) + 1, shareA + shareB, a.isPlayerDesigned || b.isPlayerDesigned);
}
