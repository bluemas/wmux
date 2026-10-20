import { memo, useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
  BOSS,
  CHARACTERS,
  FURNITURE,
  FURNITURE_ANCHORS,
  GENERIC_CHARACTER,
  OFFICE_EXTRAS,
  STATION,
  type CharacterPose,
  type CharacterSheet,
  type SpriteRef,
} from '../../assets/office';
import type { OfficeEmployee } from '../../stores/selectors/officeEmployees';
import { formatResetClock } from '../../../shared/usageLimit';
import type { TranslationKey } from '../../i18n/locales/en';
import { prefersReducedMotion } from '../../utils/reducedMotion';
import { stackIndex, type OfficeLayout, type OfficeProp, type Seat } from './officeLayout';

/** Display scale: the art is drawn at 1x and meant to be seen at 2x. */
export const OFFICE_SCALE = 2;
/** Above every sprite: activity bubbles stack by depth from here, so a nearer employee's wins. */
const BUBBLE_Z = 100000;
/** Names sit above every activity bubble (depths stay well under 10000). */
const LABEL_Z = 110000;
/**
 * Needs-you and finished bubbles sit above every name, so a status is never
 * hidden, and stack by depth among themselves; still under the hovered
 * label and bubble (120000+).
 */
const STATUS_BUBBLE_Z = 110001;
const BUBBLE_MAX = 40;
/**
 * How long a walk between spots takes. Matches the position transition in
 * office.css; the walk pose ends on transitionend, or after this as a fallback.
 */
const WALK_MS = 900;

type Translate = (key: TranslationKey, vars?: Record<string, string | number>) => string;

const SPRITES: Record<OfficeProp['key'], SpriteRef> = { ...FURNITURE, ...OFFICE_EXTRAS };

/** Teammate meta colours → the look whose clothes carry that colour. */
const LOOK_FOR_COLOR: Record<string, string> = {
  blue: 'spiky',
  orange: 'bob',
  yellow: 'curly',
  green: 'long',
  cyan: 'ponytail',
  pink: 'ponytail',
  red: 'beanie',
  purple: 'sidepart',
};

export function characterFor(employee: OfficeEmployee): CharacterSheet {
  if (employee.kind === 'other') return GENERIC_CHARACTER;
  if (employee.kind === 'teammate' && employee.color) {
    const id = LOOK_FOR_COLOR[employee.color.toLowerCase()];
    const sheet = id ? CHARACTERS.find((c) => c.id === id) : undefined;
    if (sheet) return sheet;
  }
  return CHARACTERS[employee.look % CHARACTERS.length];
}

/** Activity text for a bubble: one line, at most 40 characters; '' hides it. */
export function bubbleText(text: string | undefined): string {
  const line = (text ?? '').replace(/\s+/g, ' ').trim();
  if (line.length <= BUBBLE_MAX) return line;
  return `${line.slice(0, BUBBLE_MAX - 1).trimEnd()}…`;
}

export function needText(employee: OfficeEmployee, t: Translate, now: number, locale?: string): string {
  switch (employee.need) {
    case 'error':
      return t('office.need.error');
    case 'usage_limit':
      return employee.resetsAt != null
        ? t('office.need.usageLimitUntil', { time: formatResetClock(employee.resetsAt, now, locale) })
        : t('office.need.usageLimit');
    default:
      return t('office.need.question');
  }
}

function spriteStyle(sprite: SpriteRef, left: number, top: number, zIndex: number): CSSProperties {
  return {
    left: left * OFFICE_SCALE,
    top: top * OFFICE_SCALE,
    width: sprite.w,
    height: sprite.h,
    zIndex,
    backgroundImage: `url(${sprite.src})`,
    backgroundPosition: `-${sprite.x}px -${sprite.y}px`,
    transform: `scale(${OFFICE_SCALE})`,
  };
}

function Prop({ prop }: { prop: OfficeProp }) {
  const sprite = SPRITES[prop.key];
  const anchor = FURNITURE_ANCHORS[prop.key];
  return (
    <div
      className="wmux-office-sprite"
      aria-hidden="true"
      style={spriteStyle(sprite, prop.x - anchor.x, prop.y - anchor.y, prop.zIndex)}
    />
  );
}

