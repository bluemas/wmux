// Chibi office workers, hand-drawn as letter templates (one letter = one pixel)
// and coloured per look. Templates hold materials, not colours: `H` hair,
// `K` skin, `T` top, `P` trousers, `Z` shoes and so on. Capital letters are
// shaded automatically (light from the top-left, a cast shadow under any other
// material); lower-case and the extra letters pin a tone by hand.
import { BASE, DARK, HI, LIGHT, Layer, SHADE, compose, outline } from './raster.mjs';
import { RAMPS } from './palette.mjs';
import { BOSS_FRAME, BOSS_SEAT, STATION, drawBossChair, drawBossDesk, drawChair, iso } from './furniture.mjs';

export const POSES = ['sit', 'type1', 'type2', 'raiseHand', 'rest1', 'rest2', 'walk1', 'walk2', 'standRaise'];

/** letter -> [role, tone | 'auto'] */
const LETTERS = {
  H: ['hair', 'auto'],
  i: ['hair', HI],
  j: ['hair', LIGHT],
  h: ['hair', SHADE],
  J: ['hair', DARK],
  K: ['skin', 'auto'],
  l: ['skin', LIGHT],
  k: ['skin', SHADE],
  T: ['top', 'auto'],
  y: ['top', LIGHT],
  t: ['top', SHADE],
  Y: ['top', DARK],
  U: ['top2', 'auto'],
  u: ['top2', SHADE],
  P: ['pants', 'auto'],
  p: ['pants', SHADE],
  Z: ['shoes', 'auto'],
  z: ['shoes', SHADE],
  R: ['acc', 'auto'],
  r: ['acc', SHADE],
  q: ['acc', LIGHT],
  E: ['eye', DARK],
  e: ['eye', LIGHT],
  W: ['white', HI],
  M: ['mouth', BASE],
  B: ['blush', BASE],
  G: ['mug', 'auto'],
  g: ['mug', SHADE],
  C: ['coffee', BASE],
  F: ['frame', BASE],
};
const DECALS = new Set(['eye', 'white', 'mouth', 'blush', 'frame']);

// ---------------------------------------------------------------------------
// Heads: a 20x19 grid. The face fills rows 3..18; hair overlays draw on top
// ('.' keeps what is below). Front = facing south-west (towards the viewer),
// back = facing north-east (towards a desk).

const FACE_FRONT = [
  '....................',
  '....................',
  '....................',
  '.......KKKKKK.......',
  '.....KKKKKKKKKK.....',
  '....KKKKKKKKKKKK....',
  '...KKKKKKKKKKKKKK...',
  '...KKKKKKKKKKKKKK...',
  '..KKKKKKKKKKKKKKKK..',
  '..KKKKKKKKKKKKKKKK..',
  '..KKKKKKKKKKKKKKKK..',
  '..KKKKKKKKKKKKKKKkK.',
  '..KKKWEKKKKWEKKKkKK.',
  '..KKKEEKKKKEEKKKkkK.',
  '..KKBBKKKKKKBBKKKkK.',
  '...KKKKKKMMKKKKKKK..',
  '....KKKKKKKKKKKKKk..',
  '.....kKKKKKKKKKKk...',
  '.......kkkkkkk......',
];
// Eyes closed (a happy sip).
const FACE_FRONT_CLOSED = FACE_FRONT.map((row, y) =>
  y === 12 ? '..KKKKKKKKKKKKKKkKK.' : y === 13 ? '..KKKEEKKKKEEKKKkkK.' : row,
);

const FACE_BACK = [
  '....................',
  '....................',
  '....................',
  '.......KKKKKK.......',
  '.....KKKKKKKKKK.....',
  '....KKKKKKKKKKKK....',
  '...KKKKKKKKKKKKKK...',
  '...KKKKKKKKKKKKKK...',
  '..KKKKKKKKKKKKKKKK..',
  '..KKKKKKKKKKKKKKKK..',
  '..KKKKKKKKKKKKKKKK..',
  '..KKKKKKKKKKKkKKKK..',
  '..KKKKKKKKKKkkKKKK..',
  '..KKKKKKKKKKKkKKKB..',
  '..KKKKKKKKKKKKKKKk..',
  '...KKKKKKKKKKKKKk...',
  '....KKKKKKKKKKKKk...',
  '.....kKKKKKKKKKk....',
  '.......kkkkkkk......',
];

/**
 * Hair styles. `front`/`back` overlay the head grid; `frontBehind` is drawn
 * before the body in front views (hair hanging behind the shoulders). Rows
 * may run past row 18 (long hair over the back). `x`/`y` offsets let an
 * overlay start outside the 20x19 grid.
 */
