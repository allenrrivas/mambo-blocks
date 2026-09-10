/*
 * python-runner.js — main-thread half of Python mode.
 *
 * Owns the worker, services its drone calls against the real BLE driver, and
 * kills it on STOP. Presents the same surface as Runner (run/stop/running) so
 * the teacher console can treat blocks and Python identically.
 */

/** Settle times, matching runner.js so both modes fly the same way. */
const SETTLE = { takeoff: 3000, land: 2000, flip: 2500, turn: 1500 };

const AXES = {
  forward: (s) => [0, s, 0, 0],
  backward: (s) => [0, -s, 0, 0],
  right: (s) => [s, 0, 0, 0],
  left: (s) => [-s, 0, 0, 0],
  up: (s) => [0, 0, 0, s],
  down: (s) => [0, 0, 0, -s],
};

export class PythonRunner {
  constructor(drone, { onLog = () => {}, onPrint = () => {} } = {}) {
    this.drone = drone;
    this.onLog = onLog;
    this.onPrint = onPrint;
    this.worker = null;
    this.running = false;
    this.aborted = false;
    this._ready = null;
  }

  /** Abort on STOP, and also if the link dies underneath us. */
  _shouldAbort() { return this.aborted || !this.drone.connected; }

  /**
   * Land without ever throwing. If we are landing because the link dropped,
   * the write will fail - and an exception there would skip the cleanup that
   * follows it.
   */
  async _safeLand(why) {
    if (why) this.onLog(why);
    try {
      await this.drone.land();
    } catch (err) {
      this.onLog(`Could not send land: ${err.message}`);
    }
  }

  /** Is the drone off the ground, according to its own telemetry? */
  _airborne() {
    return ['takingoff', 'hovering', 'flying'].includes(this.drone.flyingState);
  }

  /** Abortable sleep, so STOP does not have to wait out a long hover. */
  async _sleep(ms) {
    const step = 50;
    let waited = 0;
    while (waited < ms && !this.aborted) {
      await new Promise((r) => setTimeout(r, Math.min(step, ms - waited)));
      waited += step;
    }
  }

  /**
   * Boot the worker and wait for Pyodide. Kept alive between runs — it is an
   * 11.6MB download, so paying that once per lesson rather than once per
   * program matters.
   */
  async ensureReady() {
    if (this._ready) return this._ready;
    this.onLog('Starting Python (first run downloads ~12MB)...');
    this._ready = new Promise((resolve, reject) => {
      this.worker = new Worker('./js/py-worker.js', { type: 'module' });
      this.worker.onmessage = (e) => this._onMessage(e.data, resolve, reject);
      this.worker.onerror = (err) => reject(new Error(err.message || 'worker failed'));
    });
    return this._ready;
  }

  _onMessage(msg, resolveReady, rejectReady) {
    switch (msg.type) {
      case 'ready':
        this.onLog('Python ready.');
        if (resolveReady) resolveReady();
        break;
      case 'print':
        if (String(msg.text).trim()) this.onPrint(String(msg.text));
        break;
      case 'call':
        this._handleCall(msg);
        break;
      case 'done':
        if (this._finish) this._finish({ ok: true });
        break;
      case 'error':
        if (this._finish) this._finish({ ok: false, error: msg.message });
        else if (rejectReady) rejectReady(new Error(msg.message));
        break;
      default:
        break;
    }
  }

  async _handleCall({ id, fn, args }) {
    if (!this.drone.connected && !this.aborted) {
      this.aborted = true;
      this.onLog('Drone disconnected — stopping the program.');
    }
    if (this.aborted) {
      // Refuse politely rather than hanging the worker; it is about to die.
      this.worker.postMessage({ type: 'result', id, ok: false, error: 'stopped' });
      return;
    }
    try {
      await this._perform(fn, args);
      if (this.worker) this.worker.postMessage({ type: 'result', id, ok: true, value: null });
    } catch (err) {
      if (this.worker) {
        this.worker.postMessage({ type: 'result', id, ok: false, error: err.message });
      }
    }
  }

