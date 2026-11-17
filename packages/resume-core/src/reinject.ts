import type { EditableField, ParsedResume, RewriteChange } from './types.js';
import { makeLatexSafe } from './latexSafety.js';

export interface AcceptedChange {
  /** EditableField.id. */
  field: string;
  rewritten: string;
}

export interface ReinjectResult {
  tex: string;
  applied: { field: string; original: string; rewritten: string }[];
  /** Fields that were requested but rejected (unknown id / not editable). */
  skipped: { field: string; reason: string }[];
}

/**
 * Substitutes only the accepted rewrites into the original source at their
 * exact spans. Every byte outside an accepted span is preserved verbatim, so
 * any field the user kept — and all structural LaTeX — stays byte-identical to
 * the source. Replacements are applied right-to-left so earlier offsets remain
 * valid as later spans are spliced.
 */
export function applyAcceptedChanges(
  parsed: ParsedResume,
  accepted: AcceptedChange[],
): ReinjectResult {
  const byId = new Map<string, EditableField>();
  for (const f of parsed.fields) byId.set(f.id, f);

  const applied: ReinjectResult['applied'] = [];
  const skipped: ReinjectResult['skipped'] = [];

  const resolved: { field: EditableField; rewritten: string }[] = [];
  for (const change of accepted) {
    const field = byId.get(change.field);
    if (!field) {
      skipped.push({ field: change.field, reason: 'unknown-or-non-editable-field' });
      continue;
    }

    // LaTeX-safety: escape bare specials, reject structurally broken edits so a
    // malformed rewrite can never break compilation. A skipped field keeps its
    // original source (byte-identical), so the PDF still compiles.
    const result = makeLatexSafe(change.rewritten);
    if (!result.ok) {
      skipped.push({ field: change.field, reason: `unsafe-latex:${result.reason}` });
      continue;
    }
    const safeRewritten = result.safe;

    if (safeRewritten === field.original) {
      // No-op change: keep source byte-identical, nothing to apply.
      continue;
    }
    resolved.push({ field, rewritten: safeRewritten });
  }

  // Guard against overlapping spans (should never happen with our parser).
  const sorted = [...resolved].sort((a, b) => a.field.start - b.field.start);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.field.start < sorted[i - 1]!.field.end) {
      throw new Error(
        `Overlapping edit spans: ${sorted[i - 1]!.field.id} and ${sorted[i]!.field.id}`,
      );
    }
  }

  let tex = parsed.raw;
  // Apply right-to-left to keep offsets stable.
  for (const { field, rewritten } of [...sorted].reverse()) {
    tex = tex.slice(0, field.start) + rewritten + tex.slice(field.end);
    applied.push({ field: field.id, original: field.original, rewritten });
  }
  applied.reverse();

  return { tex, applied, skipped };
}

/**
 * Verifies the "keep" guarantee: every editable field that was NOT accepted is
 * byte-identical between source and output. Returns the ids that changed
 * unexpectedly (should always be empty).
 */
export function verifyKeepIntegrity(
  parsed: ParsedResume,
  accepted: AcceptedChange[],
  outputTex: string,
): { ok: boolean; violations: string[] } {
  // Mirror applyAcceptedChanges exactly: only sanitized, balanced, non-no-op
  // rewrites are actually injected; everything else keeps the original span.
  const applied = new Map<string, string>();
  for (const a of accepted) {
    const f = parsed.fields.find((x) => x.id === a.field);
    if (!f) continue;
    const result = makeLatexSafe(a.rewritten);
    if (!result.ok) continue;
    if (result.safe === f.original) continue;
    applied.set(a.field, result.safe);
  }

  // Recompute offsets in the output by re-splicing applied deltas.
  const violations: string[] = [];
  const sorted = [...parsed.fields].sort((a, b) => a.start - b.start);
  let delta = 0;

  for (const f of sorted) {
    const outStart = f.start + delta;
    if (applied.has(f.id)) {
      const rewritten = applied.get(f.id)!;
      const slice = outputTex.slice(outStart, outStart + rewritten.length);
      if (slice !== rewritten) violations.push(`${f.id} (accepted mismatch)`);
      delta += rewritten.length - f.original.length;
    } else {
      const slice = outputTex.slice(outStart, outStart + f.original.length);
      if (slice !== f.original) violations.push(`${f.id} (kept field mutated)`);
    }
  }

  return { ok: violations.length === 0, violations };
}

export function changesToAccepted(changes: RewriteChange[]): AcceptedChange[] {
  return changes.map((c) => ({ field: c.field, rewritten: c.rewritten }));
}