const HAIR = {
  spiky: {
    front: [
      '.....i..i..i..i.....',
      '....HjHHjHHiHHjH....',
      '...HjjjHHHHHHHHHH...',
      '..HjjjHHHHHHHHHHHH..',
      '..HjjHHHHHHHHHHHHHh.',
      '.HjjHHHHHHHHHHHHHHh.',
      '.HjHHHHHHHHHHHHHHHh.',
      '.HHHHHHHHHHHHHHHHHh.',
      '.HHHHHHHHHHHHHHHHhh.',
      '.HHHHHHHHhHHHHHHHhh.',
      '.HHHhHHHh.hHHHHHHh..',
      '.hHh.hHh...hH..hHh..',
      '.hh.................',
      '.h..................',
    ],
    back: [
      '.....i..i..i..i.....',
      '....HjHHjHHiHHjH....',
      '...HjjHHHHHHHHHHH...',
      '..HjjHHHHHHHHHHHHH..',
      '..HjHHHHHHHHHHHHHHh.',
      '.HjHHHHHHHHHHHHHHHh.',
      '.HjHHHHHHHHHHHHHHHh.',
      '.HHHHHHHHHHHHHHHHHh.',
      '.HHHHHHHHHHHHHHHHhh.',
      '.HHHHHHHHHHHHHHHHh..',
      '.HHHHHHHHHHHHHHHh...',
      '.HHHHHHHHHHHh...h...',
      '.hHHHHHHHHHHh.......',
      '..hHHHHHHHHHh.......',
      '..hhHHHHHHHh........',
      '...hhhhhhhh.........',
    ],
  },
  bob: {
    front: [
      '....................',
      '.......HHHHHH.......',
      '.....HHjjHHHHHH.....',
      '....HjjjHHHHHHHH....',
      '...HjjHHHHHHHHHHH...',
      '..HjjHHHHHHHHHHHHH..',
      '..HjHHHHHHHHHHHHHHh.',
      '.HjHHHHHHHHHHHHHHHh.',
      '.HHHHHHHHHHHHHHHHHh.',
      '.HHHHHHHHHHHHHHHHHh.',
      '.HHHHHHHHHHHHHHHHHh.',
      '.HHHhhhhhhhhhhhhHHh.',
      '.HHh............HHh.',
      '.HHh............HHh.',
      '.HHh............HHh.',
      '.HHhh..........hhHh.',
      '.hhh...........hhh..',
    ],
    back: [
      '....................',
      '.......HHHHHH.......',
      '.....HHjjHHHHHH.....',
      '....HjjjHHHHHHHH....',
      '...HjjHHHHHHHHHHH...',
      '..HjjHHHHHHHHHHHHH..',
      '..HjHHHHHHHHHHHHHHh.',
      '.HjHHHHHHHHHHHHHHHh.',
      '.HHHHHHHHHHHHHHHHHh.',
      '.HHHHHHHHHHHHHHHHHh.',
      '.HHHHHHHHHHHHHHHHh..',
      '.HHHHHHHHHHHHHHHh...',
      '.HHHHHHHHHHHHHHHh...',
      '.HHHHHHHHHHHHHHHh...',
      '.HHHHHHHHHHHHHHHh...',
      '.hHHHHHHHHHHHHHhh...',
      '..hhhhhhhhhhhhhh....',
    ],
  },
  curly: {
    front: [
      '.....HHH.HHH.HH.....',
      '...HHHjHHHjHHHHHH...',
      '..HHjjHHHjjHHHHHHH..',
      '.HHjjHHHHHHHHHHHHHH.',
      '.HjHHHHhHHHHHhHHHHHh',
      'HHjHHHHHHHHHHHHHHHHh',
      'HHHHHhHHHHhHHHHHHHhh',
      'HHHHHHHHHHHHHHHHHHHh',
      'HHHHHHHHHHHHHHHHHHhh',
      'HHHHHhHHHHHhHHHHHHh.',
      'HHHHHHHHHHHHHHHHHHh.',
      'HHHhHhh.hHh.hhHHHhh.',
      'hHHh............HHh.',
      '.hHh............Hhh.',
      '.hh.............hh..',
    ],
    back: [
      '.....HHH.HHH.HH.....',
      '...HHHjHHHjHHHHHH...',
      '..HHjjHHHjjHHHHHHH..',
      '.HHjjHHHHHHHHHHHHHH.',
      '.HjHHHHhHHHHHhHHHHHh',
      'HHjHHHHHHHHHHHHHHHHh',
      'HHHHHhHHHHhHHHHHHHhh',
      'HHHHHHHHHHHHHHHHHHHh',
      'HHHhHHHHHhHHHHHHHHhh',
      'HHHHHHHHHHHHHhHHHHh.',
      'HHHHHhHHHHHHHHHHHh..',
      'HHHHHHHHHHhHH...Hh..',
      'hHHHHHHHHHHHh.......',
      '.hHHHhHHHHHHh.......',
      '.hhHHHHHHHHhh.......',
      '..hhhhhhhhhh........',
    ],
  },
  long: {
    front: [
      '....................',
      '.......HHHHHH.......',
      '.....HHjjHHHHHH.....',
      '....HjjHHHHHHHHH....',
      '...HjjHHHHHHHHHHH...',
      '..HjjHHHHHHHHHHHHH..',
      '..HjHHHHHHHHHHHHHHh.',
      '.HjHHHHHHHHHHHHHHHh.',
      '.HHHHHHHHHHHHHHHHHh.',
      '.HHHHHHHhhHHHHHHHHh.',
      '.HHHHHHh..hHHHHHHHh.',
      '.HHHHHh....hhHHHHHh.',
      '.HHh..........hHHHh.',
      '.HHh...........HHHh.',
      '.HHh...........HHh..',
      '.HHh...........HHh..',
      '.HHHh.........hHHh..',
      '.HHHh.........hHHh..',
      '.HHHh..........HHh..',
    ],
    frontBehind: {
      y: 12,
      rows: [
        '.HHH............HHh.',
        '.HHH............HHh.',
        '.HHH............HHh.',
        '.HHH............HHh.',
        '.HHH............HHh.',
        'HHHHH..........HHHh.',
        'HHHHH..........HHHh.',
        'HHHHH..........HHHh.',
        'hHHHh..........hHhh.',
        'hHHHh..........hHh..',
        '.hHHh...........hh..',
        '..hh................',
      ],
    },
    back: [
      '....................',
      '.......HHHHHH.......',
      '.....HHjjHHHHHH.....',
      '....HjjjHHHHHHHH....',
      '...HjjHHHHHHHHHHH...',
      '..HjjHHHHHHHHHHHHH..',
      '..HjHHHHHHHHHHHHHHh.',
      '.HjHHHHHHHHHHHHHHHh.',
      '.HHHHHHHHHHHHHHHHHh.',
      '.HHHHHHHHHHHHHHHHHh.',
      '.HHHHHHHHHHHHHHHHh..',
      '.HHHHHHHHHHHHHHHh...',
      '.HHHHHHHHHHHHHHHh...',
      '.HHHHHHHHHHHHHHHh...',
      '.HHHHHHHHHHHHHHHh...',
      '.HHHHHHHHHHHHHHHh...',
      '.HHHHHHHHHHHHHHHh...',
      '.HHHHHHHHHHHHHHHh...',
      '.HHHHhHHHHHHHHHHh...',
      '..HHHhHHHHHhHHHh....',
      '..HHHHhHHHHhHHHh....',
      '..hHHHhHHHHHhHHh....',
      '...hHHHHHHHHHhh.....',
      '....hhhhhhhhhh......',
    ],
  },
  bun: {
    front: [
      '........HHHH........',
      '.......HjjHHH.......',
      '.......HjHHHh.......',
      '.....HHHhhhhHHH.....',
      '...HHjjjHHHHHHHH....',
      '..HjjHHHHHHHHHHHHH..',
      '..HjHHHHHHHHHHHHHHh.',
      '.HjHHHHHHHHHHHHHHHh.',
      '.HHHHHHHHHHHHHHHHHh.',
      '.HHHHHHHHHHHHHHHHHh.',
      '.HHHHhhHHHHHHHHHHh..',
      '.HHh...hhHHHHHHhhh..',
      '.Hh............h....',
      '.h..................',
    ],
    back: [
      '........HHHH........',
      '.......HjjHHH.......',
      '.......HjHHHh.......',
      '.....HHHhhhhHHH.....',
      '...HHjjjHHHHHHHH....',
      '..HjjHHHHHHHHHHHHH..',
      '..HjHHHHHHHHHHHHHHh.',
      '.HjHHHHHHHHHHHHHHHh.',
      '.HHHHHHHHHHHHHHHHHh.',
      '.HHHHHHHHHHHHHHHHh..',
      '.HHHHHHHHHHHHHHHh...',
      '.HHHHHHHHHHHh...h...',
      '.hHHHHHHHHHHh.......',
      '..hHHHHHHHHh........',
      '...hhhhhhhh.........',
    ],
  },
  ponytail: {
    front: [
      '....................',
      '.......HHHHHH.......',
      '.....HHjjHHHHHH.....',
      '....HjjjHHHHHHHH....',
      '...HjjHHHHHHHHHHH...',
      '..HjjHHHHHHHHHHHHH..',
      '..HjHHHHHHHHHHHHHHh.',
      '.HjHHHHHHHHHHHHHHHh.',
      '.HHHHHHHHHHHHHHHHHh.',
      '.HHHHHHHHHHHHHHHHHh.',
      '.HHHHHHhHHHHhHHHHh..',
      '.HHhhh..hhhh..hHHh..',
      '.Hh.............h...',
      '.h..................',
    ],
    frontBehind: {
      x: 14,
      y: 4,
      rows: [
        '....RR...',
        '...HHHH..',
        '...HjHHH.',
        '....HHHHh',
        '....HHHHh',
        '....HHHHh',
        '....HHHhh',
        '....hHHHh',
        '.....HHHh',
        '.....HHHh',
        '.....hHHh',
        '......Hh.',
        '......h..',
      ],
    },
    back: [
      '....................',
      '.......HHHHHH.......',
      '.....HHjjHHHHHH.....',
      '....HjjjHHHHHHHH....',
      '...HjjHHHHHHHHHHH...',
      '..HjjHHHHHHHHHHHHH..',
      '..HjHHHHHHHHHHHHHHh.',
      '.HjHHHHHHHHHHHHHHHh.',
      '.HHHHHHHHHHHHHHHHHh.',
      '.HHHHHHHRRRHHHHHHh..',
      '.HHHHHHHrrrHHHHHh...',
      '.HHHHHHHHHHHh...h...',
      '.hHHHHHHHHHHh.......',
      '..hHHHHjHHHh........',
      '...hhhHjHHhh........',
      '......HjHHh.........',
      '......HHHHh.........',
      '......hHHHh.........',
      '......hHHh..........',
      '.......hHh..........',
      '.......hh...........',
    ],
  },
  beanie: {
    front: [
      '....................',
      '.......RRRRRR.......',
      '.....RRqqRRRRRR.....',
      '....RqqRRRRRRRRR....',
      '...RqRRRRRRRRRRRR...',
      '..RqRRRRRRRRRRRRRR..',
      '..RRRRRRRRRRRRRRRRr.',
      '.RRRRRRRRRRRRRRRRRr.',
      '.qRqRqRqRqRqRqRqRqr.',
      '.RrRrRrRrRrRrRrRrRr.',
      '.rrrrrrrrrrrrrrrrrr.',
      '.HHhH.HhH......HHh..',
      '.Hh.............h...',
    ],
    back: [
      '....................',
      '.......RRRRRR.......',
      '.....RRqqRRRRRR.....',
      '....RqqRRRRRRRRR....',
      '...RqRRRRRRRRRRRR...',
      '..RqRRRRRRRRRRRRRR..',
      '..RRRRRRRRRRRRRRRRr.',
      '.RRRRRRRRRRRRRRRRRr.',
      '.qRqRqRqRqRqRqRqRqr.',
      '.RrRrRrRrRrRrRrRrRr.',
      '.rrrrrrrrrrrrrrrrr..',
      '.HHHHHHHHHHHh...h...',
      '.hHHHHHHHHHHh.......',
      '..hHHHHHHHHh........',
      '...hhhhhhhh.........',
    ],
  },
  sidepart: {
    front: [
      '....................',
      '.......HHHHHH.......',
      '.....HHHHHjjHHH.....',
      '....HHHHHjjjHHHH....',
      '...HHHHHjjHHHHHHH...',
      '..HHHHHjjHHHHHHHHH..',
      '..HHHHjjHHHHHHHHHHh.',
      '.HHHHjHHHHHHHHHHHHh.',
      '.HHHHHHHHHHHHHHHHHh.',
      '.HHHHHHHHHHHHHHHHHh.',
      '.HhHHHHHHHHHHHHHHhh.',
      '.h.hhhHHHHHHhh.hHh..',
      '.h......hhh.....h...',
    ],
    back: [
      '....................',
      '.......HHHHHH.......',
      '.....HHHHHjjHHH.....',
      '....HHHHHjjjHHHH....',
      '...HHHHHjjHHHHHHH...',
      '..HHHHHjjHHHHHHHHH..',
      '..HHHHjjHHHHHHHHHHh.',
      '.HHHHjHHHHHHHHHHHHh.',
      '.HHHHHHHHHHHHHHHHHh.',
      '.HHHHHHHHHHHHHHHHh..',
      '.HHHHHHHHHHHHHHHh...',
      '.HHHHHHHHHHHh...h...',
      '.hHHHHHHHHHHh.......',
      '..hHHHHHHHHh........',
      '...hhhhhhhh.........',
    ],
  },
  // The boss: combed back with a side part (front view only; the boss faces the room).
  slick: {
    front: [
      '....................',
      '......iiHHHHH.......',
      '....HjjjjHHHHHH.....',
      '...HjjHHHHHHHHHH....',
      '..HjjHHHHHHHHHHHH...',
      '..HjHHHHHHHHHHHHHh..',
      '.HjHHHHHHHHHHHHHHHh.',
      '.HHHHHHHHHHHHHHHHHh.',
      '.HHHHHHHHHHHHHHHHHh.',
      '.HHHhhhhhhHHHHHHHhh.',
      '.HHh......hhhhhHHh..',
      '.hh.............hh..',
    ],
  },
  // The generic look: hood up. Uses the top's colours, with a lock of hair.
  hood: {
    front: [
      '......TTTTTTTT......',
      '....TTyyTTTTTTTT....',
      '...TyyTTTTTTTTTTT...',
      '..TyTTTTTTTTTTTTTT..',
      '..TyTTTTTTTTTTTTTTt.',
      '.TyTTTTTTTTTTTTTTTt.',
      '.TyTTTTTTTTTTTTTTTt.',
      '.TTTTTtttttttTTTTTt.',
      '.TTTtHHHHHHHHHtTTTt.',
      '.TTtHHHHHHHhHHHtTTt.',
      '.TTtHhHHhh.hhHHHtTt.',
      '.TTt...........ktTt.',
      '.TTt............tTt.',
      '.TTt............tTt.',
      '.TTt............tTt.',
      '.TTTt..........tTTt.',
      '.tTTTt........tTTtt.',
      '..ttTTt......tTTtt..',
    ],
    back: [
      '......TTTTTTTT......',
      '....TTyyTTTTTTTT....',
      '...TyyTTTTTTTTTTT...',
      '..TyTTTTTTTTTTTTTT..',
      '..TyTTTTTTTTTTTTTTt.',
      '.TyTTTTTTTTTTTTTTTt.',
      '.TyTTTTTTTTTTTTTTTt.',
      '.TTTTTTTTTTTTTTTTTt.',
      '.TTTTTTTTTTTTTTTTTt.',
      '.TTTTTTTTTTTTTTTTt..',
      '.TTTTTTTTTTTTTTTtt..',
      '.TTTTTTTTTTTTTTtk...',
      '.TTTTTTTTTTTTTTtk...',
      '.tTTTTTTTTTTTTTt....',
      '..tTTTTTTTTTTTt.....',
      '..ttTTTTTTTTTtt.....',
      '...tttttttttt.......',
    ],
  },
};

