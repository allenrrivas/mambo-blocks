/*
 * workspace.js — Blockly setup shared by the student and teacher views.
 */

import {
  defineBlocks, TOOLBOX, STARTER_PROGRAM, START_TYPE,
} from './blocks.js';

let blocksDefined = false;

/**
 * Inject a Blockly workspace.
 * Pass toolbox:false for the teacher's review pane, which shows a submitted
 * program rather than letting anyone edit it.
 */
export function createWorkspace(divId, { toolbox = true } = {}) {
  if (!blocksDefined) {
    defineBlocks();
    blocksDefined = true;
  }
  return Blockly.inject(divId, {
    toolbox: toolbox ? TOOLBOX : undefined,
    grid: { spacing: 24, length: 3, colour: '#e6e9ef', snap: true },
    zoom: { controls: true, wheel: true, startScale: 1.0, minScale: 0.4, maxScale: 2.0 },
    // readOnly silently forces every move option off unless they are passed
    // explicitly, which left the teacher unable to pan, scroll or wheel a
    // submission at all. The blocks stay locked; the canvas should not.
    move: { scrollbars: true, wheel: true, drag: true },
    trashcan: toolbox,
    readOnly: !toolbox,
    renderer: 'zelos', // chunky, Scratch-like blocks that suit touch
  });
}

export function saveProgram(workspace) {
  return Blockly.serialization.workspaces.save(workspace);
}

export function loadProgram(workspace, program) {
  Blockly.serialization.workspaces.load(program || STARTER_PROGRAM, workspace);
}

function startBlock(workspace) {
  return workspace.getTopBlocks(false).find((b) => b.type === START_TYPE) || null;
}

/**
 * The blocks that actually run, as the first block of each chain.
 *
 * With a "when started" block, that is only what hangs underneath it - loose
 * blocks elsewhere on the canvas are ignored, as in VEXcode. Programs saved
 * before the start block existed have none, and run every stack as they
 * always did, so older submissions in the queue still fly.
 *
 * The runner, the Python preview, the "What it will do" panel and the empty
 * check all use this, so they cannot disagree about what will fly.
 */
export function programRoots(workspace) {
  const start = startBlock(workspace);
  if (start) {
    const first = start.getNextBlock();
    return first ? [first] : [];
  }
  return workspace.getTopBlocks(true).filter((b) => !b.isShadow());
}

/** Blocks sitting on the canvas that will not run because nothing starts them. */
export function looseStacks(workspace) {
  if (!startBlock(workspace)) return 0;
  return workspace.getTopBlocks(false)
    .filter((b) => !b.isShadow() && b.type !== START_TYPE).length;
}

/**
 * Make sure there is exactly one "when started" block, and that it cannot be
 * thrown away. A student whose saved program predates the block gets one, with
 * their program snapped underneath, so their work keeps flying.
 */
export function ensureStartBlock(workspace) {
  let start = startBlock(workspace);
  if (!start) {
    const tops = workspace.getTopBlocks(true).filter((b) => !b.isShadow());
    start = Blockly.serialization.blocks.append({ type: START_TYPE, x: 170, y: 40 }, workspace);
    if (tops.length === 1 && tops[0].previousConnection) {
      const xy = tops[0].getRelativeToSurfaceXY();
      start.moveBy(xy.x - start.getRelativeToSurfaceXY().x, xy.y - 50 - start.getRelativeToSurfaceXY().y);
      start.nextConnection.connect(tops[0].previousConnection);
    }
  }
  start.setDeletable(false);
  return start;
}

/** Does this workspace actually contain anything runnable? */
export function isEmpty(workspace) {
  return programRoots(workspace).length === 0;
}

/** Field numbers arrive as 2 or "2"; render 2 rather than 2.0, 1.5 as 1.5. */
function num(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '0';
  return Number.isInteger(n) ? String(n) : String(parseFloat(n.toFixed(2)));
}

/** Loop counters by nesting depth, so nested repeats do not shadow i. */
const COUNTERS = ['i', 'j', 'k', 'm', 'n'];

/**
 * The Python equivalent of a block program, for the read-only preview.
 *
 * Deliberately a separate walker from runner.js rather than a code path the
 * drone uses: this only has to be readable and correct for a student to learn
 * from. It emits calls from the same API py-worker.js exposes, so what it
 * shows is genuinely runnable in Python mode.
 */
