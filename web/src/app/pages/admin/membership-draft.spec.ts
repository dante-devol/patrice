import { Membership } from '../../core/api.types';
import { MembershipDraft, UnitRef } from './membership-draft';

const writing = { unitType: 'division' as const, unitId: 'd1' };
const usa = { unitType: 'team' as const, unitId: 't1' };

const row = (userId: string, unit: UnitRef = writing): Membership => ({
  userId,
  ...unit,
  source: 'patrice',
  createdAt: '2026-11-01T00:00:00.000Z',
});

describe('MembershipDraft', () => {
  it('stages adds and removes as one batch, removes first', () => {
    const d = new MembershipDraft();
    d.reset([row('ana')]);
    d.add(writing, 'ben');
    d.remove(writing, 'ana');
    expect(d.changes()).toEqual([
      { op: 'remove', unitType: 'division', unitId: 'd1', userId: 'ana' },
      { op: 'add', unitType: 'division', unitId: 'd1', userId: 'ben' },
    ]);
    expect(d.count()).toBe(2);
    expect(d.isMember(writing, 'ana')).toBe(false);
    expect(d.isMember(writing, 'ben')).toBe(true);
  });

  it('cancels out an add and a remove of the same person', () => {
    const d = new MembershipDraft();
    d.reset([row('ana')]);
    d.remove(writing, 'ana');
    d.add(writing, 'ana');
    d.add(writing, 'ben');
    d.remove(writing, 'ben');
    expect(d.count()).toBe(0);
  });

  it('ignores adding a member or removing a non-member', () => {
    const d = new MembershipDraft();
    d.reset([row('ana')]);
    d.add(writing, 'ana');
    d.remove(writing, 'ben');
    expect(d.changes()).toEqual([]);
  });

  it('keeps units apart and shows staged removes until saved', () => {
    const d = new MembershipDraft();
    d.reset([row('ana'), row('ana', usa)]);
    d.remove(usa, 'ana');
    d.add(usa, 'ben');
    expect(d.shown(usa).sort()).toEqual(['ana', 'ben']);
    expect(d.staged(usa, 'ana')).toBe('removed');
    expect(d.memberCount(usa)).toBe(1);
    expect(d.memberCount(writing)).toBe(1);
    expect([...d.changedUnits()]).toEqual(['team:t1']);
  });

  it('undo puts a person back the way they were saved', () => {
    const d = new MembershipDraft();
    d.reset([row('ana')]);
    d.remove(writing, 'ana');
    d.undo(writing, 'ana');
    expect(d.isMember(writing, 'ana')).toBe(true);
    expect(d.count()).toBe(0);
  });
});
