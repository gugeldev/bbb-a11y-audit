#!/usr/bin/env node
/**
 * Static layer: searches the code for accessibility anti-patterns and prints the CANDIDATES as
 * JSON. A candidate is not a finding: the agent reads the code around it and decides.
 *
 *   node static-scan.mjs [--guidelines=2.1,2.4] <path> [<path> ...] > raw/static.json
 *
 * --guidelines keeps only the patterns that can inform those guidelines (or a principle "2", or a
 * criterion "2.4.7"). No dependencies. Skips node_modules, tests, build output and locale files.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

import { PATTERNS } from './lib/static-patterns.mjs';
import { matchesTopic } from './lib/wcag.mjs';

const FILE_KINDS = {
  code: ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'],
  style: ['.css', '.scss', '.less'],
  markup: ['.html'],
};
const SKIPPED_DIR =
  /(^|\/)(node_modules|dist|build|coverage|\.git|tests?|__tests__|__mocks__|locales|compatibility)(\/|$)/;
const SKIPPED_FILE = /(\.spec\.|\.test\.|\.min\.|\.d\.ts$)/;
const MAX_SNIPPET = 200;

// EN 301 549 9.7 (user preferences) patterns are selected with the visual-presentation topic, 1.4.
const EN_TOPIC_PROXY = '1.4.4';

function parseArgs(argv) {
  const topicFlag = argv.find((arg) => arg.startsWith('--guidelines='));
  const topic = topicFlag
    ? topicFlag
        .slice('--guidelines='.length)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  const roots = argv.filter((arg) => !arg.startsWith('--'));
  return { topic, roots };
}

function patternsFor(topic) {
  return PATTERNS.filter((pattern) => {
    const criteria = [pattern.standard === 'EN' ? EN_TOPIC_PROXY : pattern.criterion, ...(pattern.also || [])];
    return criteria.some((criterion) => matchesTopic(criterion, topic));
  });
}

function kindOf(file) {
  const ext = extname(file);
  return Object.keys(FILE_KINDS).find((kind) => FILE_KINDS[kind].includes(ext)) || null;
}

/** Yields every file under `path` (or `path` itself), skipping ignored directories and files. */
function* walk(path) {
  if (statSync(path).isFile()) {
    yield path;
    return;
  }
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIR.test(`/${entry.name}/`)) yield* walk(full);
    } else if (!SKIPPED_FILE.test(entry.name)) {
      yield full;
    }
  }
}

/** Returns a function that maps a character offset in `text` to its 1-based line number. */
function lineLocator(text) {
  const lineStarts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) lineStarts.push(i + 1);
  return (offset) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (lineStarts[mid] <= offset) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
}

function* scanFile(file, kind, patterns, cwd) {
  const text = readFileSync(file, 'utf8');
  const lineOf = lineLocator(text);
  for (const pattern of patterns) {
    if (!pattern.kinds.includes(kind)) continue;
    for (const match of text.matchAll(pattern.re)) {
      yield {
        pattern: pattern.id,
        criterion: pattern.criterion,
        standard: pattern.standard || 'WCAG',
        file: relative(cwd, file),
        line: lineOf(match.index),
        snippet: match[0].replace(/\s+/g, ' ').trim().slice(0, MAX_SNIPPET),
      };
    }
  }
}

function countBy(items, key) {
  const counts = {};
  for (const item of items) counts[item[key]] = (counts[item[key]] || 0) + 1;
  return counts;
}

function main() {
  const { topic, roots } = parseArgs(process.argv.slice(2));
  if (!roots.length) {
    console.error('usage: node static-scan.mjs [--guidelines=2.1,2.4] <path> [<path> ...]');
    process.exit(1);
  }

  const patterns = patternsFor(topic);
  const cwd = process.cwd();
  const hits = [];
  let scannedFiles = 0;
  for (const root of roots) {
    for (const file of walk(root)) {
      const kind = kindOf(file);
      if (!kind) continue;
      scannedFiles++;
      hits.push(...scanFile(file, kind, patterns, cwd));
    }
  }

  const counts = countBy(hits, 'pattern');
  const report = {
    scannedFiles,
    roots,
    topic,
    patterns: patterns.map(({ re, kinds, ...description }) => description),
    counts,
    hits,
  };
  console.log(JSON.stringify(report, null, 2));
  console.error(`static-scan: ${scannedFiles} files, ${hits.length} candidates ${JSON.stringify(counts)}`);
}

main();
