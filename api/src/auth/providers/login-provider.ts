import { AuthProvider } from '@prisma/client';

export type OAuthIntent = 'login' | 'register' | 'link';

/** What a login provider tells us about the person who signed in with it. */
export interface ExternalProfile {
  /** The provider's stable account id (`user_identity.provider_subject`). */
  subject: string;
  username: string;
  displayName: string | null;
  email: string | null;
  avatar: string | null;
}

/**
 * The slot an OAuth/OIDC sign-in provider plugs into. Patrice ships Discord; adding
 * another provider means one adapter implementing this, registered in
 * {@link LOGIN_PROVIDERS}, with no change to the flow, callback or account code.
 */
export interface LoginProvider {
  readonly id: AuthProvider;
  isConfigured(): Promise<boolean>;
  authorizeUrl(state: string, intent: OAuthIntent): Promise<string>;
  /** Exchange the callback's authorization code for the signed-in profile. */
  exchange(code: string): Promise<ExternalProfile>;
  /**
   * Optional: provider-specific follow-up once the profile is attached to an account
   * (Discord creates its integration sync links here).
   */
  afterLink?(userId: string, profile: ExternalProfile): Promise<void>;
  /**
   * Optional: provider-specific cleanup when the method is disconnected. Returns
   * whether there was anything to remove.
   */
  afterUnlink?(userId: string): Promise<boolean>;
}

export const LOGIN_PROVIDERS = Symbol('LOGIN_PROVIDERS');
