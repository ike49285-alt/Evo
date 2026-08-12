import { Rng } from './rng.js';

/**
 * A tiny feedforward neural network: inputs -> hidden (tanh) -> outputs.
 * This is the "brain" evolved by mutation across generations. Topology is
 * fixed for v1 (no NEAT-style structural mutation) — only weights evolve.
 */
export interface NNTopology {
  inputs: number;
  hidden: number;
  outputs: number;
}

function tanh(x: number): number {
  return Math.tanh(x);
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

export class NeuralNet {
  readonly topology: NNTopology;
  // hidden layer: weights shaped [hidden][inputs], flattened row-major
  w1: Float32Array;
  b1: Float32Array;
  // output layer: weights shaped [outputs][hidden], flattened row-major
  w2: Float32Array;
  b2: Float32Array;

  constructor(topology: NNTopology, weights?: {
    w1: Float32Array; b1: Float32Array; w2: Float32Array; b2: Float32Array;
  }) {
    this.topology = topology;
    if (weights) {
      this.w1 = weights.w1;
      this.b1 = weights.b1;
      this.w2 = weights.w2;
      this.b2 = weights.b2;
    } else {
      this.w1 = new Float32Array(topology.hidden * topology.inputs);
      this.b1 = new Float32Array(topology.hidden);
      this.w2 = new Float32Array(topology.outputs * topology.hidden);
      this.b2 = new Float32Array(topology.outputs);
    }
  }

  /** Xavier-style scaled init: weight range shrinks with fan-in so the
   * pre-activation sum lands near tanh's responsive middle regardless of
   * how many inputs/hidden units there are. Without this, growing the
   * sensor vector (this brain now has 15 inputs, not the original 11)
   * pushes hidden-neuron sums deep into tanh's flat tails on pure luck —
   * a "random" brain isn't just unskilled then, it's *saturated*: its
   * output barely moves no matter how the inputs change, which looks
   * identical to "ignoring everything it senses" from the outside. That's
   * a much harder hole to evolve out of than genuine unskilled-but-
   * responsive randomness, since gradient-free mutation has almost
   * nothing to select on when the output doesn't react to input changes
   * in the first place. */
  static random(topology: NNTopology, rng: Rng): NeuralNet {
    const net = new NeuralNet(topology);
    const w1Limit = 1 / Math.sqrt(topology.inputs);
    const w2Limit = 1 / Math.sqrt(topology.hidden);
    for (let i = 0; i < net.w1.length; i++) net.w1[i] = rng.range(-w1Limit, w1Limit);
    for (let i = 0; i < net.b1.length; i++) net.b1[i] = rng.range(-0.2, 0.2);
    for (let i = 0; i < net.w2.length; i++) net.w2[i] = rng.range(-w2Limit, w2Limit);
    for (let i = 0; i < net.b2.length; i++) net.b2[i] = rng.range(-0.2, 0.2);
    return net;
  }

  /** Runs a forward pass. Output activations: tanh for all but the last
   * (thrust) output, which is passed through sigmoid to land in [0, 1]. */
  forward(inputs: readonly number[]): number[] {
    const { inputs: nIn, hidden: nHid, outputs: nOut } = this.topology;
    const hiddenActivations = new Array<number>(nHid);
    for (let h = 0; h < nHid; h++) {
      let sum = this.b1[h];
      const base = h * nIn;
      for (let i = 0; i < nIn; i++) sum += this.w1[base + i] * inputs[i];
      hiddenActivations[h] = tanh(sum);
    }
    const out = new Array<number>(nOut);
    for (let o = 0; o < nOut; o++) {
      let sum = this.b2[o];
      const base = o * nHid;
      for (let h = 0; h < nHid; h++) sum += this.w2[base + h] * hiddenActivations[h];
      // last output (thrust) uses sigmoid so it's a clean 0..1 "how hard to push"
      out[o] = o === nOut - 1 ? sigmoid(sum) : tanh(sum);
    }
    return out;
  }

  /** Uniform crossover: each weight/bias comes from `a` or `b` with equal
   * probability. Requires matching topology (always true here — brain shape
   * is fixed, only weights evolve). */
  static crossover(a: NeuralNet, b: NeuralNet, rng: Rng): NeuralNet {
    const child = new NeuralNet(a.topology);
    const mix = (dst: Float32Array, sa: Float32Array, sb: Float32Array): void => {
      for (let i = 0; i < dst.length; i++) dst[i] = rng.bool(0.5) ? sa[i] : sb[i];
    };
    mix(child.w1, a.w1, b.w1);
    mix(child.b1, a.b1, b.b1);
    mix(child.w2, a.w2, b.w2);
    mix(child.b2, a.b2, b.b2);
    return child;
  }

  clone(): NeuralNet {
    return new NeuralNet(this.topology, {
      w1: new Float32Array(this.w1),
      b1: new Float32Array(this.b1),
      w2: new Float32Array(this.w2),
      b2: new Float32Array(this.b2),
    });
  }

  /** Returns a *new* mutated network; the original is left untouched. */
  mutate(rng: Rng, rate: number, strength: number): NeuralNet {
    const child = this.clone();
    mutateArray(child.w1, rng, rate, strength);
    mutateArray(child.b1, rng, rate, strength);
    mutateArray(child.w2, rng, rate, strength);
    mutateArray(child.b2, rng, rate, strength);
    return child;
  }

  /** Plain-array snapshot for save/restore — Float32Arrays don't survive
   * JSON.stringify as themselves (they'd come back as an object keyed by
   * numeric-string index, not a real array). */
  toJSON(): { topology: NNTopology; w1: number[]; b1: number[]; w2: number[]; b2: number[] } {
    return {
      topology: this.topology,
      w1: Array.from(this.w1),
      b1: Array.from(this.b1),
      w2: Array.from(this.w2),
      b2: Array.from(this.b2),
    };
  }

  static fromJSON(json: { topology: NNTopology; w1: number[]; b1: number[]; w2: number[]; b2: number[] }): NeuralNet {
    return new NeuralNet(json.topology, {
      w1: Float32Array.from(json.w1),
      b1: Float32Array.from(json.b1),
      w2: Float32Array.from(json.w2),
      b2: Float32Array.from(json.b2),
    });
  }
}

function mutateArray(arr: Float32Array, rng: Rng, rate: number, strength: number): void {
  for (let i = 0; i < arr.length; i++) {
    if (rng.next() < rate) {
      arr[i] += rng.gaussian(0, strength);
    }
    // rare larger jump — keeps some exploration alive even after
    // convergence. Scaled to roughly match the Xavier-init weight range,
    // not the old flat [-1,1] one — a "big jump" that's disproportionately
    // huge relative to every other weight risks single-handedly
    // resaturating the neuron it lands on, undoing the point of scaled
    // initialization in the first place.
    if (rng.next() < rate * 0.05) {
      arr[i] = rng.range(-0.6, 0.6);
    }
  }
}
