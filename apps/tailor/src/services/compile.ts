import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Shells out to a real LaTeX engine (pdflatex/xelatex - see config.ts's
 * LATEX_ENGINE) rather than a JS-side LaTeX-to-PDF reimplementation. A
 * candidate's tailored resume must render exactly as the same engine would
 * render it if they compiled it themselves; nothing here parses or
 * reinterprets the document, it only runs the real compiler and returns
 * the real output.
 *
 * Runs in a scratch temp directory per call, deleted afterward regardless
 * of outcome - a compile leaves .aux/.log/.out files alongside the .pdf,
 * none of which belong anywhere near a shared process.
 */

export interface CompileResult {
  pdfBytes: Buffer;
  pdfSha256: string;
}

export class CompileError extends Error {
  constructor(
    message: string,
    public readonly log: string,
  ) {
    super(message);
    this.name = 'CompileError';
  }
}

/**
 * Compiles one .tex source to PDF bytes.
 *
 * `-halt-on-error` stops on the first real error rather than pdflatex's
 * default of plowing through a broken document; `-interaction=nonstopmode`
 * stops it from blocking on a TTY prompt in an environment with no TTY at
 * all. Success is judged by "did a .pdf file actually appear," not by the
 * engine's own exit code - pdflatex has a long history of exiting 0 while
 * still emitting a document with an error in it under some warning
 * configurations, and a caller (services/ai's Graph A) needs a decisive
 * answer, not a warning to go interpret itself.
 */
export async function compileTex(
  tex: string,
  engine: 'pdflatex' | 'xelatex',
): Promise<CompileResult> {
  const dir = await mkdtemp(join(tmpdir(), 'jobswitch-tailor-'));
  const texPath = join(dir, 'resume.tex');
  const pdfPath = join(dir, 'resume.pdf');

  try {
    await writeFile(texPath, tex, 'utf8');

    const log = await runOnce(engine, dir, texPath);

    let pdfBytes: Buffer;
    try {
      pdfBytes = await readFile(pdfPath);
    } catch {
      throw new CompileError(`${engine} did not produce a PDF`, log);
    }

    const pdfSha256 = createHash('sha256').update(pdfBytes).digest('hex');
    return { pdfBytes, pdfSha256 };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runOnce(engine: string, dir: string, texPath: string): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn(
      engine,
      ['-interaction=nonstopmode', '-halt-on-error', '-output-directory=' + dir, texPath],
      { cwd: dir },
    );

    let output = '';
    proc.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    proc.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    // Resolve on both 'close' and 'error' (e.g. engine binary not found) -
    // callers judge success by whether a PDF actually appeared, not by
    // this promise rejecting, so a missing binary surfaces as the same
    // CompileError as a real compile failure rather than an unhandled
    // rejection.
    proc.on('close', () => resolve(output));
    proc.on('error', (err) => resolve(output + `\n${engine} failed to start: ${err.message}`));
  });
}
