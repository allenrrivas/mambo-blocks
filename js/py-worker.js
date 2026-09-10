/*
 * py-worker.js — runs student Python in a Web Worker.
 *
 * Why a worker: students write infinite loops. On the main thread a
 * `while True: pass` would peg the tab, and the STOP button's own click
 * handler would never get to run. In a worker we just terminate() it, which
 * kills anything regardless of what it is doing.
 *
 * Web Bluetooth does not exist in workers, so every drone call is proxied to
 * the main thread by postMessage. JSPI (WebAssembly stack switching) lets the
 * Python side block on that round trip, so students write plain synchronous
 * Python with no await anywhere.
 */

const PYODIDE_VERSION = '314.0.6';

let pyodide = null;
let nextCallId = 1;
const pending = new Map();

/** Ask the main thread to perform a drone call; resolves when it replies. */
function callHost(fn, args) {
  const id = nextCallId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    self.postMessage({ type: 'call', id, fn, args });
  });
}

const host = {
  takeoff: () => callHost('takeoff', []),
  land: () => callHost('land', []),
  hover: (s) => callHost('hover', [s]),
  fly: (d, s, sp) => callHost('fly', [d, s, sp]),
  fly_direct: (r, p, y, v, d) => callHost('fly_direct', [r, p, y, v, d]),
  turn: (d, deg) => callHost('turn', [d, deg]),
  turn_degrees: (deg) => callHost('turn_degrees', [deg]),
  flip: (d) => callHost('flip', [d]),
  flip_times: (d, t, g) => callHost('flip_times', [d, t, g]),
  emergency: () => callHost('emergency', []),
  sleep: (s) => callHost('sleep', [s]),
};

/*
 * The API students actually see. Each wrapper blocks via run_sync, so the
 * Python reads as ordinary synchronous code.
 *
 * Friendly names come first; the pyparrot-compatible spellings are aliases so
 * that code written here transfers to a real Python environment later.
 */
const PRELUDE = `
from pyodide.ffi import run_sync as _run_sync
from _dronehost import host as _host

def takeoff():
    """Lift off and hover in place."""
    _run_sync(_host.takeoff())

def land():
    """Come down gently and stop the motors."""
    _run_sync(_host.land())

def hover(seconds=1):
    """Stay still in the air."""
    _run_sync(_host.hover(seconds))

def fly(direction, seconds=1, speed=40):
    """Fly one way: forward, backward, left, right, up or down."""
    _run_sync(_host.fly(direction, seconds, speed))

def turn(direction, degrees=90):
    """Spin in place. direction is 'left' or 'right'."""
    _run_sync(_host.turn(direction, degrees))

def flip(direction='front'):
    """Barrel roll: front, back, left or right. Needs clear space."""
    _run_sync(_host.flip(direction))

def flip_times(direction='front', times=3, gap=1.2):
    """Chain flips back to back without settling in between.

    Each flip loses height and this skips the recovery, so climb first
    and leave plenty of room. Gaps under about a second may be ignored
    by the drone, which will not start a flip while recovering.
    """
    _run_sync(_host.flip_times(direction, times, gap))

def emergency():
    """Cut the motors immediately. The drone will fall."""
    _run_sync(_host.emergency())

def wait(seconds=1):
    """Pause without moving."""
    _run_sync(_host.sleep(seconds))

# --- pyparrot-compatible aliases -------------------------------------------
def safe_takeoff(timeout=5): takeoff()
def safe_land(timeout=5): land()
def smart_sleep(seconds): wait(seconds)
def turn_degrees(degrees): _run_sync(_host.turn_degrees(degrees))
def fly_direct(roll=0, pitch=0, yaw=0, vertical_movement=0, duration=1):
    _run_sync(_host.fly_direct(roll, pitch, yaw, vertical_movement, duration))
`;

async function boot() {
  const { loadPyodide } = await import(
    `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/pyodide.mjs`
  );
  pyodide = await loadPyodide({
    enableRunUntilComplete: true, // required for run_sync / stack switching
    stdout: (text) => self.postMessage({ type: 'print', text }),
    stderr: (text) => self.postMessage({ type: 'print', text }),
  });
  pyodide.registerJsModule('_dronehost', { host });

  // Define the API in its own compilation unit, under its own filename.
  // If the prelude were prepended to the student's code, every traceback
  // would report line numbers offset by the length of the prelude - a student
  // with a mistake on line 2 would be told "line 46".
  pyodide.globals.set('_prelude_src', PRELUDE);
  await pyodide.runPythonAsync(
    "exec(compile(_prelude_src, '<drone-api>', 'exec'), globals())\ndel _prelude_src"
  );

  self.postMessage({ type: 'ready' });
}

self.onmessage = async (e) => {
  const msg = e.data;

  if (msg.type === 'result') {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.value);
    else p.reject(new Error(msg.error));
    return;
  }

  if (msg.type === 'run') {
    try {
      await pyodide.runPythonAsync(msg.code);
      self.postMessage({ type: 'done' });
    } catch (err) {
      self.postMessage({ type: 'error', message: formatPythonError(err) });
    }
  }
};

/**
 * Turn a Pyodide traceback into something a student can act on: their own
 * line numbers, no interpreter internals, no frames from inside the drone API.
 */
function formatPythonError(err) {
  const text = String(err.message || err);
  const lines = text.split('\n').filter((l) => l.trim());
  if (!lines.length) return text;

  // Filtering interpreter frames out of a traceback is a losing game - they
  // include bare source snippets with nothing to match on. Instead take the
  // two things a student can actually use: where in THEIR file it broke, and
  // what Python said. <exec> is their program; <drone-api> is our prelude.
  let where = null;
  for (const l of lines) {
    const m = l.match(/File "<exec>", line (\d+)/);
    if (m) where = m[1];
  }

  // Errors we raise ourselves arrive wrapped as JsException; a student should
  // just see "fly(): unknown direction", not the bridge that carried it.
  const message = lines[lines.length - 1]
    .trim()
    .replace(/^pyodide\.ffi\.JsException:\s*(Error:\s*)?/, '');

  return where ? `line ${where}: ${message}` : message;
}

boot().catch((err) => {
  self.postMessage({ type: 'error', message: `Could not start Python: ${err.message}` });
});
