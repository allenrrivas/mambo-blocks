/*
 * junior-blocks.js — picture-only blocks for children who cannot read yet.
 *
 * Every block is an icon: a drone plus an arrow showing what it will do. There
 * are no words and no numbers to type; each block has fixed, gentle settings,
 * and a child repeats a move by stacking the block again.
 *
 * Junior blocks never reach the teacher as-is. On submit, toStandardProgram()
 * rewrites them into the ordinary blocks from blocks.js, so the server, the
 * teacher console and runner.js need no changes at all - the teacher sees a
 * normal, readable program.
 */

/* ---- icons -------------------------------------------------------------- */

const INK = '#fff';

function svg(body) {
  return `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none" stroke="${INK}" `
    + `stroke-width="5" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`,
  )}`;
}

/** Drone seen from above - used for moves across the floor and for turns. */
function topDrone(cx, cy) {
  const r = (dx, dy) => `<circle cx="${cx + dx}" cy="${cy + dy}" r="5"/>`;
  return `<path d="M${cx - 9} ${cy - 9}L${cx + 9} ${cy + 9}M${cx + 9} ${cy - 9}L${cx - 9} ${cy + 9}" stroke-width="3"/>`
    + `<g fill="${INK}" stroke="none">${r(-9, -9)}${r(9, -9)}${r(-9, 9)}${r(9, 9)}`
    + `<rect x="${cx - 5}" y="${cy - 5}" width="10" height="10" rx="2"/></g>`;
}

/** Drone seen from the side - used for going up, going down and flipping. */
function sideDrone(cx, cy) {
  return `<path d="M${cx - 16} ${cy}H${cx + 16}M${cx - 16} ${cy}V${cy - 6}M${cx + 16} ${cy}V${cy - 6}`
    + `M${cx - 23} ${cy - 7}H${cx - 9}M${cx + 9} ${cy - 7}H${cx + 23}" stroke-width="3.5"/>`
    + `<rect x="${cx - 8}" y="${cy - 3}" width="16" height="8" rx="3" fill="${INK}" stroke="none"/>`;
}

function arrow(x1, y1, x2, y2, head = 10) {
  const a = Math.atan2(y2 - y1, x2 - x1);
  const tip = (t) => [x2 - head * Math.cos(a + t), y2 - head * Math.sin(a + t)].map((n) => n.toFixed(1));
  const [ax, ay] = tip(0.6);
  const [bx, by] = tip(-0.6);
  return `<path d="M${x1} ${y1}L${x2} ${y2}M${ax} ${ay}L${x2} ${y2}L${bx} ${by}"/>`;
}

// A ground line is what tells "take off"/"land" apart from "up"/"down".
const GROUND = '<path d="M6 58H58" stroke-width="4"/>';

export const ICONS = {
  start: svg('<path d="M18 58V8" /><path d="M18 10H48L40 21L48 32H18Z" fill="#fff"/>'),
  takeoff: svg(GROUND + sideDrone(32, 48) + arrow(32, 30, 32, 6)),
  land: svg(GROUND + sideDrone(32, 48) + arrow(32, 6, 32, 30)),
  up: svg(sideDrone(32, 38) + arrow(32, 27, 32, 4)),
  down: svg(sideDrone(32, 20) + arrow(32, 30, 32, 58)),
  forward: svg(topDrone(32, 42) + arrow(32, 24, 32, 4)),
  back: svg(topDrone(32, 22) + arrow(32, 40, 32, 60)),
  left: svg(topDrone(42, 32) + arrow(24, 32, 4, 32)),
  right: svg(topDrone(22, 32) + arrow(40, 32, 60, 32)),
  // The arc is centred on the drone and clears its rotors.
  turnRight: svg(topDrone(32, 32) + '<path d="M32 7A25 25 0 0 1 57 32"/><path d="M51 26L57 33L63 26"/>'),
  turnLeft: svg(topDrone(32, 32) + '<path d="M32 7A25 25 0 0 0 7 32"/><path d="M1 26L7 33L13 26"/>'),
  flip: svg(sideDrone(32, 44) + '<path d="M12 34A20 20 0 0 1 52 34"/><path d="M45 28L52 35L59 28"/>'),
  wait: svg('<path d="M20 8H44M20 56H44M23 8L41 8L32 32L41 56L23 56L32 32Z"/>'
    + '<path d="M26 54H38L32 45Z" fill="#fff" stroke="none"/>'),
  repeat: svg('<path d="M14 30A18 18 0 0 1 46 18"/><path d="M38 14L46 18L44 26"/>'
    + '<path d="M50 34A18 18 0 0 1 18 46"/><path d="M26 50L18 46L20 38"/>'),
  send: svg('<path d="M8 30L56 8L42 56L30 36Z" fill="#fff" stroke-width="3"/><path d="M30 36L56 8"/>'),
};

/** Dots stand in for the numbers 2-4, which a non-reader can count. */
function dots(n) {
  const gap = 18;
  const start = 32 - ((n - 1) * gap) / 2;
  let body = '';
  for (let i = 0; i < n; i += 1) {
    body += `<circle cx="${start + i * gap}" cy="32" r="7" fill="#fff" stroke="none"/>`;
  }
  return svg(body);
}

/* ---- blocks ------------------------------------------------------------- */

const SIZE = 48;
const img = (src) => ({ type: 'field_image', src, width: SIZE, height: SIZE, alt: '' });

const COLOURS = { start: 120, air: 200, move: 230, turn: 290, wait: 35, repeat: 60 };

