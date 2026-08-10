import { Cell, mateCells } from './cell.js';
import { createFood, Food } from './food.js';
import {
  buildOrganelles,
  deriveArmorMitigation,
  deriveFlagellaPower,
  deriveMaxSpeed,
  deriveMouthPower,
  Genome,
  hasBud,
  StarterLoadout,
} from './genome.js';
import { NeuralNet } from './nn.js';
import { Rng } from './rng.js';
import { BRAIN_TOPOLOGY, ReproductionMode } from './types.js';

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export interface SpeciesTemplate {
  reproductionMode: ReproductionMode;
  size: number;
  senseRadius: number;
  maxAge: number;
  hue: number;
  loadout: StarterLoadout;
}

export interface LineageInfo {
  id: number;
  name: string;
  hue: number;
  isPlayerDesigned: boolean;
  createdTick: number;
}

export interface StatsSnapshot {
  tick: number;
  population: number;
  sexual: number;
  asexual: number;
  colonies: number;
  soloCells: number;
  avgColonySize: number;
  avgSize: number;
  avgSpeed: number;
  avgSense: number;
  avgFlagella: number;
  avgMouths: number;
  avgChloroplasts: number;
  avgEyes: number;
  avgArmor: number;
  avgAge: number;
  maxGeneration: number;
  plantFood: number;
  meatFood: number;
}

export class World {
  readonly width: number;
  readonly height: number;
  readonly rng: Rng;

  cells: Cell[] = [];
  plantFood: Food[] = [];
  meatFood: Food[] = [];
  lineages = new Map<number, LineageInfo>();
  history: StatsSnapshot[] = [];

  tick = 0;

  // --- tunables -----------------------------------------------------
  readonly maxPopulation = 320;
  readonly maxColonySize = 14;
  readonly maxPlantFood = 900;
  readonly plantSpawnRate = 3.2; // pellets per tick
  readonly plantEnergy = 18;
  readonly predationSizeRatio = 0.88; // prey must be <= predator.size * this
  readonly statsSampleInterval = 10;
  readonly maxHistory = 400;

  private nextLineageId = 1;
  private plantSpawnAccumulator = 0;

  constructor(width: number, height: number, seed: number) {
    this.width = width;
    this.height = height;
    this.rng = new Rng(seed);
  }

  static createDefault(width: number, height: number, seed: number): World {
    const world = new World(width, height, seed);
    world.seedBaseSpecies();
    return world;
  }

  seedBaseSpecies(): void {
    // Photosynthetic, colonial grazers — bud-capable so colonies form on
    // their own without you having to design one first.
    this.addSpecies(
      {
        reproductionMode: 'asexual',
        size: 0.9,
        senseRadius: 150,
        maxAge: 1000,
        hue: 125,
        loadout: { flagella: 2, mouths: 1, chloroplasts: 2, eyes: 1, bud: true },
      },
      18,
      { name: 'Wild Grazers', spread: true },
    );
    // Solitary mobile predators — no chloroplasts, no bud, built to chase.
    this.addSpecies(
      {
        reproductionMode: 'asexual',
        size: 1.3,
        senseRadius: 190,
        maxAge: 900,
        hue: 4,
        loadout: { flagella: 3, mouths: 1, eyes: 2, armor: 1 },
      },
      10,
      { name: 'Wild Hunters', spread: true },
    );
    for (let i = 0; i < this.maxPlantFood * 0.6; i++) {
      this.plantFood.push(
        createFood('plant', this.rng.range(20, this.width - 20), this.rng.range(20, this.height - 20), this.plantEnergy),
      );
    }
  }

