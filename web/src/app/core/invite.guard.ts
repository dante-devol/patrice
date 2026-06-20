import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthStore } from './auth.store';

/**
 * Reflects invite-management permission for the route. Only users who may manage
 * invitations (in Slice 1, `invite:create`) can reach the page; everyone else is
 * sent home. UX only — the API re-authorizes every invitation endpoint regardless.
 */
export const inviteManageGuard: CanActivateFn = async () => {
  const auth = inject(AuthStore);
  const router = inject(Router);
  await auth.ensureLoaded();
  if (auth.canInvite()) return true;
  return router.createUrlTree(['/home']);
};