/** Floor, walls and decor: redrawn only when the room or its sofa count changes. */
const RoomProps = memo(
  function RoomProps({ props }: { props: OfficeProp[]; desks: number; height: number }) {
    return (
      <>
        {props.map((p, i) => (
          <Prop key={i} prop={p} />
        ))}
      </>
    );
  },
  (a, b) => a.desks === b.desks && a.height === b.height && a.props.length === b.props.length,
);

/**
 * `working`: its employee sits at it (the seated frame brings the chair).
 * `reserved`: its employee is queued at the boss desk or on the way: monitor
 * on, chair empty. `empty`: its employee rests, or there is none.
 */
type DeskState = 'working' | 'reserved' | 'empty';

function Station({ seat, state, owner }: { seat: Seat; state: DeskState; owner?: string }) {
  const left = seat.x - STATION.deskX;
  const top = seat.y - STATION.deskY;
  return (
    <>
      <div
        className="wmux-office-sprite"
        aria-hidden="true"
        data-office-desk-of={owner}
        data-desk-state={state}
        style={spriteStyle(FURNITURE.desk, left, top, stackIndex(seat.z, 0))}
      />
      <div
        className="wmux-office-sprite"
        aria-hidden="true"
        style={spriteStyle(state === 'empty' ? FURNITURE.monitorOff : FURNITURE.monitorOn, left, top, stackIndex(seat.z, 1))}
      />
      {state !== 'working' && (
        <div className="wmux-office-sprite" aria-hidden="true" style={spriteStyle(FURNITURE.chair, left, top, stackIndex(seat.z, 2))} />
      )}
    </>
  );
}

/** The boss (the owner) at the boss desk, with a nameplate. */
function BossDesk({ layout, t }: { layout: OfficeLayout; t: Translate }) {
  const { x, y, z } = layout.boss;
  const left = x - BOSS.deskX;
  const top = y - BOSS.deskY;
  // The nameplate sits above the boss's head: the queue stands in front of
  // the desk, so its status bubbles never cover it there.
  const plateX = x + (BOSS.seatX - BOSS.deskX);
  const plateY = y + (BOSS.seatY - BOSS.deskY) - BOSS_PLATE_RISE;
  return (
    <>
      <div
        className="wmux-office-sprite"
        aria-hidden="true"
        style={spriteStyle(OFFICE_EXTRAS.bossDesk, left, top, stackIndex(z, 0))}
      />
      <div
        className="wmux-office-sprite"
        role="img"
        data-office-boss
        aria-label={t('office.boss.label')}
        style={spriteStyle(BOSS, left, top, stackIndex(z, 1))}
      />
      <span
        className="wmux-office-nameplate"
        data-office-boss-nameplate
        aria-hidden="true"
        style={{ left: plateX * OFFICE_SCALE, top: plateY * OFFICE_SCALE, zIndex: LABEL_Z }}
      >
        {t('office.boss.nameplate')}
      </span>
    </>
  );
}

/** From the boss's anchor (the chair's centre on the floor) up to the nameplate's top, in 1x px. */
const BOSS_PLATE_RISE = 46;

type PoseName = 'type' | 'raiseHand' | 'rest' | 'stand' | 'walk';

type SpotKind = 'desk' | 'queue' | 'sofa';

/** Where an employee belongs now: its desk, its place in the boss queue, or a sofa. */
function spotFor(employee: OfficeEmployee, layout: OfficeLayout): { seat: Seat; kind: SpotKind } | null {
  let seat: Seat | undefined;
  if (employee.state === 'working') seat = layout.desks[layout.deskFor[employee.id]];
  else if (employee.state === 'resting') seat = layout.lounge[layout.loungeFor[employee.id]];
  else seat = layout.queue[layout.queueFor[employee.id]];
  return seat ? { seat, kind: seat.spot } : null;
}

/** Frame top-left: a desk frame shares the station's origin; elsewhere the character's anchor stands on the seat point. */
function frameOrigin(seat: Seat): { left: number; top: number } {
  return seat.spot === 'desk'
    ? { left: seat.x - STATION.deskX, top: seat.y - STATION.deskY }
    : { left: seat.x - STATION.seatX, top: seat.y - STATION.seatY };
}

