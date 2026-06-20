/**
 * Invitation status is **derived on read** (overview convention), never stored.
 * CASE order matters: revoked beats exhausted beats expired beats pending.
 */
export type InvitationStatus = 'revoked' | 'exhausted' | 'expired' | 'pending';

export function deriveInvitationStatus(inv: {
  revokedAt: Date | null;
  useCount: number;
  maxUses: number;
  expiresAt: Date;
}): InvitationStatus {
  if (inv.revokedAt) return 'revoked';
  if (inv.useCount >= inv.maxUses) return 'exhausted';
  if (Date.now() >= inv.expiresAt.getTime()) return 'expired';
  return 'pending';
}
