import { ACTIONS } from '../actions';

/**
 * Cedar schema (human-readable text) for Slice 1. Used for **projection-time
 * validation** of the policy set; authorization at request time runs without a
 * schema (dynamic) so heterogeneous resources can be guarded with `has`.
 *
 * The principal `User` is `in [Role]` (memberOf its roles) and carries the
 * `memberDivisions`/`memberTeams` sets used by `own_division`/`own_team` scopes
 * and by claim-eligibility in later slices. `Division`/`Team` exist now (the
 * columns exist; inherent roles arrive in Slice 2) so the schema is extensible.
 */
function actionDecls(): string {
  return Object.values(ACTIONS)
    .map(
      (a) =>
        `  action "${a.action}" appliesTo {\n` +
        `    principal: [User],\n` +
        `    resource: [${a.resourceType}]\n` +
        `  };`,
    )
    .join('\n');
}

export const CEDAR_SCHEMA_TEXT = `namespace Patrice {
  entity Division {
    restrictClaims: Bool
  };
  entity Team {
    restrictClaims: Bool
  };
  entity Role;
  entity User in [Role] {
    memberDivisions: Set<Division>,
    memberTeams: Set<Team>
  };
  entity Organization;
  entity Invitation {
    retired: Bool
  };
${actionDecls()}
}`;

export const CEDAR_NAMESPACE = 'Patrice';