// Glasses: drawn over the face in front views, an arm by the ear in back views.
const GLASSES_FRONT = [
  ...Array(11).fill('....................'),
  '....FFFF..FFFF......',
  '....F..FFFF..FFFF...',
  '....F..F..F..F......',
];
const GLASSES_BACK = [...Array(12).fill('....................'), '..............FFF...'];

// ---------------------------------------------------------------------------
// Bodies. Each template has an origin in station-frame pixels. Seated poses
// face north-east (back view) at the desk; rest and walk face south-west.
// `over` layers draw after the head (an arm in front of the face, a mug).

const HEAD_BACK = { x: 8, y: 10 };
const HEAD_FRONT_WALK = { x: 12, y: 14 };
const HEAD_FRONT_REST = { x: 12, y: 13 };

const SIT_ORIGIN = { x: 8, y: 26 };
const SIT_BASE = [
  '........KKKK..................',
  '.......KKkkK..................',
  '.....TTTTTTTTTTT..............',
  '....TTTTTTTTTTTTTT............',
  '...TTTTTTTTTTTTTtTT...........',
  '...TTTTTTTTTTTTTtTTT..........',
  '...TTTTTTTTTTTTTtTTTT.........',
  '...TTTTTTTTTTTTTtTTTTTT.......',
  '...TTTTTTTTTTTTTtTTTTTTT......',
  '...tTTTTTTTTTTTTtTTtTTTT......',
  '...tTTTTTTTTTTTTTPPPPPP.......',
  '...ttTTTTTTTTTTTPPPPPPPP......',
  '....tttTTTTTTTTPPPPPPPPPP.....',
  '.....PPPPPPPPPPPPPPPPPPPp.....',
  '.....PPPPPPPPPPPPPPP..PPp.....',
  '......PPPPPPPPPPPP....PPp.....',
  '......................PPp.....',
  '.....................ZZZZZ....',
  '.....................ZZZZZZ...',
  '......................zzzz....',
];
// Hands at the keyboard (right hand, nearest the viewer).
const HAND_REST = [
  { x: 30, y: 31, rows: ['TKKK', 'tKKk'] },
];
const HANDS_TYPE_A = [
  { x: 29, y: 26, rows: ['.KK', 'TKk'] },
  { x: 30, y: 31, rows: ['TKKK', 'tKKk'] },
];
const HANDS_TYPE_B = [
  { x: 29, y: 27, rows: ['.KK', 'TKk'] },
  { x: 30, y: 30, rows: ['TKKK', 'tKKk'] },
];
// Right arm raised high beside the head (drawn after the head).
const RAISED_ARM = {
  x: 24,
  y: 4,
  rows: [
    '..K.K....',
    '.KKKKK...',
    '.KKKKKK..',
    '..KKKKK..',
    '..KKKk...',
    '..TTTT...',
    '..TTTt...',
    '..TTTt...',
    '..TTTt...',
    '..TTTt...',
    '..TTTt...',
    '..TTTt...',
    '..TTTt...',
    '.TTTTt...',
    '.TTTTt...',
    'TTTTTt...',
    'TTTTt....',
    'TTTt.....',
  ],
};
// With the right arm raised, the forearm on the desk is gone.
const SIT_RAISED = SIT_BASE.map((row, y) => {
  if (y >= 4 && y <= 9) return row.slice(0, 19).padEnd(30, '.');
  return row;
});

