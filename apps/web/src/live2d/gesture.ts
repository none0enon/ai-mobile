export type Gesture = 'rest' | 'wave' | 'crossed';
const targets: Record<Gesture, [number, number]> = { rest: [0, 0], wave: [1, 0], crossed: [0, 1] };

/** Retargetable spring from the supplied Madara v19 model: a new command replaces the target. */
export class GestureMotion {
  target: Gesture = 'rest';
  private omega = 7.5;
  raise = 0;
  fold = 0;
  raiseVelocity = 0;
  foldVelocity = 0;
  sleeveLag = 0;

  setTarget(target: Gesture, immediate = false) {
    if (!(target in targets)) throw new Error('未知手势');
    if (target !== this.target) this.omega = target !== 'rest' && this.target !== 'rest' ? 5 : 7.5;
    this.target = target;
    if (immediate) {
      [this.raise, this.fold] = targets[target];
      this.raiseVelocity = this.foldVelocity = this.sleeveLag = 0;
    }
  }

  update(seconds: number) {
    const dt = Math.max(0, Math.min(seconds, 0.05));
    const omega = this.omega;
    const decay = Math.exp(-omega * dt);
    const desired = targets[this.target];
    const step = (value: number, velocity: number, target: number): [number, number] => {
      const offset = value - target;
      const j = velocity + omega * offset;
      return [target + (offset + j * dt) * decay, (velocity - omega * j * dt) * decay];
    };
    [this.raise, this.raiseVelocity] = step(this.raise, this.raiseVelocity, desired[0]);
    [this.fold, this.foldVelocity] = step(this.fold, this.foldVelocity, desired[1]);
    if (this.raise < 0) { this.raise = 0; this.raiseVelocity = Math.max(0, this.raiseVelocity); }
    if (this.fold < 0) { this.fold = 0; this.foldVelocity = Math.max(0, this.foldVelocity); }
    // Keep the two arm targets within the model's continuous pose triangle.
    const sum = this.raise + this.fold;
    if (sum > 1) {
      this.raise /= sum;
      this.fold /= sum;
      const outward = this.raiseVelocity + this.foldVelocity;
      if (outward > 0) {
        this.raiseVelocity -= outward * this.raise;
        this.foldVelocity -= outward * this.fold;
      }
    }
    const lagTarget = Math.max(-1, Math.min(1, -this.raiseVelocity * 0.3 + this.foldVelocity * 0.24));
    this.sleeveLag += (lagTarget - this.sleeveLag) * (1 - Math.exp(-dt * 7));
    if (Math.abs(this.raise - desired[0]) + Math.abs(this.fold - desired[1]) < 0.0004 && this.speed < 0.004) {
      [this.raise, this.fold] = desired;
      this.raiseVelocity = this.foldVelocity = 0;
    }
    if (Math.abs(this.sleeveLag) < 0.0001 && this.speed === 0) this.sleeveLag = 0;
    return this;
  }

  get speed() { return Math.hypot(this.raiseVelocity, this.foldVelocity); }
}
