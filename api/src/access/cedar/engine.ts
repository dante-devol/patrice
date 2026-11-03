import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import * as cedar from '@cedar-policy/cedar-wasm/nodejs';
import { CEDAR_NAMESPACE, CEDAR_SCHEMA_TEXT } from './schema';

export interface CedarUid {
  type: string;
  id: string;
}

export interface CedarEntity {
  uid: CedarUid;
  attrs: Record<string, unknown>;
  parents: CedarUid[];
}

export interface AuthorizeRequest {
  principal: CedarUid;
  action: CedarUid;
  resource: CedarUid;
  context?: Record<string, unknown>;
  entities: CedarEntity[];
  /** The projected policy set as Cedar text (static policies + grant policies). */
  policiesText: string;
}

/**
 * Thin wrapper over `@cedar-policy/cedar-wasm`. Authorization runs **without a
 * schema** (dynamic) so `has`-guarded heterogeneous resources evaluate correctly;
 * the schema is used separately for projection-time validation.
 */
@Injectable()
export class CedarEngine {
  private readonly logger = new Logger(CedarEngine.name);

  /** Parse-validate a policy-set text; returns error messages (empty = ok). */
  parseErrors(policiesText: string): string[] {
    const ans = cedar.checkParsePolicySet({ staticPolicies: policiesText });
    if (ans.type === 'success') return [];
    return ans.errors.map((e) => e.message);
  }

  /**
   * Schema-validate a policy set against the Patrice Cedar schema (strict mode).
   * Used for **validate-before-activate** on grant writes: a projected grant whose
   * action/scope combination is structurally impossible (e.g. scoping a governance
   * action by division, or `own` on a resource with no owner relation) surfaces here
   * as a validation error and is refused at the boundary before the row is written.
   * Returns the error messages (empty = valid).
   */
  validationErrors(policiesText: string): string[] {
    const parse = this.parseErrors(policiesText);
    if (parse.length > 0) return parse;
    const ans = cedar.validate({
      validationSettings: { mode: 'strict' },
      schema: CEDAR_SCHEMA_TEXT as unknown as cedar.Schema,
      policies: { staticPolicies: policiesText },
    });
    if (ans.type === 'failure') return ans.errors.map((e) => e.message);
    return (ans.validationErrors ?? []).map((e) => e.error.message);
  }

  /** Policy-set texts already parsed into the engine, by content hash. */
  private readonly preparsed = new Set<string>();

  /** The id of `policiesText` parsed once into the engine (later calls reuse it). */
  private preparsedId(policiesText: string): string {
    const id = createHash('sha256').update(policiesText).digest('hex');
    if (!this.preparsed.has(id)) {
      const ans = cedar.preparsePolicySet(id, { staticPolicies: policiesText });
      if (ans.type !== 'success') {
        throw new Error(`Cedar policy set failed to parse: ${ans.errors.map((e) => e.message).join('; ')}`);
      }
      // Policy sets change only on config edits; keep a handful of recent ones.
      if (this.preparsed.size >= 32) this.preparsed.clear();
      this.preparsed.add(id);
    }
    return id;
  }

  /** Authorize a single request. Returns true iff the decision is `allow`. */
  authorize(req: AuthorizeRequest): boolean {
    const answer = cedar.statefulIsAuthorized({
      principal: { type: req.principal.type, id: req.principal.id },
      action: { type: req.action.type, id: req.action.id },
      resource: { type: req.resource.type, id: req.resource.id },
      context: (req.context ?? {}) as unknown as cedar.Context,
      preparsedPolicySetId: this.preparsedId(req.policiesText),
      entities: req.entities.map((e) => ({
        uid: e.uid,
        attrs: e.attrs as Record<string, cedar.CedarValueJson>,
        parents: e.parents,
      })),
    });
    if (answer.type === 'failure') {
      // An evaluation failure (malformed entities/policies) is a server fault, not
      // a user denial — surface it loudly rather than silently denying.
      const msg = answer.errors.map((e) => e.message).join('; ');
      throw new Error(`Cedar authorization failure: ${msg}`);
    }
    return answer.response.decision === 'allow';
  }

  /** Qualify a bare entity-type name with the Patrice namespace. */
  static qualify(entityType: string): string {
    return `${CEDAR_NAMESPACE}::${entityType}`;
  }

  /** The fully-qualified action entity type. */
  static actionType(): string {
    return `${CEDAR_NAMESPACE}::Action`;
  }
}