const WALK_ORIGIN = { x: 14, y: 31 };
const WALK1 = [
  '.......KkKK.......',
  '.....TTTUUTTT.....',
  '....TTTTTUTTTTT...',
  '...TTTTTTTTTTTTT..',
  '...TTtTTTTTTTtTT..',
  '...TTtTTTTTTTtTT..',
  '...TTtTTTTTTTtTT..',
  '...KKtTTTTTTTtKK..',
  '...KKtTTTTTTTtKk..',
  '.....PPPPPPPPP....',
  '.....PPPPPPPPP....',
  '.....PPPp.PPPP....',
  '....PPPp...PPP....',
  '....PPPp...PPp....',
  '...ZZZZ....PPp....',
  '...ZZZZz..ZZZZ....',
  '..........zzzz....',
];
const WALK2 = [
  '.......KkKK.......',
  '.....TTTUUTTT.....',
  '....TTTTTUTTTTT...',
  '...TTTTTTTTTTTTT..',
  '...TTtTTTTTTTtTT..',
  '...TTtTTTTTTTtTT..',
  '...TTtTTTTTTTtTT..',
  '...KKtTTTTTTTtKK..',
  '...KKtTTTTTTTtKk..',
  '.....PPPPPPPPP....',
  '.....PPPPPPPPP....',
  '.....PPPP.PPPp....',
  '.....PPP...PPPp...',
  '.....PPP...PPPp...',
  '.....PPp....ZZZZ..',
  '....ZZZZ....ZZZZz.',
  '....zzzz..........',
];

