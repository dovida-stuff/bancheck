// Tests for matcher.js against the real register CSVs.
// Run with:  node test/match.test.mjs
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
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

// ── 5. Middle name corroboration (confirm-only, never downgrades) ──────────
function bestM(first, middle, last, rows) {
  const hits = M.matchEmployee({ firstName: first, middleName: middle, lastName: last }, rows);
  return hits.length ? hits[0] : null;
}
h = bestM('Bobbie', 'Joanne', 'Albertella', acqsc);
check('Matching middle name sets middleMatch', h && h.score >= 1.0 && h.middleMatch === true);
h = bestM('Bobbie', 'Karen', 'Albertella', acqsc);
check('Wrong middle name never downgrades the match', h && h.score >= 1.0 && h.middleMatch === false);
h = bestM('Bobbie', '', 'Albertella', acqsc);
check('No middle name provided → no corroboration, same match', h && h.score >= 1.0 && h.middleMatch === false);
h = bestM('Jacob', 'Alfred', 'Tants', ndis);
check('Middle name corroborates NDIS "SURNAME, Given" entries', h && h.score >= 1.0 && h.middleMatch === true);

// ── 6. Severity and export status (what the CSV report says) ───────────────
const fullBan = M.matchEmployee({ firstName: 'Jacob', lastName: 'Tants' }, ndis)[0];
check('Full match on an NDIS banning order is high severity', fullBan && M.isHighSeverity(fullBan));
const initialOnly = M.matchEmployee({ firstName: 'J', lastName: 'Tants' }, ndis)[0];
check('Initial-only match is not high severity', initialOnly && !M.isHighSeverity(initialOnly));

