#!/usr/bin/env bash
# Build and publish every @bugsee package from this machine (the one-time bootstrap, and any manual
# release). Run from anywhere inside the repo:
#
#   scripts/publish-local.sh                  # preflight → build → dry-run → confirm → publish → trust
#   scripts/publish-local.sh --tag beta       # publish under a dist-tag (default: latest)
#   scripts/publish-local.sh --skip-trust     # publish only; do not attach the OIDC trusted publisher
#   scripts/publish-local.sh --yes            # no confirmation prompt
#   scripts/publish-local.sh --dry-run        # stop after the dry run
#
# Auth: be logged in (`npm login`) or export NODE_AUTH_TOKEN. If your account requires a 2FA code for
# every publish, npm will prompt 49 times — use a granular token (read/write on @bugsee/*, bypass 2FA,
# 1-day expiry) for the bulk publish instead:  NODE_AUTH_TOKEN=npm_xxx scripts/publish-local.sh
#
# Safe to re-run: packages already on npm at this version are skipped, so a failure halfway is fixed by
# running it again.
set -euo pipefail
cd "$(dirname "$0")/.."

TAG=latest
TRUST=1
ASSUME_YES=0
DRY_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --tag) TAG="$2"; shift ;;
    --skip-trust) TRUST=0 ;;
    --yes) ASSUME_YES=1 ;;
    --dry-run) DRY_ONLY=1 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

step "Preflight"
branch=$(git rev-parse --abbrev-ref HEAD)
[ "$branch" = "main" ] || die "on branch '$branch'; release from main"
[ -z "$(git status --porcelain)" ] || die "working tree is not clean (commit or stash first)"
git fetch -q origin main
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || die "HEAD is not origin/main (pull/push first)"
echo "main @ $(git rev-parse --short HEAD)"

user=$(npm whoami 2>/dev/null) || die "not logged in to npm — run: npm login   (or export NODE_AUTH_TOKEN)"
echo "npm user: $user"
npm --version | awk -F. '{ if ($1 < 11 || ($1 == 11 && $2 < 10)) { print "npm " $0 " is too old for `npm trust` (need >= 11.10)"; exit 1 } }' \
  || [ "$TRUST" = 0 ] || die "upgrade npm or pass --skip-trust"

pnpm check:publishable

step "Install + build"
pnpm install --frozen-lockfile
pnpm exec turbo run build

step "Dry run (packs every package and runs npm publish --dry-run)"
node scripts/publish-all.mjs --dry-run --tag "$TAG"
[ "$DRY_ONLY" = 0 ] || { echo "dry run only — stopping."; exit 0; }

if [ "$ASSUME_YES" = 0 ]; then
  printf '\nPublish %s packages to npm under tag "%s" as %s? [y/N] ' "$(node scripts/check-publishable.mjs --list | wc -l | tr -d ' ')" "$TAG" "$user"
  read -r answer
  [ "$answer" = "y" ] || [ "$answer" = "Y" ] || { echo "aborted."; exit 1; }
fi

step "Publish"
node scripts/publish-all.mjs --tag "$TAG"

step "Verify (every package must be readable on the registry)"
# The registry accepts a publish (HTTP 202) and only serves it a few minutes later, so poll instead of
# failing on the first 404.
version=$(node -p "require('./packages/core/package.json').version")
deadline=$((SECONDS + 900))
while :; do
  missing=()
  while read -r name; do
    got=$(npm view "$name@$version" version --prefer-online 2>/dev/null || true)
    [ "$got" = "$version" ] || missing+=("$name")
  done < <(node scripts/check-publishable.mjs --list)
  [ "${#missing[@]}" = 0 ] && break
  [ "$SECONDS" -lt "$deadline" ] || die "still not readable after 15 min: ${missing[*]} — re-run to retry"
  echo "waiting for the registry: ${#missing[@]} package(s) not readable yet"
  sleep 30
done
echo "all published at $version"

if [ "$TRUST" = 1 ]; then
  step "Attach the trusted publisher (OIDC) to every package"
  node scripts/npm-trust-all.mjs
fi

step "Done"
echo "Next: add the REPO_READ_TOKEN secret, then run the Release workflow (dry_run=true first)."
