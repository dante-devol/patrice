import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { ApiService } from './api.service';
import { AuthStore } from './auth.store';

/**
 * Route guard reflecting "is authenticated". When unauthenticated it routes to
 * `/setup` if the instance still needs bootstrapping (no effective admin yet),
 * otherwise to `/login` — so a fresh install is never stranded at the login page.
 */
export const authGuard: CanActivateFn = async () => {
  const auth = inject(AuthStore);
  const api = inject(ApiService);
  const router = inject(Router);

  await auth.ensureLoaded();
  if (auth.isAuthenticated()) return true;

  try {
    const status = await api.bootstrapStatus();
    if (status.open) return router.createUrlTree(['/setup']);
  } catch {
    // If the status check fails, fall through to login.
  }
  return router.createUrlTree(['/login']);
};
