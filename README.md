# Aged Care & NDIS Banning Register Checker

A browser-based compliance tool for Dovida's People & Culture team. Checks employee names against two Australian banning registers and produces a flagged/clear report.

## What it does

- Upload a staff list (CSV or Excel) with `Location`, `First Name`, and `Last Name` columns (an optional `Middle Name` column is used too, if present) — **or** check a single person by typing their name
- The tool checks each name against:
  - **ACQSC Aged Care Banning Register** — issued under the Aged Care Act
  - **NDIS Commission Banning Register** — every entry in the export, including all compliance action types (banning orders, compliance notices, revocations, suspensions, etc.), expired orders, and organisations
- Lists every employee with a match in a results table (Banned / Verify), with the matching register entry one click away; clear employees are not listed on the page but are included in the report
- Results can be exported as a CSV report
- Each register can be downloaded from the page, so any result can be verified by hand against the exact file the checker used
- All processing happens in the browser — no employee data is transmitted to any server

## How to use it

1. Go to **https://dovida-stuff.github.io/bancheck/**
2. Either type a person's name (last name is required; a surname-only search flags all surname matches for review), or upload your employee CSV or Excel file
3. Click **Run check**
4. Click a row to see the register entry it matched, then download the report

The register line under the form shows each register's entry count and the date its content
last changed, with a download link for each file. The ⓘ tooltip carries the SHA-256 hashes.
If either source has not been successfully checked for more than 3 days the line turns amber
with a warning — that is the signal that the automatic update has stopped and needs attention
(see *What to do if the Action fails*).

### Verifying a result by hand

1. Click **Open register CSV** on the match, or the **↓ Aged Care** / **↓ NDIS** link under the
   form (the file is named with the date its content last changed, e.g.
   `acqsc-aged-care-banning-register_2026-09-03.csv`)
2. Open it in Excel and search for the surname — the row the checker matched will be there
3. To prove the download is the same file the checker used, hash it and compare with the
   SHA-256 shown on the page. In PowerShell: `Get-FileHash .\<file>.csv -Algorithm SHA256`;
   on a Mac: `shasum -a 256 <file>.csv`
4. For the official record, the source pages are linked in the page footer, and the file's
   commit history in this repository shows every version the tool has ever used

### The CSV report

The downloaded report has one row per employee:

| Column | Meaning |
|--------|---------|
| Location | As supplied in the uploaded file (blank for a single-name check) |
| First Name / Last Name | As supplied |
| Outcome | `Banned` only when a **full name** matched a **banning order**; `Possible match - verify` when the only matches were partial (initial / variant / surname) or against a non-banning action; `Not Banned` when nothing matched (or every partial match was dismissed) |
| Banning Register Checked Date | The date the check was run |
| Next Banning Register Check Date | Always 3 months after the check date |

The register versions used are shown on the page (the *Register data* panel and the results
audit bar) and can be downloaded from there if a result needs to be verified.

## How the register data works

The register CSVs are stored in this repository and served as static files by GitHub Pages:

| File | Source |
|------|--------|
| `aged-care-register.csv` | ACQSC Aged Care Banning Register |
| `ndis-register.csv` | NDIS Commission Banning Register (the full compliance-actions export) |
| `register-meta.json` | Written by the workflow: row count, SHA-256, last-changed and last-checked timestamps for each file |

A GitHub Actions workflow (`.github/workflows/update-registers.yml`) refreshes both files
**twice a day** — scheduled for 11am and 6am AEST. GitHub runs scheduled workflows on a
best-effort basis and the 11am slot has in practice started anywhere between noon and 10pm
AEST, which is why there are two slots. Every run:

1. Downloads each register directly from the government site with a browser-like request
   (a ScrapingBee proxy fallback exists but has not been needed since May 2026)
2. **Validates** the download before it can replace the published file: it must not be an
   HTML/JSON error page, must have the header columns the checker relies on (`First name` /
   `Surname`, `Type` / `Name`), and must not have shrunk by more than 20% against the current
   file (so a truncated export can never replace a complete one). A download that fails
   validation is discarded and the last good file stays published
