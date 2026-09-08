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
// The workflow also uses it to vet a download BEFORE it replaces the
// published file:
//
//   node scripts/register-meta.mjs --verify=ndis /tmp/download.csv
//
// which parses the file with the same CSV rules as everything else here,
// checks the header has the columns the checker reads, prints the number
// of data records, and exits 1 if the file is unusable.
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
// Verify mode:   --verify=<register> <file>
const outcomes = {};
let verifyKey = null, verifyFile = null;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const m = /^--(\w+)=(\w+)$/.exec(argv[i]);
  if (m && m[1] === 'verify') { verifyKey = m[2]; verifyFile = argv[++i]; }
  else if (m) outcomes[m[1]] = m[2];
}

// Minimal RFC 4180 record counter: honours quoted fields so an embedded
// newline is not counted as a new record, and returns the header as a list
// of cell values (quotes removed, commas inside quotes preserved).
function countRowsAndHeader(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let rows = 0, inQuotes = false, sawData = false, header = null;
  let cell = '', cells = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { cell += c; i++; } else inQuotes = false; }
      else cell += c;
    } else if (c === '"') { inQuotes = true; sawData = true; }
    else if (c === ',') { cells.push(cell); cell = ''; sawData = true; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      if (sawData) { if (header === null) header = cells.concat(cell); else rows++; }
      sawData = false; cell = ''; cells = [];
    } else { sawData = true; cell += c; }
  }
  if (sawData) { if (header === null) header = cells.concat(cell); else rows++; }
  return {
    rows,
    header: (header || []).map(h => h.trim()),
    unterminated: inQuotes   // a stray quote swallowed the rest of the file
  };
}

function missingColumns(def, header) {
  return def.requiredColumns.filter(c => !header.includes(c));
}

// --verify: vet a freshly downloaded file for the workflow. Prints the record
// count on stdout (the workflow's shrink guard reads it) and exits non-zero
// when the file cannot be used, with the reason on stderr.
if (verifyKey !== null) {
  const def = REGISTERS[verifyKey];
  if (!def) { console.error(`verify: unknown register "${verifyKey}"`); process.exit(2); }
  if (!verifyFile || !existsSync(verifyFile)) { console.error(`verify: file not found: ${verifyFile}`); process.exit(2); }
  const text = readFileSync(verifyFile, 'utf8');
  const { rows, header, unterminated } = countRowsAndHeader(text);
  const problemsFound = [];
  if (unterminated) problemsFound.push('unterminated quoted field (a stray " swallowed the rest of the file)');
  const missing = missingColumns(def, header);
  if (missing.length) problemsFound.push(`header is missing expected column(s): ${missing.join(', ')} — got [${header.join(', ')}]`);
  if (problemsFound.length) {
    for (const p of problemsFound) console.error(`verify: ${p}`);
    process.exit(1);
  }
  console.log(rows);
  process.exit(0);
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
    const { rows, header, unterminated } = countRowsAndHeader(buf.toString('utf8'));
    entry.rows = rows;
    entry.bytes = statSync(path).size;
    entry.sha256 = createHash('sha256').update(buf).digest('hex');
    const missing = missingColumns(def, header);
    if (missing.length) {
      console.error(`::error::${def.file}: header is missing expected column(s): ${missing.join(', ')}`);
      problems++;
    }
    if (unterminated) {
      console.error(`::error::${def.file}: unterminated quoted field — row count unreliable`);
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
