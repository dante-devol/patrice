import { computeMinRuleStatus, computeStatusCache } from './task-status';

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

describe('computeMinRuleStatus (Slice 5 — full Status Min-Rule)', () => {
  it('reduces to open/claimed when there are no submissions', () => {
    expect(
      computeMinRuleStatus({ openings: 1, claimsClosed: false, claimantStates: [] }),
    ).toBe('open');
    expect(
      computeMinRuleStatus({ openings: 1, claimsClosed: false, claimantStates: [null] }),
    ).toBe('claimed');
    expect(
      computeMinRuleStatus({ openings: 5, claimsClosed: true, claimantStates: [] }),
    ).toBe('claimed');
  });

  it('single claimant: status tracks the submission state', () => {
    const single = (s: 'review' | 'revising' | 'approved') =>
      computeMinRuleStatus({ openings: 1, claimsClosed: false, claimantStates: [s] });
    expect(single('review')).toBe('review');
    expect(single('revising')).toBe('revising');
    expect(single('approved')).toBe('approved');
  });

  it('a still-open spot keeps the task open even if a claimant submitted', () => {
    // openings=2, one claimant in review, one spot free + claims open ⇒ the open spot
    // (rank 0) wins the min over the review contribution.
    expect(
      computeMinRuleStatus({ openings: 2, claimsClosed: false, claimantStates: ['review'] }),
    ).toBe('open');
    // Closing claims drops the open spot, so the submission state surfaces.
    expect(
      computeMinRuleStatus({ openings: 2, claimsClosed: true, claimantStates: ['review'] }),
    ).toBe('review');
  });

  it('multi-claimant: a mixed review/revising split shows the lower (revising)', () => {
    expect(
      computeMinRuleStatus({
        openings: 3,
        claimsClosed: true,
        claimantStates: ['approved', 'review', 'revising'],
      }),
    ).toBe('revising');
  });

  it('rejected submissions are excluded from the min', () => {
    // {approved, approved, rejected}, claims closed ⇒ approved (rejected excluded).
    expect(
      computeMinRuleStatus({
        openings: 3,
        claimsClosed: true,
        claimantStates: ['approved', 'approved', 'rejected'],
      }),
    ).toBe('approved');
  });

  it('all-approved (claims closed, no open spots) ⇒ approved', () => {
    expect(
      computeMinRuleStatus({
        openings: 2,
        claimsClosed: true,
        claimantStates: ['approved', 'approved'],
      }),
    ).toBe('approved');
  });

  it('Empty Contributing Set Floor: a lone rejected submission ⇒ claimed, never approved', () => {
    expect(
      computeMinRuleStatus({
        openings: 1,
        claimsClosed: true,
        claimantStates: ['rejected'],
      }),
    ).toBe('claimed');
  });
});
