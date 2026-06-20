import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthStore } from './auth.store';

/**
 * Reflects org-configuration permission for the admin area. Only users who may
 * author config (Slice 2, `grant:create` ⇒ effective admin) reach it; everyone
 * else is sent home. UX only — the API re-authorizes every endpoint regardless.
 */
export const adminGuard: CanActivateFn = async () => {
  const auth = inject(AuthStore);
  const router = inject(Router);
  await auth.ensureLoaded();
  if (auth.canManageOrg()) return true;
  return router.createUrlTree(['/home']);
};
