import { StagedRows } from './staged-rows';
import { runStaged } from './staged';

interface Row {
  id: string;
  version: number;
  lifecycleState: string;
  name: string;
  restrictClaims: boolean;
}

const row = (over: Partial<Row> = {}): Row => ({
  id: 'a',
  version: 1,
  lifecycleState: 'active',
  name: 'Writing',
  restrictClaims: false,
  ...over,
});

const staged = () =>
  new StagedRows<Row, { name: string; restrictClaims: boolean }>(
    (r) => ({ name: r.name, restrictClaims: r.restrictClaims }),
    () => ({ name: '', restrictClaims: false }),
  );

describe('StagedRows', () => {
  it('stages a field edit and reads it back', () => {
    const s = staged();
    const r = row();
    s.reset([r]);
    s.set(r, 'name', 'Writers');
    expect(s.value(r, 'name')).toBe('Writers');
    expect(s.isChanged(r, 'name')).toBe(true);
    expect(s.count()).toBe(1);
  });

  it('drops an edit set back to the saved value', () => {
    const s = staged();
    const r = row();
    s.reset([r]);
    s.set(r, 'name', 'Writers');
    s.set(r, 'restrictClaims', true);
    s.set(r, 'name', 'Writing');
    expect(s.edits()).toEqual({ a: { restrictClaims: true } });
    s.set(r, 'restrictClaims', false);
    expect(s.count()).toBe(0);
  });

  it('toggles a staged retire, and counts creates', () => {
    const s = staged();
    const r = row();
    s.reset([r]);
    s.toggleLifecycle(r, 'retire');
    expect(s.lifecycleOf(r)).toBe('retire');
    s.addCreate({ name: 'Art' });
    expect(s.count()).toBe(2);
    s.toggleLifecycle(r, 'retire');
    expect(s.lifecycleOf(r)).toBeUndefined();
    expect(s.creates()[0].fields).toEqual({ name: 'Art', restrictClaims: false });
  });

  it('discards everything on reset', () => {
    const s = staged();
    const r = row();
    s.reset([r]);
    s.set(r, 'name', 'X');
    s.addCreate();
    s.reset([r]);
    expect(s.count()).toBe(0);
  });
});

describe('runStaged', () => {
  it('stops at the first failure and clears only what landed', async () => {
    const cleared: string[] = [];
    const op = (name: string, fail = false) => ({
      run: () => (fail ? Promise.reject(new Error(name)) : Promise.resolve()),
      clear: () => cleared.push(name),
    });
    const r = await runStaged([op('a'), op('b', true), op('c')]);
    expect(r.done).toBe(1);
    expect(r.total).toBe(3);
    expect((r.error as Error).message).toBe('b');
    expect(cleared).toEqual(['a']);
  });
});
