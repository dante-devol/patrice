import { Injectable, inject } from '@angular/core';
import { ApiClient, RequestBody } from './client';

/** Signing in and out, bootstrap, invitations to redeem, and emailed-link flows. */
@Injectable({ providedIn: 'root' })
export class AuthApi {
  private readonly api = inject(ApiClient);

  bootstrapStatus() {
    return this.api.get('/bootstrap');
  }
  me() {
    return this.api.get('/me');
  }
  login(email: string, password: string) {
    return this.api.post('/auth/login', { email, password });
  }
  logout() {
    return this.api.post('/auth/logout');
  }
  viewInvite(token: string) {
    return this.api.get('/invite/{token}', { path: { token } });
  }
  acceptInvite(token: string, body: RequestBody<'/invite/{token}/accept', 'post'>) {
    return this.api.post('/invite/{token}/accept', body, { path: { token } });
  }
  requestPasswordReset(email: string) {
    return this.api.post('/auth/password-reset', { email });
  }
  confirmPasswordReset(token: string, password: string) {
    return this.api.post('/auth/password-reset/confirm', { token, password });
  }
  confirmEmailChange(token: string) {
    return this.api.post('/auth/email-change/confirm', { token });
  }
  confirmVerification(token: string) {
    return this.api.post('/auth/verify-email/confirm', { token });
  }
  resendVerification(email: string) {
    return this.api.post('/auth/verify-email/resend', { email });
  }
  /** Disconnect a sign-in provider (e.g. Discord); returns the refreshed user. */
  unlinkProvider(provider: string) {
    return this.api.delete('/auth/{provider}', { path: { provider } });
  }
  /** Shorthand for Discord. */
  unlinkDiscord() {
    return this.unlinkProvider('discord');
  }
  /** Full-page OAuth starts (navigations, not XHRs). */
  providerUrl(provider: string, intent: 'login' | 'link' | 'register', invite?: string): string {
    const base = `/api/auth/${encodeURIComponent(provider)}/${intent}`;
    return invite ? `${base}?invite=${encodeURIComponent(invite)}` : base;
  }
}

/** The signed-in user's own account: password, email, sessions. */
@Injectable({ providedIn: 'root' })
export class AccountApi {
  private readonly api = inject(ApiClient);

  setPassword(body: RequestBody<'/me/password', 'post'>) {
    return this.api.post('/me/password', body);
  }
  requestEmailChange(body: RequestBody<'/me/email', 'post'>) {
    return this.api.post('/me/email', body);
  }
  listSessions() {
    return this.api.get('/me/sessions');
  }
  revokeSession(id: string) {
    return this.api.delete('/sessions/{id}', { path: { id } });
  }
}
