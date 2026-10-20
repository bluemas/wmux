import { memo, type CSSProperties } from 'react';
import {
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

type DeskState = 'working' | 'needs_you' | 'finished';

function Station({ seat, occupied }: { seat: Seat; occupied: DeskState | null }) {
  const left = seat.x - STATION.deskX;
  const top = seat.y - STATION.deskY;
  return (
    <>
      <div className="wmux-office-sprite" aria-hidden="true" style={spriteStyle(FURNITURE.desk, left, top, stackIndex(seat.z, 0))} />
      <div
        className="wmux-office-sprite"
        aria-hidden="true"
        style={spriteStyle(occupied ? FURNITURE.monitorOn : FURNITURE.monitorOff, left, top, stackIndex(seat.z, 1))}
      />
      {/* Seated frames include the chair; draw it at an empty desk or beside a reporting employee. */}
      {(!occupied || occupied === 'finished') && (
        <div className="wmux-office-sprite" aria-hidden="true" style={spriteStyle(FURNITURE.chair, left, top, stackIndex(seat.z, 2))} />
      )}
    </>
  );
}

type PoseName = 'type' | 'raiseHand' | 'rest' | 'stand';

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
  t: Translate;
  now: number;
  locale?: string;
  onJump: (employee: OfficeEmployee) => void;
}

function Employee({ employee, layout, t, now, locale, onJump }: EmployeeProps) {
  const sheet = characterFor(employee);
  const seated = employee.state === 'working' || employee.state === 'needs_you';
  const seat = seated
    ? layout.desks[layout.deskFor[employee.id]]
    : employee.state === 'finished'
      ? layout.stands[layout.deskFor[employee.id]]
      : layout.lounge[layout.loungeFor[employee.id]];
  if (!seat) return null;

  // Frame top-left: a desk frame shares the station's origin; elsewhere the
  // character's anchor stands on the seat point.
  const left = seated ? seat.x - STATION.deskX : seat.x - STATION.seatX;
  const top = seated ? seat.y - STATION.deskY : seat.y - STATION.seatY;

  let pose: PoseName;
  let frame: CharacterPose;
  let loop: CSSProperties | null = null;
  if (employee.state === 'working') {
    pose = 'type';
    frame = 'type1';
    loop = frameLoop(sheet, 'type1', 'type2', 0.5, employee.look);
  } else if (employee.state === 'needs_you') {
    pose = 'raiseHand';
    frame = 'raiseHand';
  } else if (employee.state === 'finished') {
    // Standing beside the desk, facing the viewer, to report.
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
      aria-label={t('office.employeeLabel', {
        name: employee.label,
        workspace: employee.workspaceName,
        agent: employee.agent,
        tag: employee.paneTag,
        state: stateText,
      })}
      style={{ left: left * OFFICE_SCALE, top: top * OFFICE_SCALE, width: STATION.w * OFFICE_SCALE, height: STATION.h * OFFICE_SCALE }}
      onClick={() => onJump(employee)}
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
          {` · ${employee.workspaceName} · ${employee.agent} · ${employee.paneTag}`}
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
  const seatedAt = new Map<number, DeskState>();
  for (const e of employees) {
    if (e.state !== 'resting') seatedAt.set(layout.deskFor[e.id], e.state);
  }
  return (
    <div
      className="wmux-office-room"
      role="group"
      aria-label={label}
      style={{ width: layout.width * OFFICE_SCALE, height: layout.height * OFFICE_SCALE }}
    >
      <RoomProps props={layout.props} desks={layout.desks.length} height={layout.height} />
      {layout.desks.map((seat, i) => (
        <Station key={i} seat={seat} occupied={seatedAt.get(i) ?? null} />
      ))}
      {employees.map((e) => (
        <Employee key={e.id} employee={e} layout={layout} t={t} now={now} locale={locale} onJump={onJump} />
      ))}
    </div>
  );
}
