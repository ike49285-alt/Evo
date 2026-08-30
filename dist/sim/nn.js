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
    static random(topology, rng) {
        const net = new NeuralNet(topology);
        const w1Limit = 1 / Math.sqrt(topology.inputs);
        const w2Limit = 1 / Math.sqrt(topology.hidden);
        for (let i = 0; i < net.w1.length; i++)
            net.w1[i] = rng.range(-w1Limit, w1Limit);
        for (let i = 0; i < net.b1.length; i++)
            net.b1[i] = rng.range(-0.2, 0.2);
        for (let i = 0; i < net.w2.length; i++)
            net.w2[i] = rng.range(-w2Limit, w2Limit);
        for (let i = 0; i < net.b2.length; i++)
            net.b2[i] = rng.range(-0.2, 0.2);
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
    /** Uniform crossover: each weight/bias comes from `a` or `b` with equal
     * probability. Requires matching topology (always true here — brain shape
     * is fixed, only weights evolve). */
    static crossover(a, b, rng) {
        const child = new NeuralNet(a.topology);
        const mix = (dst, sa, sb) => {
            for (let i = 0; i < dst.length; i++)
                dst[i] = rng.bool(0.5) ? sa[i] : sb[i];
        };
        mix(child.w1, a.w1, b.w1);
        mix(child.b1, a.b1, b.b1);
        mix(child.w2, a.w2, b.w2);
        mix(child.b2, a.b2, b.b2);
        return child;
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
    /** Base64 snapshot for save/restore. Float32Arrays don't survive
     * JSON.stringify as themselves (they'd come back as an object keyed by
     * numeric-string index, not a real array), so they have to be encoded
     * somehow — and *which* encoding is a real save-size decision, not a
     * detail.
     *
     * This used to be `Array.from(...)`, which turns every float32 into a
     * full JS double and prints it at up to 17 significant digits: ~18
     * characters to store 4 bytes. Brains were 3.7 KB of an 8.2 KB cell,
     * the single largest line item in the save, and the save was hitting
     * iOS Safari's 5 MB localStorage ceiling (see save.ts). Base64 of the
     * raw buffer is 5.33 characters per weight instead of ~18.
     *
     * Base64 rather than rounded decimals specifically because it is
     * **exact**. Rounding to fewer digits would also shrink the file, but
     * it would quietly perturb every brain in the dish on reload — a saved
     * run would come back behaving subtly differently, which is a worse
     * failure than a large file. */
    toJSON() {
        return {
            topology: this.topology,
            w1: encodeWeights(this.w1),
            b1: encodeWeights(this.b1),
            w2: encodeWeights(this.w2),
            b2: encodeWeights(this.b2),
        };
    }
    /** Accepts both the base64 form above and the legacy number-array form,
     * so a save written before the format changed still loads. See save.ts
     * on why old saves are migrated rather than discarded. */
    static fromJSON(json) {
        return new NeuralNet(json.topology, {
            w1: decodeWeights(json.w1),
            b1: decodeWeights(json.b1),
            w2: decodeWeights(json.w2),
            b2: decodeWeights(json.b2),
        });
    }
}
/** Float32Array -> base64 of its raw little-endian bytes.
 *
 * Deliberately byte-at-a-time rather than
 * `String.fromCharCode(...bytes)`: spreading a typed array into an
 * argument list blows the engine's argument limit on large inputs, and
 * "large" here is a moving target — the topology is a constant today but
 * the whole point of this function is that it is used on every genome in
 * the dish on every save. */
function encodeWeights(arr) {
    const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    let binary = '';
    for (let i = 0; i < bytes.length; i++)
        binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}
function decodeWeights(value) {
    if (typeof value !== 'string')
        return Float32Array.from(value);
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++)
        bytes[i] = binary.charCodeAt(i);
    // Copies through a fresh buffer rather than viewing `bytes.buffer`
    // directly: a Float32Array view demands 4-byte alignment, and nothing
    // guarantees a decoded string's length is a multiple of 4 if the save
    // was ever truncated.
    return new Float32Array(bytes.buffer.slice(0, bytes.length - (bytes.length % 4)));
}
function mutateArray(arr, rng, rate, strength) {
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
