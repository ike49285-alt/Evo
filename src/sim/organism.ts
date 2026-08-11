// The entity itself: sensing, thinking (brain forward pass), acting
// (movement), and metabolism. An Organism is deliberately thin — almost
// everything about what it *can* do comes from `deriveStats(genome)`.
// World owns eating/reproduction/death since those need cross-organism
// state (contact, population caps); this file just owns one individual's
// per-tick behavior loop.

import { Genome, DerivedStats, deriveStats } from './genome.js';
import { forward, Sensor, Output, INPUT_COUNT } from './nn.js';
import { Vec2, clamp, wrapAngle } from './types.js';
import { GridEntry } from './grid.js';

let nextOrganismId = 1;

export const MAX_TURN_RATE = 3.4; // rad/sec at full agility
const DRAG_COEFF = 0.9;
const MOVEMENT_UPKEEP_SCALE = 0.02;

export interface SenseTarget {
  dir: Vec2; // unit vector toward target, {0,0} if none
  dist01: number; // 0 = on top of it, 1 = at/ beyond vision range (or no target)
}

export interface Perception {
  food: SenseTarget;
  threat: SenseTarget;
  mate: SenseTarget;
}

export class Organism implements GridEntry {
  readonly id: number;
  genome: Genome;
  stats: DerivedStats;

  x: number;
  y: number;
  heading: number; // radians
  speed: number; // world units / sec

  energy: number;
  age = 0; // ticks
  generation: number;
  lineageId: number; // founder id this traces back to, for the eventual Tree of Life view
  alive = true;
  matingReady = false;

  // ---- Colony bonds (budding) --------------------------------------------
  // A bonded organism doesn't move independently — its position/heading are
  // derived every tick from its parent's transform + this fixed local
  // offset (set once, at bud time). Only a root (parent === null) actually
  // runs sense/think/act; see World.tick(). Bonds are a tree, not just
  // parent-root, so branching colonies fall out naturally from repeated
  // budding at any member.
  parent: Organism | null = null;
  children: Organism[] = [];
  localAngle = 0;
  localDistance = 0;
  /** Max reach of this organism's colony subtree, in world units — only
   *  meaningful (and only kept current) on a root; used for colony-vs-colony
   *  separation so a big colony doesn't just check its root's tiny hull. */
  colonyRadius = 0;
  /** Scratch accumulator for World's separation pass — accumulate-then-apply
   *  so pushes from multiple overlapping neighbors don't stomp each other
   *  mid-pass. Reset to 0 at the start of each separation pass. */
  pendingPushX = 0;
  pendingPushY = 0;

  constructor(genome: Genome, x: number, y: number, energy: number, generation: number, lineageId: number) {
    this.id = nextOrganismId++;
    this.genome = genome;
    this.stats = deriveStats(genome);
    this.x = x;
    this.y = y;
    this.heading = Math.random() * Math.PI * 2;
    this.speed = 0;
    this.energy = energy;
    this.generation = generation;
    this.lineageId = lineageId;
    this.colonyRadius = this.stats.hullRadius;
  }

  get isRoot(): boolean {
    return this.parent === null;
  }

  /** Bonds `child` onto this organism at a fixed offset in this organism's
   *  local frame (set once, at bud time — the child never independently
   *  drifts from it). */
  bondChild(child: Organism, angle: number, distance: number): void {
    child.parent = this;
    child.localAngle = angle;
    child.localDistance = distance;
    this.children.push(child);
  }

  /** Called when this organism dies. Its direct children each become the
   *  root of their own (still-intact) sub-colony, rather than the whole
   *  tree dissolving down to individuals — a colony fragments, it doesn't
   *  vaporize. */
  dissolveBonds(): void {
    for (const child of this.children) child.parent = null;
    this.children = [];
  }

