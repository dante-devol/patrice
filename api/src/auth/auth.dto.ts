import { z } from 'zod';

// New-account password rules — each rule carries its own specific message so the
// client can tell the user exactly what to fix.
const newPassword = z
  .string({ required_error: 'Password is required' })
  .min(8, 'Password must be at least 8 characters long')
  .max(200, 'Password must be at most 200 characters long')
  .refine((v) => v.trim().length >= 8, {
    message: 'Password must contain at least 8 non-whitespace characters',
  });

const email = z
  .string({ required_error: 'Email address is required' })
  .min(1, 'Email address is required')
  .email('Enter a valid email address (e.g. name@example.com)')
  .max(320, 'Email address is too long');

const displayName = z
  .string({ required_error: 'Display name is required' })
  .trim()
  .min(1, 'Display name is required')
  .max(200, 'Display name must be at most 200 characters long');

export const loginSchema = z.object({
  email,
  password: z
    .string({ required_error: 'Password is required' })
    .min(1, 'Password is required')
    .max(200),
});
export type LoginDto = z.infer<typeof loginSchema>;

export const acceptInviteSchema = z.object({
  passcode: z
    .string()
    .min(1, 'Enter the bootstrap key')
    .max(200, 'Bootstrap key is too long')
    .optional(),
  email,
  password: newPassword,
  displayName,
});
export type AcceptInviteDto = z.infer<typeof acceptInviteSchema>;

export const resendVerificationSchema = z.object({ email });
export type ResendVerificationDto = z.infer<typeof resendVerificationSchema>;

export const confirmVerificationSchema = z.object({ token: z.string().min(1) });
export type ConfirmVerificationDto = z.infer<typeof confirmVerificationSchema>;

export const passwordResetRequestSchema = z.object({ email });
export type PasswordResetRequestDto = z.infer<typeof passwordResetRequestSchema>;

export const passwordResetConfirmSchema = z.object({
  token: z.string().min(1),
  password: newPassword,
});
export type PasswordResetConfirmDto = z.infer<typeof passwordResetConfirmSchema>;

/** The longest an invitation may stay open. */
export const MAX_INVITE_LIFETIME_DAYS = 90;

export const createInvitationSchema = z.object({
  email: email.optional(),
  intendedRoleIds: z.array(z.string().uuid()).optional(),
  // Must be in the future, and at most MAX_INVITE_LIFETIME_DAYS away.
  expiresAt: z.coerce
    .date()
    .refine((d) => d.getTime() > Date.now(), 'Expiry must be in the future')
    .refine(
      (d) => d.getTime() <= Date.now() + MAX_INVITE_LIFETIME_DAYS * 24 * 60 * 60 * 1000,
      `Expiry can be at most ${MAX_INVITE_LIFETIME_DAYS} days away`,
    )
    .optional(),
});
export type CreateInvitationDto = z.infer<typeof createInvitationSchema>;

// ---- Self-service account (Phase 1) ----------------------------------------

/** Change the password (`currentPassword` required when one exists) or add a first one. */
export const setPasswordSchema = z
  .object({ currentPassword: z.string().min(1).optional(), newPassword })
  .strict();
export type SetPasswordDto = z.infer<typeof setPasswordSchema>;

/** Start an email change; accounts with a password must confirm it. */
export const requestEmailChangeSchema = z
  .object({ newEmail: email, currentPassword: z.string().min(1).optional() })
  .strict();
export type RequestEmailChangeDto = z.infer<typeof requestEmailChangeSchema>;

export const confirmEmailChangeSchema = z.object({ token: z.string().min(1) }).strict();
export type ConfirmEmailChangeDto = z.infer<typeof confirmEmailChangeSchema>;
