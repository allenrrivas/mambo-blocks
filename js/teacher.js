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
};

const drone = new MamboBLE();
let workspace = null;
let runner = null;      // blocks
let pyRunner = null;    // python
let queue = [];
let selectedId = null;

/** Whichever runner owns the current program. */
function activeRunner() {
  const item = queue.find((q) => q.id === selectedId);
  return item && item.mode === 'python' ? pyRunner : runner;
}

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
  const ready = drone.connected && !!selectedId && !anyRunning();
  els.fly.disabled = !ready;
  els.land.disabled = !drone.connected;
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
  els.battery.className = pct < 20 ? 'value low' : 'value';
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

function stopEverything() {
  if (runner && runner.running) runner.stop();
  if (pyRunner && pyRunner.running) pyRunner.stop();
}

els.stop.addEventListener('click', stopEverything);

els.land.addEventListener('click', async () => {
  stopEverything();
  await drone.land();
  log('Manual land.');
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
