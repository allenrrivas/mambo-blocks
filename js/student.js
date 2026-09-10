/*
 * student.js — the iPad view. Authoring and submitting only; students never
 * hold a Bluetooth connection, so this needs no drone code and works in plain
 * Safari over plain HTTP.
 */

import { createWorkspace, saveProgram, loadProgram, describe, isEmpty } from './workspace.js';
import { createCodeEditor, highlightBlock } from './code-editor.js';

const KEYS = {
  blocks: 'mambo-blocks-workspace',
  python: 'mambo-blocks-python',
  name: 'mambo-blocks-name',
  mode: 'mambo-blocks-mode',
};

const STARTER_PYTHON = `# Fly the drone with Python.
# Look at "Things you can say" for everything you can do.

takeoff()
hover(2)
land()
`;

const els = {
  name: document.getElementById('name'),
  submit: document.getElementById('submit'),
  status: document.getElementById('status'),
  steps: document.getElementById('steps'),
  help: document.getElementById('help'),
  sideTitle: document.getElementById('side-title'),
  blockly: document.getElementById('blockly'),
  editor: document.getElementById('editor'),
  modeBlocks: document.getElementById('mode-blocks'),
  modePython: document.getElementById('mode-python'),
};

let workspace = null;
let editor = null;
let mode = 'blocks';

function setStatus(text, cls = '') {
  els.status.textContent = text;
  els.status.className = `status ${cls}`;
}

/* ---- mode switching ----------------------------------------------------- */

function setMode(next) {
  mode = next;
  const python = next === 'python';

  els.blockly.hidden = python;
  els.editor.hidden = !python;
  els.steps.hidden = python;
  els.help.hidden = !python;
  els.sideTitle.textContent = python ? 'Your program' : 'What it will do';
  els.modeBlocks.classList.toggle('active', !python);
  els.modePython.classList.toggle('active', python);

  localStorage.setItem(KEYS.mode, next);
  setStatus('');

  if (!python && workspace) Blockly.svgResize(workspace);
}

els.modeBlocks.addEventListener('click', () => setMode('blocks'));
els.modePython.addEventListener('click', () => setMode('python'));

/* ---- submitting --------------------------------------------------------- */

els.submit.addEventListener('click', async () => {
  const name = els.name.value.trim();
  if (!name) {
    setStatus('Put your name in first.', 'warn');
    els.name.focus();
    return;
  }

  let program;
  if (mode === 'blocks') {
    if (isEmpty(workspace)) {
      setStatus('Your program is empty — drag some blocks in.', 'warn');
      return;
    }
    program = saveProgram(workspace);
  } else {
    program = editor.value;
    if (!program.trim()) {
      setStatus('Your program is empty — write some code.', 'warn');
      return;
    }
  }

  els.submit.disabled = true;
  setStatus('Sending...');
  try {
    const res = await fetch('/api/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mode, program }),
    });
    const data = await res.json().catch(() => ({}));

    if (res.ok) {
      setStatus('Sent! Your teacher will fly it. Change it and send again any time.', 'ok');
    } else if (data.error === 'syntax') {
      // The server compiled it with real CPython, so this is the true parser.
      setStatus(`Line ${data.line}: ${data.message}`, 'bad');
      editor.selectLine(data.line);
    } else {
      setStatus(`Could not send: ${data.error || res.status}`, 'bad');
    }
  } catch (err) {
    setStatus(`Could not send: ${err.message}. Ask your teacher to check the wifi.`, 'bad');
  } finally {
    els.submit.disabled = false;
  }
});

/* ---- startup ------------------------------------------------------------ */

function init() {
  workspace = createWorkspace('blockly');

  const savedBlocks = localStorage.getItem(KEYS.blocks);
  try {
    loadProgram(workspace, savedBlocks ? JSON.parse(savedBlocks) : null);
  } catch (err) {
    loadProgram(workspace, null);
  }

  editor = createCodeEditor(els.editor, {
    value: localStorage.getItem(KEYS.python) ?? STARTER_PYTHON,
    onChange: (code) => {
      localStorage.setItem(KEYS.python, code);
      setStatus('');
    },
  });

  // The reference panel is Python too, so colour it the same as the editor.
  document.querySelectorAll('pre.api').forEach((el) => {
    highlightBlock(el, el.textContent);
  });

  els.name.value = localStorage.getItem(KEYS.name) || '';

  els.name.addEventListener('input', () => {
    localStorage.setItem(KEYS.name, els.name.value);
  });

  workspace.addChangeListener(() => {
    if (workspace.isDragging()) return;
    localStorage.setItem(KEYS.blocks, JSON.stringify(saveProgram(workspace)));
    const lines = describe(workspace);
    els.steps.textContent = lines.length ? lines.join('\n') : 'Drag some blocks to build a flight.';
  });

  els.steps.textContent = describe(workspace).join('\n') || 'Drag some blocks to build a flight.';
  setMode(localStorage.getItem(KEYS.mode) === 'python' ? 'python' : 'blocks');
}

window.addEventListener('resize', () => {
  if (workspace && mode === 'blocks') Blockly.svgResize(workspace);
});

init();
