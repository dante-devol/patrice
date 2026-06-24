import { Message, Task } from '../../core/api.types';
import {
  buildHistory,
  divisionColor,
  humanizeSystemBody,
  initials,
  isMultiClaim,
  parseSubmitEvent,
  relativeTime,
  stampClass,
  stampStatus,
  systemNodeKind,
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

  describe('systemNodeKind', () => {
    it('classifies the canonical system bodies', () => {
      expect(systemNodeKind('User abc claimed this task.')).toBe('claim');
      expect(systemNodeKind('User abc left this task.')).toBe('leave');
      expect(systemNodeKind('User abc submitted version 2.')).toBe('submit');
      expect(systemNodeKind('Reviewer abc returned version 1.')).toBe('return');
      expect(systemNodeKind('Reviewer abc approved version 2.')).toBe('approve');
      expect(systemNodeKind('User abc marked this task complete.')).toBe('approve');
      expect(systemNodeKind('Requester changed to user xyz.')).toBe('neutral');
    });
  });

  describe('parseSubmitEvent', () => {
    it('extracts the actor + version from a submit body, else null', () => {
      expect(parseSubmitEvent('User u1 submitted version 3.')).toEqual({ actorId: 'u1', version: 3 });
      expect(parseSubmitEvent('User u1 claimed this task.')).toBeNull();
    });
  });

  describe('humanizeSystemBody', () => {
    const name = (id: string) => ({ u1: 'Maya', u2: 'Aric', u3: 'Devin' }[id] ?? id);

    it('rewrites canonical bodies into domain phrasing with resolved names', () => {
      expect(humanizeSystemBody('User u1 claimed this task.', name)).toBe('Maya claimed an opening');
      expect(humanizeSystemBody('User u1 left this task.', name)).toBe('Maya left');
      expect(humanizeSystemBody('User u1 submitted version 2.', name)).toBe('Maya submitted v2 for review');
      expect(humanizeSystemBody('Reviewer u3 returned version 1.', name)).toBe('Devin returned v1');
      expect(humanizeSystemBody('Reviewer u3 approved version 2.', name)).toBe('Devin approved v2');
      expect(humanizeSystemBody('Requester changed to user u2.', name)).toBe('requester changed to Aric');
    });

    it('never leaks a raw id for an unrecognised body', () => {
      expect(humanizeSystemBody('User u1 did something odd.', name)).toContain('Maya');
    });
  });

  describe('buildHistory', () => {
    const task: Pick<Task, 'requesterUserId' | 'createdAt'> = {
      requesterUserId: 'u3',
      createdAt: '2026-06-16T00:00:00.000Z',
    };
    const resolve = (id: string | null) =>
      id === null ? 'System' : ({ u1: 'Maya', u3: 'Devin' }[id] ?? id);

    function msg(partial: Partial<Message>): Message {
      return {
        id: 'm', taskId: 't', kind: 'comment', senderUserId: 'u1', parentMessageId: null,
        body: '', lifecycleState: 'active', retiredAt: null, editedAt: null, version: 1,
        createdAt: '2026-06-17T00:00:00.000Z', attachments: [], ...partial,
      };
    }

    it('prepends a synthetic requested event from the task itself', () => {
      const events = buildHistory(task, [], resolve);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'system', node: 'request', text: 'Devin requested this task' });
    });

    it('threads one-level replies under their parent event and links submit events', () => {
      const events = buildHistory(
        task,
        [
          msg({
            id: 'm1', kind: 'system', senderUserId: null,
            body: 'User u1 submitted version 2.', createdAt: '2026-06-18T00:00:00.000Z',
            replies: [
              msg({ id: 'm1r', kind: 'system', senderUserId: null, body: 'Reviewer u3 returned version 2.', createdAt: '2026-06-19T00:00:00.000Z' }),
              msg({ id: 'm1c', kind: 'comment', senderUserId: 'u3', body: 'Loosen lines 4–9.', createdAt: '2026-06-19T01:00:00.000Z' }),
            ],
          }),
        ],
        resolve,
      );
      // Top-level stays the submit event; the decision + comment nest under it.
      expect(events.map((e) => e.id)).toEqual(['requested', 'm1']);
      expect(events[1].submission).toEqual({ actorId: 'u1', version: 2 });
      expect(events[1].replies.map((r) => r.id)).toEqual(['m1r', 'm1c']);
      expect(events[1].replies[0]).toMatchObject({ node: 'return', text: 'Devin returned v2' });
      expect(events[1].replies[1]).toMatchObject({ kind: 'comment', text: 'Loosen lines 4–9.' });
    });

    it('humanises system messages and passes comments through as cards', () => {
      const events = buildHistory(
        task,
        [
          msg({ id: 'm1', kind: 'system', senderUserId: null, body: 'User u1 claimed this task.' }),
          msg({ id: 'm2', kind: 'comment', senderUserId: 'u1', body: 'On it.' }),
        ],
        resolve,
      );
      expect(events.map((e) => e.kind)).toEqual(['system', 'system', 'comment']);
      expect(events[1].text).toBe('Maya claimed an opening');
      expect(events[1].node).toBe('claim');
      expect(events[2].text).toBe('On it.');
      expect(events[2].message?.id).toBe('m2');
    });
  });
});
