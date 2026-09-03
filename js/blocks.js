/*
 * blocks.js — the block vocabulary kids see, plus the toolbox layout.
 *
 * Blocks carry no behaviour. runner.js walks the block tree and decides
 * what each one does, so nothing here can execute arbitrary code.
 */

const HUE_FLIGHT = 200;
const HUE_MOVE = 160;
const HUE_TRICK = 290;
const HUE_DANGER = 0;

export function defineBlocks() {
  Blockly.defineBlocksWithJsonArray([
    {
      type: 'mambo_takeoff',
      message0: 'take off',
      previousStatement: null,
      nextStatement: null,
      colour: HUE_FLIGHT,
      tooltip: 'Lift off and hover in place.',
    },
    {
      type: 'mambo_land',
      message0: 'land',
      previousStatement: null,
      nextStatement: null,
      colour: HUE_FLIGHT,
      tooltip: 'Come down gently and stop the motors.',
    },
    {
      type: 'mambo_hover',
      message0: 'hover for %1 seconds',
      args0: [
        { type: 'field_number', name: 'SECONDS', value: 1, min: 0.1, max: 10, precision: 0.1 },
      ],
      previousStatement: null,
      nextStatement: null,
      colour: HUE_FLIGHT,
      tooltip: 'Stay still in the air.',
    },
    {
      type: 'mambo_move',
      message0: 'fly %1 for %2 seconds at speed %3',
      args0: [
        {
          type: 'field_dropdown',
          name: 'DIRECTION',
          options: [
            ['forward', 'forward'],
            ['backward', 'backward'],
            ['left', 'left'],
            ['right', 'right'],
            ['up', 'up'],
            ['down', 'down'],
          ],
        },
        { type: 'field_number', name: 'SECONDS', value: 1, min: 0.1, max: 10, precision: 0.1 },
        { type: 'field_number', name: 'SPEED', value: 40, min: 5, max: 100, precision: 5 },
      ],
      previousStatement: null,
      nextStatement: null,
      colour: HUE_MOVE,
      tooltip: 'Move in one direction. Speed is a percentage.',
    },
    {
      type: 'mambo_turn',
      message0: 'turn %1 %2 degrees',
      args0: [
        {
          type: 'field_dropdown',
          name: 'DIRECTION',
          options: [['right', 'right'], ['left', 'left']],
        },
        { type: 'field_number', name: 'DEGREES', value: 90, min: 1, max: 180, precision: 1 },
      ],
      previousStatement: null,
      nextStatement: null,
      colour: HUE_MOVE,
      tooltip: 'Spin in place without moving.',
    },
    {
      type: 'mambo_flip',
      message0: 'flip %1',
      args0: [
        {
          type: 'field_dropdown',
          name: 'DIRECTION',
          options: [
            ['forward', 'front'],
            ['backward', 'back'],
            ['left', 'left'],
            ['right', 'right'],
          ],
        },
      ],
      previousStatement: null,
      nextStatement: null,
      colour: HUE_TRICK,
      tooltip: 'Do a barrel roll. Needs about 1.5 m of clear space.',
    },
    {
      type: 'mambo_multiflip',
      message0: 'flip %1 %2 times in a row, %3 s apart',
      args0: [
        {
          type: 'field_dropdown',
          name: 'DIRECTION',
          options: [
            ['forward', 'front'],
            ['backward', 'back'],
            ['left', 'left'],
            ['right', 'right'],
          ],
        },
        { type: 'field_number', name: 'TIMES', value: 3, min: 2, max: 5, precision: 1 },
        { type: 'field_number', name: 'GAP', value: 1.2, min: 0.2, max: 3, precision: 0.1 },
      ],
      previousStatement: null,
      nextStatement: null,
      colour: HUE_TRICK,
      tooltip: 'Chain flips back to back without settling in between. Each flip '
        + 'loses height, so climb first and leave plenty of room. Gaps under '
        + 'about a second may be ignored by the drone.',
    },
    {
      type: 'mambo_emergency',
      message0: 'EMERGENCY STOP',
      previousStatement: null,
      nextStatement: null,
      colour: HUE_DANGER,
      tooltip: 'Cut the motors immediately. The drone will fall.',
    },
  ]);
}

export const TOOLBOX = {
  kind: 'categoryToolbox',
  contents: [
    {
      kind: 'category',
      name: 'Flight',
      colour: HUE_FLIGHT,
      contents: [
        { kind: 'block', type: 'mambo_takeoff' },
        { kind: 'block', type: 'mambo_hover' },
        { kind: 'block', type: 'mambo_land' },
      ],
    },
    {
      kind: 'category',
      name: 'Move',
      colour: HUE_MOVE,
      contents: [
        { kind: 'block', type: 'mambo_move' },
        { kind: 'block', type: 'mambo_turn' },
      ],
    },
    {
      kind: 'category',
      name: 'Tricks',
      colour: HUE_TRICK,
      contents: [
        { kind: 'block', type: 'mambo_flip' },
        { kind: 'block', type: 'mambo_multiflip' },
      ],
    },
    {
      kind: 'category',
      name: 'Repeat',
      colour: 120,
      contents: [
        {
          kind: 'block',
          type: 'controls_repeat_ext',
          inputs: {
            TIMES: { shadow: { type: 'math_number', fields: { NUM: 3 } } },
          },
        },
      ],
    },
    {
      kind: 'category',
      name: 'Safety',
      colour: HUE_DANGER,
      contents: [{ kind: 'block', type: 'mambo_emergency' }],
    },
  ],
};

/** A short starter program so a fresh workspace is never empty. */
export const STARTER_PROGRAM = {
  blocks: {
    languageVersion: 0,
    blocks: [
      {
        type: 'mambo_takeoff',
        x: 170,
        y: 60,
        next: {
          block: {
            type: 'mambo_hover',
            fields: { SECONDS: 2 },
            next: {
              block: { type: 'mambo_land' },
            },
          },
        },
      },
    ],
  },
};
