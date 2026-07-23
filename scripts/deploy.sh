#!/usr/bin/env bash
# Deploy Find-A-Flock S&T to GitHub Pages (branch-deploy model).
#
# Builds the Vite site and publishes it to the `gh-pages` branch, which
# GitHub Pages serves at https://<user>.github.io/<repo>/. There is no
# GitHub Actions step — this script IS the deploy.
#
# Usage:
#   scripts/deploy.sh            # commit any staged/unstaged source, build, publish
#   scripts/deploy.sh --no-src   # skip the source commit/push; only rebuild + publish
#
# Run from anywhere inside the repo.
set -euo pipefail

# --- locate repo root + derive the Pages base path from the remote ------------
cd "$(git rev-parse --show-toplevel)"

REPO="$(basename -s .git "$(git remote get-url origin)")"
BASE="/${REPO}/"
BRANCH="gh-pages"

echo "==> repo: ${REPO}   base path: ${BASE}   deploy branch: ${BRANCH}"

# --- 1. commit + push source on the current branch (unless --no-src) ----------
if [ "${1:-}" != "--no-src" ]; then
  if ! git diff --quiet || ! git diff --cached --quiet; then
    git add -A
    git commit -m "Update site content"
  fi
  git push
else
  echo "==> --no-src: skipping source commit/push"
fi

# --- 2. build with the correct base path --------------------------------------
echo "==> building (VITE_BASE=${BASE})"
VITE_BASE="${BASE}" npm run build
touch dist/.nojekyll   # stop GitHub Pages from running Jekyll on the build output

# --- 3. publish dist/ as a fresh parentless commit on gh-pages ----------------
# A throwaway index lets us build a tree purely from dist/ without touching the
# working tree or the checked-out branch.
echo "==> publishing dist/ to ${BRANCH}"
GIT_INDEX_FILE="$(mktemp)"; rm -f "$GIT_INDEX_FILE"; export GIT_INDEX_FILE
git --work-tree=dist add -Af .
TREE="$(git --work-tree=dist write-tree)"
COMMIT="$(git commit-tree "$TREE" -m "Deploy site to GitHub Pages")"
git update-ref "refs/heads/${BRANCH}" "$COMMIT"
rm -f "$GIT_INDEX_FILE"; unset GIT_INDEX_FILE

git push -f origin "${BRANCH}"

echo "==> done. Live at: https://$(gh api "repos/$(gh repo view --json nameWithOwner --jq .nameWithOwner)/pages" --jq '.html_url' 2>/dev/null | sed 's#https://##' || echo "<user>.github.io/${REPO}/")"
