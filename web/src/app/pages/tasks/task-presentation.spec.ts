import { Message, TimelineEntry } from '../../core/api.types';
import {
  buildHistory,
  divisionColor,
  initials,
  isMultiClaim,
  relativeTime,
  stampClass,
  stampStatus,
  teamColor,
} from './task-presentation';

describe('task-presentation', () => {
  describe('stamp', () => {
    it('maps each status to its stamp modifier', () => {
      expect(stampClass('open')).toBe('stamp--open');
      expect(stampClass('review')).toBe('stamp--review');
      expect(stampClass('approved')).toBe('stamp--approved');
    });

    it('treats a null statusCache as open (nothing has happened yet)', () => {
      expect(stampStatus(null)).toBe('open');
      expect(stampClass(null)).toBe('stamp--open');
    });
  });

  describe('isMultiClaim', () => {
    it('is true only when there is more than one opening (1-of-1 is the norm)', () => {
      expect(isMultiClaim({ openings: 1 })).toBe(false);
      expect(isMultiClaim({ openings: 2 })).toBe(true);
      expect(isMultiClaim({ openings: 0 })).toBe(false);
    });
  });

  describe('relativeTime', () => {
    const now = Date.parse('2026-06-21T12:00:00.000Z');
    const ago = (ms: number) => new Date(now - ms).toISOString();

    it('renders compact buckets', () => {
      expect(relativeTime(ago(10_000), now)).toBe('just now');
      expect(relativeTime(ago(5 * 60_000), now)).toBe('5m');
      expect(relativeTime(ago(6 * 3_600_000), now)).toBe('6h');
      expect(relativeTime(ago(5 * 86_400_000), now)).toBe('5d');
      expect(relativeTime(ago(14 * 86_400_000), now)).toBe('2w');
      expect(relativeTime(ago(60 * 86_400_000), now)).toBe('2mo');
    });

    it('is empty for an unparseable date', () => {
      expect(relativeTime('not-a-date', now)).toBe('');
    });
  });

  describe('colours', () => {
    it('uses the canonical hue for known division names (case-insensitive)', () => {
      expect(divisionColor('Writing')).toBe('#3c5ba0');
      expect(divisionColor('art')).toBe('#b0573c');
    });

    it('is deterministic for unknown divisions and for teams', () => {
      expect(divisionColor('Audio')).toBe(divisionColor('Audio'));
      expect(teamColor('USA')).toBe(teamColor('USA'));
    });
  });

  describe('initials', () => {
    it('takes first+last initials, or two letters of a single token', () => {
      expect(initials('Maya Lin')).toBe('ML');
      expect(initials('Devin')).toBe('DE');
      expect(initials('  ')).toBe('?');
    });
  });

  describe('buildHistory', () => {
    const resolve = (id: string | null) =>
      id === null ? 'System' : ({ u1: 'Maya', u3: 'Devin' }[id] ?? id);
    const at = (day: number, hour = 0) => `2026-06-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.000Z`;

    function entry(partial: Partial<TimelineEntry> & Pick<TimelineEntry, 'id' | 'type' | 'payload'>): TimelineEntry {
      return { actorUserId: 'u1', occurredAt: at(17), ...partial } as TimelineEntry;
    }
    function msg(partial: Partial<Message>): Message {
      return {
        id: 'm', taskId: 't', senderUserId: 'u1', parentMessageId: null, submissionId: null,
        body: '', deletedAt: null, editedAt: null, version: 1,
        createdAt: at(17), attachments: [], ...partial,
      };
    }

    it('renders typed events with resolved names', () => {
      const events = buildHistory(
        [
          entry({ id: 'e0', type: 'task.created', actorUserId: 'u3', payload: {}, occurredAt: at(16) }),
          entry({ id: 'e1', type: 'task.claimed', payload: { userId: 'u1' } }),
        ],
        [],
        resolve,
      );
      expect(events.map((e) => [e.node, e.text])).toEqual([
        ['request', 'Devin requested this task'],
        ['claim', 'Maya claimed an opening'],
      ]);
    });

    it('threads a submission’s decisions and the comments about it under its submit event', () => {
      const events = buildHistory(
        [
          entry({ id: 'e1', type: 'submission.submitted', payload: { submissionId: 's1', submissionNo: 2 }, occurredAt: at(18) }),
          entry({
            id: 'e2',
            type: 'submission.reviewed',
            actorUserId: 'u3',
            payload: { submissionId: 's1', submissionNo: 2, decision: 'return' },
            occurredAt: at(19),
          }),
        ],
        [msg({ id: 'c1', senderUserId: 'u3', submissionId: 's1', body: 'Loosen lines 4–9.', createdAt: at(19, 1) })],
        resolve,
      );
      expect(events.map((e) => e.id)).toEqual(['e1']);
      expect(events[0].submission).toEqual({ submissionId: 's1', actorId: 'u1', version: 2 });
      expect(events[0].replies.map((r) => r.id)).toEqual(['e2', 'c1']);
      expect(events[0].replies[0]).toMatchObject({ node: 'return', text: 'Devin returned v2' });
      expect(events[0].replies[1]).toMatchObject({ kind: 'comment', text: 'Loosen lines 4–9.' });
    });

    it('interleaves comments with events by time, and shows deleted markers', () => {
      const events = buildHistory(
        [entry({ id: 'e1', type: 'task.claimed', payload: { userId: 'u1' }, occurredAt: at(17) })],
        [
          msg({ id: 'm1', body: 'On it.', createdAt: at(18) }),
          msg({ id: 'm0', body: '', deletedAt: at(18), createdAt: at(16) }),
        ],
        resolve,
      );
      expect(events.map((e) => e.id)).toEqual(['m0', 'e1', 'm1']);
      expect(events[0].text).toBe('(deleted)');
      expect(events[2]).toMatchObject({ kind: 'comment', text: 'On it.' });
    });
  });
});
