import { Division } from './division';
import { DomainError } from '../shared/domain-error';

const HOUR = 60 * 60 * 1000;

function codeOf(fn: () => void): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof DomainError ? e.code : 'not-a-domain-error';
  }
  return undefined;
}

describe('Division', () => {
  it('creates with defaults and raises a creation event', () => {
    const d = Division.create('  Writing  ');
    expect(d.name).toBe('Writing');
    expect(d.settings).toEqual({ defaultOpenings: 1, openingsLocked: false, restrictClaims: false });
    expect(d.pullEvents().map((e) => e.type)).toEqual(['division.created']);
    expect(d.pullEvents()).toEqual([]);
  });

  it('rejects an empty name and out-of-range openings', () => {
    expect(codeOf(() => Division.create('   '))).toBe('VALIDATION_FAILED');
    expect(codeOf(() => Division.create('Art', { defaultOpenings: -1 }))).toBe('VALIDATION_FAILED');
    const d = Division.create('Art');
    expect(codeOf(() => d.update({ defaultOpenings: 1.5 }))).toBe('VALIDATION_FAILED');
  });

  it('updates only the fields given', () => {
    const d = Division.create('Art', { restrictClaims: true, defaultOpenings: 3 });
    d.update({ name: 'Visual Art' });
    expect(d.name).toBe('Visual Art');
    expect(d.settings).toEqual({ defaultOpenings: 3, openingsLocked: false, restrictClaims: true });
  });

  it('retire and revive enforce the grace window; a retired division is read-only', () => {
    const d = Division.create('Art');
    d.pullEvents();
    const t0 = new Date('2026-01-01T00:00:00Z');
    d.retire(t0);
    expect(d.lifecycle.isRetired).toBe(true);
    expect(d.pullEvents().map((e) => e.type)).toEqual(['division.retired']);
    expect(codeOf(() => d.update({ name: 'X' }))).toBe('DIVISION_RETIRED');

    expect(codeOf(() => d.retire(t0))).toBe('ALREADY_RETIRED');
    expect(codeOf(() => d.revive(new Date(t0.getTime() + 25 * HOUR), 24 * HOUR))).toBe('NOT_REVIVABLE');

    d.revive(new Date(t0.getTime() + HOUR), 24 * HOUR);
    expect(d.lifecycle.state).toBe('active');
    expect(d.lifecycle.retiredAt).toBeNull();
  });

  it('refuses to revive an active division', () => {
    expect(codeOf(() => Division.create('Art').revive(new Date(), HOUR))).toBe('NOT_REVIVABLE');
  });
});