export function toPython(workspace) {
  const lines = [];

  const walk = (block, depth) => {
    let b = block;
    while (b) {
      const pad = '    '.repeat(depth);
      const f = (n) => b.getFieldValue(n);

      switch (b.type) {
        case 'mambo_takeoff': lines.push(`${pad}takeoff()`); break;
        case 'mambo_land': lines.push(`${pad}land()`); break;
        case 'mambo_hover': lines.push(`${pad}hover(${num(f('SECONDS'))})`); break;
        case 'mambo_move':
          lines.push(`${pad}fly("${f('DIRECTION')}", ${num(f('SECONDS'))}, ${num(f('SPEED'))})`);
          break;
        case 'mambo_turn':
          lines.push(`${pad}turn("${f('DIRECTION')}", ${num(f('DEGREES'))})`);
          break;
        case 'mambo_flip': lines.push(`${pad}flip("${f('DIRECTION')}")`); break;
        case 'mambo_multiflip':
          lines.push(`${pad}flip_times("${f('DIRECTION')}", ${num(f('TIMES'))}, ${num(f('GAP'))})`);
          break;
        case 'mambo_emergency': lines.push(`${pad}emergency()`); break;

        case 'controls_repeat_ext': {
          const target = b.getInputTargetBlock('TIMES');
          const times = target && target.type === 'math_number'
            ? num(target.getFieldValue('NUM'))
            : '1';
          const counter = COUNTERS[depth] || `x${depth}`;
          lines.push(`${pad}for ${counter} in range(${times}):`);
          const body = b.getInputTargetBlock('DO');
          if (body) walk(body, depth + 1);
          else lines.push(`${pad}    pass`); // an empty loop is still valid Python
          break;
        }

        default:
          lines.push(`${pad}# ${b.type}`);
      }

      b = b.getNextBlock();
    }
  };

  programRoots(workspace).forEach((b) => walk(b, 0));
  return lines.join('\n');
}

/**
 * Plain-English summary of a program, so the teacher can see what a
 * submission will do without reading blocks, and students can sanity-check
 * their own work before submitting.
 */
export function describe(workspace) {
  const lines = [];

  const walk = (block, depth) => {
    let b = block;
    while (b) {
      const pad = '  '.repeat(depth);
      const f = (n) => b.getFieldValue(n);
      switch (b.type) {
        case 'mambo_takeoff': lines.push(`${pad}take off`); break;
        case 'mambo_land': lines.push(`${pad}land`); break;
        case 'mambo_hover': lines.push(`${pad}hover ${f('SECONDS')}s`); break;
        case 'mambo_move':
          lines.push(`${pad}fly ${f('DIRECTION')} ${f('SECONDS')}s at speed ${f('SPEED')}`);
          break;
        case 'mambo_turn':
          lines.push(`${pad}turn ${f('DIRECTION')} ${f('DEGREES')}°`);
          break;
        case 'mambo_flip': lines.push(`${pad}flip ${f('DIRECTION')}`); break;
        case 'mambo_multiflip':
          lines.push(`${pad}flip ${f('DIRECTION')} ${f('TIMES')}x, ${f('GAP')}s apart`);
          break;
        case 'mambo_emergency': lines.push(`${pad}EMERGENCY STOP (motors off)`); break;
        case 'controls_repeat_ext': {
          const times = b.getInputTargetBlock('TIMES');
          const n = times && times.type === 'math_number' ? times.getFieldValue('NUM') : '?';
          lines.push(`${pad}repeat ${n} times:`);
          const body = b.getInputTargetBlock('DO');
          if (body) walk(body, depth + 1);
          break;
        }
        default: lines.push(`${pad}${b.type}`);
      }
      b = b.getNextBlock();
    }
  };

  programRoots(workspace).forEach((b) => walk(b, 0));

  // Say so when blocks are lying loose, or a student cannot tell why part of
  // their program never flew.
  const loose = looseStacks(workspace);
  if (loose) {
    lines.push('');
    lines.push(`(${loose} loose block${loose > 1 ? 's' : ''} not under "when started" — won't fly)`);
  }
  return lines;
}
