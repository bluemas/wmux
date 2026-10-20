import { useCallback, useMemo, useRef } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { getLocale } from '../../i18n';
import { createOfficeEmployeesSelector, type OfficeEmployee } from '../../stores/selectors/officeEmployees';
import { focusPaneByPtyId } from '../../hooks/useNotificationListener';
import { layoutOffice, type OfficeLayout } from './officeLayout';
import { rememberOfficeLayout, rememberedOfficeLayout } from './officeMemory';
import OfficeScene from './OfficeScene';
import './office.css';

/**
 * The Office rail page: every agent session as an employee in one isometric
 * room. It renders only when the employee list changes (the selector is
 * reference-stable and its running state follows the store's own clock), and
 * all motion is CSS sprite steps, so nothing runs per frame in React.
 */
export default function OfficePage() {
  const t = useT();
  const selector = useMemo(() => createOfficeEmployeesSelector(), []);
  const employees = useStore(selector);

  // Each employee keeps its desk and its place in the boss queue, also across
  // leaving the page and coming back. On return, the queue area is sized
  // afresh (it only grows while the page is open).
  const previous = useRef<OfficeLayout | undefined>(undefined);
  const layout = useMemo(() => {
    const remembered = rememberedOfficeLayout();
    const prev = previous.current ?? (remembered && { ...remembered, queueRows: 0 });
    const next = layoutOffice(employees, prev);
    previous.current = next;
    rememberOfficeLayout(next);
    return next;
  }, [employees]);

  const onJump = useCallback((employee: OfficeEmployee) => {
    focusPaneByPtyId(() => useStore.getState(), employee.jumpPtyId);
  }, []);

  return (
    <div className="wmux-office" data-office-page>
      <div className="wmux-office__scroll">
        <OfficeScene
          employees={employees}
          layout={layout}
          t={t}
          now={Date.now()}
          locale={getLocale()}
          onJump={onJump}
          label={t('office.roomLabel', { count: employees.length })}
        />
        {employees.length === 0 && (
          <div className="wmux-office__empty" data-office-empty>
            <p className="wmux-office__empty-title">{t('office.empty')}</p>
            <p className="wmux-office__empty-hint">{t('office.emptyHint')}</p>
          </div>
        )}
      </div>
    </div>
  );
}
