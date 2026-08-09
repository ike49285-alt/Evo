function tanh(x) {
    return Math.tanh(x);
}
function sigmoid(x) {
    return 1 / (1 + Math.exp(-x));
}
export class NeuralNet {
    constructor(topology, weights) {
        this.topology = topology;
        if (weights) {
            this.w1 = weights.w1;
            this.b1 = weights.b1;
            this.w2 = weights.w2;
            this.b2 = weights.b2;
        }
        else {
            this.w1 = new Float32Array(topology.hidden * topology.inputs);
            this.b1 = new Float32Array(topology.hidden);
            this.w2 = new Float32Array(topology.outputs * topology.hidden);
            this.b2 = new Float32Array(topology.outputs);
        }
    }
    static random(topology, rng) {
        const net = new NeuralNet(topology);
        for (let i = 0; i < net.w1.length; i++)
            net.w1[i] = rng.range(-1, 1);
        for (let i = 0; i < net.b1.length; i++)
            net.b1[i] = rng.range(-0.5, 0.5);
        for (let i = 0; i < net.w2.length; i++)
            net.w2[i] = rng.range(-1, 1);
        for (let i = 0; i < net.b2.length; i++)
            net.b2[i] = rng.range(-0.5, 0.5);
        return net;
    }
    /** Runs a forward pass. Output activations: tanh for all but the last
     * (thrust) output, which is passed through sigmoid to land in [0, 1]. */
    forward(inputs) {
        const { inputs: nIn, hidden: nHid, outputs: nOut } = this.topology;
        const hiddenActivations = new Array(nHid);
        for (let h = 0; h < nHid; h++) {
            let sum = this.b1[h];
            const base = h * nIn;
            for (let i = 0; i < nIn; i++)
                sum += this.w1[base + i] * inputs[i];
            hiddenActivations[h] = tanh(sum);
        }
        const out = new Array(nOut);
        for (let o = 0; o < nOut; o++) {
            let sum = this.b2[o];
            const base = o * nHid;
            for (let h = 0; h < nHid; h++)
                sum += this.w2[base + h] * hiddenActivations[h];
            // last output (thrust) uses sigmoid so it's a clean 0..1 "how hard to push"
            out[o] = o === nOut - 1 ? sigmoid(sum) : tanh(sum);
        }
        return out;
    }
    clone() {
        return new NeuralNet(this.topology, {
            w1: new Float32Array(this.w1),
            b1: new Float32Array(this.b1),
            w2: new Float32Array(this.w2),
            b2: new Float32Array(this.b2),
        });
    }
    /** Returns a *new* mutated network; the original is left untouched. */
    mutate(rng, rate, strength) {
        const child = this.clone();
        mutateArray(child.w1, rng, rate, strength);
        mutateArray(child.b1, rng, rate, strength);
        mutateArray(child.w2, rng, rate, strength);
        mutateArray(child.b2, rng, rate, strength);
        return child;
    }
}
function mutateArray(arr, rng, rate, strength) {
    for (let i = 0; i < arr.length; i++) {
        if (rng.next() < rate) {
            arr[i] += rng.gaussian(0, strength);
        }
        // rare larger jump — keeps some exploration alive even after convergence
        if (rng.next() < rate * 0.05) {
            arr[i] = rng.range(-1.5, 1.5);
        }
    }
}
