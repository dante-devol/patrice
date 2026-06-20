import { Routes } from '@angular/router';
import { authGuard } from './core/auth.guard';
import { inviteManageGuard } from './core/invite.guard';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'home' },
  {
    path: 'home',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/home.component').then((m) => m.HomeComponent),
  },
  {
    path: 'setup',
    loadComponent: () => import('./pages/setup.component').then((m) => m.SetupComponent),
  },
  {
    path: 'login',
    loadComponent: () => import('./pages/login.component').then((m) => m.LoginComponent),
  },
  {
    path: 'accept/:token',
    loadComponent: () =>
      import('./pages/accept-invite.component').then((m) => m.AcceptInviteComponent),
  },
  {
    path: 'invitations',
    canActivate: [authGuard, inviteManageGuard],
    loadComponent: () =>
      import('./pages/invitations.component').then((m) => m.InvitationsComponent),
  },
  {
    path: 'forgot-password',
    loadComponent: () =>
      import('./pages/forgot-password.component').then((m) => m.ForgotPasswordComponent),
  },
  {
    path: 'reset-password',
    loadComponent: () =>
      import('./pages/reset-password.component').then((m) => m.ResetPasswordComponent),
  },
  {
    path: 'verify-email',
    loadComponent: () =>
      import('./pages/verify-email.component').then((m) => m.VerifyEmailComponent),
  },
  { path: '**', redirectTo: 'home' },
];
