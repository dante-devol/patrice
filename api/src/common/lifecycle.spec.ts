import { isRevivable, RevivableRow } from './lifecycle';

/** Build a retired row whose `retiredAt` is `agoMs` milliseconds in the past. */
function retired(agoMs: number): RevivableRow {
  return { lifecycleState: 'retired', retiredAt: new Date(Date.now() - agoMs) };
}

const DAY = 24 * 60 * 60 * 1000;

describe('isRevivable (revive state-machine guard)', () => {
  it('allows reviving a just-retired row inside the grace window', () => {
    expect(isRevivable(retired(0), 30)).toBe(true);
    expect(isRevivable(retired(5 * DAY), 30)).toBe(true);
  });

  it('rejects reviving once the grace window has elapsed', () => {
    expect(isRevivable(retired(31 * DAY), 30)).toBe(false);
  });

  it('treats the exact grace boundary as still revivable', () => {
    expect(isRevivable(retired(30 * DAY), 30)).toBe(true);
  });

  it('rejects an active row (nothing to revive)', () => {
    expect(isRevivable({ lifecycleState: 'active', retiredAt: null }, 30)).toBe(false);
  });

  it('rejects a deactivated row (reactivate is the reversal arrow, not revive)', () => {
    expect(
      isRevivable({ lifecycleState: 'deactivated', retiredAt: null }, 30),
    ).toBe(false);
  });

  it('rejects a retired row with a null retiredAt (defensive)', () => {
    expect(isRevivable({ lifecycleState: 'retired', retiredAt: null }, 30)).toBe(false);
  });
})
