/*
  Name-matching logic for the Banning Register Checker.
  ======================================================
  Loaded by index.html in the browser (as window.BanMatcher) and by
  test/match.test.mjs in Node (via module.exports), so the exact code that
  runs in production is what gets tested against the real register CSVs.

  Register names arrive in many shapes:
    "Simon James NUGUS"                              given names first
    "TANTS, Jacob Alfred"                            surname first
    "AL SHAMARE" / "LEDDINGTON-HILL" / "FA'ASOLO"    multi-word, hyphenated,
                                                     apostrophe surnames
    "Kayla Pethybridge trading as J & K Loyalty..."  business suffix
    "Ahmed Abdi JAMA, also known as Faysal MUKETAR"  aliases
    "HORTON (also known as Scott ... HORTON"         parenthetical alias,
                                                     sometimes unclosed
  Each register entry is pre-parsed into candidate {given[], surnameKey}
  interpretations; an employee matches if their surname key equals a
  candidate's surname key, with the score set by how well given names agree.
*/
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BanMatcher = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Lowercase, fold accents (é→e), drop apostrophes (O'Brien→obrien) and
  // mojibake replacement chars, turn all other punctuation into spaces.
  function normName(s) {
    return (s || '')
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[\u2018\u2019\u02BC']/g, '')
      .replace(/\uFFFD/g, '')
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function tokenise(s) {
    return normName(s).split(' ').filter(Boolean);
  }

  // Split a raw register name into independent name segments: the main name
  // plus any aliases found in parentheses, after "also known as"/"aka", or
  // after semicolons. "trading as <business>" suffixes are dropped.
  function aliasSegments(raw) {
    const segs = [];
    let name = String(raw || '');

    // Parenthetical aliases — tolerate an unclosed "(" (real data has one).
    name = name.replace(/\(([^)]*)\)?/g, function (_, inner) {
      inner = inner.replace(/^\s*(?:also\s+known(?:\s+as)?|a\.?k\.?a\b\.?|formerly|n[eé]e)\s*/i, '');
      if (inner.trim()) segs.push(inner);
      return ' ';
    });

    name = name.replace(/[,;]?\s*trading\s+as\b[\s;:]*.*$/i, ' ');

    name.split(/[,;]?\s*(?:also\s+known(?:\s+as)?|a\.?k\.?a\b\.?)\s*|;/i).forEach(function (s) {
      if (s && s.trim()) segs.push(s);
    });
    return segs;
  }

  // Parse one segment into candidate {given[], surname[]} interpretations.
  function segmentCandidates(seg) {
    seg = String(seg || '').trim().replace(/^\s*(?:mr|mrs|ms|miss|dr)\.?\s+/i, '');
    const cands = [];

    // "SURNAME, Given Names" — authoritative when a comma is present.
    const commaIdx = seg.indexOf(',');
    if (commaIdx > -1) {
      const sur = tokenise(seg.slice(0, commaIdx));
      const given = tokenise(seg.slice(commaIdx + 1));
      if (sur.length) cands.push({ given: given, surname: sur });
    }

    // Given-names-first: the surname may span the last 1–3 tokens
    // ("VAN ROOYEN", "DE CELIS", "AL SHAMARE" are all real entries).
    const tokens = tokenise(seg);
    const maxSur = Math.min(3, tokens.length - 1);
    for (let k = 1; k <= maxSur; k++) {
      cands.push({
        given: tokens.slice(0, tokens.length - k),
        surname: tokens.slice(tokens.length - k)
      });
    }
    return cands;
  }

  function buildNameCandidates(rawName) {
    const out = [];
    aliasSegments(rawName).forEach(function (seg) {
      segmentCandidates(seg).forEach(function (c) {
        out.push({ given: c.given, surnameKey: c.surname.join('') });
      });
    });
    return out;
  }

  // ── Register row normalisation ────────────────────────────────────────────

  function normaliseAcqscRow(row) {
    const v = function (k) { return (row[k] || '').trim(); };
    const first = v('First name');
    const middle = v('Middle Name');
    const last = v('Surname');
    const name = [first, middle, last].filter(Boolean).join(' ');

    const candidates = buildNameCandidates(name);
    // The ACQSC register provides the surname column explicitly — add a
    // structured parse so multi-word surnames are never mis-split.
    const surTokens = tokenise(last.replace(/\(([^)]*)\)?/g, ' '));
    if (surTokens.length) {
      candidates.push({
        given: tokenise((first + ' ' + middle).replace(/\(([^)]*)\)?/g, ' ')),
        surnameKey: surTokens.join('')
      });
    }

    return {
      name: name,
      suburb: v('Suburb'),
      state: v('State'),
      postcode: v('Postcode'),
      orderDate: v('Ban Start Date'),
      orderType: v('Status'),
      reason: v('Description'),
      isBanning: true, // the ACQSC register is exclusively banning orders
      nameCandidates: candidates
    };
  }

  // Every row in the NDIS export is checked, regardless of compliance action
  // type, expiry date, or whether the name is an individual or organisation.
  function normaliseNdisRow(row) {
    const v = function (k) { return (row[k] || '').trim(); };
    const type = v('Type');
    const name = v('Name');
    return {
      name: name,
      suburb: v('City'),
      state: v('State'),
      postcode: v('Postcode'),
      orderDate: v('Date effective from'),
      orderType: type,
      reason: v('Relevant information'),
      endDate: v('Date no longer in force'),
      isBanning: type.toLowerCase().indexOf('banning order') !== -1,
      nameCandidates: buildNameCandidates(name)
    };
  }

  // ── Matching ──────────────────────────────────────────────────────────────

  // Returns {score, type} or null.
  //   1.0  full     — surname and first name both match
  //   0.75 initial  — surname matches, first initial matches
  //   0.65 variant  — surname matches, first name matches a middle name
  //   0.65 surname  — surname matches, no first name available to compare
  function scoreCandidate(cand, empFirstTokens, empInitial, empLastKey) {
    if (!cand.surnameKey || cand.surnameKey !== empLastKey) return null;
    const g = cand.given;
    if (empFirstTokens.length === 0 || g.length === 0) {
      return { score: 0.65, type: 'surname' };
    }
    const empFirst = empFirstTokens[0];
    if (g[0] === empFirst) return { score: 1.0, type: 'full' };
    if (empInitial && g[0][0] === empInitial) return { score: 0.75, type: 'initial' };
    for (let i = 1; i < g.length; i++) {
      if (g[i] === empFirst || (empInitial && g[i][0] === empInitial)) {
        return { score: 0.65, type: 'variant' };
      }
    }
    return null;
  }

  // Middle names only ever STRENGTHEN a match — the registers record them
  // inconsistently (often omitted), so a missing or differing middle name
  // must never downgrade or hide a hit. When the employee's middle name
  // appears among a candidate's given names, the hit is annotated with
  // middleMatch: true so reviewers see the extra corroboration.
  function middleNameMatches(cand, empMiddleTokens) {
    if (!empMiddleTokens.length || cand.given.length < 2) return false;
    const middles = cand.given.slice(1);
    return empMiddleTokens.some(function (t) { return middles.indexOf(t) !== -1; });
  }

  function matchEmployee(emp, registerRows) {
    const empFirstTokens = tokenise(emp.firstName);
    const empMiddleTokens = tokenise(emp.middleName);
    const empInitial = empFirstTokens.length ? empFirstTokens[0][0] : '';
    const empLastKey = tokenise(emp.lastName).join('');
    if (!empLastKey) return [];

    const hits = [];
    for (const entry of registerRows) {
      let best = null;
      for (const cand of (entry.nameCandidates || [])) {
        const r = scoreCandidate(cand, empFirstTokens, empInitial, empLastKey);
        if (!r) continue;
        r.middleMatch = middleNameMatches(cand, empMiddleTokens);
        // Prefer higher score; at equal score prefer a middle-name-corroborated parse
        if (!best || r.score > best.score || (r.score === best.score && r.middleMatch && !best.middleMatch)) best = r;
      }
      if (best) hits.push({ entry: entry, score: best.score, matchType: best.type, middleMatch: best.middleMatch });
    }

    // Deduplicate by name+suburb, keep highest score
    const seen = new Map();
    for (const h of hits) {
      const key = h.entry.name + '\x00' + h.entry.suburb;
      const ex = seen.get(key);
      if (!ex || ex.score < h.score) seen.set(key, h);
    }
    return Array.from(seen.values()).sort(function (a, b) { return b.score - a.score; });
  }

  return {
    normName: normName,
    tokenise: tokenise,
    buildNameCandidates: buildNameCandidates,
    normaliseAcqscRow: normaliseAcqscRow,
    normaliseNdisRow: normaliseNdisRow,
    matchEmployee: matchEmployee
  };
}));
