import { computed, signal } from '@angular/core';

export type LifecycleOp = 'retire' | 'revive';

/** A saved admin row: anything with an id, a version and a lifecycle. */
export interface StagedRow {
  id: string;
  version: number;
  lifecycleState: string;
}

/**
 * The staging for a table of admin rows (divisions, teams, roles). Field edits, new rows
 * and retire/revive are all held here until Save; reverting a field to its saved value
 * drops the edit, so "changed" always means "differs from what's saved".
 */
export class StagedRows<T extends StagedRow, F extends object> {
  readonly saved = signal<T[]>([]);
  readonly edits = signal<Record<string, Partial<F>>>({});
  readonly lifecycle = signal<Record<string, LifecycleOp>>({});
  readonly creates = signal<{ key: string; fields: F }[]>([]);
  private nextKey = 1;

  readonly count = computed(
    () => Object.keys(this.edits()).length + Object.keys(this.lifecycle()).length + this.creates().length,
  );

  /**
   * @param pick the editable fields of a saved row
   * @param blank the fields of a new row
   */
  constructor(
    private readonly pick: (row: T) => F,
    private readonly blank: () => F,
  ) {}

  /** Replace the saved rows and drop everything staged. */
  reset(rows: T[]): void {
    this.saved.set(rows);
    this.discard();
  }

  discard(): void {
    this.edits.set({});
    this.lifecycle.set({});
    this.creates.set([]);
  }

  value<K extends keyof F>(row: T, k: K): F[K] {
    const edit = this.edits()[row.id];
    return edit && k in edit ? (edit[k] as F[K]) : this.pick(row)[k];
  }

  set<K extends keyof F>(row: T, k: K, v: F[K]): void {
    const { [row.id]: current = {}, ...others } = this.edits();
    const { [k]: _old, ...rest } = current as Partial<F>;
    const next = (v === this.pick(row)[k] ? rest : { ...rest, [k]: v }) as Partial<F>;
    this.edits.set(Object.keys(next).length > 0 ? { ...others, [row.id]: next } : others);
  }

  isChanged(row: T, k?: keyof F): boolean {
    const edit = this.edits()[row.id];
    if (k !== undefined) return !!edit && k in edit;
    return !!edit || row.id in this.lifecycle();
  }

  /** The staged lifecycle change for a row, if any. */
  lifecycleOf(row: T): LifecycleOp | undefined {
    return this.lifecycle()[row.id];
  }

  /** Stage a retire or revive; staging the same one again undoes it. */
  toggleLifecycle(row: T, op: LifecycleOp): void {
    const { [row.id]: current, ...others } = this.lifecycle();
    this.lifecycle.set(current === op ? others : { ...others, [row.id]: op });
  }

  addCreate(fields: Partial<F> = {}): void {
    this.creates.update((cs) => [...cs, { key: `new:${this.nextKey++}`, fields: { ...this.blank(), ...fields } }]);
  }

  updateCreate<K extends keyof F>(key: string, k: K, v: F[K]): void {
    this.creates.update((cs) => cs.map((c) => (c.key === key ? { ...c, fields: { ...c.fields, [k]: v } } : c)));
  }

  removeCreate(key: string): void {
    this.creates.update((cs) => cs.filter((c) => c.key !== key));
  }

  /** Drop one landed change (after Save applied it). */
  clearEdit(id: string): void {
    const { [id]: _e, ...rest } = this.edits();
    this.edits.set(rest);
  }
  clearLifecycle(id: string): void {
    const { [id]: _l, ...rest } = this.lifecycle();
    this.lifecycle.set(rest);
  }
}
