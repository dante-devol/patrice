import { statusSeries } from './unit-stats.service';

const DAY = 24 * 60 * 60 * 1000;
const at = (d: number) => new Date(Date.UTC(2026, 0, 1) + d * DAY);

describe('statusSeries', () => {
  it('counts each task in the state it held at each weekly point', () => {
    const series = statusSeries(at(0), at(21), [
      { taskId: 'a', state: 'open', changedAt: at(1) },
      { taskId: 'a', state: 'claimed', changedAt: at(8) },
      { taskId: 'a', state: 'done', changedAt: at(20) },
      { taskId: 'b', state: 'open', changedAt: at(-3) },
      { taskId: 'b', state: 'retired', changedAt: at(14) },
    ]);
    expect(series.map((p) => p.at)).toEqual([at(0), at(7), at(14), at(21)]);
    // Day 0: only b exists. Day 7: a open. Day 14: a claimed, b retired (same instant counts).
    expect(series.map((p) => [p.counts.open, p.counts.claimed, p.counts.done, p.counts.retired])).toEqual([
      [1, 0, 0, 0],
      [2, 0, 0, 0],
      [0, 1, 0, 1],
      [0, 0, 1, 1],
    ]);
  });

  it('ends with a point at `to` even mid-week', () => {
    const series = statusSeries(at(0), at(10), [{ taskId: 'a', state: 'open', changedAt: at(9) }]);
    expect(series.map((p) => p.at)).toEqual([at(0), at(7), at(10)]);
    expect(series[2].counts.open).toBe(1);
  });
});
