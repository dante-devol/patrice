import { DomainError } from './domain-error';

export type LifecycleStateValue = 'active' | 'deactivated' | 'retired';

/**
 * The retire → grace → revive state of an aggregate. Immutable: each transition
 * returns a new value, so an aggregate only changes state through its own methods.
 */
export class Lifecycle {
  private constructor(
    readonly state: LifecycleStateValue,
    readonly retiredAt: Date | null,
  ) {}

  static active(): Lifecycle {
    return new Lifecycle('active', null);
  }

  static of(state: LifecycleStateValue, retiredAt: Date | null): Lifecycle {
    return new Lifecycle(state, retiredAt);
  }

  get isRetired(): boolean {
    return this.state === 'retired';
  }

  retire(now: Date, label: string): Lifecycle {
    if (this.isRetired) throw new DomainError('ALREADY_RETIRED', `${label} is already retired`);
    return new Lifecycle('retired', now);
  }

  /** Revive is valid only while retired and still inside the grace window. */
  revive(now: Date, graceMs: number, label: string): Lifecycle {
    const inGrace =
      this.isRetired &&
      this.retiredAt !== null &&
      now.getTime() - this.retiredAt.getTime() <= graceMs;
    if (!inGrace) {
      throw new DomainError(
        'NOT_REVIVABLE',
        `${label} is not retired or its grace period has elapsed`,
      );
    }
    return new Lifecycle('active', null);
  }
}
