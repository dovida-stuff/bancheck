#!/usr/bin/env bash
# Downloads one register CSV and, only if it passes validation, replaces the
# published file. Called twice by .github/workflows/update-registers.yml.
#
#   REGISTER=ndis URL=... REFERER=... TARGET=ndis-register.csv \
#     SCRAPINGBEE_API_KEY=... scripts/fetch-register.sh
#
# Attempt 1 is a direct curl with a browser fingerprint (what has worked every
# day so far). Attempt 2 is a ScrapingBee proxy fallback, only if the direct
# fetch failed and a key is set. Every download goes to a temp file and must
# pass validate() and to_utf8() before it is moved over TARGET, so a failed run
# can never corrupt the published data.
#
# validate() checks that the file:
#   - is non-empty and is not an HTML/JSON error page
#   - parses as CSV with the header columns the checker relies on, using the
#     same parser that writes register-meta.json (node scripts/register-meta.mjs
#     --verify), which also counts real records rather than physical lines
#   - has at least 5 records and has not shrunk by more than 20% against the
#     file already published (a truncated export must not replace a full one)
set -euo pipefail

: "${REGISTER:?REGISTER (acqsc|ndis) is required}"
: "${URL:?URL is required}"
: "${REFERER:?REFERER is required}"
: "${TARGET:?TARGET is required}"
KEY=${SCRAPINGBEE_API_KEY:-}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
VERIFY="$HERE/register-meta.mjs"

TMP=$(mktemp)
trap 'rm -f "$TMP" "$TMP.utf8"' EXIT

records() { node "$VERIFY" "--verify=$REGISTER" "$1"; }

validate() {
  local f=$1
  [ -s "$f" ] || { echo "validate: empty file"; return 1; }
  local peek; peek=$(head -c 200 "$f" | tr -d '\357\273\277[:space:]' | head -c 1)
  { [ "$peek" = "{" ] || [ "$peek" = "<" ]; } && { echo "validate: looks like JSON/HTML, not CSV"; return 1; }
  if head -c 4096 "$f" | grep -qiE '<html|<!doctype'; then
    echo "validate: HTML markup found near the top of the file"; return 1
  fi
  local n
  if ! n=$(records "$f"); then
    echo "validate: file failed the column/format check"; return 1
  fi
  [ "$n" -ge 5 ] || { echo "validate: only $n records"; return 1; }
  if [ -s "$TARGET" ]; then
    local old
    if old=$(records "$TARGET" 2>/dev/null); then
      local floor=$(( old * 80 / 100 ))
      if [ "$n" -lt "$floor" ]; then
        echo "validate: new file has $n records but the published file has $old — refusing to shrink by more than 20%"
        return 1
      fi
    fi
  fi
  echo "validate: $n records, header OK"
  return 0
}

# The source sometimes serves Windows-1252; the browser decodes the published
# file as UTF-8, so re-encode when needed. Returns 1 (rather than aborting the
# script) if conversion is impossible, so the caller can fall through to the
# next attempt.
to_utf8() {
  local f=$1
  iconv -f UTF-8 -t UTF-8 "$f" >/dev/null 2>&1 && return 0
  echo "File is not valid UTF-8 — converting from Windows-1252"
  if iconv -f WINDOWS-1252 -t UTF-8 "$f" > "$f.utf8" 2>/dev/null; then mv "$f.utf8" "$f"; return 0; fi
  rm -f "$f.utf8"
  echo "to_utf8: conversion failed — the file contains bytes that are neither UTF-8 nor Windows-1252"
  return 1
}

publish() {
  mv "$TMP" "$TARGET"
  trap - EXIT
  echo "$REGISTER: published $(records "$TARGET") records to $TARGET"
}

# --- Attempt 1: direct fetch with realistic browser fingerprint ---
echo "=== Attempt 1: direct fetch (Chrome browser fingerprint) ==="
set +e
HTTP_CODE=$(curl -sS -L --max-time 60 --compressed -w "%{http_code}" \
  -o "$TMP" \
  -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" \
  -H "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8" \
  -H "Accept-Language: en-AU,en-US;q=0.9,en;q=0.8" \
  -H "Accept-Encoding: gzip, deflate, br" \
  -H "Referer: ${REFERER}" \
  -H "Sec-Fetch-Dest: document" \
  -H "Sec-Fetch-Mode: navigate" \
  -H "Sec-Fetch-Site: same-origin" \
  -H "Sec-Fetch-User: ?1" \
  -H "Upgrade-Insecure-Requests: 1" \
  "$URL")
CURL_EXIT=$?
set -e
echo "Direct: curl=$CURL_EXIT HTTP=$HTTP_CODE bytes=$(wc -c < "$TMP")"

if [ "$CURL_EXIT" = "0" ] && [ "$HTTP_CODE" = "200" ] && validate "$TMP" && to_utf8 "$TMP"; then
  publish
  echo "Direct fetch succeeded — ScrapingBee not used"
  exit 0
fi
echo "Direct fetch did not produce a valid CSV"

if [ -z "$KEY" ]; then
  echo "::error::Direct fetch failed for $REGISTER and SCRAPINGBEE_API_KEY is not set — no fallback available"
  echo "--- Response preview ---"
  head -c 1500 "$TMP" || true
  echo
  exit 1
fi

# --- Attempt 2: ScrapingBee ---
# The key is a query parameter (ScrapingBee offers no header form), so it is
# handed to curl through a config file on stdin rather than on the command
# line, where it would be visible to every process on the runner.
echo "=== Attempt 2: ScrapingBee (premium_proxy, no JS) ==="
set +e
HTTP_CODE=$(printf 'data-urlencode = "api_key=%s"\n' "$KEY" | curl -sS -L --max-time 180 -w "%{http_code}" \
  -o "$TMP" \
  -G "https://app.scrapingbee.com/api/v1/" \
  -K - \
  --data-urlencode "url=${URL}" \
  --data-urlencode "render_js=false" \
  --data-urlencode "premium_proxy=true")
CURL_EXIT=$?
set -e
echo "ScrapingBee: curl=$CURL_EXIT HTTP=$HTTP_CODE bytes=$(wc -c < "$TMP")"

if [ "$CURL_EXIT" = "0" ] && [ "$HTTP_CODE" = "200" ] && validate "$TMP" && to_utf8 "$TMP"; then
  publish
  echo "ScrapingBee succeeded"
  exit 0
fi

echo "::error::Both direct fetch and ScrapingBee failed for $REGISTER"
echo "--- Final response preview ---"
head -c 1500 "$TMP" || true
echo
exit 1