/**
 * Employees on the way between spots. Derived from the spots themselves: when
 * an employee's spot changes, it walks until its position transition ends (or
 * WALK_MS passes). Two state changes per walk, nothing per frame.
 */
function useWalkers(spots: Record<string, string>): { walking: ReadonlySet<string>; arrive: (id: string) => void } {
  const [state, setState] = useState(() => ({ spots, walking: new Set<string>() as ReadonlySet<string> }));
  let current = state;
  if (state.spots !== spots) {
    const still = prefersReducedMotion();
    const walking = new Set<string>();
    for (const id of Object.keys(spots)) {
      const from = state.spots[id];
      if (still) continue;
      if (state.walking.has(id) || (from !== undefined && from !== spots[id])) walking.add(id);
    }
    current = { spots, walking };
    setState(current);
  }
  const arrive = useCallback((id: string) => {
    setState((s) => {
      if (!s.walking.has(id)) return s;
      const walking = new Set(s.walking);
      walking.delete(id);
      return { spots: s.spots, walking };
    });
  }, []);
  return { walking: current.walking, arrive };
}

/** Two neighbouring frames in one sheet row animate by stepping background-position-x. */
function frameLoop(sheet: CharacterSheet, first: CharacterPose, second: CharacterPose, seconds: number, phase: number): CSSProperties | null {
  const a = sheet.frames[first];
  const b = sheet.frames[second];
  if (a.y !== b.y || b.x - a.x !== a.w) return null;
  return {
    '--office-frame-from': `-${a.x}px`,
    '--office-frame-to': `-${b.x + b.w}px`,
    '--office-frame-time': `${seconds}s`,
    animationDelay: `-${(phase % 8) * (seconds / 8)}s`,
  } as CSSProperties;
}

interface EmployeeProps {
  employee: OfficeEmployee;
  layout: OfficeLayout;
  walking: boolean;
  onArrive: (id: string) => void;
  t: Translate;
  now: number;
  locale?: string;
  onJump: (employee: OfficeEmployee) => void;
}

function Employee({ employee, layout, walking, onArrive, t, now, locale, onJump }: EmployeeProps) {
  const sheet = characterFor(employee);
  const id = employee.id;
  // A walk that never fires transitionend (hidden window, same spot) still ends.
  useEffect(() => {
    if (!walking) return undefined;
    const timer = setTimeout(() => onArrive(id), WALK_MS + 100);
    return () => clearTimeout(timer);
  }, [walking, id, onArrive]);

  const spot = spotFor(employee, layout);
  if (!spot) return null;
  const { seat } = spot;
  const { left, top } = frameOrigin(seat);

  let pose: PoseName;
  let frame: CharacterPose;
  let loop: CSSProperties | null = null;
  if (walking) {
    pose = 'walk';
    frame = 'walk1';
    loop = frameLoop(sheet, 'walk1', 'walk2', 0.4, employee.look);
  } else if (employee.state === 'working') {
    pose = 'type';
    frame = 'type1';
    loop = frameLoop(sheet, 'type1', 'type2', 0.5, employee.look);
  } else if (employee.state === 'needs_you') {
    // Standing in the boss queue with a hand up.
    pose = 'raiseHand';
    frame = 'standRaise';
  } else if (employee.state === 'finished') {
    // Standing in the boss queue, facing the viewer, to report.
    pose = 'stand';
    frame = 'walk1';
  } else {
    pose = 'rest';
    frame = 'rest1';
    loop = frameLoop(sheet, 'rest1', 'rest2', 2.4, employee.look);
  }

  const alert = employee.state === 'needs_you' ? needText(employee, t, now, locale) : '';
  const done = employee.state === 'finished' ? t('office.bubble.done') : '';
  const activity = employee.state === 'working' ? bubbleText(employee.bubble) : '';
  const stateText =
    employee.state === 'working'
      ? t('office.state.working')
      : employee.state === 'resting'
        ? t('office.state.resting')
        : employee.state === 'finished'
          ? t('office.state.finished')
          : alert;
  const z = stackIndex(seat.z, 2);

  return (
    <button
      type="button"
      className="wmux-office-employee"
      data-office-employee={employee.id}
      data-state={employee.state}
      data-pose={pose}
      data-spot={spot.kind}
      data-walking={walking || undefined}
      aria-label={t('office.employeeLabel', {
        name: employee.label,
        workspace: employee.workspaceName,
        // The agent and its pane tag, leaving out a tag the pane does not have yet.
        agent: [employee.agent, employee.paneTag].filter(Boolean).join(' '),
        state: stateText,
      })}
      style={{ left: left * OFFICE_SCALE, top: top * OFFICE_SCALE, width: STATION.w * OFFICE_SCALE, height: STATION.h * OFFICE_SCALE }}
      onClick={() => onJump(employee)}
      onTransitionEnd={(e) => {
        if (e.target === e.currentTarget) onArrive(id);
      }}
    >
      <span
        className={`wmux-office-sprite${loop ? ' wmux-office-sprite--loop' : ''}`}
        aria-hidden="true"
        style={{ ...spriteStyle(sheet.frames[frame], 0, 0, z), ...loop }}
      />
      {/* The click target: the character's body, not the whole frame. */}
      <span className="wmux-office-employee__hit" aria-hidden="true" style={{ zIndex: z }} />
      <span
        className="wmux-office-employee__label"
        aria-hidden="true"
        style={{ left: STATION.seatX * OFFICE_SCALE, top: (STATION.seatY + 2) * OFFICE_SCALE, zIndex: LABEL_Z }}
      >
        <span className="wmux-office-employee__name">{employee.label}</span>
        <span className="wmux-office-employee__workspace">
          {` · ${[employee.workspaceName, employee.agent, employee.paneTag].filter(Boolean).join(' · ')}`}
        </span>
      </span>
      {(alert || done || activity) && (
        <span
          className={`wmux-office-bubble ${
            alert ? 'wmux-office-bubble--alert' : done ? 'wmux-office-bubble--done' : 'wmux-office-bubble--line'
          }`}
          data-office-bubble={alert ? 'alert' : done ? 'done' : 'activity'}
          aria-hidden="true"
          style={{ left: STATION.seatX * OFFICE_SCALE, zIndex: (alert || done ? STATUS_BUBBLE_Z : BUBBLE_Z) + Math.round(seat.z) }}
        >
          {alert || done ? (
            <>
              <span className="wmux-office-bubble__mark">{alert ? '!' : '✓'}</span>
              {alert || done}
            </>
          ) : (
            activity
          )}
        </span>
      )}
    </button>
  );
}

