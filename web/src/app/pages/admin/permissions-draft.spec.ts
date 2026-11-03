import { Grant } from '../../core/api.types';
import { changedCells, diffDrafts, draftsFrom, isIncomplete, withScope } from './permissions-draft';
import { groupActions, scopeHint, scopeLabel } from './permission-labels';

const grant = (over: Partial<Grant>): Grant => ({
  id: 'g1',
  roleId: 'r1',
  action: 'task:review',
  effect: 'permit',
  scopeKind: 'own_division',
  scopeDivisionId: null,
  scopeTeamId: null,
  scopeRoleId: null,
  lifecycleState: 'active',
  retiredAt: null,
  version: 3,
  ...over,
});

describe('diffDrafts', () => {
  it('is empty when nothing changed', () => {
    const saved = [grant({})];
    expect(diffDrafts(saved, draftsFrom(saved))).toEqual([]);
  });

  it('turns a re-scope into an update carrying the saved version', () => {
    const saved = [grant({})];
    const drafts = draftsFrom(saved).map((d) => withScope(d, 'own_team'));
    expect(diffDrafts(saved, drafts)).toEqual([
      {
        op: 'update',
        id: 'g1',
        version: 3,
        scopeKind: 'own_team',
        scopeDivisionId: null,
        scopeTeamId: null,
        scopeRoleId: null,
      },
    ]);
  });

  it('retires removed grants and creates new ones', () => {
    const saved = [grant({})];
    const drafts = [
      { ...draftsFrom(saved)[0], key: 'new:1', id: null, version: null, action: 'task:create', scopeKind: 'global' as const },
    ];
    expect(diffDrafts(saved, drafts).map((c) => c.op)).toEqual(['retire', 'create']);
  });

  it('reverting an edit leaves no change behind', () => {
    const saved = [grant({})];
    const edited = draftsFrom(saved).map((d) => withScope(d, 'global'));
    const reverted = edited.map((d) => withScope(d, 'own_division'));
    expect(diffDrafts(saved, reverted)).toEqual([]);
    expect(changedCells(saved, reverted).size).toBe(0);
  });
});

describe('changedCells', () => {
  it('marks re-scoped, removed and added role/action pairs', () => {
    const saved = [grant({}), grant({ id: 'g2', action: 'task:retire' })];
    const drafts = [
      withScope(draftsFrom(saved)[0], 'own_team'),
      { ...draftsFrom(saved)[0], key: 'new:1', id: null, version: null, roleId: 'r2' },
    ];
    expect([...changedCells(saved, drafts)].sort()).toEqual([
      'r1|task:retire',
      'r1|task:review',
      'r2|task:review',
    ]);
  });
});

describe('withScope / isIncomplete', () => {
  it('clears target ids the new scope does not use', () => {
    const d = { ...draftsFrom([grant({ scopeKind: 'specific_division', scopeDivisionId: 'd1' })])[0] };
    expect(withScope(d, 'own').scopeDivisionId).toBeNull();
    expect(withScope(d, 'specific_division').scopeDivisionId).toBe('d1');
  });

  it('flags a targeted scope with no target', () => {
    const d = withScope(draftsFrom([grant({})])[0], 'specific_team');
    expect(isIncomplete(d)).toBe(true);
    expect(isIncomplete({ ...d, scopeTeamId: 't1' })).toBe(false);
  });
});

describe('permission labels', () => {
  const review = {
    action: 'task:review',
    resourceType: 'Task',
    scopes: ['global', 'own_division', 'own'] as const,
    own: 'requester',
  };
  const settings = { action: 'config:update', resourceType: 'Organization', scopes: ['global'] as const, own: null };

  it('names own by what it checks', () => {
    expect(scopeLabel('own', { ...review, scopes: [...review.scopes] })).toBe('Own requests');
    expect(scopeHint('own', { ...review, scopes: [...review.scopes] })).toBe('Only tasks the person requested.');
  });

  it('treats a global-only action as a plain on/off grant', () => {
    expect(scopeLabel('global', { ...settings, scopes: [...settings.scopes] })).toBe('Granted');
  });

  it('names the picked target in the hint', () => {
    expect(scopeHint('specific_division', { ...review, scopes: [...review.scopes] }, 'Art')).toBe(
      'Only tasks in Art, whether or not the person belongs to it.',
    );
  });

  it('groups actions by resource in display order', () => {
    const groups = groupActions([
      { ...settings, scopes: ['global'] },
      { ...review, scopes: ['global'] },
      { action: 'widget:spin', resourceType: 'Organization', scopes: ['global'], own: null },
    ]);
    expect(groups.map((g) => g.name)).toEqual(['Tasks', 'Settings and integrations', 'Other']);
  });
});
