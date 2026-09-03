/*
 * app.js — wires the workspace, the drone and the buttons together.
 */

import { MamboBLE } from './mambo-ble.js';
import { defineBlocks, TOOLBOX, STARTER_PROGRAM } from './blocks.js';
import { Runner } from './runner.js';

const STORAGE_KEY = 'mambo-blocks-workspace';

const els = {
  connect: document.getElementById('connect'),
  run: document.getElementById('run'),
  stop: document.getElementById('stop'),
  land: document.getElementById('land'),
  status: document.getElementById('status'),
  battery: document.getElementById('battery'),
  state: document.getElementById('state'),
  log: document.getElementById('log'),
};

const drone = new MamboBLE();
let workspace = null;
let runner = null;

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

function setConnectedUI(connected) {
  els.run.disabled = !connected;
  els.land.disabled = !connected;
  els.connect.textContent = connected ? 'Disconnect' : 'Connect drone';
  setStatus(connected ? 'Connected' : 'Not connected', connected ? 'ok' : 'off');
  if (!connected) {
    els.battery.textContent = '--';
    els.state.textContent = '--';
  }
}

function initWorkspace() {
  defineBlocks();
  workspace = Blockly.inject('blockly', {
    toolbox: TOOLBOX,
    grid: { spacing: 24, length: 3, colour: '#e6e9ef', snap: true },
    zoom: { controls: true, wheel: true, startScale: 1.0, minScale: 0.5, maxScale: 2.0 },
    trashcan: true,
    renderer: 'zelos', // chunky, Scratch-like blocks that suit touch
  });

  const saved = localStorage.getItem(STORAGE_KEY);
  try {
    Blockly.serialization.workspaces.load(saved ? JSON.parse(saved) : STARTER_PROGRAM, workspace);
  } catch (err) {
    Blockly.serialization.workspaces.load(STARTER_PROGRAM, workspace);
  }

  workspace.addChangeListener(() => {
    if (workspace.isDragging()) return;
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(Blockly.serialization.workspaces.save(workspace))
    );
  });

  runner = new Runner(drone, {
    onLog: log,
    onHighlight: (id) => workspace.highlightBlock(id),
  });
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

els.run.addEventListener('click', () => runner.run(workspace));
els.stop.addEventListener('click', () => runner.stop());
els.land.addEventListener('click', async () => {
  runner.stop();
  await drone.land();
  log('Manual land.');
});

// Browsers throttle timers in background tabs to about 1Hz, which starves the
// PCMD heartbeat and would leave the drone holding its last stick command.
// If the page is hidden mid-program, stop and land rather than fly on blind.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && runner && runner.running) {
    log('Page hidden — landing for safety.');
    runner.stop();
  }
});

// Keep the canvas the right size when the iPad rotates.
window.addEventListener('resize', () => {
  if (workspace) Blockly.svgResize(workspace);
});

initWorkspace();
setConnectedUI(false);
log('Ready. Open this page in Bluefy on iPad, then tap Connect drone.');
