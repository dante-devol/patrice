import { Inject, Injectable } from '@nestjs/common';
import { ENV, Env } from '../config/env';

const DISCORD_API = 'https://discord.com/api/v10';

export interface DiscordOAuthUser {
  /** Stable Discord snowflake — the subject we key identity on. */
  id: string;
  username: string;
  /** The user's chosen display name (newer Discord field), may be absent. */
  globalName: string | null;
  /** Avatar hash for the CDN URL; `a_`-prefixed = animated (#52). */
  avatar: string | null;
  /** Present only when the `email` scope was granted. */
  email: string | null;
}

/**
 * Thin wrapper over Discord's **app-level** OAuth (the `DISCORD_CLIENT_ID/SECRET`
 * application). This is the auth/identity client — connection-independent — and is
 * deliberately separate from the per-connection bot token used for role sync. The
 * one redirect URI (`callbackUri`) serves every Discord flow (login/register/link)
 * so only a single URI needs registering in the Discord developer portal.
 */
@Injectable()
export class DiscordOAuthService {
  constructor(@Inject(ENV) private readonly env: Env) {}

  isConfigured(): boolean {
    return !!(this.env.DISCORD_CLIENT_ID && this.env.DISCORD_CLIENT_SECRET);
  }

  /** The single OAuth redirect URI for all Discord flows. */
  callbackUri(): string {
    return `${this.env.PUBLIC_BASE_URL.replace(/\/$/, '')}/api/auth/discord/callback`;
  }

  authorizeUrl(state: string, scope = 'identify'): string {
    const params = new URLSearchParams({
      client_id: this.env.DISCORD_CLIENT_ID ?? '',
      redirect_uri: this.callbackUri(),
      response_type: 'code',
      scope,
      state,
    });
    return `https://discord.com/oauth2/authorize?${params.toString()}`;
  }

  /** Exchange an authorization code for a user access token. */
  async exchangeCode(code: string): Promise<string> {
    const res = await fetch(`${DISCORD_API}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.env.DISCORD_CLIENT_ID ?? '',
        client_secret: this.env.DISCORD_CLIENT_SECRET ?? '',
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.callbackUri(),
      }),
    });
    if (!res.ok) {
      throw new Error(`Discord token exchange failed: ${res.status}`);
    }
    const json = (await res.json()) as { access_token: string };
    return json.access_token;
  }

  /** Fetch the consenting user's profile (`/users/@me`). */
  async fetchUser(accessToken: string): Promise<DiscordOAuthUser> {
    const res = await fetch(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      throw new Error(`Discord user fetch failed: ${res.status}`);
    }
    const u = (await res.json()) as {
      id: string;
      username: string;
      global_name?: string | null;
      avatar?: string | null;
      email?: string | null;
    };
    return {
      id: u.id,
      username: u.username,
      globalName: u.global_name ?? null,
      avatar: u.avatar ?? null,
      email: u.email ?? null,
    };
  }
}
