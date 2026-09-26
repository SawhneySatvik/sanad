import { z } from "zod";

// bcrypt (what Supabase Auth hashes with) only looks at a password's first 72 BYTES, not
// characters — a refine on the UTF-8 byte length so a passphrase full of multi-byte characters is
// bounded by the same limit bcrypt itself enforces, never by a shorter character count.
const MAX_PASSWORD_BYTES = 72;
function passwordByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * POST /api/auth/sign-in's request body. 6 is Supabase Auth's own default minimum, kept here (not
 * sign-up's 8) so an account created before this app enforced a stronger policy can still sign in;
 * 254 is RFC 5321's own email length cap. Bounds are a cheap edge sanity check, not real credential
 * policy — Supabase itself is the source of truth for whether a password is accepted.
 */
export const SignInInput = z.strictObject({
  email: z.string().min(1).max(254),
  password: z
    .string()
    .min(6)
    .max(MAX_PASSWORD_BYTES)
    .refine((value) => passwordByteLength(value) <= MAX_PASSWORD_BYTES, { message: `Password must be at most ${MAX_PASSWORD_BYTES} bytes.` }),
});
export type SignInInput = z.infer<typeof SignInInput>;

/** POST /api/auth/sign-up's own request body — same shape, but its own 8-character minimum. */
export const SignUpInput = z.strictObject({
  email: z.string().min(1).max(254),
  password: z
    .string()
    .min(8)
    .max(MAX_PASSWORD_BYTES)
    .refine((value) => passwordByteLength(value) <= MAX_PASSWORD_BYTES, { message: `Password must be at most ${MAX_PASSWORD_BYTES} bytes.` }),
});
export type SignUpInput = z.infer<typeof SignUpInput>;

/** The shape both sign-in and sign-up hand to supabase-auth.ts and auth.ts — sign-in's own (looser) bounds are enough for either caller's own body validation to have already run. */
export type EmailPasswordInput = SignInInput;