// Standing still with the right arm (screen right) raised beside the head.
const STAND_RAISE = [
  '.......KkKK.......',
  '.....TTTUUTTT.....',
  '....TTTTTUTTTTT...',
  '...TTTTTTTTTTTT...',
  '...TTtTTTTTTTt....',
  '...TTtTTTTTTTt....',
  '...TTtTTTTTTTt....',
  '...KKtTTTTTTTt....',
  '...KKtTTTTTTTt....',
  '.....PPPPPPPPP....',
  '.....PPPPPPPPP....',
  '.....PPPp.PPPP....',
  '.....PPPp.PPPp....',
  '.....PPPp.PPPp....',
  '.....PPPp.PPPp....',
  '....ZZZZ..ZZZZ....',
  '....zzzz..zzzz....',
];
const RAISED_ARM_FRONT = {
  x: 27,
  y: 15,
  rows: [
    '.....K.K.',
    '....KKKKK',
    '....KKKKK',
    '.....KKKk',
    '.....TTTt',
    '.....TTTt',
    '.....TTTt',
    '.....TTTt',
    '....TTTTt',
    '....TTTt.',
    '...TTTTt.',
    '...TTTt..',
    '..TTTTt..',
    '..TTTt...',
    '.TTTTt...',
    '.TTTt....',
    'TTTTt....',
    'TTTt.....',
    'TTt......',
  ],
};

