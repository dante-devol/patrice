import { ACTIONS } from '../actions';

/**
 * Cedar schema (human-readable text). Used for **projection-time
 * validation** of the policy set; authorization at request time runs without a
 * schema (dynamic) so heterogeneous resources can be guarded with `has`.
 *
 * The principal `User` is `in [Role]` (memberOf its roles) and carries the
 * `memberDivisions`/`memberTeams` sets (from `membership`) used by the
 * `own_division`/`own_team` scopes and by claim eligibility.
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
    // division-targeted action (division:update, task:create) can match.
    division?: Division,
    restrictClaims?: Bool,
    allowCustomTemplates?: Bool,
    // For *:assign_roles: the unit role being assigned, and whether leads may.
    targetRole?: Role,
    targetRoleAssignableByLeads?: Bool
  };
  entity Team {
    // Self-reference, plus the divisions it supports. Division scopes and division
    // unit roles reach a team only when it lists exactly one division and isn't an
    // all-division team; divisionCount is sent because Cedar has no set size.
    team?: Team,
    divisions?: Set<Division>,
    allDivisions?: Bool,
    divisionCount?: Long,
    restrictClaims?: Bool,
    targetRole?: Role,
    targetRoleAssignableByLeads?: Bool
  };
  // A unit role as held at one unit ("<roleId>@division:<id>" / "@team:<id>").
  entity UnitRole;
  entity Role {
    targetRole?: Role
  };
  entity User in [Role, UnitRole] {
    memberDivisions: Set<Division>,
    memberTeams: Set<Team>,
    targetRole?: Role,
    discordGated?: Bool
  };
  entity Organization;
  entity Invitation;
  entity Session {
    owner?: User
  };
  entity Task {
    division?: Division,
    team?: Team,
    requester?: User,
    // Everyone holding a seat (own scope for leave/submit, visibility).
    claimants?: Set<User>,
    // The reviewed submission's author (the self-review forbid).
    claimant?: User,
    divisionRestrictsClaims?: Bool,
    teamRestrictsClaims?: Bool
  };
  entity Message {
    division?: Division,
    team?: Team,
    sender?: User
  };
  entity Attachment {
    division?: Division,
    team?: Team,
    uploader?: User
  };
${actionDecls()}
}`;

export const CEDAR_NAMESPACE = 'Patrice';
