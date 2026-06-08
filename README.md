# Aged Care & NDIS Banning Register Checker

A browser-based compliance tool for Dovida's People & Culture team. Checks employee names against two Australian banning registers and produces a flagged/clear report.

## What it does

- Upload a staff list (CSV or Excel) with `Location`, `First Name`, and `Last Name` columns — **or** check a single person by typing their first and last name
- The tool checks each name against:
  - **ACQSC Aged Care Banning Register** — issued under the Aged Care Act
  - **NDIS Commission Banning Register** — active individual banning orders only
- Produces a colour-coded results page showing flagged employees and match details
- Flagged employees can be exported as CSV or emailed as a report
- All processing happens in the browser — no employee data is transmitted to any server

## How to use it

1. Go to **https://dovida-stuff.github.io/bancheck/**
2. Either upload your employee CSV or Excel file, or type a single person's **First Name** and **Last Name** and click **Use this name**
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
