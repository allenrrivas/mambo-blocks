/*
 * runner.js — walks the block tree and drives the drone.
 *
 * Deliberately an interpreter rather than a code generator: nothing the
 * kids build is ever eval'd, the abort flag can be checked between every
 * step, and we can highlight whichever block is currently running.
 */

/** Directions map onto the four PCMD stick axes. */
const AXES = {
  forward: (s) => ({ roll: 0, pitch: s, yaw: 0, gaz: 0 }),
  backward: (s) => ({ roll: 0, pitch: -s, yaw: 0, gaz: 0 }),
  right: (s) => ({ roll: s, pitch: 0, yaw: 0, gaz: 0 }),
  left: (s) => ({ roll: -s, pitch: 0, yaw: 0, gaz: 0 }),
  up: (s) => ({ roll: 0, pitch: 0, yaw: 0, gaz: s }),
  down: (s) => ({ roll: 0, pitch: 0, yaw: 0, gaz: -s }),
};

export class Runner {
  constructor(drone, { onLog = () => {}, onHighlight = () => {} } = {}) {
    this.drone = drone;
    this.onLog = onLog;
    this.onHighlight = onHighlight;
    this.aborted = false;
    this.running = false;
  }

  /** Requested by the STOP button. Long moves poll this mid-flight. */
  stop() {
    if (!this.running) return;
    this.aborted = true;
    this.onLog('STOP pressed — landing.');
  }

  _shouldAbort() { return this.aborted; }

  /** setTimeout that wakes early when STOP is pressed. */
  async _sleep(ms) {
    const step = 50;
    let waited = 0;
    while (waited < ms) {
      if (this.aborted) return;
      await new Promise((r) => setTimeout(r, Math.min(step, ms - waited)));
      waited += step;
    }
  }

  async run(workspace) {
    if (this.running) return;
    if (!this.drone.connected) {
      this.onLog('Not connected to a drone.');
      return;
    }

    this.aborted = false;
    this.running = true;
    this.onLog('Running program...');

    // Top blocks are ordered visually so the program reads top to bottom.
    const tops = workspace.getTopBlocks(true).filter((b) => !b.isShadow());

    try {
      for (const top of tops) {
        await this._runChain(top);
        if (this.aborted) break;
      }
      if (this.aborted) {
        await this.drone.land();
      }
      this.onLog(this.aborted ? 'Stopped.' : 'Program finished.');
    } catch (err) {
      this.onLog(`Error: ${err.message}. Landing.`);
      await this.drone.land();
    } finally {
      this.onHighlight(null);
      this.running = false;
    }
  }

  /** Run a block and everything connected below it. */
  async _runChain(block) {
    let current = block;
    while (current && !this.aborted) {
      if (!current.isEnabled || current.isEnabled()) {
        await this._runBlock(current);
      }
      current = current.getNextBlock();
    }
  }

  async _runBlock(block) {
    this.onHighlight(block.id);
    const f = block.getFieldValue.bind(block);

    switch (block.type) {
      case 'mambo_takeoff':
        this.onLog('take off');
        await this.drone.takeoff();
        // The Mambo needs a moment before it will accept the next command.
        await this._sleep(3000);
        break;

      case 'mambo_land':
        this.onLog('land');
        await this.drone.land();
        await this._sleep(2000);
        break;

      case 'mambo_hover': {
        const secs = Number(f('SECONDS')) || 1;
        this.onLog(`hover ${secs}s`);
        await this.drone.fly(0, 0, 0, 0, secs * 1000, this._shouldAbort.bind(this));
        break;
      }

      case 'mambo_move': {
        const dir = f('DIRECTION');
        const secs = Number(f('SECONDS')) || 1;
        const speed = Number(f('SPEED')) || 40;
        const axis = AXES[dir];
        if (!axis) throw new Error(`Unknown direction ${dir}`);
        const { roll, pitch, yaw, gaz } = axis(speed);
        this.onLog(`fly ${dir} ${secs}s @ ${speed}`);
        await this.drone.fly(roll, pitch, yaw, gaz, secs * 1000, this._shouldAbort.bind(this));
        break;
      }

      case 'mambo_turn': {
        const dir = f('DIRECTION');
        const degrees = Number(f('DEGREES')) || 90;
        const signed = dir === 'left' ? -degrees : degrees;
        this.onLog(`turn ${dir} ${degrees}deg`);
        await this.drone.turn(signed);
        await this._sleep(1500);
        break;
      }

      case 'mambo_flip': {
        const dir = f('DIRECTION');
        this.onLog(`flip ${dir}`);
        await this.drone.flip(dir);
        await this._sleep(2500);
        break;
      }

      case 'mambo_multiflip': {
        const dir = f('DIRECTION');
        const times = Math.max(2, Math.min(5, Number(f('TIMES')) || 3));
        const gap = Number(f('GAP')) || 1.2;
        this.onLog(`flip ${dir} x${times}, ${gap}s apart`);
        for (let i = 0; i < times && !this.aborted; i += 1) {
          this.onLog(`  flip ${i + 1}/${times}`);
          await this.drone.flip(dir);
          // No settle between flips — that is the point. Only the gap.
          if (i < times - 1) await this._sleep(gap * 1000);
        }
        // Recover properly after the last one before anything else runs.
        if (!this.aborted) {
          this.onLog('  recovering');
          await this._sleep(2500);
        }
        break;
      }

      case 'mambo_emergency':
        this.onLog('EMERGENCY STOP');
        await this.drone.emergency();
        this.aborted = true;
        break;

      case 'controls_repeat_ext': {
        const times = this._readNumber(block, 'TIMES', 1);
        const body = block.getInputTargetBlock('DO');
        this.onLog(`repeat ${times}x`);
        for (let i = 0; i < times && !this.aborted; i += 1) {
          if (body) await this._runChain(body);
        }
        break;
      }

      default:
        this.onLog(`Skipping unknown block: ${block.type}`);
    }
  }

  /**
   * Read a numeric input. Only literal number blocks are honoured — there
   * is no expression evaluation, and nothing here can run user code.
   */
  _readNumber(block, inputName, fallback) {
    const target = block.getInputTargetBlock(inputName);
    if (target && target.type === 'math_number') {
      const n = Number(target.getFieldValue('NUM'));
      if (Number.isFinite(n)) return Math.max(0, Math.min(100, Math.floor(n)));
    }
    return fallback;
  }
}
