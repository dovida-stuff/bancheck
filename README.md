# Aged Care & NDIS Banning Register Checker

A browser-based compliance tool for Dovida's People & Culture team. Checks employee names against two Australian banning registers and produces a flagged/clear report.

## What it does

- Upload a staff list (CSV or Excel) with `Location`, `First Name`, and `Last Name` columns
- The tool checks each name against:
  - **ACQSC Aged Care Banning Register** — issued under the Aged Care Act
  - **NDIS Commission Banning Register** — all individual banning orders
- Both registers are checked for **active and expired** banning orders. Matches against
  orders still in force are flagged as **Active** (urgent); matches against orders no longer
  in force are flagged separately as **Expired** (lower priority, for context only).
- Produces a colour-coded results page showing flagged employees and match details
- Flagged employees can be exported as CSV or emailed as a report
- All processing happens in the browser — no employee data is transmitted to any server

## How to use it

1. Go to **https://dovida-stuff.github.io/bancheck/**
2. Upload your employee CSV or Excel file
3. Click **Run Check**
4. Review flagged results and download/email the report

The **"Register data last updated"** date shown on the page tells you how current the data is.

## How the register data works

The register CSVs are stored in this repository and served as static files by GitHub Pages:

| File | Source |
|------|--------|
| `aged-care-register.csv` | ACQSC Aged Care Banning Register |
| `ndis-register.csv` | NDIS Commission Banning Register |

A GitHub Actions workflow automatically refreshes both files on the **1st of every month at 11am AEST**.

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

Names are compared using normalised fuzzy matching:

| Score | Meaning |
|-------|---------|
| 1.0 — Full name match | First and last name both match exactly |
| 0.75 — Initial match | Last name matches; first name initial matches |
| 0.65 — Name variant | Last name matches; employee first name matches a middle name on the register |

All matches ≥ 0.65 are flagged for manual review. **Flagged results must be verified before any employment action is taken.**

## Active vs expired orders

Every match is classified by the status of the banning order it matched:

| Status | Meaning | How it's flagged |
|--------|---------|------------------|
| **Active** | Order is still in force (ACQSC `Status` is in force and any `Ban End Date` is in the future; NDIS `Date no longer in force` is empty or in the future) | High priority — red **Active Flags** section |
| **Expired** | Order is no longer in force (ACQSC marked "No longer in force" or end date passed; NDIS end date in the past) | Lower priority — amber **Expired Flags** section, for context only |

An employee with any active match is listed under Active Flags; one whose matches are all
expired is listed under Expired Flags. In the CSV export the *Banned/Not Banned* column reads
`Banned`, `Banned (expired order)`, or `Not Banned`, and expired reasons are tagged `(expired)`.