interface OfficeSceneProps {
  employees: OfficeEmployee[];
  layout: OfficeLayout;
  t: Translate;
  now: number;
  locale?: string;
  onJump: (employee: OfficeEmployee) => void;
  label: string;
}

/** The isometric room: layered DOM sprites, with names and bubbles as DOM text. */
export default function OfficeScene({ employees, layout, t, now, locale, onJump, label }: OfficeSceneProps) {
  const spots = useMemo(() => {
    const out: Record<string, string> = {};
    for (const e of employees) {
      const spot = spotFor(e, layout);
      if (spot) out[e.id] = `${spot.seat.x},${spot.seat.y}`;
    }
    return out;
  }, [employees, layout]);
  const { walking, arrive } = useWalkers(spots);

  const deskAt = new Map<number, { state: DeskState; owner: string }>();
  for (const e of employees) {
    const desk = layout.deskFor[e.id];
    if (desk === undefined) continue;
    const state: DeskState =
      e.state === 'resting' ? 'empty' : e.state === 'working' && !walking.has(e.id) ? 'working' : 'reserved';
    deskAt.set(desk, { state, owner: e.id });
  }
  return (
    <div
      className="wmux-office-room"
      role="group"
      aria-label={label}
      style={{ width: layout.width * OFFICE_SCALE, height: layout.height * OFFICE_SCALE }}
    >
      <RoomProps props={layout.props} desks={layout.desks.length} height={layout.height} />
      <BossDesk layout={layout} t={t} />
      {layout.desks.map((seat, i) => (
        <Station key={i} seat={seat} state={deskAt.get(i)?.state ?? 'empty'} owner={deskAt.get(i)?.owner} />
      ))}
      {employees.map((e) => (
        <Employee
          key={e.id}
          employee={e}
          layout={layout}
          walking={walking.has(e.id)}
          onArrive={arrive}
          t={t}
          now={now}
          locale={locale}
          onJump={onJump}
        />
      ))}
    </div>
  );
}
