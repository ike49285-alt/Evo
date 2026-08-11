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
