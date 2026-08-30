import { hash, verify } from '@node-rs/argon2';

/**
 * Password hashing - Argon2id (ADR §13).
 *
 * Parameters follow OWASP's current guidance: 19 MiB memory, 2 iterations,
 * parallelism 1. Memory cost is what makes GPU cracking expensive, so it is
 * the parameter not to trim.
 */
const ARGON2_OPTIONS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  // 2 = Argon2id, the hybrid variant. Argon2i and Argon2d each give up one of
  // the two resistances Argon2id keeps.
  algorithm: 2 as const,
};

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, ARGON2_OPTIONS);
}

export async function verifyPassword(
  storedHash: string,
  plain: string,
): Promise<boolean> {
  try {
    return await verify(storedHash, plain, ARGON2_OPTIONS);
  } catch {
    // A malformed or truncated hash must read as "wrong password", never as an
    // exception that a caller might treat as success.
    return false;
  }
}

/**
 * A dummy hash for timing equalisation.
 *
 * When no user exists for a submitted email, the login path still performs a
 * verification against this value. Without it, "no such user" returns in about
 * a millisecond while "wrong password" takes ~50ms, and that difference alone
 * tells an attacker which addresses have accounts - which for this product
 * reveals who is job hunting.
 */
export const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZQ$0kM7zPMSDHRpJ1nGZBLzXlnLIfRQTGZlRLxSPFvNLLo';

export async function equalizeTiming(): Promise<void> {
  await verifyPassword(DUMMY_PASSWORD_HASH, 'timing-equalization-password');
}