  async _perform(fn, args) {
    const d = this.drone;
    const abort = this._shouldAbort.bind(this);

    switch (fn) {
      case 'takeoff':
        this.onLog('take off');
        await d.takeoff();
        return this._sleep(SETTLE.takeoff);

      case 'land':
        this.onLog('land');
        await d.land();
        return this._sleep(SETTLE.land);

      case 'hover': {
        const secs = Number(args[0]) || 1;
        this.onLog(`hover ${secs}s`);
        return d.fly(0, 0, 0, 0, secs * 1000, abort);
      }

      case 'sleep':
        return this._sleep((Number(args[0]) || 1) * 1000);

      case 'fly': {
        const [dir, secs = 1, speed = 40] = args;
        const axis = AXES[String(dir)];
        if (!axis) throw new Error(`fly(): unknown direction "${dir}"`);
        const [roll, pitch, yaw, gaz] = axis(Number(speed));
        this.onLog(`fly ${dir} ${secs}s @ ${speed}`);
        return d.fly(roll, pitch, yaw, gaz, Number(secs) * 1000, abort);
      }

      case 'fly_direct': {
        const [roll, pitch, yaw, vertical, duration] = args.map(Number);
        this.onLog(`fly_direct r=${roll} p=${pitch} y=${yaw} v=${vertical} ${duration}s`);
        return d.fly(roll, pitch, yaw, vertical, duration * 1000, abort);
      }

      case 'turn': {
        const [dir, degrees = 90] = args;
        if (!['left', 'right'].includes(String(dir))) {
          throw new Error(`turn(): direction must be 'left' or 'right', got "${dir}"`);
        }
        const signed = dir === 'left' ? -Number(degrees) : Number(degrees);
        this.onLog(`turn ${dir} ${degrees}deg`);
        await d.turn(signed);
        return this._sleep(SETTLE.turn);
      }

      case 'turn_degrees':
        this.onLog(`turn_degrees ${args[0]}`);
        await d.turn(Number(args[0]));
        return this._sleep(SETTLE.turn);

      case 'flip': {
        const dir = String(args[0] || 'front');
        if (!['front', 'back', 'left', 'right'].includes(dir)) {
          throw new Error(`flip(): direction must be front, back, left or right, got "${dir}"`);
        }
        this.onLog(`flip ${dir}`);
        await d.flip(dir);
        return this._sleep(SETTLE.flip);
      }

      case 'flip_times': {
        const dir = String(args[0] || 'front');
        const times = Number(args[1]);
        const gap = Number(args[2]);
        if (!['front', 'back', 'left', 'right'].includes(dir)) {
          throw new Error(`flip_times(): direction must be front, back, left or right, got "${dir}"`);
        }
        // Explicit errors rather than silent clamping: a student who asks for
        // 20 flips should be told no, not quietly given 5.
        if (!Number.isFinite(times) || times < 2 || times > 5) {
          throw new Error(`flip_times(): times must be between 2 and 5, got ${args[1]}`);
        }
        if (!Number.isFinite(gap) || gap < 0.2 || gap > 3) {
          throw new Error(`flip_times(): gap must be between 0.2 and 3 seconds, got ${args[2]}`);
        }

        this.onLog(`flip ${dir} x${times}, ${gap}s apart`);
        for (let i = 0; i < times && !this.aborted; i += 1) {
          this.onLog(`  flip ${i + 1}/${times}`);
          await d.flip(dir);
          // No settle between flips - that is the point. Only the gap.
          if (i < times - 1) await this._sleep(gap * 1000);
        }
        if (!this.aborted) {
          this.onLog('  recovering');
          await this._sleep(SETTLE.flip);
        }
        return undefined;
      }

      case 'emergency':
        this.onLog('EMERGENCY STOP');
        this.aborted = true;
        return d.emergency();

      default:
        throw new Error(`unknown drone call: ${fn}`);
    }
  }

  async run(code) {
    if (this.running) return;
    if (!this.drone.connected) {
      this.onLog('Not connected to a drone.');
      return;
    }

    try {
      await this.ensureReady();
    } catch (err) {
      this.onLog(`Python failed to start: ${err.message}`);
      return;
    }

    this.aborted = false;
    this.running = true;
    this.onLog('Running Python...');

    const outcome = await new Promise((resolve) => {
      this._finish = resolve;
      this.worker.postMessage({ type: 'run', code });
    });
    this._finish = null;

    try {
      if (this.aborted) {
        await this.drone.land();
        this.onLog('Stopped.');
      } else if (!outcome.ok) {
        this.onLog(`Python error:\n${outcome.error}`);
        await this.drone.land();
      } else {
        this.onLog('Program finished.');
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * Terminate rather than signal. A student's `while True: pass` has no
   * suspension point, so nothing cooperative would ever get a look in.
   * The worker is disposable; the drone is not, so we land it.
   */
  stop() {
    if (!this.running) return;
    this.aborted = true;
    this.onLog('STOP pressed — killing Python and landing.');
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
      this._ready = null; // next run pays the startup cost again
    }
    if (this._finish) {
      this._finish({ ok: false, error: 'stopped' });
      this._finish = null;
    }
  }
}
