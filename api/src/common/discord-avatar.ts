/**
 * Build a Discord CDN avatar URL from a user's snowflake id + avatar hash (#52).
 * `a_`-prefixed hashes are animated; we always serve the static `.png` so callers
 * don't have to branch. Returns null when the user has no avatar hash.
 */
export function discordAvatarUrl(
  externalUserId: string | null | undefined,
  avatarHash: string | null | undefined,
  size = 64,
): string | null {
  if (!externalUserId || !avatarHash) return null;
  return `https://cdn.discordapp.com/avatars/${externalUserId}/${avatarHash}.png?size=${size}`;
}
