/**
 * Post-processes the eslint JSON written by eslint-a11y.sh: makes file paths repo-relative (like
 * static-scan.mjs, so the agent can cite them as is) and prints a per-rule count on stderr.
 *
 *   node eslint-postprocess.mjs <eslint.json> <repo-root>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { relative } from 'node:path';

function summarize(results) {
  const byRule = {};
  let parseErrors = 0;
  for (const file of results) {
    for (const { ruleId } of file.messages) {
      if (ruleId) byRule[ruleId] = (byRule[ruleId] || 0) + 1;
      else parseErrors++;
    }
  }
  const total = Object.values(byRule).reduce((sum, n) => sum + n, 0);
  return { byRule, total, parseErrors };
}

function main() {
  const [outputFile, repoRoot] = process.argv.slice(2);
  if (!outputFile || !repoRoot) {
    console.error('usage: node eslint-postprocess.mjs <eslint.json> <repo-root>');
    process.exit(1);
  }

  const results = JSON.parse(readFileSync(outputFile, 'utf8'));
  for (const file of results) file.filePath = relative(repoRoot, file.filePath);
  writeFileSync(outputFile, JSON.stringify(results));

  const { byRule, total, parseErrors } = summarize(results);
  console.error(`eslint-a11y: ${results.length} files, ${total} messages, ${parseErrors} parse errors`);
  console.error(JSON.stringify(byRule, null, 1));
}

main();
