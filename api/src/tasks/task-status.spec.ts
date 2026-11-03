import { deriveStatus } from './task-status';

describe('deriveStatus', () => {
  it('a completed task is approved, whatever its seats say', () => {
    expect(deriveStatus({ completed: true, openings: 3, claimsClosed: false, claimantStates: [null, 'review'] })).toBe(
      'approved',
    );
  });

  it('not-required submissions contribute nothing', () => {
    expect(deriveStatus({ completed: false, openings: 2, claimsClosed: true, claimantStates: ['not_required', 'review'] })).toBe(
      'review',
    );
  });

  it('reduces to open/claimed when there are no submissions', () => {
    expect(
      deriveStatus({ completed: false, openings: 1, claimsClosed: false, claimantStates: [] }),
    ).toBe('open');
    expect(
      deriveStatus({ completed: false, openings: 1, claimsClosed: false, claimantStates: [null] }),
    ).toBe('claimed');
    expect(
      deriveStatus({ completed: false, openings: 5, claimsClosed: true, claimantStates: [] }),
    ).toBe('claimed');
  });

  it('single claimant: status tracks the submission state', () => {
    const single = (s: 'review' | 'revising' | 'approved') =>
      deriveStatus({ completed: false, openings: 1, claimsClosed: false, claimantStates: [s] });
    expect(single('review')).toBe('review');
    expect(single('revising')).toBe('revising');
    expect(single('approved')).toBe('approved');
  });

  it('a still-open spot keeps the task open even if a claimant submitted', () => {
    // openings=2, one claimant in review, one spot free + claims open ⇒ the open spot
    // (rank 0) wins the min over the review contribution.
    expect(
      deriveStatus({ completed: false, openings: 2, claimsClosed: false, claimantStates: ['review'] }),
    ).toBe('open');
    // Closing claims drops the open spot, so the submission state surfaces.
    expect(
      deriveStatus({ completed: false, openings: 2, claimsClosed: true, claimantStates: ['review'] }),
    ).toBe('review');
  });

  it('multi-claimant: a mixed review/revising split shows the lower (revising)', () => {
    expect(
      deriveStatus({
        completed: false,
        openings: 3,
        claimsClosed: true,
        claimantStates: ['approved', 'review', 'revising'],
      }),
    ).toBe('revising');
  });

  it('rejected submissions are excluded from the min', () => {
    // {approved, approved, rejected}, claims closed ⇒ approved (rejected excluded).
    expect(
      deriveStatus({
        completed: false,
        openings: 3,
        claimsClosed: true,
        claimantStates: ['approved', 'approved', 'rejected'],
      }),
    ).toBe('approved');
  });

  it('all-approved (claims closed, no open spots) ⇒ approved', () => {
    expect(
      deriveStatus({
        completed: false,
        openings: 2,
        claimsClosed: true,
        claimantStates: ['approved', 'approved'],
      }),
    ).toBe('approved');
  });

  it('Empty Contributing Set Floor: a lone rejected submission ⇒ claimed, never approved', () => {
    expect(
      deriveStatus({
        completed: false,
        openings: 1,
        claimsClosed: true,
        claimantStates: ['rejected'],
      }),
    ).toBe('claimed');
  });
});
