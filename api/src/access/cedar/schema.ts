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

/**
 * Resource attributes are declared **optional** (`?`) because resources are
 * heterogeneous and the templates guard every access with `has`. The set is the
 * union of what the five Scope-Shape templates read: `division`/`team` (specific_*
 * / own_*), `targetRole` (role scope), the Own-Family owner relations, and
 * `retired` (the hard-deny). This schema is used for **projection-time validation**
 * only (validate-before-activate); request-time authorization stays schema-less.
 */
export const CEDAR_SCHEMA_TEXT = `namespace Patrice {
  entity Division {
    // Self-reference so a 'specific_division'/'own_division' scope on a
    // division-targeted action (division:update) can match resource.division.
    division?: Division,
    restrictClaims?: Bool,
    retired?: Bool
  };
  entity Team {
    restrictClaims?: Bool,
    retired?: Bool
  };
  entity Role {
    retired?: Bool
  };
  entity User in [Role] {
    memberDivisions: Set<Division>,
    memberTeams: Set<Team>,
    targetRole?: Role,
    retired?: Bool
  };
  entity Organization {
    retired?: Bool
  };
  entity Invitation {
    retired?: Bool
  };
  entity Session {
    owner?: User,
    retired?: Bool
  };
  entity Task {
    division?: Division,
    team?: Team,
    requester?: User,
    claimant?: User,
    // Claim Eligibility AND-Composition (Slice 4.2): the restrict flags the
    // task:assign @ own_as_claimant template reads alongside principal membership.
    divisionRestrictsClaims?: Bool,
    teamRestrictsClaims?: Bool,
    retired?: Bool
  };
  entity Message {
    division?: Division,
    team?: Team,
    sender?: User,
    retired?: Bool
  };
  entity Attachment {
    division?: Division,
    team?: Team,
    uploader?: User,
    retired?: Bool
  };
${actionDecls()}
}`;

export const CEDAR_NAMESPACE = 'Patrice';
