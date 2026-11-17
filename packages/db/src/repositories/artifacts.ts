import {
  AccountId,
  type ProposedEdit,
  type ResumeArtifact,
  type ResumeArtifactStatus,
  type TailorFlag,
} from '@jobswitch/core';
import type { Queryable } from '../context.js';

/**
 * Resume tailoring output (Phase 7) - `resume_source` (the candidate's
 * template) and `resume_artifact` (one tailoring run). Schema is Phase 5's
 * (migration 0008); this is the first application-layer code to read or
 * write either. See specs/application-workspace.md.
 */

export interface ResumeSource {
  accountId: AccountId;
  variantId: string;
  label: string;
  pdfBaseName: string;
  tex: string;
  sha256: string;
}

interface ResumeSourceRow {
  account_id: string;
  variant_id: string;
  label: string;
  pdf_base_name: string;
  tex: string;
  sha256: string;
}

function toResumeSource(row: ResumeSourceRow): ResumeSource {
  return {
    accountId: AccountId(row.account_id),
    variantId: row.variant_id,
    label: row.label,
    pdfBaseName: row.pdf_base_name,
    tex: row.tex,
    sha256: row.sha256,
  };
}

export async function listResumeSources(
  tx: Queryable,
  accountId: AccountId,
): Promise<ResumeSource[]> {
  const { rows } = await tx.query<ResumeSourceRow>(
    `SELECT account_id, variant_id, label, pdf_base_name, tex, sha256
     FROM resume_source WHERE account_id = $1 ORDER BY variant_id`,
    [accountId],
  );
  return rows.map(toResumeSource);
}

export async function getResumeSource(
  tx: Queryable,
  accountId: AccountId,
  variantId: string,
): Promise<ResumeSource | null> {
  const { rows } = await tx.query<ResumeSourceRow>(
    `SELECT account_id, variant_id, label, pdf_base_name, tex, sha256
     FROM resume_source WHERE account_id = $1 AND variant_id = $2`,
    [accountId, variantId],
  );
  return rows[0] ? toResumeSource(rows[0]) : null;
}

/**
 * Upsert the candidate's LaTeX template for one variant. sha256 is computed
 * by the caller (routes/applications.ts, over the exact bytes stored) - the
 * same "provenance for the document itself" pattern resume_artifact's own
 * source_sha256 depends on to detect a stale proposal (see
 * getArtifactById's own caller in the compile route).
 */
export async function upsertResumeSource(
  tx: Queryable,
  accountId: AccountId,
  input: { variantId: string; label: string; pdfBaseName: string; tex: string; sha256: string },
): Promise<ResumeSource> {
  const { rows } = await tx.query<ResumeSourceRow>(
    `INSERT INTO resume_source (account_id, variant_id, label, pdf_base_name, tex, sha256)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (account_id, variant_id) DO UPDATE SET
       label = EXCLUDED.label, pdf_base_name = EXCLUDED.pdf_base_name,
       tex = EXCLUDED.tex, sha256 = EXCLUDED.sha256, updated_at = now()
     RETURNING account_id, variant_id, label, pdf_base_name, tex, sha256`,
    [accountId, input.variantId, input.label, input.pdfBaseName, input.tex, input.sha256],
  );
  const row = rows[0];
  if (!row) throw new Error('resume_source upsert returned no row');
  return toResumeSource(row);
}

interface ArtifactRow {
  id: string;
  account_id: string;
  application_id: string;
  variant_id: string;
  source_sha256: string;
  status: ResumeArtifactStatus;
  proposed_changes: Array<{ field: string; rewritten: string; source_fact_refs: string[] }>;
  flags: Array<{ field: string; token: string; reason: 'new-entity' | 'new-metric'; rewritten: string }>;
  accepted: string[];
  tex: string | null;
  pdf_sha256: string | null;
  compile_error: string | null;
  created_at: Date;
  compiled_at: Date | null;
  has_pdf: boolean;
}

const ARTIFACT_COLUMNS = `id, account_id, application_id, variant_id, source_sha256, status,
  proposed_changes, flags, accepted, tex, pdf_sha256, compile_error, created_at, compiled_at,
  (pdf_bytes IS NOT NULL) AS has_pdf`;

function toArtifact(row: ArtifactRow): ResumeArtifact {
  return {
    id: row.id,
    accountId: AccountId(row.account_id),
    applicationId: row.application_id,
    variantId: row.variant_id,
    sourceSha256: row.source_sha256,
    status: row.status,
    proposedChanges: row.proposed_changes.map(
      (c): ProposedEdit => ({ field: c.field, rewritten: c.rewritten, sourceFactRefs: c.source_fact_refs }),
    ),
    flags: row.flags.map((f): TailorFlag => ({ field: f.field, token: f.token, reason: f.reason, rewritten: f.rewritten })),
    accepted: row.accepted,
    tex: row.tex,
    pdfSha256: row.pdf_sha256,
    compileError: row.compile_error,
    createdAt: row.created_at,
    compiledAt: row.compiled_at,
    hasPdf: row.has_pdf,
  };
}

