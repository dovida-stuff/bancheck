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

  // Letters that NFD does not decompose into a base letter + accent, so the
  // accent-stripping step below would otherwise leave them intact (and the
  // punctuation step would then throw them away, turning "Søren" into "s ren").
  var LETTER_FOLDS = { 'ø': 'o', 'ł': 'l', 'đ': 'd', 'ð': 'd', 'ß': 'ss', 'æ': 'ae', 'œ': 'oe', 'þ': 'th', 'ı': 'i', 'ħ': 'h', 'ŧ': 't' };
  var LETTER_FOLD_RE = /[øłđðßæœþıħŧ]/g;

  // Lowercase, fold accents (é→e), drop apostrophes (O'Brien→obrien) and
  // mojibake replacement chars, turn all other punctuation into spaces.
  // Any Unicode letter or digit is kept, so names in non-Latin scripts are
  // compared as written rather than silently reduced to nothing. Accepts
  // non-strings (a numeric spreadsheet cell) without throwing.
  function normName(s) {
    return String(s == null ? '' : s)
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(LETTER_FOLD_RE, function (c) { return LETTER_FOLDS[c]; })
      .replace(/[\u2018\u2019\u02BC']/g, '')
      .replace(/\uFFFD/g, '')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function tokenise(s) {
    return normName(s).split(' ').filter(Boolean);
  }

  // Alias introducers seen in the registers: "also known as", "also known",
  // "also know as" (sic), "aka"/"a.k.a.", "alias", "formerly (known as)",
  // "previously known as", "previous Legal Name:", "nee".
  var ALIAS_KW = '(?:also\\s+known?(?:\\s+as)?|\\ba\\.?k\\.?a\\b\\.?|\\balias\\b|\\bformerly(?:\\s+known\\s+as)?|\\bpreviously\\s+known\\s+as|\\bprevious\\s+legal\\s+name:?|\\bn[e\u00e9]e\\b)';
  var ALIAS_LEAD = new RegExp('^\\s*' + ALIAS_KW + '\\s*', 'i');
  var ALIAS_SPLIT = new RegExp('[,;]?\\s*' + ALIAS_KW + '\\s*|;', 'i');
  // "trading as", "t/a", "t/as", "T/A" — optionally preceded by ", " or " / ".
  var TRADING_AS = /[,;\/]?\s*\/?\s*(?:trading\s+as|\bt\/as?\b)[\s;:]*.*$/i;
  // Alias lists: "A and B", "A, B, and C", "A/B", "A or B". The primary
  // name is only split on and/or — its comma means "SURNAME, Given".
  var LIST_SPLIT = /\s*(?:,|;|\/|\band\b|\bor\b)\s*/i;
  var PRIMARY_SPLIT = /\s+(?:and|or)\s+/i;

  // Split a raw register name into the primary name plus alias segments
  // (parentheses, "also known as"/"aka"/..., semicolons). "trading as"
  // suffixes are dropped. Alias lists are split on and/or/comma/slash, but
  // the unsplit segment is kept too in case the connector is part of a name.
  function aliasSegments(raw) {
    const aliases = [];
    // Collapse whitespace first: the unanchored `\s*` in the split regexes
    // is quadratic on long runs of spaces otherwise.
    let name = String(raw == null ? '' : raw).replace(/\s+/g, ' ');

    // Parenthetical aliases — tolerate an unclosed "(" (real data has one).
    name = name.replace(/\(([^)]*)\)?/g, function (_, inner) {
      inner = inner.replace(ALIAS_LEAD, '');
      if (inner.trim()) aliases.push(inner);
      return ' ';
    });

    name = name.replace(TRADING_AS, ' ');

    const parts = name.split(ALIAS_SPLIT).filter(function (s) { return s && s.trim(); });
    const primary = parts.length ? parts.shift() : '';
    parts.forEach(function (p) { aliases.push(p); });

    const expand = function (seg, rx) {
      const out = [seg];
      const bits = seg.split(rx).filter(function (s) { return s && s.trim(); });
      if (bits.length > 1) bits.forEach(function (b) { out.push(b); });
      return out;
    };
    const primaries = expand(primary, PRIMARY_SPLIT);
    const expanded = [];
    aliases.forEach(function (a) { expand(a, LIST_SPLIT).forEach(function (b) { expanded.push(b); }); });
    return { primary: primaries[0], primaryParts: primaries.slice(1), aliases: expanded };
  }

  // Parse one segment into candidate {given[], surname[]} interpretations.
  function segmentCandidates(seg) {
    seg = String(seg == null ? '' : seg).trim().replace(/^\s*(?:mr|mrs|ms|miss|dr)\.?\s+/i, '');
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
    const push = function (c) { out.push({ given: c.given, surnameKey: c.surname.join('') }); };
    const segs = aliasSegments(rawName);
    const primaryCands = segmentCandidates(segs.primary);
    primaryCands.forEach(push);

    // A one-word alias is either an alternative surname ("Wardle aka
    // Brenecki", "OETJEN (HATIBOVICH)") or an alternative given name
    // ("Nyachuat (Sarah) Riam", "Greg and Kym Plunkett") — generate both,
    // combined with the primary name's parse.
    const single = function (tok) {
      primaryCands.forEach(function (c) {
        out.push({ given: c.given, surnameKey: tok });
        out.push({ given: [tok], surnameKey: c.surname.join('') });
      });
    };
    segs.primaryParts.concat(segs.aliases).forEach(function (a) {
      const toks = tokenise(a);
      if (toks.length === 1) single(toks[0]);
      else segmentCandidates(a).forEach(push);
    });
    return out;
  }

  // ── Register row normalisation ────────────────────────────────────────────

  // "Noah (also known Ahmed)" -> { main: ['noah'], alts: [['ahmed']] };
  // "PRAFAI (also known as PRASAI/PRAFI)" -> { main: ['prafai'], alts: [['prasai'], ['prafi']] }
  function splitAliasField(field) {
    const alts = [];
    const main = String(field == null ? '' : field).replace(/\(([^)]*)\)?/g, function (_, inner) {
      inner = inner.replace(ALIAS_LEAD, '');
      inner.split(LIST_SPLIT).forEach(function (b) {
        const t = tokenise(b.replace(/^\s*(?:mr|mrs|ms|miss|dr)\.?\s+/i, ''));
        if (t.length) alts.push(t);
      });
      return ' ';
    });
    return { main: tokenise(main), alts: alts };
  }

  function normaliseAcqscRow(row) {
    const v = function (k) { return String(row[k] == null ? '' : row[k]).trim(); };
    const first = v('First name');
    const middle = v('Middle Name');
    const last = v('Surname');
    const name = [first, middle, last].filter(Boolean).join(' ');

    const candidates = buildNameCandidates(name);
    // The ACQSC register provides the surname column explicitly — add a
    // structured parse so multi-word surnames are never mis-split, and
    // cross every given-name alternative with every surname alternative
    // ("Noah (also known Ahmed)" x "ADEL (also known MOUSSA)").
    const f = splitAliasField(first);
    const m = tokenise(middle.replace(/\(([^)]*)\)?/g, ' '));
    const l = splitAliasField(last);
    const givens = [f.main].concat(f.alts).filter(function (g) { return g.length; });
    [l.main].concat(l.alts).forEach(function (sur, i) {
      if (!sur.length) return;
      givens.forEach(function (g) {
        candidates.push({ given: g.concat(m), surnameKey: sur.join('') });
      });
      // A multi-word surname alias may itself be "Given SURNAME".
      if (i > 0 && sur.length > 1) {
        segmentCandidates(sur.join(' ')).forEach(function (c) {
          candidates.push({ given: c.given, surnameKey: c.surname.join('') });
        });
      }
    });

    return {
      name: name,
      suburb: v('Suburb'),
      state: v('State'),
      postcode: v('Postcode'),
      orderDate: v('Ban Start Date'),
      orderType: v('Status'),
      reason: v('Description'),
      endDate: v('Ban End Date'),
      isBanning: true, // the ACQSC register is exclusively banning orders
      nameCandidates: candidates
    };
  }

  // Every row in the NDIS export is checked, regardless of compliance action
  // type, expiry date, or whether the name is an individual or organisation.
  function normaliseNdisRow(row) {
    const v = function (k) { return String(row[k] == null ? '' : row[k]).trim(); };
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
  //   0.65 variant  — surname matches, and a given name on one side matches
  //                   a given name on the other (an employee's second given
  //                   name is the register's first, or vice versa, or a
  //                   middle name is shared)
  //   0.65 surname  — surname matches, no first name available to compare
  // An employee's "first name" field may hold several tokens ("Mary Anne",
  // "Jean-Paul"); every token is considered so that a register entry under
  // any of them is still flagged.
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
    for (let j = 1; j < empFirstTokens.length; j++) {
      if (g.indexOf(empFirstTokens[j]) !== -1) return { score: 0.65, type: 'variant' };
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
    const empFirstTokens = tokenise(String(emp.firstName == null ? '' : emp.firstName)
      .replace(/^\s*(?:mr|mrs|ms|miss|dr)\.?\s+/i, ''));
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

    // Collapse only genuinely duplicated rows (same name, place, action type
    // and dates). Distinct actions against the same name — a banning order
    // and a later revocation, or an expired order and its replacement — are
    // all kept, so a banning order can never be hidden behind another row.
    const seen = new Map();
    for (const h of hits) {
      const e = h.entry;
      const key = [e.name, e.suburb, e.orderType, e.orderDate, e.endDate || ''].join('\x00');
      const ex = seen.get(key);
      if (!ex || ex.score < h.score || (ex.score === h.score && h.middleMatch && !ex.middleMatch)) seen.set(key, h);
    }
    // Strongest first: higher score, then banning orders, then orders still
    // in force, so the most serious row is the one a reviewer sees first.
    return Array.from(seen.values()).sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      const ab = a.entry.isBanning ? 1 : 0, bb = b.entry.isBanning ? 1 : 0;
      if (ab !== bb) return bb - ab;
      const ae = a.entry.endDate ? 1 : 0, be = b.entry.endDate ? 1 : 0;
      return ae - be;
    });
  }

  // ── Result classification (shared by the page and the CSV export) ─────────

  // A match is "high" severity only when the name matches in full AND the
  // register entry is a banning order. Everything else — a partial name
  // match, or a non-banning compliance action — is "soft": still flagged for
  // review, but not evidence that the person is banned.
  function isHighSeverity(m) {
    return m.score >= 1.0 && !!(m.entry && m.entry.isBanning);
  }

  var MATCH_LABELS = {
    full: 'Full name match',
    initial: 'Initial match',
    variant: 'Name variant',
    surname: 'Surname match'
  };

  var STATUS = {
    banned: 'Banned',
    review: 'Possible match - verify',
    clear: 'Not Banned'
  };

  // Summarises one employee's result for the export:
  //   status   'Banned' only when at least one match is high severity;
  //            'Possible match - verify' when every match is soft;
  //            'Not Banned' when there are no (remaining) matches.
  //   details  one line per match naming the register, the entry, the match
  //            tier and the order type, so a reviewer can find the entry.
  function summariseResult(acqscMatches, ndisMatches) {
    var all = [];
    (acqscMatches || []).forEach(function (m) { all.push({ reg: 'Aged Care', m: m }); });
    (ndisMatches || []).forEach(function (m) { all.push({ reg: 'NDIS', m: m }); });
    var status = STATUS.clear;
    if (all.length) status = all.some(function (x) { return isHighSeverity(x.m); }) ? STATUS.banned : STATUS.review;
    var details = all.map(function (x) {
      var e = x.m.entry || {};
      var bits = [MATCH_LABELS[x.m.matchType] || 'Possible match'];
      if (x.m.middleMatch) bits.push('middle name matches');
      if (e.orderType) bits.push(e.orderType);
      if (e.endDate) bits.push('ended ' + e.endDate);
      if (e.suburb || e.state) bits.push([e.suburb, e.state].filter(Boolean).join(' '));
      return x.reg + ': ' + e.name + ' (' + bits.join('; ') + ')';
    }).join(' | ');
    var reason = all.map(function (x) { return x.m.entry && x.m.entry.reason; })
      .map(function (r, i) { return r ? all[i].reg + ': ' + r : ''; })
      .filter(Boolean).join('; ');
    return { status: status, details: details, reason: reason };
  }

  return {
    normName: normName,
    tokenise: tokenise,
    buildNameCandidates: buildNameCandidates,
    normaliseAcqscRow: normaliseAcqscRow,
    normaliseNdisRow: normaliseNdisRow,
    matchEmployee: matchEmployee,
    isHighSeverity: isHighSeverity,
    summariseResult: summariseResult,
    MATCH_LABELS: MATCH_LABELS,
    STATUS: STATUS
  };
}));
