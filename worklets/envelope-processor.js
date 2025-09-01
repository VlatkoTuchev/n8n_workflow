// Lightweight envelope follower with attack/release and periodic posting.
// Posts { env } to the main thread every N blocks. Pass-through output
// so the node can be chained to a zero-gain sink to keep the graph pulled.
class EnvelopeProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    const sr = sampleRate;
    const attackMs = Math.max(1, Number(o.attackMs ?? 8));
    const releaseMs = Math.max(1, Number(o.releaseMs ?? 180));
    this.aAtk = Math.exp(-1 / (attackMs * 0.001 * sr));
    this.aRel = Math.exp(-1 / (releaseMs * 0.001 * sr));
    this.postEvery = Math.max(1, Number(o.postEvery ?? 6));
    this.env = 0;
    this.blocks = 0;
  }
  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) return true;
    const chIn = input[0];
    let env = this.env;
    const aAtk = this.aAtk, aRel = this.aRel;
    for (let i = 0; i < chIn.length; i++) {
      const x = Math.abs(chIn[i]);
      const a = x > env ? aAtk : aRel;
      env = x + a * (env - x);
    }
    this.env = env;

    if (++this.blocks % this.postEvery === 0) {
      this.port.postMessage({ env });
    }

    // Pass-through
    if (output && output.length) {
      const chOut = output[0];
      const n = Math.min(chOut.length, chIn.length);
      for (let i = 0; i < n; i++) chOut[i] = chIn[i];
    }
    return true;
  }
}
registerProcessor('envelope-processor', EnvelopeProcessor);