const REST_ORIGIN = { x: 14, y: 30 };
const REST1 = [
  '.......KkKK.......',
  '.....TTTUUTTT.....',
  '....TTTTTUTTTTT...',
  '...TTTTTTTTTTTTT..',
  '...TTtTTTTTTTtTT..',
  '...TTtTTTTTTTtTT..',
  '...TTTtTTTTTtTTT..',
  '....TTKKGGGKKTT...',
  '....TTKKGGgKKTT...',
  '...PPPPPPPPPPPPP..',
  '..PPPPPPPPPPPPPPP.',
  '..PPPPPPPPPPPPPPp.',
  '...PPPPp..PPPPpp..',
  '...PPPp....PPPp...',
  '...PPPp....PPPp...',
  '..ZZZZ....ZZZZ....',
  '..zzzz....zzzz....',
];
const REST1_OVER = { x: 20, y: 36, rows: ['CCC'] };
const REST2 = [
  '.......KkKK.......',
  '.....TTTUUTTT.....',
  '....TTTTTUTTTTT...',
  '...TTTTTTTTTTTTT..',
  '...TTtTTTTTTTtTT..',
  '...TTtTTTTTTTtTT..',
  '...TTtTTTTTTTtTT..',
  '...TTtTTTTTTTTTT..',
  '....TTTTTTTTTTT...',
  '...PPPPPPPPPPPPP..',
  '..PPPPPPPPPPPPPPP.',
  '..PPPPPPPPPPPPPPp.',
  '...PPPPp..PPPPpp..',
  '...PPPp....PPPp...',
  '...PPPp....PPPp...',
  '..ZZZZ....ZZZZ....',
  '..zzzz....zzzz....',
];
// Both hands bring the mug up to the mouth.
const REST2_OVER = {
  x: 17,
  y: 25,
  rows: ['.CCC..', 'GGGGg.', 'GGGgGg', 'KGGgKk', 'TKKKTt', 'TTtTTt', '.TTTt.'],
};

