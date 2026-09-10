/*
 * teacher.js — the laptop view. Holds the only Bluetooth connection, shows
 * the submission queue, and flies one program at a time.
 */

import { MamboBLE } from './mambo-ble.js';
import { Runner } from './runner.js';
import { PythonRunner } from './python-runner.js';
import { createWorkspace, loadProgram, describe } from './workspace.js';
import { highlightBlock } from './code-editor.js';

const POLL_MS = 2000;

/* Below this the Mambo gets erratic and drops hard rather than landing, so
   refuse to launch. Flying already in progress is never interrupted by it. */
const MIN_BATTERY = 15;

const els = {
  queue: document.getElementById('queue'),
  steps: document.getElementById('steps'),
  source: document.getElementById('source'),
  blockly: document.getElementById('blockly'),
  sideTitle: document.getElementById('side-title'),
  output: document.getElementById('output'),
  outputTitle: document.getElementById('output-title'),
  status: document.getElementById('status'),
  selected: document.getElementById('selected'),
  battery: document.getElementById('battery'),
  state: document.getElementById('state'),
  connect: document.getElementById('connect'),
  fly: document.getElementById('fly'),
  land: document.getElementById('land'),
  stop: document.getElementById('stop'),
  log: document.getElementById('log'),
  trim: document.getElementById('trim'),
  skip: document.getElementById('skip'),
  clearQueue: document.getElementById('clear-queue'),
  batteryWarning: document.getElementById('battery-warning'),
};

const drone = new MamboBLE();
let workspace = null;
let runner = null;      // blocks
let pyRunner = null;    // python
let queue = [];
let selectedId = null;

function anyRunning() {
  return (runner && runner.running) || (pyRunner && pyRunner.running);
}

function log(msg) {
  const line = document.createElement('div');
  line.textContent = `${new Date().toLocaleTimeString()}  ${msg}`;
  els.log.appendChild(line);
  els.log.scrollTop = els.log.scrollHeight;
}

function setStatus(text, cls) {
  els.status.textContent = text;
  els.status.className = `pill ${cls}`;
}

function updateButtons() {
  const running = anyRunning();
  const lowBattery = drone.battery !== null && drone.battery < MIN_BATTERY;
  els.fly.disabled = !(drone.connected && !!selectedId && !running && !lowBattery);
  els.land.disabled = !drone.connected;
  els.trim.disabled = !drone.connected || running;
  els.skip.disabled = !selectedId || running;

  if (lowBattery) {
    els.batteryWarning.hidden = false;
    els.batteryWarning.className = 'banner bad';
    els.batteryWarning.textContent =
      `Battery is ${drone.battery}% — too low to fly safely. Charge or swap it. `
      + 'Land and STOP still work.';
  } else if (drone.battery !== null && drone.battery < 30) {
    els.batteryWarning.hidden = false;
    els.batteryWarning.className = 'banner';
    els.batteryWarning.textContent =
      `Battery is ${drone.battery}% — a couple of flights left at most.`;
  } else {
    els.batteryWarning.hidden = true;
  }
}

function setConnectedUI(connected) {
  els.connect.textContent = connected ? 'Disconnect' : 'Connect drone';
  setStatus(connected ? 'Connected' : 'Not connected', connected ? 'ok' : 'off');
  if (!connected) {
    els.battery.textContent = '--';
    els.state.textContent = '--';
  }
  updateButtons();
}

function renderQueue() {
  els.queue.innerHTML = '';
  const waiting = queue.filter((q) => q.status === 'waiting');
  const done = queue.filter((q) => q.status !== 'waiting');

  if (!queue.length) {
    const p = document.createElement('div');
    p.className = 'empty';
    p.textContent = 'No submissions yet. Students send their programs from the iPads.';
    els.queue.appendChild(p);
    return;
  }

  [...waiting, ...done].forEach((item) => {
    const div = document.createElement('div');
    div.className = 'entry'
      + (item.id === selectedId ? ' selected' : '')
      + (item.status !== 'waiting' ? ' flown' : '');
    const when = new Date(item.submitted_at * 1000).toLocaleTimeString();
    div.innerHTML = `<div class="who"></div><div class="meta"></div>`;
    div.querySelector('.who').textContent = item.name;
    div.querySelector('.meta').textContent =
      `${item.mode} · ${when}${item.status !== 'waiting' ? ` · ${item.status}` : ''}`;
    div.addEventListener('click', () => select(item.id));
    els.queue.appendChild(div);
  });
}

function select(id) {
  const item = queue.find((q) => q.id === id);
  if (!item) return;
  selectedId = id;
  els.selected.textContent = `showing ${item.name}`;
  els.output.textContent = '';
  els.output.hidden = true;
  els.outputTitle.hidden = true;

  if (item.mode === 'python') {
    els.blockly.hidden = true;
    els.source.hidden = false;
    highlightBlock(els.source, item.program);
    els.steps.textContent = 'Python program — read the code before flying it.';
    els.sideTitle.textContent = 'Heads up';
  } else {
    els.source.hidden = true;
    els.blockly.hidden = false;
    loadProgram(workspace, item.program);
    Blockly.svgResize(workspace);
    // Students place blocks wherever they like, so a submission can load
    // off-screen. Centre it rather than making the teacher hunt for it.
    workspace.scrollCenter();
    els.steps.textContent = describe(workspace).join('\n') || '(empty program)';
    els.sideTitle.textContent = 'What it will do';
  }

  renderQueue();
  updateButtons();
}

