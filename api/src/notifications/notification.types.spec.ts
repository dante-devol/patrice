import { computeRecipients, REVIEW_DECISION_TYPE } from './notification.types';

describe('computeRecipients', () => {
  it('removes the sender from their own recipient set', () => {
    expect(computeRecipients(['a', 'b', 'c'], 'b')).toEqual(['a', 'c']);
  });

  it('de-duplicates recipients while preserving first-seen order', () => {
    expect(computeRecipients(['a', 'b', 'a', 'c', 'b'])).toEqual(['a', 'b', 'c']);
  });

  it('drops null/undefined ids (e.g. a senderless system author)', () => {
    expect(computeRecipients(['a', null, undefined, 'b'])).toEqual(['a', 'b']);
  });

  it('returns empty when the only recipient is the sender', () => {
    expect(computeRecipients(['solo'], 'solo')).toEqual([]);
  });

  it('returns empty for an empty cohort', () => {
    expect(computeRecipients([])).toEqual([]);
  });

  it('treats a null sender as no suppression', () => {
    expect(computeRecipients(['a', 'b'], null)).toEqual(['a', 'b']);
  });
});

describe('REVIEW_DECISION_TYPE', () => {
  it('maps each review decision to its notification type', () => {
    expect(REVIEW_DECISION_TYPE.approve).toBe('task.reviewed_approved');
    expect(REVIEW_DECISION_TYPE.return).toBe('task.reviewed_returned');
    expect(REVIEW_DECISION_TYPE.reject).toBe('task.reviewed_rejected');
  });
});
