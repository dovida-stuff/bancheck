#!/usr/bin/env node
// Builds register-meta.json — the provenance record for the two register CSVs.
//
// Run by the update workflow after each fetch, and by hand if a CSV is ever
// replaced manually:
//
//   node scripts/register-meta.mjs --acqsc=success --ndis=success
//
// The --<register>=<outcome> flags are the outcome of that register's fetch
// step ("success" or "failure"). A failed fetch keeps the previously
// published file, so its row count and hash are still recorded; only the
// "checkedAt" timestamp is withheld, which is what lets the page warn that
// the data may be stale.
//
// For each register the file records:
//   rows       data rows in the CSV (header excluded, quoted newlines handled)
//   bytes      file size
//   sha256     hash of the file as published — download the CSV and hash it
//              to confirm you have the same file the checker used
//   changedAt  when the content last changed (hash differs from previous run)
//   checkedAt  when the source was last fetched successfully
//   lastFetch  outcome of the most recent fetch attempt
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const metaPath = join(root, 'register-meta.json');

const REGISTERS = {
  acqsc: {
    file: 'aged-care-register.csv',
    label: 'ACQSC Aged Care Banning Register',
    source: 'https://www.agedcarequality.gov.au/sites/default/files/media/register-banning-orders-data-file.csv',
    sourcePage: 'https://www.agedcarequality.gov.au/providers/compliance-enforcement/banning-orders',
    requiredColumns: ['First name', 'Surname']
  },
  ndis: {
    file: 'ndis-register.csv',
    label: 'NDIS Commission Compliance Actions (incl. Banning Orders)',
    source: 'https://www.ndiscommission.gov.au/about-us/compliance-and-enforcement/compliance-actions/search/download-csv',
    sourcePage: 'https://www.ndiscommission.gov.au/about-us/compliance-and-enforcement/compliance-actions/search',
    requiredColumns: ['Type', 'Name']
  }
};

// Outcome flags: --acqsc=success --ndis=failure (default: success)
const outcomes = {};
for (const arg of process.argv.slice(2)) {
  const m = /^--(\w+)=(\w+)$/.exec(arg);
  if (m) outcomes[m[1]] = m[2];
}

// Minimal RFC 4180 row counter: honours quoted fields so an embedded newline
// is not counted as a new record.
function countRowsAndHeader(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let rows = 0, inQuotes = false, sawData = false, header = null, cur = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { cur += c; i++; } else inQuotes = false; }
      else cur += c;
    } else if (c === '"') inQuotes = true;
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      if (sawData) { if (header === null) header = cur; else rows++; }
      sawData = false; cur = '';
    } else { sawData = true; cur += c; }
  }
  if (sawData) { if (header === null) header = cur; else rows++; }
  return { rows, header: header || '' };
}

function gitLastChange(file) {
  try {
    const out = execSync(`git log -1 --format=%cI -- "${file}"`, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
    return out || null;
  } catch (_) { return null; }
}

let previous = {};
if (existsSync(metaPath)) {
  try { previous = JSON.parse(readFileSync(metaPath, 'utf8')).registers || {}; }
  catch (_) { previous = {}; }
}

const now = new Date().toISOString();
const registers = {};
let problems = 0;

for (const [key, def] of Object.entries(REGISTERS)) {
  const path = join(root, def.file);
  const prev = previous[key] || {};
  const outcome = outcomes[key] || 'success';
  const entry = {
    file: def.file,
    label: def.label,
    source: def.source,
    sourcePage: def.sourcePage,
    rows: 0,
    bytes: 0,
    sha256: null,
    changedAt: prev.changedAt || null,
    checkedAt: prev.checkedAt || null,
    lastFetch: { at: now, outcome }
  };

  if (existsSync(path)) {
    const buf = readFileSync(path);
    const { rows, header } = countRowsAndHeader(buf.toString('utf8'));
    entry.rows = rows;
    entry.bytes = statSync(path).size;
    entry.sha256 = createHash('sha256').update(buf).digest('hex');
    const missing = def.requiredColumns.filter(c => !header.split(',').map(h => h.trim().replace(/^"|"$/g, '')).includes(c));
    if (missing.length) {
      console.error(`::warning::${def.file}: header is missing expected column(s): ${missing.join(', ')}`);
      problems++;
    }
    if (entry.sha256 !== prev.sha256) {
      // Content changed since the last recorded run. On the very first run
      // (no previous hash) fall back to git's record of when the file last
      // changed, so the date is not simply "now".
      entry.changedAt = prev.sha256 ? now : (gitLastChange(def.file) || now);
    }
  } else {
    console.error(`::error::${def.file} is missing`);
    problems++;
  }

  if (outcome === 'success') entry.checkedAt = now;

  registers[key] = entry;
  console.log(`${key}: ${entry.rows} rows, ${entry.bytes} bytes, sha256 ${String(entry.sha256).slice(0, 12)}…, ` +
    `changed ${entry.changedAt}, checked ${entry.checkedAt}, fetch ${outcome}`);
}

const meta = { generatedAt: now, registers };
writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
console.log(`Wrote ${metaPath}`);
process.exit(problems ? 1 : 0);