let sum = M.summariseResult([], [fullBan]);
check('Export status is Banned for a full banning-order match', sum.status === 'Banned', sum.status);
check('Export details name the register entry and tier',
  /^NDIS: .*TANTS.*\(Full name match/i.test(sum.details), sum.details);

sum = M.summariseResult([], [initialOnly]);
check('Export status is "Possible match - verify" for a partial match only',
  sum.status === 'Possible match - verify', sum.status);

sum = M.summariseResult([], []);
check('Export status is Not Banned with no matches', sum.status === 'Not Banned' && sum.details === '');

// A full name match against a non-banning NDIS action (e.g. a compliance
// notice) must not be reported as Banned.
const nonBan = ndis.find(r => !r.isBanning && r.nameCandidates.some(c => c.given.length >= 1 && c.surnameKey));
if (nonBan) {
  const cand = nonBan.nameCandidates.find(c => c.given.length >= 1 && c.surnameKey);
  const hits = M.matchEmployee({ firstName: cand.given[0], lastName: cand.surnameKey }, [nonBan]);
  const s2 = M.summariseResult([], hits);
  check(`Full match on non-banning action (${nonBan.orderType}) exports as verify, not Banned`,
    hits.length && hits[0].score >= 1.0 && s2.status === 'Possible match - verify', s2.status);
}

// ── 7. register-meta.json must describe the committed CSVs ─────────────────
const meta = JSON.parse(readFileSync(join(root, 'register-meta.json'), 'utf8'));
for (const [key, file, rows] of [['acqsc', 'aged-care-register.csv', acqscRaw.length], ['ndis', 'ndis-register.csv', ndisRaw.length]]) {
  const m = meta.registers[key];
  const sha = createHash('sha256').update(readFileSync(join(root, file))).digest('hex');
  check(`register-meta.json ${key}.sha256 matches ${file}`, m && m.sha256 === sha,
    'run: node scripts/register-meta.mjs');
  check(`register-meta.json ${key}.rows matches parsed row count`, m && m.rows === rows, `${m && m.rows} vs ${rows}`);
  check(`register-meta.json ${key} has changedAt and checkedAt`, m && m.changedAt && m.checkedAt);
}

// ── 7b. Alias and business-suffix formats from the live registers ──────────
// Each case names a row by a fragment of its register Name (or ACQSC
// Surname) and the first/last name HR would type. A row that has left the
// export is reported as SKIP rather than silently passing, so the suite
// stays honest as the registers change.
let skipped = 0;
function row(name, type, from, to) {
  return { name, suburb: 'X', orderType: type, orderDate: from, endDate: to || '',
    isBanning: /banning order/i.test(type), nameCandidates: M.buildNameCandidates(name) };
}
function liveCase(reg, fragment, first, last, minScore, why) {
  const rows = reg === 'ndis' ? ndis : acqsc;
  const row = rows.find(r => r.name.toLowerCase().includes(fragment.toLowerCase()));
  if (!row) { skipped++; console.log(`SKIP (row no longer in export): ${reg} "${fragment}"`); return; }
  const hits = M.matchEmployee({ firstName: first, lastName: last }, [row]);
  const score = hits.length ? hits[0].score : 0;
  check(`${reg} ${why}: ${first} ${last} vs "${row.name}"`, score >= minScore, `score ${score}`);
}
liveCase('ndis', 'El-Shreffy / t/as', 'Muna', 'El-Shreffy', 1.0, '"/ t/as" business suffix');
liveCase('ndis', 'Kaur, t/a', 'Kamaldeep', 'Kaur', 1.0, '", t/a" business suffix');
liveCase('ndis', 'Campbell t/as', 'Julie-Anne', 'Campbell', 1.0, '"t/as" business suffix');
liveCase('ndis', 'Wardle aka Brenecki', 'Lisa', 'Brenecki', 1.0, 'one-word "aka" surname alias');
liveCase('ndis', 'Natutuvuli a.k.a.', 'Vasiti', 'Korocawiri', 1.0, 'one-word "a.k.a." surname alias');
liveCase('ndis', 'Nortman (aka Sutherland)', 'Natalie', 'Sutherland', 1.0, 'parenthetical one-word alias');
liveCase('ndis', 'OETJEN (HATIBOVICH)', 'Karina', 'Hatibovich', 1.0, 'bare parenthetical surname');
liveCase('ndis', 'Nyachuat (Sarah) Riam', 'Sarah', 'Riam', 1.0, 'parenthetical nickname');
liveCase('ndis', 'Nicholas (Nick) Pefkos', 'Nick', 'Pefkos', 1.0, 'parenthetical nickname');
liveCase('ndis', 'also known as Adam Tiba and Adam Zain', 'Adam', 'Tiba', 1.0, '"A and B" alias list');
liveCase('ndis', 'also known as Adam Tiba and Adam Zain', 'Adam', 'Zain', 1.0, '"A and B" alias list (second)');
liveCase('ndis', 'Saurav PRAFAI or Saurav PRAFI', 'Saurav', 'Prafi', 1.0, '"A or B" alias list');
liveCase('ndis', 'Elena Pollard or Sabin', 'Elena', 'Pollard', 1.0, 'primary name before "or"');
liveCase('ndis', 'Willow Smith, previously known as', 'Willow', 'Smith', 1.0, '"previously known as" keeps the primary name');
liveCase('ndis', 'Willow Smith, previously known as', 'Lisa', 'Wilson', 1.0, '"previously known as" alias');
liveCase('ndis', 'Noah Adel (alias Ahmed Moussa)', 'Ahmed', 'Moussa', 1.0, '"alias" introducer');
liveCase('ndis', 'LUSENAKA OKWARO', 'James', 'Okwaro', 1.0, 'name ending in "aka" is not an alias marker');
liveCase('acqsc', 'ADEL (also known MOUSSA)', 'Ahmed', 'Moussa', 1.0, 'aliases in both First name and Surname columns');
liveCase('acqsc', 'ADEL (also known MOUSSA)', 'Noah', 'Adel', 1.0, 'primary name with aliased columns');
liveCase('acqsc', 'BARLETTA (also known as BIVIANO)', 'Roseanna', 'Biviano', 1.0, 'Surname-column alias');
liveCase('acqsc', 'PRAFAI (also known as PRASAI/PRAFI)', 'Saurav', 'Prasai', 1.0, 'slash-separated alias list');
liveCase('acqsc', 'Jodi COMITO', 'Jodi', 'Comito', 1.0, 'long comma-separated alias list');
liveCase('acqsc', 'WESENCIK (also know as Kate HARTMAN)', 'Kate', 'Hartman', 1.0, '"also know as" (sic)');
// A surname that is itself an alias keyword must not be treated as one
for (const [raw, first, last] of [['John NEE', 'John', 'Nee'], ['NEE, John', 'John', 'Nee'], ['Mary ALIAS', 'Mary', 'Alias'], ['Formerly, Ann', 'Ann', 'Formerly']]) {
  const r = [row(raw, 'ER - Banning Order', '1')];
  h = M.matchEmployee({ firstName: first, lastName: last }, r)[0];
  check(`Keyword-like surname "${raw}" still full-matches`, h && h.score >= 1.0, h && h.score);
}
h = M.matchEmployee({ firstName: 'Jane', lastName: 'Brown' }, [row('Jane Smith nee Brown', 'ER - Banning Order', '1')])[0];
check('"nee" with a following name is still an alias', h && h.score >= 1.0);

// Titles typed into the employee first-name field
h = best('Mr Jacob', 'Tants', ndis);
check('A title in the employee first name is ignored', h && h.score >= 1.0);
// Register-side regexes must stay linear on hostile whitespace
let t0 = Date.now();
M.buildNameCandidates(' '.repeat(100000) + 'x');
check('buildNameCandidates is fast on 100k spaces (no quadratic regex)', Date.now() - t0 < 1000, `${Date.now() - t0} ms`);
// Synthetic banning row: "aka" inside a surname must never split it
h = M.matchEmployee({ firstName: 'Hiroshi', lastName: 'Tanaka' },
  [{ name: 'Hiroshi Tanaka', suburb: '', isBanning: true, nameCandidates: M.buildNameCandidates('Hiroshi Tanaka') }])[0];
check('"Tanaka" is not truncated by the aka rule', h && h.score >= 1.0);

// ── 8. Ordering and de-duplication ──────────────────────────────────────────
// Distinct register rows for the same name are all kept; the strongest is
// first (score, then banning order, then still in force). Built from
// synthetic rows so the test does not depend on which names are in the
// live export this week.
const synth = [
  row('Pat Example', 'ER - Compliance notice', '2025-01-01'),
  row('Pat Example', 'ER - Banning Order', '2023-01-01', '2025-01-01'),
  row('Pat Example', 'ER - Banning Order', '2025-01-01'),
  row('Pat Example', 'ER - Banning Order', '2025-01-01')   // exact duplicate row
];
const ordered = M.matchEmployee({ firstName: 'Pat', lastName: 'Example' }, synth);
check('Distinct rows for one name are all kept (exact duplicates collapsed)', ordered.length === 3, `got ${ordered.length}`);
check('Banning order in force is listed first', ordered[0] && ordered[0].entry.isBanning && !ordered[0].entry.endDate);
check('Expired banning order is listed before the non-banning action',
  ordered[1] && ordered[1].entry.isBanning && ordered[2] && !ordered[2].entry.isBanning);
check('A same-scored non-banning row never hides the banning order from the export',
  M.summariseResult([], ordered).status === 'Banned');
// The same guarantee on the live data: every NDIS banning order must still be
// reachable when other actions exist for the same name and place.
let hiddenBans = 0;
const byName = new Map();
for (const r of ndis) { const k = r.name + '\x00' + r.suburb; (byName.get(k) || byName.set(k, []).get(k)).push(r); }
for (const rows of byName.values()) {
  const ban = rows.find(r => r.isBanning);
  if (!ban || rows.length < 2) continue;
  const c = ban.nameCandidates.find(c => c.given.length && c.surnameKey);
  if (!c) continue;
  const hits = M.matchEmployee({ firstName: c.given[0], lastName: c.surnameKey }, rows);
  if (!hits.some(h => h.entry === ban)) hiddenBans++;
}
check('No live NDIS banning order is hidden behind another row for the same name', hiddenBans === 0, `${hiddenBans} hidden`);

// ── 9. ACQSC end date is carried through to the match card / report ────────
const acqscEnded = acqsc.find(r => r.endDate);
check('ACQSC rows expose the Ban End Date as endDate', !!acqscEnded, 'no ACQSC row has an end date');
if (acqscEnded) {
  const c = acqscEnded.nameCandidates[acqscEnded.nameCandidates.length - 1];
  const hits = M.matchEmployee({ firstName: c.given[0], lastName: c.surnameKey }, [acqscEnded]);
  const s9 = M.summariseResult(hits, []);
  check('Report details mention the ACQSC end date', /end(s|ed) /.test(s9.details), s9.details);
}
// Tense follows the end date: a future date "ends", a past date "ended".
const t2020 = Date.UTC(2020, 0, 1);
const future = row('Future Example', 'ER - Banning Order', '2019-01-01', '2030-01-01T07:00:00');
const pastRow = row('Past Example', 'ER - Banning Order', '2015-01-01', ' 2016-01-01 17:00');
check('Report says "ends" for a future end date',
  /ends 2030/.test(M.summariseResult([], M.matchEmployee({ firstName: 'Future', lastName: 'Example' }, [future]), t2020).details));
check('Report says "ended" for a past end date',
  /ended 2016/.test(M.summariseResult([], M.matchEmployee({ firstName: 'Past', lastName: 'Example' }, [pastRow]), t2020).details));
check('inForce: no end date, future end date, past end date, "No longer in force" status',
  M.inForce(row('x', 'ER - Banning Order', '1'), t2020) && M.inForce(future, t2020) && !M.inForce(pastRow, t2020)
  && !M.inForce({ orderType: 'No longer in force', endDate: '' }, t2020) && !M.inForce({ orderType: 'NO_LONGER_IN_FORCE', endDate: '' }, t2020));
{
  const expired = row('Order Example', 'ER - Banning Order', '2010-01-01', '2012-01-01');
  const current = row('Order Example', 'ER - Banning Order', '2019-01-01', '2030-01-01');
  const o = M.matchEmployee({ firstName: 'Order', lastName: 'Example' }, [expired, current]);
  check('Current order sorts before an expired order with a later end date', o[0].entry === current);
}

// ── 10. Employee first-name field holding several given names ──────────────
const anne = [row('Anne EXAMPLE', 'ER - Banning Order', '2025-01-01')];
h = M.matchEmployee({ firstName: 'Mary Anne', lastName: 'Example' }, anne)[0];
check('"Mary Anne" is flagged against a register entry under "Anne"', h && h.matchType === 'variant', h && h.matchType);
h = M.matchEmployee({ firstName: 'Mary-Anne', lastName: 'Example' }, anne)[0];
check('"Mary-Anne" is flagged against a register entry under "Anne"', h && h.matchType === 'variant');
h = M.matchEmployee({ firstName: 'Anne Mary', lastName: 'Example' }, anne)[0];
check('"Anne Mary" full-matches a register entry under "Anne"', h && h.score >= 1.0);
h = M.matchEmployee({ firstName: 'Mary', lastName: 'Example' }, anne)[0];
check('"Mary" alone still does not match "Anne"', !h);

// ── 11. Name normalisation edge cases ──────────────────────────────────────
check('Letters that do not decompose are folded (Søren Łukasz Straße)',
  M.normName('Søren Łukasz Straße') === 'soren lukasz strasse', M.normName('Søren Łukasz Straße'));
check('Non-Latin letters are kept rather than dropped', M.normName('محمد') === 'محمد');
check('Numbers and null are tolerated', M.normName(42) === '42' && M.normName(null) === '' && M.normName(undefined) === '');
check('Curly apostrophe, straight apostrophe and none all normalise alike',
  M.normName('O’Brien') === M.normName("O'Brien") && M.normName("O'Brien") === M.normName('OBrien'));
check('Employee with only whitespace/punctuation surname yields no matches, no crash',
  M.matchEmployee({ firstName: 'A', lastName: ' - ' }, ndis).length === 0);
check('Employee fields may be numbers without crashing',
  Array.isArray(M.matchEmployee({ firstName: 1, middleName: 2, lastName: 3 }, ndis)));

// ── 12. register-meta.mjs --verify (used by the update workflow) ───────────
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
const tmp = mkdtempSync(join(tmpdir(), 'bancheck-'));
function verify(key, content) {
  const f = join(tmp, key + '-' + Math.random().toString(36).slice(2) + '.csv');
  writeFileSync(f, content);
  const r = spawnSync(process.execPath, [join(root, 'scripts/register-meta.mjs'), `--verify=${key}`, f], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}
let v = verify('ndis', '\uFEFFType,"Date effective from",Name\r\n"ER - Banning Order",2026-01-01,"Multi\r\nline"\r\n\r\nx,y,z\n');
check('verify counts records not lines (BOM, CRLF, quoted newline, blank line)', v.code === 0 && v.out === '2', JSON.stringify(v));
v = verify('ndis', 'Type,"Date effective from",Provider Name\na,b,c\n');
check('verify rejects a header missing a required column', v.code === 1 && /missing.*Name/.test(v.err), JSON.stringify(v));
v = verify('ndis', 'Type,Name\na,"unterminated\nb,c\n');
check('verify rejects an unterminated quoted field', v.code === 1 && /unterminated/.test(v.err), JSON.stringify(v));
v = verify('acqsc', '"Name, given",Surname,First name\na,b,c\n');
check('verify handles a quoted header cell containing a comma', v.code === 0 && v.out === '1', JSON.stringify(v));
for (const [key, file] of [['acqsc', 'aged-care-register.csv'], ['ndis', 'ndis-register.csv']]) {
  v = verify(key, readFileSync(join(root, file), 'utf8'));
  check(`verify accepts the committed ${file} and agrees with the row count`, v.code === 0 && Number(v.out) === meta.registers[key].rows, JSON.stringify(v));
}

// ── 13. index.html CSP hashes match the inline script and style ────────────
// The page allows its one inline <script> and <style> by SHA-256 hash instead
// of 'unsafe-inline'. If either block is edited without updating the hash the
// browser refuses to run the page, so guard it here.
const html = readFileSync(join(root, 'index.html'), 'utf8');
const cspMatch = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html);
check('index.html has a CSP meta tag', !!cspMatch);
if (cspMatch) {
  const csp = cspMatch[1];
  const inlineScripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const inlineStyles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(m => m[1]);
  const sha = t => "'sha256-" + createHash('sha256').update(t, 'utf8').digest('base64') + "'";
  check('index.html has exactly one inline script and one inline style', inlineScripts.length === 1 && inlineStyles.length === 1);
  check("CSP does not rely on 'unsafe-inline'", !csp.includes("'unsafe-inline'"));
  const scriptSrc = /script-src ([^;]+)/.exec(csp)[1], styleSrc = /style-src ([^;]+)/.exec(csp)[1];
  for (const t of inlineScripts) check('CSP script-src carries the hash of the inline script', scriptSrc.includes(sha(t)), `expected ${sha(t)}`);
  for (const t of inlineStyles) check('CSP style-src carries the hash of the inline style', styleSrc.includes(sha(t)), `expected ${sha(t)}`);
  check('No inline event handlers or style attributes bypass the hashed CSP', !/\son[a-z]+=|\sstyle=/i.test(html));
}

console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped (register rows no longer present)` : ''}`);
process.exit(failed ? 1 : 0);
