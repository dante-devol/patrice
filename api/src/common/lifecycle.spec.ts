import { activeFilter, isRevivable, RevivableRow } from './lifecycle';

/** Build a retired row whose `retiredAt` is `agoMs` milliseconds in the past. */
function retired(agoMs: number): RevivableRow {
  return { lifecycleState: 'retired', retiredAt: new Date(Date.now() - agoMs) };
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('isRevivable (revive state-machine guard)', () => {
  it('allows reviving a just-retired row inside the grace window', () => {
    expect(isRevivable(retired(0), DAY)).toBe(true);
    expect(isRevivable(retired(5 * HOUR), DAY)).toBe(true);
  });

  it('rejects reviving once the grace window has elapsed', () => {
    expect(isRevivable(retired(25 * HOUR), DAY)).toBe(false);
  });

  it('treats the exact grace boundary as still revivable', () => {
    expect(isRevivable(retired(DAY), DAY)).toBe(true);
  });

  it('a zero-length grace window rejects even a just-retired row', () => {
    expect(isRevivable(retired(1), 0)).toBe(false);
  });

  it('rejects an active row (nothing to revive)', () => {
    expect(isRevivable({ lifecycleState: 'active', retiredAt: null }, DAY)).toBe(false);
  });

  it('rejects a deactivated row (reactivate is the reversal arrow, not revive)', () => {
    expect(
      isRevivable({ lifecycleState: 'deactivated', retiredAt: null }, DAY),
    ).toBe(false);
  });

  it('rejects a retired row with a null retiredAt (defensive)', () => {
    expect(isRevivable({ lifecycleState: 'retired', retiredAt: null }, DAY)).toBe(false);
  });
});

describe('activeFilter (soft-retire default list filter)', () => {
  it('excludes retired rows by default', () => {
    expect(activeFilter()).toEqual({ lifecycleState: { not: 'retired' } });
    expect(activeFilter(false)).toEqual({ lifecycleState: { not: 'retired' } });
  });

  it('opts in to retired rows when asked (no lifecycle constraint)', () => {
    expect(activeFilter(true)).toEqual({});
  });
})
