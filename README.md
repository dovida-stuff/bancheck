# Aged Care & NDIS Banning Register Checker

A browser-based compliance tool for Dovida's People & Culture team. Checks employee names against two Australian banning registers and produces a flagged/clear report.

## What it does

- Upload a staff list (CSV or Excel) with `Location`, `First Name`, and `Last Name` columns (an optional `Middle Name` column is used too, if present) — **or** check a single person by typing their name
- The tool checks each name against:
  - **ACQSC Aged Care Banning Register** — issued under the Aged Care Act
  - **NDIS Commission Banning Register** — every entry in the export, including all compliance action types (banning orders, compliance notices, revocations, suspensions, etc.), expired orders, and organisations
- Produces a colour-coded results page showing flagged employees and match details
- Results can be exported as a CSV report
- All processing happens in the browser — no employee data is transmitted to any server

## How to use it

1. Go to **https://dovida-stuff.github.io/bancheck/**
2. Either upload your employee CSV or Excel file, or type a single person's **First Name** and **Last Name** (first name is optional — a surname-only search flags all surname matches for review)
3. Click **Run Check**
4. Review flagged results and download the CSV report

The **"Register data last updated"** date shown on the page tells you how current the data is.

## How the register data works

The register CSVs are stored in this repository and served as static files by GitHub Pages:

| File | Source |
|------|--------|
| `aged-care-register.csv` | ACQSC Aged Care Banning Register |
| `ndis-register.csv` | NDIS Commission Banning Register |

A GitHub Actions workflow automatically refreshes both files **daily at 11am AEST**. Files are
normalised to UTF-8 during the update (the ACQSC source sometimes serves Windows-1252, which
would otherwise corrupt names like *D'Aguilar* when the browser reads them). A day without a
new commit just means the source data didn't change — the workflow still ran.

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
NDIS name format. Run with:

```
node test/match.test.mjs
```

### Flag colours

Flagged results are colour-coded by how serious the match is:

| Colour | Meaning |
|--------|---------|
| 🔴 Red | A **full name match** against a **banning order** — the strongest signal |
| 🔵 Blue | A **partial name match** (initial or variant), or a match against a **non-banning compliance action** (compliance notice, revocation, suspension, etc.) — lower confidence, still review |

Blue is not "safe" — every flagged result still requires manual verification. The colour only indicates relative confidence.

### Dismissing partial matches

Blue (partial) matches can be **dismissed** during review using the **Dismiss match** button. Dismissing removes that match from the results; if an employee has no remaining matches they drop into the Clear list and export as "Not Banned". Full-name matches against banning orders (red) cannot be dismissed.

Dismissals are **session-only** — nothing is stored, and re-running the check restores all matches.