export async function listArtifactsForApplication(
  tx: Queryable,
  accountId: AccountId,
  applicationId: string,
): Promise<ResumeArtifact[]> {
  const { rows } = await tx.query<ArtifactRow>(
    `SELECT ${ARTIFACT_COLUMNS} FROM resume_artifact
     WHERE account_id = $1 AND application_id = $2
     ORDER BY created_at DESC`,
    [accountId, applicationId],
  );
  return rows.map(toArtifact);
}

export async function getArtifactById(
  tx: Queryable,
  accountId: AccountId,
  artifactId: string,
): Promise<ResumeArtifact | null> {
  const { rows } = await tx.query<ArtifactRow>(
    `SELECT ${ARTIFACT_COLUMNS} FROM resume_artifact WHERE account_id = $1 AND id = $2`,
    [accountId, artifactId],
  );
  return rows[0] ? toArtifact(rows[0]) : null;
}

export async function getArtifactPdf(
  tx: Queryable,
  accountId: AccountId,
  artifactId: string,
): Promise<{ pdfBytes: Buffer; pdfSha256: string } | null> {
  const { rows } = await tx.query<{ pdf_bytes: Buffer | null; pdf_sha256: string | null }>(
    `SELECT pdf_bytes, pdf_sha256 FROM resume_artifact WHERE account_id = $1 AND id = $2`,
    [accountId, artifactId],
  );
  const row = rows[0];
  if (!row?.pdf_bytes || !row.pdf_sha256) return null;
  return { pdfBytes: row.pdf_bytes, pdfSha256: row.pdf_sha256 };
}

/** Records one graph run's outcome - 'proposed' (with or without changes) or 'failed' (the AI/tailor call itself errored). */
export async function createArtifact(
  tx: Queryable,
  accountId: AccountId,
  input: {
    applicationId: string;
    variantId: string;
    sourceSha256: string;
    status: 'proposed' | 'failed';
    proposedChanges?: ProposedEdit[];
    flags?: TailorFlag[];
    tex?: string;
    compileError?: string;
  },
): Promise<ResumeArtifact> {
  const proposedChangesJson = JSON.stringify(
    (input.proposedChanges ?? []).map((c) => ({
      field: c.field,
      rewritten: c.rewritten,
      source_fact_refs: c.sourceFactRefs,
    })),
  );
  const flagsJson = JSON.stringify(input.flags ?? []);

  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO resume_artifact
       (account_id, application_id, variant_id, source_sha256, status, proposed_changes, flags, tex, compile_error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      accountId,
      input.applicationId,
      input.variantId,
      input.sourceSha256,
      input.status,
      proposedChangesJson,
      flagsJson,
      input.tex ?? null,
      input.compileError ?? null,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('resume_artifact insert returned no row');

  const created = await getArtifactById(tx, accountId, id);
  if (!created) throw new Error('resume_artifact not found immediately after insert');
  return created;
}

/** Finalizes an artifact after a successful reinject+compile: the accepted subset, the final spliced tex, and the PDF bytes. */
export async function markArtifactCompiled(
  tx: Queryable,
  accountId: AccountId,
  artifactId: string,
  input: { accepted: string[]; tex: string; pdfBytes: Buffer; pdfSha256: string },
): Promise<ResumeArtifact | null> {
  const { rowCount } = await tx.query(
    `UPDATE resume_artifact
     SET status = 'compiled', accepted = $3, tex = $4, pdf_bytes = $5, pdf_sha256 = $6,
         compile_error = NULL, compiled_at = now()
     WHERE account_id = $1 AND id = $2`,
    [accountId, artifactId, JSON.stringify(input.accepted), input.tex, input.pdfBytes, input.pdfSha256],
  );
  if (rowCount === 0) return null;
  return getArtifactById(tx, accountId, artifactId);
}

export async function markArtifactFailed(
  tx: Queryable,
  accountId: AccountId,
  artifactId: string,
  compileError: string,
): Promise<ResumeArtifact | null> {
  const { rowCount } = await tx.query(
    `UPDATE resume_artifact SET status = 'failed', compile_error = $3 WHERE account_id = $1 AND id = $2`,
    [accountId, artifactId, compileError],
  );
  if (rowCount === 0) return null;
  return getArtifactById(tx, accountId, artifactId);
}