  /** Walks this organism's colony subtree, setting every descendant's
   *  position/heading from this organism's current transform + its fixed
   *  local offset. Returns the subtree's max reach (world units) from
   *  *this* node, so a root can cache the whole colony's footprint. Only
   *  meaningful to call on a root (or as the recursive step below it) —
   *  a bonded organism's own x/y/heading are never authoritative. */
  propagateColonyTransform(): number {
    let maxReach = this.stats.hullRadius;
    for (const child of this.children) {
      const worldAngle = this.heading + child.localAngle;
      child.x = this.x + Math.cos(worldAngle) * child.localDistance;
      child.y = this.y + Math.sin(worldAngle) * child.localDistance;
      child.heading = this.heading;
      const reach = child.localDistance + child.propagateColonyTransform();
      if (reach > maxReach) maxReach = reach;
    }
    if (this.isRoot) this.colonyRadius = maxReach;
    return maxReach;
  }

  /** Re-derive cached physical stats after the genome changes (mutation on birth). */
  refreshStats(): void {
    this.stats = deriveStats(this.genome);
  }

  sense(perception: Perception): Float32Array {
    const inputs = new Float32Array(INPUT_COUNT);
    inputs[Sensor.Bias] = 1;
    inputs[Sensor.Energy] = clamp(this.energy / (this.stats.reproCost * 2), 0, 1);

    inputs[Sensor.FoodDirX] = perception.food.dir.x;
    inputs[Sensor.FoodDirY] = perception.food.dir.y;
    inputs[Sensor.FoodDist] = perception.food.dist01;

    inputs[Sensor.ThreatDirX] = perception.threat.dir.x;
    inputs[Sensor.ThreatDirY] = perception.threat.dir.y;
    inputs[Sensor.ThreatDist] = perception.threat.dist01;

    inputs[Sensor.MateDirX] = perception.mate.dir.x;
    inputs[Sensor.MateDirY] = perception.mate.dir.y;
    inputs[Sensor.MateDist] = perception.mate.dist01;

    inputs[Sensor.VelX] = Math.cos(this.heading) * clamp(this.speed / 40, -1, 1);
    inputs[Sensor.VelY] = Math.sin(this.heading) * clamp(this.speed / 40, -1, 1);
    return inputs;
  }

  think(inputs: Float32Array): Float32Array {
    return forward(this.genome.brain.weights, inputs);
  }

  /** Applies brain outputs to heading/speed and integrates position. No eyes -> no
   *  usable sensing, but the brain still runs on whatever (zeroed) inputs it gets;
   *  a blind organism just can't do much with them. */
  act(outputs: Float32Array, dt: number): void {
    const turnRate = MAX_TURN_RATE * (0.4 + 0.6 * (this.stats.agility / 3.2));
    this.heading = wrapAngle(this.heading + outputs[Output.Turn] * turnRate * dt);

    const thrust = clamp(outputs[Output.Thrust], 0, 1);
    const force = thrust * this.stats.thrustForce;
    const accel = force / Math.max(this.stats.mass, 0.5) - DRAG_COEFF * this.speed;
    this.speed = Math.max(0, this.speed + accel * dt);

    this.x += Math.cos(this.heading) * this.speed * dt;
    this.y += Math.sin(this.heading) * this.speed * dt;

    // Movement costs energy proportional to thrust effort, not just distance
    // covered — idling at zero thrust is (almost) free, gunning it isn't.
    this.energy -= thrust * thrust * this.stats.thrustForce * MOVEMENT_UPKEEP_SCALE * dt;
  }

  /** Base metabolic upkeep + sunlight income. Returns energy delta actually applied
   *  isn't needed by callers; mutates `energy` directly. */
  metabolize(dt: number, sunlightScale: number): void {
    this.energy -= this.stats.baseUpkeep * dt;
    this.energy += this.stats.photoRate * sunlightScale * dt;
    this.age += dt;
    this.matingReady = this.energy > this.stats.reproCost * 1.4;
  }

  get isDead(): boolean {
    return this.energy <= 0;
  }
}