// ---------------------------------------------------------------------------

/** The looks. Ramps come from palette.mjs. */
export const LOOKS = [
  { id: 'spiky', hair: 'spiky', ramps: { hair: 'hairBlack', skin: 'skin1', top: 'navy', top2: 'shirt', pants: 'denim', shoes: 'sneaker', acc: 'bezel' } },
  { id: 'bob', hair: 'bob', ramps: { hair: 'hairBlonde', skin: 'skin1', top: 'coral', top2: 'shirt', pants: 'charcoal', shoes: 'shoe', acc: 'bezel' } },
  { id: 'curly', hair: 'curly', glasses: true, ramps: { hair: 'hairDark', skin: 'skin3', top: 'mustard', top2: 'shirt', pants: 'khaki', shoes: 'shoe', acc: 'bezel' } },
  { id: 'long', hair: 'long', ramps: { hair: 'hairAuburn', skin: 'skin2', top: 'sage', top2: 'shirt', pants: 'denim', shoes: 'shoe', acc: 'bezel' } },
  { id: 'bun', hair: 'bun', ramps: { hair: 'hairBlack', skin: 'skin2', top: 'shirt', top2: 'navy', pants: 'black', shoes: 'shoe', acc: 'bezel' } },
  { id: 'ponytail', hair: 'ponytail', ramps: { hair: 'hairLilac', skin: 'skin1', top: 'teal', top2: 'shirt', pants: 'charcoal', shoes: 'sneaker', acc: 'coral' } },
  { id: 'beanie', hair: 'beanie', ramps: { hair: 'hairBrown', skin: 'skin4', top: 'olive', top2: 'shirt', pants: 'khaki', shoes: 'shoe', acc: 'red' } },
  { id: 'sidepart', hair: 'sidepart', glasses: true, ramps: { hair: 'hairTeal', skin: 'skin3', top: 'purple', top2: 'shirt', pants: 'black', shoes: 'sneaker', acc: 'bezel' } },
];
export const GENERIC_LOOK = {
  id: 'hood',
  hair: 'hood',
  ramps: { hair: 'hairBrown', skin: 'skin2', top: 'hoodie', top2: 'hoodie', pants: 'charcoal', shoes: 'sneaker', acc: 'bezel' },
};

const FIXED_ROLES = { frame: 'metal', eye: 'eye', white: 'white', mouth: 'mouth', blush: 'blush', mug: 'mug', coffee: 'coffee' };

/** A role layer: ramp per pixel is the role; tone is 'auto' or fixed. */
class RoleLayer {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.role = new Array(w * h).fill(null);
    this.tone = new Array(w * h).fill(null);
  }
  put(x, y, role, tone) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    this.role[y * this.w + x] = role;
    this.tone[y * this.w + x] = tone;
  }
  at(x, y) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return null;
    return this.role[y * this.w + x];
  }
  stamp(rows, ox, oy) {
    rows.forEach((row, y) =>
      [...row].forEach((ch, x) => {
        if (ch === '.') return;
        const m = LETTERS[ch];
        if (!m) throw new Error(`unknown template letter '${ch}'`);
        this.put(ox + x, oy + y, m[0], m[1]);
      }),
    );
  }
}

function resolve(rl, look) {
  const L = new Layer(rl.w, rl.h);
  for (let y = 0; y < rl.h; y++) for (let x = 0; x < rl.w; x++) {
    const role = rl.at(x, y);
    if (!role) continue;
    let tone = rl.tone[y * rl.w + x];
    if (tone === 'auto') {
      const above = rl.at(x, y - 1);
      if (above && above !== role && !DECALS.has(above)) tone = SHADE;
      else if (!above || !rl.at(x - 1, y)) tone = LIGHT;
      else if (!rl.at(x + 1, y) || !rl.at(x, y + 1)) tone = SHADE;
      else tone = BASE;
    }
    const ramp = FIXED_ROLES[role] ?? look.ramps[role];
    L.set(x, y, ramp, tone);
  }
  return L;
}

function stampHead(rl, look, view, at, { closed = false } = {}) {
  const style = HAIR[look.hair];
  if (view === 'front') {
    rl.stamp(closed ? FACE_FRONT_CLOSED : FACE_FRONT, at.x, at.y);
    rl.stamp(style.front, at.x, at.y);
    if (look.glasses) rl.stamp(GLASSES_FRONT, at.x, at.y);
  } else {
    rl.stamp(FACE_BACK, at.x, at.y);
    rl.stamp(style.back, at.x, at.y);
    if (look.glasses) rl.stamp(GLASSES_BACK, at.x, at.y);
  }
}

