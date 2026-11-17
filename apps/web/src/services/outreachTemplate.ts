/**
 * Outreach draft content - template-based, not LLM-generated.
 *
 * A deliberate, honest scope decision (see specs/application-workspace.md):
 * services/ai has no outreach-drafting graph, and building one is real new
 * scope beyond "Phase 7 sits on the retention-aware job_application table"
 * (docs/BUILD_PLAN.md's own words for this phase). A plain, editable
 * template gets a candidate to a sendable draft in one click today; an
 * LLM-drafted version is a named, tracked gap (this file's own doc
 * comment), not a silent placeholder pretending to be the real thing.
 */
export function draftOutreachContent(input: {
  title: string;
  company: string | null;
  candidateHeadline: string | null;
}): { subject: string; body: string } {
  const company = input.company ?? 'your team';
  const subject = `Interested in the ${input.title} role${input.company ? ` at ${input.company}` : ''}`;

  const introLine = input.candidateHeadline
    ? `I'm a ${input.candidateHeadline}, and `
    : "I'm ";

  const body = [
    'Hi,',
    '',
    `${introLine}I recently came across the ${input.title} role${input.company ? ` at ${company}` : ''} and wanted to reach out directly.`,
    '',
    "I've attached my resume, tailored for this role - I'd welcome the chance to talk about how I could contribute.",
    '',
    'Thanks for your time,',
  ].join('\n');

  return { subject, body };
}
