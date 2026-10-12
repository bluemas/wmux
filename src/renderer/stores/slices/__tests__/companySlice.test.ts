import { describe, it, expect, beforeEach } from 'vitest';

// Minimal Zustand test store — inline to avoid complex imports
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createCompanySlice, type CompanySlice } from '../companySlice';
import type { Company } from '../../../../company/types';

// CompanySlice depends on StoreState which includes workspaces etc.
// We create a minimal mock that satisfies the slice's needs.
type TestState = CompanySlice & {
  workspaces: { id: string; name: string; companyRole?: string }[];
  activeWorkspaceId: string;
};

function createTestStore() {
  return create<TestState>()(
    immer((...args) => ({
      workspaces: [
        { id: 'ws-1', name: 'Workspace 1' },
        { id: 'ws-2', name: 'Workspace 2' },
        { id: 'ws-3', name: 'Workspace 3' },
      ],
      activeWorkspaceId: 'ws-1',
      // @ts-expect-error — minimal test store doesn't match full StoreState
      ...createCompanySlice(...args),
    }))
  );
}

describe('CompanySlice', () => {
  let store: ReturnType<typeof createTestStore>;

  beforeEach(() => {
    store = createTestStore();
  });

  it('creates a company', () => {
    store.getState().createCompany('TestCorp');
    const c = store.getState().company;
    expect(c).not.toBeNull();
    expect(c!.name).toBe('TestCorp');
    expect(c!.departments).toEqual([]);
  });

  it('adds a department with lead', () => {
    store.getState().createCompany('TestCorp');
    store.getState().addDepartment('Engineering', 'CTO');
    const c = store.getState().company!;
    expect(c.departments).toHaveLength(1);
    expect(c.departments[0].name).toBe('Engineering');
    expect(c.departments[0].members).toHaveLength(1);
    expect(c.departments[0].members[0].name).toBe('CTO');
    // Lead is the first member
    expect(c.departments[0].leadId).toBe(c.departments[0].members[0].id);
  });

  it('adds a member to department', () => {
    store.getState().createCompany('TestCorp');
    store.getState().addDepartment('Engineering', 'CTO');
    const deptId = store.getState().company!.departments[0].id;
    store.getState().addMember(deptId, 'Dev1', 'frontend-developer');
    const dept = store.getState().company!.departments[0];
    expect(dept.members).toHaveLength(2);
    expect(dept.members[1].name).toBe('Dev1');
    expect(dept.members[1].preset).toBe('frontend-developer');
  });

  it('removes a member', () => {
    store.getState().createCompany('TestCorp');
    store.getState().addDepartment('Engineering', 'CTO');
    const deptId = store.getState().company!.departments[0].id;
    store.getState().addMember(deptId, 'Dev1', 'frontend-developer');
    const memberId = store.getState().company!.departments[0].members[1].id;
    store.getState().removeMember(deptId, memberId);
    expect(store.getState().company!.departments[0].members).toHaveLength(1);
  });

  it('destroys company', () => {
    store.getState().createCompany('TestCorp');
    store.getState().destroyCompany();
    expect(store.getState().company).toBeNull();
  });

  it('updates member status', () => {
    store.getState().createCompany('TestCorp');
    store.getState().addDepartment('Engineering', 'CTO');
    const memberId = store.getState().company!.departments[0].members[0].id;
    store.getState().updateMemberStatus(memberId, 'running', 'Working on task...');
    const member = store.getState().company!.departments[0].members[0];
    expect(member.status).toBe('running');
    expect(member.lastMessage).toBe('Working on task...');
  });

  it('manages message queue', () => {
    store.getState().createCompany('TestCorp');
    store.getState().addDepartment('Engineering', 'CTO');
    const memberId = store.getState().company!.departments[0].members[0].id;

    const msgId = store.getState().enqueueMessage(memberId, 'pty-1', 'CTO', 'hello', 'CEO', false);
    expect(msgId).toBeTruthy();

    const pending = store.getState().getPendingMessages(memberId);
    expect(pending).toHaveLength(1);
    expect(pending[0].message).toBe('hello');

    store.getState().markDelivered(msgId);
    const afterDelivery = store.getState().getPendingMessages(memberId);
    expect(afterDelivery).toHaveLength(0);
  });

  it('manages inbox', () => {
    store.getState().createCompany('TestCorp');
    store.getState().addDepartment('Engineering', 'CTO');
    const memberId = store.getState().company!.departments[0].members[0].id;

    store.getState().addToInbox(memberId, { from: 'CEO', to: 'CTO', message: 'Hi', priority: 'normal' });

    const unread = store.getState().getInbox(memberId, true);
    expect(unread).toHaveLength(1);
    expect(unread[0].from).toBe('CEO');
    expect(unread[0].read).toBe(false);

    store.getState().ackInbox(memberId, [unread[0].id]);
    const afterAck = store.getState().getInbox(memberId, true);
    expect(afterAck).toHaveLength(0);

    const all = store.getState().getInbox(memberId, false);
    expect(all).toHaveLength(1);
    expect(all[0].read).toBe(true);
  });
});
