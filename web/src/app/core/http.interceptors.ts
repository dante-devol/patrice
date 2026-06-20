import { inject } from '@angular/core';
import {
  HttpErrorResponse,
  HttpInterceptorFn,
} from '@angular/common/http';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function readCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

/** Send cookies on every request and attach the CSRF token on mutations (double-submit). */
export const credentialsInterceptor: HttpInterceptorFn = (req, next) => {
  let updated = req.clone({ withCredentials: true });
  if (MUTATING.has(req.method)) {
    const csrf = readCookie('patrice_csrf');
    if (csrf) {
      updated = updated.clone({ setHeaders: { 'X-CSRF-Token': csrf } });
    }
  }
  return next(updated);
};

/** Route to /login on a 401 (reflect-don't-enforce: the API is the authority). */
export const authErrorInterceptor: HttpInterceptorFn = (req, next) => {
  const router = inject(Router);
  return next(req).pipe(
    catchError((err: HttpErrorResponse) => {
      if (err.status === 401 && !router.url.startsWith('/login')) {
        void router.navigate(['/login']);
      }
      return throwError(() => err);
    }),
  );
};