async function poll() {
  try {
    const res = await fetch('/api/queue');
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    const changed = JSON.stringify(data.queue) !== JSON.stringify(queue);
    queue = data.queue;
    if (changed) renderQueue();
    // Auto-select the first submission so the console is never empty-handed.
    if (!selectedId && queue.length) select(queue[0].id);
  } catch (err) {
    // The server going away mid-lesson should not spam the log every 2s.
  }
}

async function markStatus(id, status) {
  try {
    await fetch(`/api/status/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
  } catch (err) {
    log(`Could not mark submission: ${err.message}`);
  }
}

drone.on('log', log);
drone.on('battery', (pct) => {
  els.battery.textContent = `${pct}%`;
  els.battery.className = pct < MIN_BATTERY ? 'value low' : 'value';
  updateButtons();
});
drone.on('state', (s) => { els.state.textContent = s; });
drone.on('disconnect', () => setConnectedUI(false));

els.connect.addEventListener('click', async () => {
  if (drone.connected) {
    await drone.disconnect();
    setConnectedUI(false);
    return;
  }
  try {
    setStatus('Connecting...', 'busy');
    const name = await drone.connect();
    log(`Connected to ${name}.`);
    setConnectedUI(true);
  } catch (err) {
    log(`Connection failed: ${err.message}`);
    setConnectedUI(false);
  }
});

els.fly.addEventListener('click', async () => {
  const item = queue.find((q) => q.id === selectedId);
  if (!item) return;
  log(`--- flying ${item.name}'s ${item.mode} program ---`);
  els.fly.disabled = true;

  if (item.mode === 'python') {
    els.output.textContent = '';
    els.output.hidden = false;
    els.outputTitle.hidden = false;
    await pyRunner.run(item.program);
  } else {
    await runner.run(workspace);
  }

  await markStatus(item.id, 'flown');
  await poll();
  updateButtons();
});

/**
 * The red button has to mean something at all times. A program that ends
 * without land() leaves the drone hovering with nothing running, and the old
 * version returned early in exactly that case - so STOP did nothing at the
 * moment someone would most want it.
 */
async function stopEverything() {
  const wasRunning = anyRunning();
  if (runner && runner.running) runner.stop();
  if (pyRunner && pyRunner.running) pyRunner.stop();

  // A running program lands the drone itself as it unwinds; if nothing was
  // running, that is on us.
  if (!wasRunning && drone.connected) {
    log('STOP pressed — landing.');
    try {
      await drone.land();
    } catch (err) {
      log(`Could not send land: ${err.message}`);
    }
  }
  updateButtons();
}

els.stop.addEventListener('click', stopEverything);

els.land.addEventListener('click', async () => {
  await stopEverything();
});

els.trim.addEventListener('click', async () => {
  try {
    await drone.flatTrim();
    log('Flat trim sent. Drone must be on a level surface for this to help.');
  } catch (err) {
    log(`Flat trim failed: ${err.message}`);
  }
});

els.skip.addEventListener('click', async () => {
  const item = queue.find((q) => q.id === selectedId);
  if (!item) return;
  await markStatus(item.id, 'skipped');
  log(`Skipped ${item.name}'s program.`);
  selectedId = null;
  await poll();
  updateButtons();
});

els.clearQueue.addEventListener('click', async () => {
  const waiting = queue.filter((q) => q.status === 'waiting').length;
  // This throws away student work, so make them mean it.
  if (!window.confirm(
    `Clear all ${queue.length} submissions (${waiting} still waiting)?

`
    + 'This cannot be undone.')) return;
  try {
    await fetch('/api/clear', { method: 'POST' });
    selectedId = null;
    await poll();
    log('Queue cleared.');
  } catch (err) {
    log(`Could not clear the queue: ${err.message}`);
  }
});

// Background tabs get throttled to ~1Hz, which starves the PCMD heartbeat.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && anyRunning()) {
    log('Page hidden — landing for safety.');
    stopEverything();
  }
});

window.addEventListener('resize', () => {
  if (workspace) Blockly.svgResize(workspace);
});

workspace = createWorkspace('blockly', { toolbox: false });
runner = new Runner(drone, {
  onLog: log,
  onHighlight: (id) => workspace.highlightBlock(id),
});
pyRunner = new PythonRunner(drone, {
  onLog: log,
  onPrint: (text) => {
    els.output.textContent += `${text}\n`;
    els.output.scrollTop = els.output.scrollHeight;
  },
});
setConnectedUI(false);
log('Ready. Connect the drone, then pick a submission.');
poll();
setInterval(poll, POLL_MS);
