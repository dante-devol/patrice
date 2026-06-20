// Hand-written API contract types for Slice 1.
//
// NOTE (deferred stack item): the pinned stack calls for an OpenAPI-generated
// client + TanStack Query. Slice 1 ships a slim hand-written data layer to stay
// runnable; wiring code-first OpenAPI emission (from the API's Zod schemas) and
// the generated client is a follow-up tracked against the Slice 1 umbrella.

export interface UserCapabilities {
  inviteCreate: boolean;
}

export interface CurrentUser {
  id: string;
  organizationId: string;
  email: string | null;
  displayName: string;
  emailVerified: boolean;
  capabilities: UserCapabilities;
}

export interface BootstrapStatus {
  open: boolean;
  inviteToken: string | null;
}

export interface InviteView {
  // True when the invite is bound to a specific email. The value is intentionally
  // never sent — the redeemer must know it; the server enforces the match.
  requiresEmail: boolean;
  requiresPasscode: boolean;
  status: 'pending' | 'revoked' | 'exhausted' | 'expired';
  isBootstrap: boolean;
}

export interface InvitationListItem {
  id: string;
  email: string | null;
  intendedRoleIds: string[];
  maxUses: number;
  useCount: number;
  status: 'pending' | 'revoked' | 'exhausted' | 'expired';
  createdAt: string;
  expiresAt: string;
}

export interface CreatedInvitation {
  id: string;
  token: string;
  url: string;
}

export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}
