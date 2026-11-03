import { ActivityPayload, ActivityVerb } from '../../activity/activity.types';

/**
 * Something that happened to an aggregate. The unit of work turns each event into an
 * audit row (`type` is the activity verb) inside the command's transaction.
 */
export interface DomainEvent<V extends ActivityVerb = ActivityVerb> {
  type: V;
  subjectType: string;
  subjectId: string;
  payload: ActivityPayload<V>;
  /** True when the change alters the projected Cedar policy text. */
  policyChanged?: boolean;
}

/**
 * Base for aggregate roots. `version` is the optimistic-lock counter the repository
 * checks on save; `pullEvents` hands raised events to the unit of work exactly once.
 */
export abstract class AggregateRoot {
  private events: DomainEvent[] = [];

  protected constructor(
    readonly id: string,
    private _version: number,
  ) {}

  get version(): number {
    return this._version;
  }

  /** Called by the repository after a successful version-guarded save. */
  markSaved(newVersion: number): void {
    this._version = newVersion;
  }

  protected raise<V extends ActivityVerb>(event: DomainEvent<V>): void {
    this.events.push(event as unknown as DomainEvent);
  }

  pullEvents(): DomainEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }
}
