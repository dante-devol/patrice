import { computeStatusCache } from './task-status';

describe('computeStatusCache (Slice 4 subset)', () => {
  it('open when claims are open and a spot is free', () => {
    expect(
      computeStatusCache({ activeClaimants: 0, openings: 1, claimsClosed: false }),
    ).toBe('open');
    expect(
      computeStatusCache({ activeClaimants: 1, openings: 3, claimsClosed: false }),
    ).toBe('open');
  });

  it('claimed when every opening is filled', () => {
    expect(
      computeStatusCache({ activeClaimants: 1, openings: 1, claimsClosed: false }),
    ).toBe('claimed');
    expect(
      computeStatusCache({ activeClaimants: 2, openings: 2, claimsClosed: false }),
    ).toBe('claimed');
  });

  it('claimed when claims are closed even with a free spot', () => {
    expect(
      computeStatusCache({ activeClaimants: 0, openings: 5, claimsClosed: true }),
    ).toBe('claimed');
  });

  it('a freshly created task (no claimants, ≥1 opening) is open', () => {
    expect(
      computeStatusCache({ activeClaimants: 0, openings: 1, claimsClosed: false }),
    ).toBe('open');
  });
});
