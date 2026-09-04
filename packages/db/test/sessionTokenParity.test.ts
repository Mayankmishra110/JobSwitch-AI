import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hashToken } from '../src/repositories/identity.js';

/**
 * Cross-language session-token parity (the Go matcher service's highest-
 * risk integration point).
 *
 * This fixture is asserted by BOTH this suite and
 * services/matcher/internal/session's Go test. If they ever disagree, a
 * session issued by apps/web silently fails - or worse, silently resolves
 * to the wrong account - when validated by the Go service. Regenerating the
 * fixture is fine; changing the hashing algorithm on either side without
 * updating both tests is exactly the bug this file exists to catch.
 */

interface TokenPair {
  rawToken: string;
  sha256Hex: string;
}

const FIXTURE = JSON.parse(
  readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'session-tokens.json'),
    'utf8',
  ),
) as TokenPair[];

describe('session token hashing parity with the Go matcher service', () => {
  it('has a non-trivial fixture to check', () => {
    expect(FIXTURE.length).toBeGreaterThan(0);
  });

  it.each(FIXTURE)('hashToken(fixture[%#].rawToken) matches the committed sha256Hex', (pair) => {
    const hash = hashToken(pair.rawToken);
    expect(hash.toString('hex')).toBe(pair.sha256Hex);
  });
});
