// Tests for matcher.js against the real register CSVs.
// Run with:  node test/match.test.mjs
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const M = require(join(root, 'matcher.js'));

// ── Minimal CSV parser (quoted fields, embedded commas/newlines, CRLF) ──────
function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let field = '', row = [], inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift().map(h => h.trim());
  return rows.map(r => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

const acqscRaw = parseCsv(readFileSync(join(root, 'aged-care-register.csv'), 'utf8'));
const ndisRaw = parseCsv(readFileSync(join(root, 'ndis-register.csv'), 'utf8'));
const acqsc = acqscRaw.map(M.normaliseAcqscRow).filter(r => r.name);
const ndis = ndisRaw.map(M.normaliseNdisRow).filter(r => r.name);

let passed = 0, failed = 0;
function check(desc, ok, extra) {
  if (ok) { passed++; }
  else { failed++; console.error(`FAIL: ${desc}${extra ? ' — ' + extra : ''}`); }
}

// ── 1. Every ACQSC person must fully match their own register entry ────────
// (HR would type the name exactly as the register's First name/Surname
// columns show it, minus any parenthetical alias text.)
const stripParen = s => s.replace(/\s*\([^)]*\)?\s*/g, ' ').trim();
let selfTested = 0;
for (const row of acqscRaw) {
  const first = stripParen((row['First name'] || '').trim());
  const last = stripParen((row['Surname'] || '').trim());
  if (!first || !last) continue;
  selfTested++;
  const hits = M.matchEmployee({ firstName: first, lastName: last }, acqsc);
  check(`ACQSC self-match: ${first} ${last}`,
    hits.some(h => h.score >= 1.0),
    `best score ${Math.max(0, ...hits.map(h => h.score))}`);
}
console.log(`ACQSC self-test: ${selfTested} people tested`);

// ── 2. NDIS name-format handling ────────────────────────────────────────────
function best(first, last, rows) {
  const hits = M.matchEmployee({ firstName: first, lastName: last }, rows);
  return hits.length ? hits[0] : null;
}

// "SURNAME, Given Names" format
let h = best('Jacob', 'Tants', ndis);
check('NDIS "TANTS, Jacob Alfred" full-matches Jacob Tants', h && h.score >= 1.0);
h = best('Vin', 'Chan', ndis);
check('NDIS "CHAN, Vin Le" full-matches Vin Chan', h && h.score >= 1.0);

// hyphenated surname
h = best('Feras', 'El-Masri', ndis);
check('NDIS hyphenated surname El-Masri full-matches', h && h.score >= 1.0);

// "trading as" suffix on an individual
h = best('Kayla', 'Pethybridge', ndis);
check('NDIS "Kayla Pethybridge trading as ..." full-matches', h && h.score >= 1.0);

// alias: both names of an "also known as" entry should match
h = best('Ahmed', 'Jama', ndis);
check('NDIS alias: Ahmed Jama matches', h && h.score >= 1.0);
h = best('Faysal', 'Muketar', ndis);
check('NDIS alias: Faysal Muketar (also-known-as name) matches', h && h.score >= 1.0);

// ── 3. ACQSC hard cases from the live data ──────────────────────────────────
h = best('Gregory', 'Van Rooyen', acqsc);
check('ACQSC multi-word surname VAN ROOYEN full-matches', h && h.score >= 1.0);
h = best('Kimberly', 'Leddington-Hill', acqsc);
check('ACQSC hyphenated surname LEDDINGTON-HILL full-matches', h && h.score >= 1.0);
h = best('Folototo', "Fa'asolo", acqsc);
check("ACQSC apostrophe surname FA'ASOLO full-matches", h && h.score >= 1.0);
h = best('Folototo', 'Faasolo', acqsc);
check('ACQSC apostrophe surname matches without apostrophe typed', h && h.score >= 1.0);
h = best('Kareem', 'Al Shamare', acqsc);
check('ACQSC "AL SHAMARE" full-matches', h && h.score >= 1.0);

// ── 4. Match-quality tiers ──────────────────────────────────────────────────
h = best('J', 'Tants', ndis);
check('Initial-only gives 0.75 initial match', h && h.matchType === 'initial' && h.score === 0.75);
h = best('', 'Tants', ndis);
check('Surname-only search still flags (0.65 surname match)', h && h.matchType === 'surname');
h = best('Zzzz', 'Nosuchname', ndis);
check('Unknown name produces no match', h === null);

// A different first name with same surname should NOT full-match
h = best('Wilhelmina', 'Tants', ndis);
check('Wrong first name does not full-match', !h || h.score < 1.0);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
