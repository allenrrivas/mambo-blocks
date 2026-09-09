/*
 * student.js — the iPad view. Authoring and submitting only; students never
 * hold a Bluetooth connection, so this needs no drone code and works in plain
 * Safari over plain HTTP.
 */

import { createWorkspace, saveProgram, loadProgram, describe, isEmpty } from './workspace.js';

const STORAGE_KEY = 'mambo-blocks-workspace';
const NAME_KEY = 'mambo-blocks-name';

const els = {
  name: document.getElementById('name'),
  submit: document.getElementById('submit'),
  status: document.getElementById('status'),
  steps: document.getElementById('steps'),
};

let workspace = null;

function setStatus(text, cls = '') {
  els.status.textContent = text;
  els.status.className = `status ${cls}`;
}

function refreshSteps() {
  const lines = describe(workspace);
  els.steps.textContent = lines.length
    ? lines.join('\n')
    : 'Drag some blocks to build a flight.';
}

function init() {
  workspace = createWorkspace('blockly');

  const saved = localStorage.getItem(STORAGE_KEY);
  try {
    loadProgram(workspace, saved ? JSON.parse(saved) : null);
  } catch (err) {
    loadProgram(workspace, null);
  }

  els.name.value = localStorage.getItem(NAME_KEY) || '';
  els.name.addEventListener('input', () => {
    localStorage.setItem(NAME_KEY, els.name.value);
  });

  workspace.addChangeListener(() => {
    if (workspace.isDragging()) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saveProgram(workspace)));
    refreshSteps();
  });

  refreshSteps();
}

els.submit.addEventListener('click', async () => {
  const name = els.name.value.trim();
  if (!name) {
    setStatus('Put your name in first.', 'warn');
    els.name.focus();
    return;
  }
  if (isEmpty(workspace)) {
    setStatus('Your program is empty — drag some blocks in.', 'warn');
    return;
  }

  els.submit.disabled = true;
  setStatus('Sending...');
  try {
    const res = await fetch('/api/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mode: 'blocks', program: saveProgram(workspace) }),
    });
    if (!res.ok) throw new Error(`server said ${res.status}`);
    setStatus('Sent! Your teacher will fly it. Change it and send again any time.', 'ok');
  } catch (err) {
    setStatus(`Could not send: ${err.message}. Ask your teacher to check the wifi.`, 'bad');
  } finally {
    els.submit.disabled = false;
  }
});

window.addEventListener('resize', () => {
  if (workspace) Blockly.svgResize(workspace);
});

init();
