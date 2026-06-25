import { Injectable, Logger } from '@nestjs/common';

interface RateLimitBucket {
  remaining: number;
  resetAt: number; // Unix ms
}

interface DiscordFetchOptions {
  method: string;
  path: string;
  body?: unknown;
  reason?: string;
  botToken: string;
}

export interface DiscordFetchResult {
  status: number;
  ok: boolean;
  body: unknown;
}

const DISCORD_BASE = 'https://discord.com/api/v10';
const GLOBAL_LIMIT_PER_SECOND = 50;

/**
 * Rate-limit-aware Discord REST client (#58).
 *
 * Per-route bucket tracking + global limit:
 *  - Reads X-RateLimit-Remaining / X-RateLimit-Reset from responses.
 *  - On 429: respects Retry-After (seconds) or X-RateLimit-Reset-After.
 *  - Uses X-Audit-Log-Reason on writes.
 *  - Global limit: 50 req/s (Discord default); tracked in-process.
 *
 * Idempotent: re-adding a role that's already present returns 204 on Discord's side.
 */
@Injectable()
export class DiscordRestClient {
  private readonly logger = new Logger(DiscordRestClient.name);
  private readonly buckets = new Map<string, RateLimitBucket>();
  private globalResetAt = 0;
  private globalRemaining = GLOBAL_LIMIT_PER_SECOND;

  private bucketKey(method: string, path: string): string {
    // Major params: guild_id, channel_id. Extract from path for bucket isolation.
    const guild = path.match(/\/guilds\/(\d+)/)?.[1] ?? '';
    const channel = path.match(/\/channels\/(\d+)/)?.[1] ?? '';
    return `${method}:${guild}:${channel}:${path.replace(/\d{17,19}/g, ':id')}`;
  }

  private async waitForBucket(key: string): Promise<void> {
    const now = Date.now();

    // Global limit
    if (this.globalRemaining <= 0 && now < this.globalResetAt) {
      const delay = this.globalResetAt - now + 50;
      this.logger.debug(`Global rate limit — waiting ${delay}ms`);
      await sleep(delay);
    }

    // Per-route bucket
    const bucket = this.buckets.get(key);
    if (bucket && bucket.remaining <= 0 && Date.now() < bucket.resetAt) {
      const delay = bucket.resetAt - Date.now() + 50;
      this.logger.debug(`Bucket ${key} exhausted — waiting ${delay}ms`);
      await sleep(delay);
    }
  }

  private updateBucket(key: string, headers: Headers, isGlobal: boolean): void {
    const remaining = headers.get('x-ratelimit-remaining');
    const reset = headers.get('x-ratelimit-reset');

    if (remaining !== null && reset !== null) {
      this.buckets.set(key, {
        remaining: parseInt(remaining, 10),
        resetAt: Math.ceil(parseFloat(reset) * 1000),
      });
    }

    if (isGlobal) {
      this.globalRemaining = Math.max(0, this.globalRemaining - 1);
      const resetAfter = headers.get('x-ratelimit-reset-after');
      if (resetAfter) {
        this.globalResetAt = Date.now() + parseFloat(resetAfter) * 1000;
        this.globalRemaining = 0;
      }
    } else {
      this.globalRemaining = Math.max(0, this.globalRemaining - 1);
    }
  }

  async fetch(opts: DiscordFetchOptions, retries = 3): Promise<DiscordFetchResult> {
    const key = this.bucketKey(opts.method, opts.path);
    await this.waitForBucket(key);

    const headers: Record<string, string> = {
      Authorization: `Bot ${opts.botToken}`,
      'Content-Type': 'application/json',
    };
    if (opts.reason) {
      headers['X-Audit-Log-Reason'] = opts.reason;
    }

    const response = await globalThis.fetch(`${DISCORD_BASE}${opts.path}`, {
      method: opts.method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });

    const isGlobal = response.headers.get('x-ratelimit-global') === 'true';
    this.updateBucket(key, response.headers, isGlobal);

    if (response.status === 429) {
      if (retries <= 0) {
        this.logger.warn(`Rate limited on ${opts.path} — out of retries`);
        return { status: 429, ok: false, body: null };
      }
      const retryAfter = parseFloat(response.headers.get('retry-after') ?? '1') * 1000;
      this.logger.warn(`Rate limited on ${opts.path} — retrying after ${retryAfter}ms`);
      if (isGlobal) {
        this.globalRemaining = 0;
        this.globalResetAt = Date.now() + retryAfter;
      }
      await sleep(retryAfter);
      return this.fetch(opts, retries - 1);
    }

    let body: unknown = null;
    const ct = response.headers.get('content-type') ?? '';
    if (ct.includes('application/json') && response.status !== 204) {
      try { body = await response.json(); } catch { /* empty body */ }
    }

    return { status: response.status, ok: response.ok, body };
  }

  /** PUT /guilds/{guild}/members/{user}/roles/{role} — add a single role to a member. */
  async addMemberRole(guildId: string, userId: string, roleId: string, botToken: string, roleName?: string): Promise<DiscordFetchResult> {
    return this.fetch({
      method: 'PUT',
      path: `/guilds/${guildId}/members/${userId}/roles/${roleId}`,
      botToken,
      reason: `Patrice sync${roleName ? ` (${roleName})` : ''}`,
    });
  }

  /** DELETE /guilds/{guild}/members/{user}/roles/{role} — remove a single role from a member. */
  async removeMemberRole(guildId: string, userId: string, roleId: string, botToken: string, roleName?: string): Promise<DiscordFetchResult> {
    return this.fetch({
      method: 'DELETE',
      path: `/guilds/${guildId}/members/${userId}/roles/${roleId}`,
      botToken,
      reason: `Patrice sync${roleName ? ` (${roleName})` : ''}`,
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