3. Normalises the file to UTF-8 (the ACQSC source sometimes serves Windows-1252, which
   would otherwise corrupt names like *D'Aguilar* when the browser reads them)
4. Regenerates `register-meta.json` and runs the matcher test suite against the new data
5. Commits whatever changed. A run that found no new data still commits the metadata, so the
   page can show "checked <today>" — and so a gap in the commit history means the workflow
   did not run, not merely that the data was unchanged

If any fetch fails, or the tests fail on the new data, the run is marked **failed** (GitHub
emails the repository owner) but whatever did download successfully is still published.

## How to manually trigger a register update

1. Go to the **Actions** tab in this repository
2. Select **Update Banning Register CSVs**
3. Click **Run workflow** → **Run workflow**

The workflow will download both CSVs and commit them to the repo. GitHub Pages will update within a minute or two.

## What to do if the Action fails

If the scheduled or manual workflow run fails:

1. Check the workflow run log under the **Actions** tab for the error message
2. Try running the workflow again manually (transient network issues are common)
3. If the failure persists, the source URL may have changed:
   - **ACQSC:** Visit https://www.agedcarequality.gov.au/providers/compliance-enforcement/banning-orders and find the CSV download link
   - **NDIS:** Visit https://www.ndiscommission.gov.au/about-us/compliance-and-enforcement/compliance-actions/search and find the CSV download link
4. Update the URL in `.github/workflows/update-registers.yml` and re-run the workflow
5. If a source has changed its column names, also update `requiredColumns` in
   `scripts/register-meta.mjs` and the `HEADER_MUST_MATCH` pattern in the workflow, then
   check `matcher.js` still reads the right columns (`normaliseAcqscRow` / `normaliseNdisRow`)

If the register files were ever replaced by hand, run `node scripts/register-meta.mjs` and
commit `register-meta.json` with them — the tests fail if the metadata does not describe the
committed files.

Note that the checker page itself keeps working from the last published files whatever happens
to the workflow; the amber warning in the Register data panel is how users find out the data is
no longer current.

## Matching logic

Matching lives in `matcher.js` (shared between the page and the test suite). Names are
normalised before comparison: case, accents (é→e), apostrophes (O'Brien = OBrien = O'Brien),
hyphens and other punctuation are all ignored, so hyphenated and multi-word surnames
(`LEDDINGTON-HILL`, `VAN ROOYEN`, `AL SHAMARE`) match however the employee's name is written.

Register entries are parsed into every plausible interpretation of the name, covering the
formats that actually appear in the registers:

- `Simon James NUGUS` — given names first
- `TANTS, Jacob Alfred` — surname first
- `Kayla Pethybridge trading as J & K Loyalty...` — business suffix (ignored)
- `Ahmed JAMA, also known as Faysal MUKETAR` — aliases (both names are matched)
- `HORTON (also known as Scott ... HORTON)` — parenthetical aliases

Match tiers:

| Tier | Meaning |
|-------|---------|
| Full name match | Surname and first name both match |
| Initial match | Surname matches; first-name initial matches |
| Name variant | Surname matches; employee first name matches a middle name on the register |
| Surname match | Surname matches; no first name available to compare (e.g. surname-only search) |

Every tier is flagged for manual review. **Flagged results must be verified before any employment action is taken.**

### Middle names

A middle name can optionally be provided (single-name form field, or a `Middle Name` column in
the uploaded file). It is **confirm-only**: when it matches a middle name on the register entry,
the match card shows "✓ Middle name also matches" as extra corroboration for the reviewer. A
missing or different middle name never downgrades or hides a match — the registers record middle
names inconsistently, so absence of a middle-name match is not evidence the person is clear.

### Tests

`test/match.test.mjs` runs the real `matcher.js` against the real register CSVs — every
person on the ACQSC register must fully match their own entry, plus targeted checks for each
NDIS name format, the severity / export-status rules, and that `register-meta.json` matches
the committed files. Run with:

```
node test/match.test.mjs
```

The suite also runs in GitHub Actions on every push (`.github/workflows/test.yml`) and inside
the daily update workflow against the freshly downloaded data.

### Outcomes

Each listed employee has one outcome:

| Outcome | Meaning |
|---------|---------|
| 🔴 Banned | A **full name match** against a **banning order** — the strongest signal |
| 🔵 Verify | A **partial name match** (initial or variant), or a match against a **non-banning compliance action** (compliance notice, revocation, suspension, etc.) — lower confidence, still review |

Verify is not "safe" — every listed employee still requires manual verification. Employees with no match are not listed on the page; they appear in the report as Not Banned.

Note that "banning order" here means the register **entry type**, not whether the order is
still current: an ACQSC entry whose status is *No longer in force*, or an NDIS banning order
with a *Date no longer in force*, still shows red on a full name match. The end date is shown
on the match card and in the report's *Match details* column so the reviewer can see it.

### Dismissing partial matches

Verify-level matches can be **dismissed** during review with the **Dismiss this match** link on the match. Dismissing removes that match; if an employee has no remaining matches they leave the table and export as "Not Banned". Banned matches cannot be dismissed.

Dismissals are **session-only** — nothing is stored, and re-running the check restores all matches.