  /** Releases a new population built from a fixed body template (as
   * designed in the editor) with independently-randomized brains and a
   * little starting variation on each individual's organelle layout.
   * Returns the new lineage id. */
  addSpecies(template: SpeciesTemplate, count: number, opts: { name?: string; isPlayerDesigned?: boolean; spread?: boolean } = {}): number {
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
    const jitterPct = (value: number, pct: number): number => Math.max(0.01, value * (1 + this.rng.gaussian(0, pct)));

    for (let i = 0; i < count; i++) {
      if (this.cells.length >= this.maxPopulation) break;
      const genome: Genome = {
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
      this.cells.push(new Cell(genome, x, y, lineageId, 0, startEnergy, !!opts.isPlayerDesigned));
    }
    return lineageId;
  }

  addFoodBurst(count: number): void {
    for (let i = 0; i < count && this.plantFood.length < this.maxPlantFood; i++) {
      this.plantFood.push(
        createFood('plant', this.rng.range(20, this.width - 20), this.rng.range(20, this.height - 20), this.plantEnergy),
      );
    }
  }

  /** Advances the simulation by one fixed tick. */
  update(dt: number): void {
    this.spawnFood(dt);

    // Sense + think for every living cell (colony members included) before
    // anyone moves, so a colony's rigid-body pass can pool every member's
    // vote from the same instant.
    for (const cell of this.cells) {
      if (!cell.alive) continue;
      const inputs = this.buildInputs(cell);
      cell.think(inputs);
    }

    // Movement: solo cells act individually; colony roots move the whole
    // bonded tree as one rigid body and cascade positions to every member.
    for (const cell of this.cells) {
      if (!cell.alive || cell.attachedTo !== null) continue;
      if (cell.attachedChildren.length > 0) {
        this.moveColonyRigid(cell, dt);
      } else {
        cell.act(cell.lastOutputs, dt, this.width, this.height);
      }
    }

    for (const cell of this.cells) {
      if (cell.alive) cell.metabolize(dt);
    }

    this.handleEating();
    this.handlePredation();
    this.diffuseColonyEnergy(dt);
    this.handleReproduction();
    this.cleanupDead();

    this.tick += dt;
    if (Math.floor(this.tick) % this.statsSampleInterval === 0) {
      this.pushStatsSnapshot();
    }
  }

  getLiveStats(): StatsSnapshot {
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
      if (c.genome.reproductionMode === 'sexual') sexual++;
      else asexual++;
      sumSize += c.genome.size;
      sumSpeed += deriveMaxSpeed(c.genome);
      sumSense += c.genome.senseRadius;
      for (const o of c.genome.organelles) {
        if (o.kind === 'flagellum') sumFlagella += o.size;
        else if (o.kind === 'mouth') sumMouths += o.size;
        else if (o.kind === 'chloroplast') sumChloroplasts += o.size;
        else if (o.kind === 'eye') sumEyes += 1;
        else if (o.kind === 'armor') sumArmor += o.size;
      }
      sumAge += c.age;
      if (c.generation > maxGeneration) maxGeneration = c.generation;
      if (c.attachedTo === null) {
        if (c.attachedChildren.length > 0) {
          colonies++;
          colonyMemberTotal += this.collectColonyMembers(c).length;
        } else {
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
      plantFood: this.plantFood.length,
      meatFood: this.meatFood.length,
    };
  }

  private pushStatsSnapshot(): void {
    this.history.push(this.getLiveStats());
    if (this.history.length > this.maxHistory) this.history.shift();
  }

  private spawnFood(dt: number): void {
    this.plantSpawnAccumulator += this.plantSpawnRate * dt;
    while (this.plantSpawnAccumulator >= 1 && this.plantFood.length < this.maxPlantFood) {
      this.plantSpawnAccumulator -= 1;
      this.plantFood.push(
        createFood('plant', this.rng.range(20, this.width - 20), this.rng.range(20, this.height - 20), this.plantEnergy),
      );
    }
  }

  /** True if world point (tx, ty) falls inside cell's field of view — a
   * narrow always-on "chemoreception" cone plus the union of whatever eye
   * organelles it's grown, each mounted at its own angle relative to the
   * cell's heading with a width set by that eye's size. */
  private inFOV(cell: Cell, tx: number, ty: number): boolean {
    const angleToTarget = Math.atan2(ty - cell.y, tx - cell.x);
    const within = (mountAngle: number, halfWidth: number): boolean => {
      let diff = angleToTarget - (cell.heading + mountAngle);
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      return Math.abs(diff) <= halfWidth;
    };
    const baselineHalf = ((50 * Math.PI) / 180) * 0.5;
    if (within(0, baselineHalf)) return true;
    for (const eye of cell.genome.organelles) {
      if (eye.kind !== 'eye') continue;
      const halfWidth = (((50 + eye.size * 40) * Math.PI) / 180) * 0.5;
      if (within(eye.angle, halfWidth)) return true;
    }
    return false;
  }

  /** How far a predator's mouth investment stretches its max-prey-size
   * threshold — a bigger mouth can tackle relatively bigger prey. */
  private predatorReach(predator: Cell): number {
    return clamp(0.7 + deriveMouthPower(predator.genome) * 0.15, 0.7, 1.4);
  }

  /** Builds the fixed sensor vector consumed by Cell/NeuralNet (see
   * BRAIN_TOPOLOGY.inputs). Any mouthed cell can eat both plant matter and
   * meat/prey — there's no separate diet gate, just what you're physically
   * equipped to catch. */
  private buildInputs(cell: Cell): number[] {
    const sr = cell.genome.senseRadius;
    const canEat = cell.canEat;

    let foodDx = 0;
    let foodDy = 0;
    let foodDist = 1;
    let bestFoodD = sr;

    if (canEat) {
      for (const f of this.plantFood) {
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
      for (const f of this.meatFood) {
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
      for (const other of this.cells) {
        if (other === cell || !other.alive) continue;
        if (other.effectiveDefenseSize >= cell.genome.size * this.predationSizeRatio * this.predatorReach(cell)) continue;
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
    for (const other of this.cells) {
      if (other === cell || !other.alive || !other.canEat) continue;
      if (cell.effectiveDefenseSize >= other.genome.size * this.predationSizeRatio * this.predatorReach(other)) continue;
      const dx = other.x - cell.x;
      const dy = other.y - cell.y;
      const d = Math.hypot(dx, dy);
      if (d < bestThreatD && this.inFOV(cell, other.x, other.y)) {
        bestThreatD = d;
        threatDx = dx / sr;
        threatDy = dy / sr;
        threatDist = d / sr;
      }
    }

    let mateDx = 0;
    let mateDy = 0;
    let mateDist = 1;
    if (cell.genome.reproductionMode === 'sexual') {
      let bestMateD = sr;
      for (const other of this.cells) {
        if (other === cell || !other.alive) continue;
        if (other.lineageId !== cell.lineageId) continue;
        if (other.genome.reproductionMode !== 'sexual') continue;
        if (!other.canMate()) continue;
        const dx = other.x - cell.x;
        const dy = other.y - cell.y;
        const d = Math.hypot(dx, dy);
        if (d < bestMateD && this.inFOV(cell, other.x, other.y)) {
          bestMateD = d;
          mateDx = dx / sr;
          mateDy = dy / sr;
          mateDist = d / sr;
        }
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
    // cell with nothing nearby sees an almost constant input vector and a
    // random brain settles into a fixed turn output, orbiting a tiny circle
    // forever. Gives every genome some baseline ability to explore.
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

  private collectColonyMembers(root: Cell): Cell[] {
    const members: Cell[] = [];
    const stack: Cell[] = [root];
    while (stack.length) {
      const cell = stack.pop() as Cell;
      members.push(cell);
      for (const child of cell.attachedChildren) stack.push(child);
    }
    return members;
  }

  /** Moves an entire bonded colony as one rigid body: every member's brain
   * cast a [turn, thrust] vote this tick (cached in lastOutputs); votes are
   * pooled weighted by each member's own flagella investment, so
   * heavily-flagellated members steer more than a bare passenger cell
   * would. The colony's top speed comes from its *pooled* flagella power
   * (with diminishing returns), same shape as a solo cell's but bigger.
   * After integrating the root, every other member is repositioned from
   * its fixed parent-relative joint. */
  private moveColonyRigid(root: Cell, dt: number): void {
    const members = this.collectColonyMembers(root);
    let turnSum = 0;
    let thrustSum = 0;
    let weightSum = 0;
    let totalFlagellaPower = 0;
    for (const m of members) {
      const power = deriveFlagellaPower(m.genome);
      totalFlagellaPower += power;
      if (power <= 0) continue;
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
    const stack: Cell[] = [root];
    while (stack.length) {
      const cell = stack.pop() as Cell;
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
   * colony shares resources, letting e.g. a flagella-heavy propulsion cell
   * survive on income harvested by its photosynthetic/mouthed neighbors. */
  private diffuseColonyEnergy(dt: number): void {
    const rate = 0.08;
    for (const cell of this.cells) {
      if (!cell.alive || !cell.attachedTo || !cell.attachedTo.alive) continue;
      const parent = cell.attachedTo;
      const transfer = (parent.energy - cell.energy) * rate * dt;
      parent.energy -= transfer;
      cell.energy += transfer;
    }
  }

  private handleEating(): void {
    for (const cell of this.cells) {
      if (!cell.alive || !cell.canEat) continue;
      const reach = cell.radius + (deriveMouthPower(cell.genome) - 1) * 4;
      const yieldMult = cell.biteYield;
      for (let i = this.plantFood.length - 1; i >= 0; i--) {
        const f = this.plantFood[i];
        const d = Math.hypot(f.x - cell.x, f.y - cell.y);
        if (d < reach + f.radius) {
          cell.eat(f.energy * yieldMult);
          this.plantFood.splice(i, 1);
        }
      }
      for (let i = this.meatFood.length - 1; i >= 0; i--) {
        const f = this.meatFood[i];
        const d = Math.hypot(f.x - cell.x, f.y - cell.y);
        if (d < reach + f.radius) {
          cell.eat(f.energy * yieldMult);
          this.meatFood.splice(i, 1);
        }
      }
    }
  }

  private handlePredation(): void {
    for (const predator of this.cells) {
      if (!predator.alive || !predator.canEat) continue;
      for (const prey of this.cells) {
        if (prey === predator || !prey.alive) continue;
        if (prey.effectiveDefenseSize >= predator.genome.size * this.predationSizeRatio * this.predatorReach(predator)) continue;
        const d = Math.hypot(prey.x - predator.x, prey.y - predator.y);
        const reach = predator.radius + (deriveMouthPower(predator.genome) - 1) * 4;
        if (d < reach + prey.radius * 0.6) {
          const mitigation = deriveArmorMitigation(prey.genome);
          const bite = prey.energy * 0.6 * clamp(predator.biteYield, 0.4, 1.6) * (1 - mitigation);
          predator.eat(bite);
          const corpseEnergy = Math.max(0, prey.energy - bite);
          if (corpseEnergy > 0.5) this.meatFood.push(createFood('meat', prey.x, prey.y, corpseEnergy));
          prey.alive = false;
          prey.detachFromColony();
          break; // one successful strike per predator per tick
        }
      }
    }
  }

  private findColonyRoot(cell: Cell): Cell {
    let root = cell;
    while (root.attachedTo) root = root.attachedTo;
    return root;
  }

  private handleReproduction(): void {
    if (this.cells.length >= this.maxPopulation) return;
    const newborns: Cell[] = [];
    const mated = new Set<number>();

    // Sexual pairing: two same-lineage, mating-ready cells produce one
    // crossed-over child once they're within sensing range of each other —
    // always ejected as a free cell (sexual reproduction is the "spread to
    // a new lineage" path).
    for (const a of this.cells) {
      if (this.cells.length + newborns.length >= this.maxPopulation) break;
      if (mated.has(a.id) || !a.canMate()) continue;
      for (const b of this.cells) {
        if (b === a || mated.has(b.id) || !b.canMate()) continue;
        if (b.lineageId !== a.lineageId) continue;
        const d = Math.hypot(b.x - a.x, b.y - a.y);
        const meetRange = Math.max(a.genome.senseRadius, b.genome.senseRadius);
        if (d < meetRange && (this.inFOV(a, b.x, b.y) || this.inFOV(b, a.x, a.y))) {
          newborns.push(mateCells(a, b, this.rng));
          mated.add(a.id);
          mated.add(b.id);
          break;
        }
      }
    }

    // Asexual: a cell with a bud organelle grows its colony (if there's
    // room); everyone else ejects a free-floating clone.
    for (const cell of this.cells) {
      if (this.cells.length + newborns.length >= this.maxPopulation) break;
      if (!cell.canReproduce()) continue;
      if (hasBud(cell.genome)) {
        const root = this.findColonyRoot(cell);
        if (this.collectColonyMembers(root).length < this.maxColonySize) {
          newborns.push(cell.budOffspring(this.rng));
          continue;
        }
      }
      newborns.push(cell.reproduce(this.rng));
    }

    if (newborns.length) this.cells.push(...newborns);
  }

  private cleanupDead(): void {
    const survivors: Cell[] = [];
    for (const cell of this.cells) {
      if (!cell.alive) {
        cell.detachFromColony(); // already corpsed by handlePredation
        continue;
      }
      if (cell.isDead()) {
        this.meatFood.push(createFood('meat', cell.x, cell.y, Math.max(4, cell.genome.size * 8)));
        cell.detachFromColony();
        continue;
      }
      survivors.push(cell);
    }
    this.cells = survivors;
  }
}
