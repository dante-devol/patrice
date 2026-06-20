import { Injectable, Logger } from '@nestjs/common';
import * as cedar from '@cedar-policy/cedar-wasm/nodejs';
import { CEDAR_NAMESPACE } from './schema';

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

  /** Authorize a single request. Returns true iff the decision is `allow`. */
  authorize(req: AuthorizeRequest): boolean {
    const answer = cedar.isAuthorized({
      principal: { type: req.principal.type, id: req.principal.id },
      action: { type: req.action.type, id: req.action.id },
      resource: { type: req.resource.type, id: req.resource.id },
      context: (req.context ?? {}) as unknown as cedar.Context,
      policies: { staticPolicies: req.policiesText },
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