function stampBehind(rl, look, at) {
  const b = HAIR[look.hair].frontBehind;
  if (b) rl.stamp(b.rows, at.x + (b.x ?? 0), at.y + (b.y ?? 0));
}

function stampPart(rl, part) {
  rl.stamp(part.rows, part.x, part.y);
}

let chairLayer = null;

/** Build one frame (a station-sized layer) for a look and a pose. */
export function drawCharacter(look, pose) {
  const rl = new RoleLayer(STATION.w, STATION.h);
  const seated = ['sit', 'type1', 'type2', 'raiseHand'].includes(pose);
  if (seated) {
    rl.stamp(pose === 'raiseHand' ? SIT_RAISED : SIT_BASE, SIT_ORIGIN.x, SIT_ORIGIN.y);
    const hands = pose === 'sit' ? HAND_REST : pose === 'type2' ? HANDS_TYPE_B : pose === 'raiseHand' ? [HANDS_TYPE_A[0]] : HANDS_TYPE_A;
    for (const h of hands) stampPart(rl, h);
    stampHead(rl, look, 'back', HEAD_BACK);
    if (pose === 'raiseHand') stampPart(rl, RAISED_ARM);
  } else if (pose === 'rest1' || pose === 'rest2') {
    stampBehind(rl, look, HEAD_FRONT_REST);
    rl.stamp(pose === 'rest1' ? REST1 : REST2, REST_ORIGIN.x, REST_ORIGIN.y);
    stampHead(rl, look, 'front', HEAD_FRONT_REST, { closed: pose === 'rest2' });
    stampPart(rl, pose === 'rest1' ? REST1_OVER : REST2_OVER);
  } else if (pose === 'standRaise') {
    stampBehind(rl, look, HEAD_FRONT_WALK);
    rl.stamp(STAND_RAISE, WALK_ORIGIN.x, WALK_ORIGIN.y);
    stampHead(rl, look, 'front', HEAD_FRONT_WALK);
    stampPart(rl, RAISED_ARM_FRONT);
  } else {
    const head = { x: HEAD_FRONT_WALK.x, y: HEAD_FRONT_WALK.y + (pose === 'walk2' ? 1 : 0) };
    stampBehind(rl, look, head);
    rl.stamp(pose === 'walk1' ? WALK1 : WALK2, WALK_ORIGIN.x, WALK_ORIGIN.y);
    stampHead(rl, look, 'front', head);
  }
  let L = outline(resolve(rl, look), RAMPS);
  if (seated) {
    chairLayer ??= drawChair();
    L = compose(L, chairLayer);
  }
  return L;
}

// ---------------------------------------------------------------------------
// The boss: seated behind the boss desk in a suit, facing the room.

export const BOSS_LOOK = {
  id: 'boss',
  hair: 'slick',
  ramps: { hair: 'hairSilver', skin: 'skin2', top: 'suit', top2: 'shirt', pants: 'suit', shoes: 'shoe', acc: 'red' },
};

// Jacket with lapels (`y`), a white shirt collar (`U`) and a red tie (`R`);
// the hands rest on the desk edge. Below the hands the desk hides the body.
const BOSS_TORSO = [
  '.......KkKK.......',
  '.....TTUUUUTT.....',
  '....TTTyURUyTTT...',
  '...TTTTTyRyTTTTT..',
  '...TTtTTURUTTtTT..',
  '...TTtTTtRtTTtTT..',
  '...TTtTTTrTTTtTT..',
  '...TTtTTTTTTTtTT..',
  '..KKKtTTTTTTTtKKK.',
  '..KKKTTTTTTTTTKKk.',
  '...TTTTTTTTTTTTT..',
  '...PPPPPPPPPPPPP..',
  '..PPPPPPPPPPPPPPP.',
  '..PPPPPPPPPPPPPPp.',
];

/**
 * The boss frame's character layer: the chair, then the boss, with every
 * pixel the desk covers cleared, so drawing it over the desk sprite at the
 * same origin puts the boss behind the desk.
 */
export function drawBoss() {
  const rl = new RoleLayer(BOSS_FRAME.w, BOSS_FRAME.h);
  const [ax, ay] = iso(BOSS_FRAME.ox, BOSS_FRAME.oy)(BOSS_SEAT.a, BOSS_SEAT.b, 0);
  // Same offsets from the anchor as a standing front view; seated on the
  // chair the hips sit about where a standing figure's do.
  rl.stamp(BOSS_TORSO, ax - 8, ay - 18);
  stampHead(rl, BOSS_LOOK, 'front', { x: ax - 10, y: ay - 35 });
  const L = compose(drawBossChair(), outline(resolve(rl, BOSS_LOOK), RAMPS));
  const desk = drawBossDesk();
  for (let y = 0; y < L.h; y++) for (let x = 0; x < L.w; x++) {
    if (desk.filled(x, y)) L.clear(x, y);
  }
  return L;
}
