/**
 * Fixture capture tool.
 *
 *   pnpm --filter @jobswitch/ingest capture -- greenhouse <board-token>
 *
 * Fetches a real board and writes the response to test/fixtures. Run this on a
 * machine with outbound network access - it exists because the environment
 * Phase 2 was built in could not reach any ATS host, so the shipped fixture is
 * synthetic (ADR D-20 wants stored real payloads).
 *
 * After capturing, run the adapter tests: they will exercise the real shape,
 * and any mismatch between documentation and reality surfaces there rather
 * than in production at 4am.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireAdapter } from '../registry.js';
import { DEFAULT_USER_AGENT } from '../run.js';

const FIXTURE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'test',
  'fixtures',
);

const [atsType, boardIdentifier] = process.argv.slice(2);

if (!atsType || !boardIdentifier) {
  console.error(
    'Usage: capture <ats-type> <board-identifier>\n' +
      '  e.g. capture greenhouse razorpay',
  );
  process.exit(1);
}

const adapter = requireAdapter(atsType);

console.log(`Fetching ${atsType} board "${boardIdentifier}"...`);

try {
  const result = await adapter.fetch({
    boardIdentifier,
    fetchImpl: fetch,
    userAgent: DEFAULT_USER_AGENT,
  });

  await mkdir(FIXTURE_DIR, { recursive: true });
  const outPath = path.join(FIXTURE_DIR, `${atsType}-${boardIdentifier}.json`);

  await writeFile(
    outPath,
    JSON.stringify(
      {
        _fixture_provenance: {
          status: 'CAPTURED from a live board',
          captured: true,
          capturedAt: new Date().toISOString(),
          atsType,
          boardIdentifier,
          httpStatus: result.httpStatus,
        },
        jobs: result.raw,
      },
      null,
      2,
    ),
    'utf8',
  );

  console.log(`Wrote ${result.raw.length} postings to ${outPath}`);

  // Normalizing here catches a documentation/reality mismatch immediately,
  // which is the entire reason to capture rather than trust the docs.
  let normalized = 0;
  for (const record of result.raw) {
    adapter.normalize(record);
    normalized += 1;
  }
  console.log(`Normalized ${normalized}/${result.raw.length} records successfully.`);
} catch (error) {
  console.error('Capture failed:', error instanceof Error ? error.message : error);
  process.exit(1);
}
