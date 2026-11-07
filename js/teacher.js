/*
 * teacher.js — the laptop view. Holds the only Bluetooth connection, shows
 * the submission queue, and flies one program at a time.
 */

import { MamboBLE } from './mambo-ble.js';
import { Runner } from './runner.js';
import { PythonRunner } from './python-runner.js';
import {
  createWorkspace, loadProgram, saveProgram, describe, isEmpty,
} from './workspace.js';
import { createCodeEditor, highlightBlock } from './code-editor.js';

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
  edit: document.getElementById('edit'),
  saveEdit: document.getElementById('save-edit'),
  cancelEdit: document.getElementById('cancel-edit'),
  blocklyEdit: document.getElementById('blockly-edit'),
  sourceEdit: document.getElementById('source-edit'),
};

const drone = new MamboBLE();
let workspace = null;
let runner = null;      // blocks
let pyRunner = null;    // python
let queue = [];
let selectedId = null;

/* Editing happens in separate panes from the review ones. The review
   workspace is injected read-only with no toolbox, and Blockly cannot add a
   toolbox to a workspace after the fact. It also keeps the thing that flies
   apart from the thing being changed: only a saved edit reaches the drone. */
let editWorkspace = null;
let codeEditor = null;
let editing = null;     // { id, mode, original } while the teacher is editing

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
  els.fly.disabled = !(drone.connected && !!selectedId && !running && !lowBattery && !editing);
  els.land.disabled = !drone.connected;
  els.trim.disabled = !drone.connected || running;
  els.skip.disabled = !selectedId || running || !!editing;
  els.edit.hidden = !!editing;
  els.edit.disabled = !selectedId || running;
  els.saveEdit.hidden = !editing;
  els.cancelEdit.hidden = !editing;

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
    div.querySelector('.meta').textContent = `${item.mode} · ${when}`
      + `${item.edited ? ' · edited' : ''}`
      + `${item.status !== 'waiting' ? ` · ${item.status}` : ''}`;
    div.addEventListener('click', () => select(item.id));
    els.queue.appendChild(div);
  });
}

function select(id) {
  const item = queue.find((q) => q.id === id);
  if (!item) return;
  if (editing) {
    if (id === editing.id) return;
    if (isDirty() && !window.confirm(
      `Throw away your changes to ${nameOf(editing.id)}'s program?`)) return;
    closeEditor();
  }
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

function nameOf(id) {
  const item = queue.find((q) => q.id === id);
  return item ? item.name : 'this student';
}

function editedProgram() {
  return editing.mode === 'python' ? codeEditor.value : saveProgram(editWorkspace);
}

function isDirty() {
  if (!editing) return false;
  const now = editedProgram();
  return editing.mode === 'python'
    ? now !== editing.original
    : JSON.stringify(now) !== editing.original;
}

function openEditor() {
  const item = queue.find((q) => q.id === selectedId);
  if (!item || anyRunning()) return;

  if (item.mode === 'python') {
    els.source.hidden = true;
    els.sourceEdit.hidden = false;
    if (!codeEditor) codeEditor = createCodeEditor(els.sourceEdit);
    codeEditor.value = item.program;
    editing = { id: item.id, mode: 'python', original: item.program };
    els.steps.textContent = 'Editing. Save your changes to fly this version.';
    codeEditor.focus();
  } else {
    els.blockly.hidden = true;
    els.blocklyEdit.hidden = false;
    // Inject only once the pane is visible; injected while hidden, Blockly
    // measures 0 x 0 and jams everything into the top-left corner.
    if (!editWorkspace) {
      editWorkspace = createWorkspace('blockly-edit');
      editWorkspace.addChangeListener(() => {
        if (!editing || editWorkspace.isDragging()) return;
        els.steps.textContent = describe(editWorkspace).join('\n') || '(empty program)';
      });
    }
    Blockly.svgResize(editWorkspace);
    loadProgram(editWorkspace, item.program);
    editWorkspace.scrollCenter();
    // Compare against Blockly's own serialisation of what it loaded, not the
    // submitted JSON, so an untouched program never counts as changed.
    editing = { id: item.id, mode: 'blocks', original: JSON.stringify(saveProgram(editWorkspace)) };
    els.steps.textContent = describe(editWorkspace).join('\n') || '(empty program)';
  }

  els.sideTitle.textContent = `Editing ${item.name}'s program`;
  log(`Editing ${item.name}'s program.`);
  updateButtons();
}

function closeEditor() {
  editing = null;
  els.blocklyEdit.hidden = true;
  els.sourceEdit.hidden = true;
  updateButtons();
}

async function saveEdits() {
  if (!editing) return;
  const { id, mode } = editing;
  const name = nameOf(id);
  const program = editedProgram();

  if (!isDirty()) {
    closeEditor();
    select(id);
    return;
  }
  if (mode === 'python' ? !program.trim() : isEmpty(editWorkspace)) {
    log('That would leave the program empty. Skip it instead if it should not fly.');
    return;
  }

  els.saveEdit.disabled = true;
  try {
    const res = await fetch(`/api/program/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ program }),
    });
    const data = await res.json().catch(() => ({}));

    if (res.ok) {
      log(`Saved your changes to ${name}'s program.`);
      closeEditor();
      await poll();
      select(id);
    } else if (data.error === 'syntax') {
      log(`Not saved. Line ${data.line}: ${data.message}`);
      codeEditor.selectLine(data.line);
    } else if (res.status === 404) {
      // A resubmission replaces the entry, so the one being edited is gone.
      log(`Not saved: ${name} sent a new version while you were editing. `
        + 'Their new version is in the queue.');
      closeEditor();
      selectedId = null;
      await poll();
    } else {
      log(`Not saved: ${data.error || res.status}`);
    }
  } catch (err) {
    log(`Not saved: ${err.message}`);
  } finally {
    els.saveEdit.disabled = false;
  }
}

function cancelEdits() {
  if (!editing) return;
  const { id } = editing;
  if (isDirty() && !window.confirm('Throw away your changes?')) return;
  closeEditor();
  log('Edit cancelled.');
  select(id);
}

els.edit.addEventListener('click', openEditor);
els.saveEdit.addEventListener('click', saveEdits);
els.cancelEdit.addEventListener('click', cancelEdits);

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
    closeEditor();
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
  if (editWorkspace) Blockly.svgResize(editWorkspace);
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
