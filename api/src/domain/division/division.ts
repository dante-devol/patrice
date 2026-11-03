import { uuidv7 } from 'uuidv7';
import { AggregateRoot } from '../shared/aggregate';
import { DomainError } from '../shared/domain-error';
import { Lifecycle } from '../shared/lifecycle';
import { diffFields } from '../../activity/changes';

export interface DivisionSettings {
  defaultOpenings: number;
  openingsLocked: boolean;
  restrictClaims: boolean;
  /** Any requester may write their own questions for a task here. */
  allowCustomTemplates: boolean;
}

export interface DivisionState extends DivisionSettings {
  id: string;
  name: string;
  lifecycle: Lifecycle;
  version: number;
}

export const MAX_DIVISION_NAME = 120;
export const MAX_DEFAULT_OPENINGS = 10_000;

/** A division: the axis of labour, a claim-restriction scope and a permission scope. */
export class Division extends AggregateRoot {
  private _name: string;
  private _settings: DivisionSettings;
  private _lifecycle: Lifecycle;

  private constructor(s: DivisionState) {
    super(s.id, s.version);
    this._name = s.name;
    this._settings = {
      defaultOpenings: s.defaultOpenings,
      openingsLocked: s.openingsLocked,
      restrictClaims: s.restrictClaims,
      allowCustomTemplates: s.allowCustomTemplates,
    };
    this._lifecycle = s.lifecycle;
  }

  static create(name: string, settings: Partial<DivisionSettings> = {}): Division {
    const d = new Division({
      id: uuidv7(),
      name: Division.validName(name),
      defaultOpenings: Division.validOpenings(settings.defaultOpenings ?? 1),
      openingsLocked: settings.openingsLocked ?? false,
      restrictClaims: settings.restrictClaims ?? false,
      allowCustomTemplates: settings.allowCustomTemplates ?? false,
      lifecycle: Lifecycle.active(),
      version: 0,
    });
    d.raise({
      type: 'division.created',
      subjectType: 'division',
      subjectId: d.id,
      payload: { divisionId: d.id },
    });
    return d;
  }

  /** Rebuild from storage. Raises no events. */
  static restore(s: DivisionState): Division {
    return new Division(s);
  }

  get name(): string {
    return this._name;
  }
  get settings(): Readonly<DivisionSettings> {
    return this._settings;
  }
  get lifecycle(): Lifecycle {
    return this._lifecycle;
  }

  /** A retired division can't be edited; revive it first. */
  update(changes: { name?: string } & Partial<DivisionSettings>): void {
    if (this._lifecycle.isRetired) throw new DomainError('DIVISION_RETIRED', 'Division is retired');
    const before = { name: this._name, ...this._settings };
    if (changes.name !== undefined) this._name = Division.validName(changes.name);
    this._settings = {
      defaultOpenings:
        changes.defaultOpenings !== undefined
          ? Division.validOpenings(changes.defaultOpenings)
          : this._settings.defaultOpenings,
      openingsLocked: changes.openingsLocked ?? this._settings.openingsLocked,
      restrictClaims: changes.restrictClaims ?? this._settings.restrictClaims,
      allowCustomTemplates: changes.allowCustomTemplates ?? this._settings.allowCustomTemplates,
    };
    this.raise({
      type: 'division.updated',
      subjectType: 'division',
      subjectId: this.id,
      payload: {
        divisionId: this.id,
        changes: diffFields(before, { name: this._name, ...this._settings }, [
          'name',
          'defaultOpenings',
          'openingsLocked',
          'restrictClaims',
          'allowCustomTemplates',
        ]),
      },
    });
  }

  /**
   * Retiring blocks new tasks in the division; existing tasks finish their lifecycle,
   * which is what lets the division reach zero references and be collected.
   */
  retire(now: Date): void {
    this._lifecycle = this._lifecycle.retire(now, 'Division');
    this.raiseLifecycle('retired');
  }

  revive(now: Date, graceMs: number): void {
    this._lifecycle = this._lifecycle.revive(now, graceMs, 'Division');
    this.raiseLifecycle('revived');
  }

  private raiseLifecycle(kind: 'retired' | 'revived'): void {
    this.raise({
      type: `division.${kind}`,
      subjectType: 'division',
      subjectId: this.id,
      payload: { divisionId: this.id },
    });
  }

  private static validName(name: string): string {
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_DIVISION_NAME) {
      throw new DomainError('VALIDATION_FAILED', 'Division name must be 1–120 characters');
    }
    return trimmed;
  }

  private static validOpenings(n: number): number {
    if (!Number.isInteger(n) || n < 1 || n > MAX_DEFAULT_OPENINGS) {
      throw new DomainError('VALIDATION_FAILED', 'Default openings must be 1–10000');
    }
    return n;
  }
}