/*
 * What each junior block means, in ordinary blocks.json terms. Settings are
 * fixed and deliberately gentle: 1 second at speed 20 for every move, half the
 * reading page's default. Only moves have a speed at all - take off, land,
 * turn and flip run at whatever the drone's own firmware does.
 */
const JUNIOR_SPEED = 20;
const MOVE = (direction) => ({
  type: 'mambo_move',
  fields: { DIRECTION: direction, SECONDS: 1, SPEED: JUNIOR_SPEED },
});

const MEANING = {
  junior_takeoff: () => ({ type: 'mambo_takeoff' }),
  junior_land: () => ({ type: 'mambo_land' }),
  junior_up: () => MOVE('up'),
  junior_down: () => MOVE('down'),
  junior_forward: () => MOVE('forward'),
  junior_back: () => MOVE('backward'),
  junior_left: () => MOVE('left'),
  junior_right: () => MOVE('right'),
  junior_turn_left: () => ({ type: 'mambo_turn', fields: { DIRECTION: 'left', DEGREES: 90 } }),
  junior_turn_right: () => ({ type: 'mambo_turn', fields: { DIRECTION: 'right', DEGREES: 90 } }),
  junior_flip: () => ({ type: 'mambo_flip', fields: { DIRECTION: 'front' } }),
  junior_wait: () => ({ type: 'mambo_hover', fields: { SECONDS: 2 } }),
  junior_repeat: (b) => ({
    type: 'controls_repeat_ext',
    inputs: { TIMES: { shadow: { type: 'math_number', fields: { NUM: Number(b.fields.TIMES) || 2 } } } },
  }),
};

const SIMPLE = [
  ['junior_takeoff', ICONS.takeoff, COLOURS.air],
  ['junior_land', ICONS.land, COLOURS.air],
  ['junior_up', ICONS.up, COLOURS.move],
  ['junior_down', ICONS.down, COLOURS.move],
  ['junior_forward', ICONS.forward, COLOURS.move],
  ['junior_back', ICONS.back, COLOURS.move],
  ['junior_left', ICONS.left, COLOURS.move],
  ['junior_right', ICONS.right, COLOURS.move],
  ['junior_turn_left', ICONS.turnLeft, COLOURS.turn],
  ['junior_turn_right', ICONS.turnRight, COLOURS.turn],
  ['junior_flip', ICONS.flip, COLOURS.turn],
  ['junior_wait', ICONS.wait, COLOURS.wait],
];

export function defineJuniorBlocks() {
  Blockly.defineBlocksWithJsonArray([
    {
      // Only blocks snapped under the flag are sent, as in ScratchJr, so stray
      // blocks a child leaves lying around never fly.
      type: 'junior_start',
      message0: '%1',
      args0: [img(ICONS.start)],
      nextStatement: null,
      colour: COLOURS.start,
    },
    ...SIMPLE.map(([type, src, colour]) => ({
      type,
      message0: '%1',
      args0: [img(src)],
      previousStatement: null,
      nextStatement: null,
      colour,
    })),
    {
      type: 'junior_repeat',
      message0: '%1 %2',
      args0: [
        img(ICONS.repeat),
        {
          type: 'field_dropdown',
          name: 'TIMES',
          options: [2, 3, 4].map((n) => [{ src: dots(n), width: 40, height: 40, alt: '' }, String(n)]),
        },
      ],
      message1: '%1',
      args1: [{ type: 'input_statement', name: 'DO' }],
      previousStatement: null,
      nextStatement: null,
      colour: COLOURS.repeat,
    },
  ]);
}

/*
 * One always-open strip of blocks. Category names would be words, and the
 * whole point is that nothing here needs reading.
 */
const TIGHT = { kind: 'sep', gap: 8 };

export const JUNIOR_TOOLBOX = {
  kind: 'flyoutToolbox',
  // Tight gaps so all thirteen blocks fit across an iPad without scrolling;
  // at Blockly's default spacing, repeat fell off the right-hand edge.
  contents: [
    ...SIMPLE.flatMap(([type]) => [{ kind: 'block', type }, TIGHT]),
    { kind: 'block', type: 'junior_repeat', fields: { TIMES: '2' } },
  ],
};

export const JUNIOR_STARTER = {
  blocks: {
    languageVersion: 0,
    blocks: [{ type: 'junior_start', x: 40, y: 40, deletable: false }],
  },
};

/* ---- converting for the teacher ----------------------------------------- */

function convert(block) {
  const make = MEANING[block.type];
  if (!make) throw new Error(`unknown junior block ${block.type}`);
  const out = make(block);
  if (block.type === 'junior_repeat') {
    const body = block.inputs && block.inputs.DO && block.inputs.DO.block;
    if (body) out.inputs.DO = { block: convert(body) };
  }
  if (block.next && block.next.block) out.next = { block: convert(block.next.block) };
  return out;
}

/**
 * Turn a saved junior workspace into an ordinary blocks program, or return
 * null if nothing is snapped under the flag.
 */
export function toStandardProgram(saved) {
  const tops = (saved && saved.blocks && saved.blocks.blocks) || [];
  const start = tops.find((b) => b.type === 'junior_start');
  const first = start && start.next && start.next.block;
  if (!first) return null;
  // Hang it under "when started", so it reads in the teacher's console exactly
  // like a program from the reading page. The green flag is its junior twin.
  return {
    blocks: {
      languageVersion: 0,
      blocks: [{
        type: 'mambo_when_started', x: 40, y: 40, deletable: false, next: { block: convert(first) },
      }],
    },
  };
}
