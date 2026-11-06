import { computed, signal } from '@angular/core';
import { Membership, MembershipChange } from '../../core/api.types';

export type UnitType = 'division' | 'team';

export interface UnitRef {
  unitType: UnitType;
  unitId: string;
}

export const unitKey = (u: UnitRef): string => `${u.unitType}:${u.unitId}`;
const pairKey = (u: UnitRef, userId: string): string => `${unitKey(u)}|${userId}`;

function parsePair(key: string): UnitRef & { userId: string } {
  const [unit, userId] = key.split('|');
  const [unitType, unitId] = unit.split(':') as [UnitType, string];
  return { unitType, unitId, userId };
}

/**
 * The membership editor's working copy. Adding and removing people only changes the
 * staged sets; `changes()` is the `POST /memberships/batch` that turns the saved rows
 * into what the editor shows. Undoing a staged change by hand leaves nothing behind.
 */
export class MembershipDraft {
  readonly saved = signal<Membership[]>([]);
  private readonly adds = signal<ReadonlySet<string>>(new Set());
  private readonly removes = signal<ReadonlySet<string>>(new Set());

  private readonly savedPairs = computed(() => new Set(this.saved().map((m) => pairKey(m, m.userId))));

  readonly count = computed(() => this.adds().size + this.removes().size);

  readonly changes = computed<MembershipChange[]>(() => [
    ...[...this.removes()].map((k) => ({ op: 'remove' as const, ...parsePair(k) })),
    ...[...this.adds()].map((k) => ({ op: 'add' as const, ...parsePair(k) })),
  ]);

  /** Keys (`type:id`) of the units with staged changes. */
  readonly changedUnits = computed(
    () => new Set([...this.adds(), ...this.removes()].map((k) => k.split('|')[0])),
  );

  reset(rows: Membership[]): void {
    this.saved.set(rows);
    this.discard();
  }

  discard(): void {
    this.adds.set(new Set());
    this.removes.set(new Set());
  }

  /** Member once the staged changes apply. */
  isMember(u: UnitRef, userId: string): boolean {
    const k = pairKey(u, userId);
    return this.adds().has(k) || (this.savedPairs().has(k) && !this.removes().has(k));
  }

  /** `added` / `removed` when this person's membership in the unit is staged to change. */
  staged(u: UnitRef, userId: string): 'added' | 'removed' | null {
    const k = pairKey(u, userId);
    return this.adds().has(k) ? 'added' : this.removes().has(k) ? 'removed' : null;
  }

  /** Everyone shown in a unit: current members, staged adds, and staged removes (struck through). */
  shown(u: UnitRef): string[] {
    const prefix = `${unitKey(u)}|`;
    const ids = new Set<string>();
    for (const k of [...this.savedPairs(), ...this.adds()]) if (k.startsWith(prefix)) ids.add(k.slice(prefix.length));
    return [...ids];
  }

  /** How many people will be in the unit after Save. */
  memberCount(u: UnitRef): number {
    return this.shown(u).filter((id) => this.isMember(u, id)).length;
  }

  /** The integration (Discord sync) row, when this membership came from one. */
  source(u: UnitRef, userId: string): Membership['source'] | null {
    return this.saved().find((m) => m.unitType === u.unitType && m.unitId === u.unitId && m.userId === userId)?.source ?? null;
  }

  add(u: UnitRef, userId: string): void {
    const k = pairKey(u, userId);
    if (this.removes().has(k)) this.removes.set(without(this.removes(), k));
    else if (!this.savedPairs().has(k)) this.adds.set(new Set([...this.adds(), k]));
  }

  remove(u: UnitRef, userId: string): void {
    const k = pairKey(u, userId);
    if (this.adds().has(k)) this.adds.set(without(this.adds(), k));
    else if (this.savedPairs().has(k)) this.removes.set(new Set([...this.removes(), k]));
  }

  /** Put a staged add or remove back the way it's saved. */
  undo(u: UnitRef, userId: string): void {
    const k = pairKey(u, userId);
    this.adds.set(without(this.adds(), k));
    this.removes.set(without(this.removes(), k));
  }
}

function without(set: ReadonlySet<string>, k: string): Set<string> {
  const next = new Set(set);
  next.delete(k);
  return next;
}
