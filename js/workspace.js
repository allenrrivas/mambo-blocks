/*
 * workspace.js — Blockly setup shared by the student and teacher views.
 */

import { defineBlocks, TOOLBOX, STARTER_PROGRAM } from './blocks.js';

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

/** Does this workspace actually contain anything runnable? */
export function isEmpty(workspace) {
  return workspace.getTopBlocks(false).filter((b) => !b.isShadow()).length === 0;
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

  workspace.getTopBlocks(true).filter((b) => !b.isShadow()).forEach((b) => walk(b, 0));
  return lines;
}
