/*
 * junior.js — Mambo Jr., the picture-only student page.
 *
 * Same job as student.js - build a flight and send it to the teacher - for
 * children who cannot read yet. They pick an animal instead of typing a name,
 * every block is an icon, and feedback is a picture, never a sentence.
 */

import {
  defineJuniorBlocks, JUNIOR_TOOLBOX, JUNIOR_STARTER, ICONS, toStandardProgram,
} from './junior-blocks.js';

const KEYS = {
  animal: 'mambo-junior-animal',
  workspace: 'mambo-junior-workspace',
  // Shared with the reading page: it identifies the iPad, not the page.
  client: 'mambo-blocks-client',
};

/*
 * The animal is the child's name. The teacher sees "🦊 Fox" in the queue, so
 * the word is for the teacher and the picture is for the child.
 */
const ANIMALS = [
  ['🦊', 'Fox'], ['🐼', 'Panda'], ['🐸', 'Frog'], ['🐯', 'Tiger'],
  ['🐶', 'Dog'], ['🐱', 'Cat'], ['🐰', 'Bunny'], ['🐻', 'Bear'],
  ['🦁', 'Lion'], ['🐵', 'Monkey'], ['🐧', 'Penguin'], ['🦄', 'Unicorn'],
  ['🐢', 'Turtle'], ['🐙', 'Octopus'], ['🦋', 'Butterfly'], ['🐝', 'Bee'],
];

const els = {
  app: document.getElementById('app'),
  gate: document.getElementById('gate'),
  animals: document.getElementById('animals'),
  me: document.getElementById('me'),
  switchMe: document.getElementById('switch-me'),
  send: document.getElementById('send'),
  feedback: document.getElementById('feedback'),
};

let workspace = null;

function clientId() {
  let id = localStorage.getItem(KEYS.client);
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID())
      || `c${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(KEYS.client, id);
  }
  return id;
}

function currentAnimal() {
  const saved = localStorage.getItem(KEYS.animal);
  return ANIMALS.find(([emoji]) => emoji === saved) || null;
}

/* ---- picking an animal -------------------------------------------------- */

function showGate() {
  els.app.inert = true;
  els.gate.hidden = false;
}

function showApp() {
  const animal = currentAnimal();
  els.me.textContent = animal[0];
  els.me.setAttribute('aria-label', animal[1]);
  els.gate.hidden = true;
  els.app.inert = false;
  clearFeedback();
}

ANIMALS.forEach(([emoji, word]) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'animal';
  b.textContent = emoji;
  b.setAttribute('aria-label', word);
  b.addEventListener('click', () => {
    localStorage.setItem(KEYS.animal, emoji);
    showApp();
  });
  els.animals.appendChild(b);
});

els.switchMe.addEventListener('click', showGate);

/* ---- feedback: pictures, never sentences -------------------------------- */

let feedbackTimer = null;

function showFeedback(kind) {
  const symbol = { ok: '✅', empty: '🚩', error: '❌', busy: '⏳' }[kind];
  els.feedback.textContent = symbol;
  els.feedback.className = `feedback ${kind}`;
  els.feedback.hidden = false;
  clearTimeout(feedbackTimer);
  if (kind !== 'busy') feedbackTimer = setTimeout(clearFeedback, 4000);
}

function clearFeedback() {
  els.feedback.hidden = true;
}

/** Point at the flag when nothing is attached to it. */
function nudgeFlag() {
  const flag = workspace.getTopBlocks(false).find((b) => b.type === 'junior_start');
  if (!flag) return;
  workspace.centerOnBlock(flag.id);
  const el = flag.getSvgRoot();
  el.classList.remove('nudge');
  void el.getBoundingClientRect(); // restart the animation
  el.classList.add('nudge');
}

/* ---- sending ------------------------------------------------------------ */

els.send.addEventListener('click', async () => {
  const animal = currentAnimal();
  if (!animal) { showGate(); return; }

  const program = toStandardProgram(Blockly.serialization.workspaces.save(workspace));
  if (!program) {
    showFeedback('empty');
    nudgeFlag();
    return;
  }

  els.send.disabled = true;
  showFeedback('busy');
  try {
    const res = await fetch('/api/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `${animal[0]} ${animal[1]}`,
        mode: 'blocks',
        program,
        client: clientId(),
      }),
    });
    showFeedback(res.ok ? 'ok' : 'error');
  } catch (err) {
    showFeedback('error');
  } finally {
    els.send.disabled = false;
  }
});

/* ---- startup ------------------------------------------------------------ */

function ensureFlag() {
  if (workspace.getTopBlocks(false).some((b) => b.type === 'junior_start')) return;
  Blockly.serialization.blocks.append(JUNIOR_STARTER.blocks.blocks[0], workspace);
}

function init() {
  defineJuniorBlocks();
  workspace = Blockly.inject('blockly', {
    toolbox: JUNIOR_TOOLBOX,
    // A strip along the bottom, as in ScratchJr. Down the side, a child had to
    // scroll to find flip, wait and repeat; along the bottom they all fit.
    horizontalLayout: true,
    toolboxPosition: 'end',
    renderer: 'zelos',
    grid: { spacing: 32, length: 3, colour: '#e6e9ef', snap: true },
    zoom: { controls: true, wheel: true, startScale: 1.1, minScale: 0.6, maxScale: 2.0 },
    move: { scrollbars: true, wheel: true, drag: true },
    trashcan: true,
  });

  try {
    const saved = localStorage.getItem(KEYS.workspace);
    Blockly.serialization.workspaces.load(saved ? JSON.parse(saved) : JUNIOR_STARTER, workspace);
  } catch (err) {
    Blockly.serialization.workspaces.load(JUNIOR_STARTER, workspace);
  }
  ensureFlag();
  // The flag can be moved but never thrown away.
  workspace.getTopBlocks(false)
    .filter((b) => b.type === 'junior_start')
    .forEach((b) => b.setDeletable(false));

  workspace.addChangeListener(() => {
    if (workspace.isDragging()) return;
    localStorage.setItem(KEYS.workspace, JSON.stringify(Blockly.serialization.workspaces.save(workspace)));
  });

  els.send.querySelector('img').src = ICONS.send;

  if (currentAnimal()) showApp();
  else showGate();
}

window.addEventListener('resize', () => {
  if (workspace) Blockly.svgResize(workspace);
});

init();
