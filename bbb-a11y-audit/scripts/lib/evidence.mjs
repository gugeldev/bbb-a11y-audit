/**
 * Anti-hallucination: every file, line and quote a finding cites must exist in the repository.
 * A finding that points at code which is not there is rejected, never reported.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// A quote is searched this many lines around location.line, so small edits do not break it.
const QUOTE_WINDOW_BEFORE = 6;
const QUOTE_WINDOW_AFTER = 5;

const normalizeSpace = (text) => String(text).replace(/\s+/g, ' ').trim();

/** Reads repo files once and keeps their lines; `null` for files that do not exist. */
function createFileReader(repoRoot) {
  const cache = new Map();
  return (file) => {
    if (!cache.has(file)) {
      const absolute = join(repoRoot, file);
      cache.set(file, existsSync(absolute) ? readFileSync(absolute, 'utf8').split('\n') : null);
    }
    return cache.get(file);
  };
}

function checkLocation(location, where, readLines, issues) {
  if (!location.file) return;
  const lines = readLines(location.file);
  if (!lines) {
    issues.problem(`${where}: file "${location.file}" does not exist (paths are repo-relative)`);
  } else if (location.line && (location.line < 1 || location.line > lines.length)) {
    issues.problem(`${where}: ${location.file} has ${lines.length} lines, line ${location.line} does not exist`);
  }
}

function checkQuote(finding, where, readLines, issues) {
  const { location, quote, source } = finding;
  const lines = location.file ? readLines(location.file) : null;
  if (!lines) return;

  if (quote) {
    const from = location.line ? Math.max(0, location.line - QUOTE_WINDOW_BEFORE) : 0;
    const to = location.line ? Math.min(lines.length, location.line + QUOTE_WINDOW_AFTER) : lines.length;
    if (!normalizeSpace(lines.slice(from, to).join(' ')).includes(normalizeSpace(quote))) {
      const around = location.line ? ` around line ${location.line}` : '';
      issues.problem(`${where}: "quote" is not found in ${location.file}${around}`);
    }
  } else if ((source === 'static' || source === 'review') && location.line) {
    issues.problem(`${where}: static and review findings need "quote" (the exact code at location.line)`);
  }
}

export function verifyEvidence(findings, repoRoot, issues) {
  if (!repoRoot) {
    issues.warn('not inside a git repository: file, line and quote checks were skipped');
    return;
  }
  const readLines = createFileReader(repoRoot);
  for (const finding of findings) {
    const where = `finding "${finding.title}"`;
    for (const location of [finding.location, ...finding.relatedLocations]) {
      checkLocation(location, where, readLines, issues);
    }
    checkQuote(finding, where, readLines, issues);
  }
}
