#!/usr/bin/env bash
# Release the version already on main (set it first with scripts/bump-version.mjs + a merged PR).
#
#   scripts/release.sh                 # preflight → bootstrap new packages → Release workflow → verify → tag
#   scripts/release.sh --tag beta      # npm dist-tag to publish under (default: latest)
#   scripts/release.sh --yes           # no confirmation prompts
#   scripts/release.sh --skip-github-release   # stop after npm verification: no git tag, no GitHub release
#
# What it does, in order:
#   1. Preflight: on main == origin/main, clean tree, CI green on HEAD, gh + npm logged in, gate passes.
#   2. Bootstrap: a package that has NEVER been on npm cannot use trusted publishing (OIDC) for its first
#      publish, so it is published from this machine and then has the trusted publisher attached. This is
#      the only step that needs your npm auth / 2FA; it is skipped when every package already exists.
#   3. Dispatch the Release workflow: dry run, then the real publish (it skips versions already on npm,
#      so re-running after a partial failure resumes).
#   4. Verify every package is readable at the version, with the expected dist-tag.
#   5. Tag vX.Y.Z and create the GitHub release (pre-release when the version has a `-` suffix).
set -euo pipefail
cd "$(dirname "$0")/.."

TAG=latest
ASSUME_YES=0
GH_RELEASE=1
while [ $# -gt 0 ]; do
  case "$1" in
    --tag) TAG="$2"; shift ;;
    --yes) ASSUME_YES=1 ;;
    --skip-github-release) GH_RELEASE=0 ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
confirm() {
  [ "$ASSUME_YES" = 1 ] && return 0
  printf '%s [y/N] ' "$1"
  read -r answer
  [ "$answer" = "y" ] || [ "$answer" = "Y" ] || die "aborted."
}

# Wait for a workflow run started by `gh workflow run` (id looked up after a short settle).
dispatch_and_wait() {
  local dry="$1" before run
  before=$(gh run list --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId // 0')
  gh workflow run release.yml --ref main -f tag="$TAG" -f dry_run="$dry"
  for _ in $(seq 1 30); do
    run=$(gh run list --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId // 0')
    [ "$run" != "$before" ] && break
    sleep 2
  done
  [ "$run" != "$before" ] || die "the dispatched Release run never appeared"
  echo "run $run: $(gh run view "$run" --json url --jq .url)"
  gh run watch "$run" --interval 15 --exit-status >/dev/null || {
    gh run view "$run" --log-failed | tail -30
    die "Release workflow run $run failed (dry_run=$dry)"
  }
}

step "Preflight"
branch=$(git rev-parse --abbrev-ref HEAD)
[ "$branch" = "main" ] || die "on branch '$branch'; release from main"
[ -z "$(git status --porcelain)" ] || die "working tree is not clean (commit or stash first)"
git fetch -q --tags origin main
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || die "HEAD is not origin/main (pull first)"
sha=$(git rev-parse HEAD)
echo "main @ ${sha:0:8}"

command -v gh >/dev/null || die "gh CLI not found"
gh auth status >/dev/null 2>&1 || die "gh is not logged in — run: gh auth login"
user=$(npm whoami 2>/dev/null) || die "not logged in to npm — run: npm login"
echo "npm user: $user"

pnpm check:publishable
version=$(node -p "require('./packages/core/package.json').version")
tagname="v$version"
if git rev-parse -q --verify "refs/tags/$tagname" >/dev/null; then
  die "tag $tagname already exists — bump the version first (node scripts/bump-version.mjs)"
fi

ci=$(gh run list --branch main --workflow ci.yml --commit "$sha" --limit 1 --json conclusion,status --jq '.[0]|"\(.status)/\(.conclusion)"' 2>/dev/null || true)
[ "$ci" = "completed/success" ] || die "CI on ${sha:0:8} is '${ci:-none}', expected completed/success"
echo "CI green on HEAD; releasing $version under dist-tag '$TAG'"

step "Packages that have never been on npm"
new=()
while read -r name; do
  npm view "$name" version >/dev/null 2>&1 || new+=("$name")
done < <(node scripts/check-publishable.mjs --list)

if [ "${#new[@]}" = 0 ]; then
  echo "none — every package already exists, so trusted publishing covers the whole release."
else
  echo "needs a first publish from this machine: ${new[*]}"
  npm trust github --help 2>/dev/null | grep -q allow-publish \
    || die "this npm ($(npm --version)) cannot set the trust permission the registry requires — run: npm install -g npm@latest"
  confirm "Publish ${#new[@]} new package(s) as $user (you will be asked for 2FA)?"

  pnpm install --frozen-lockfile
  pnpm exec turbo run build
  only=$(IFS=,; echo "${new[*]}")
  node scripts/publish-all.mjs --only "$only" --tag "$TAG"

  # A publish is accepted (202) and only readable a little later; trust can attach only once it exists.
  deadline=$((SECONDS + 900))
  for name in "${new[@]}"; do
    until [ "$(npm view "$name@$version" version --prefer-online 2>/dev/null || true)" = "$version" ]; do
      [ "$SECONDS" -lt "$deadline" ] || die "$name@$version still not readable after 15 min — re-run to resume"
      echo "waiting for the registry: $name"
      sleep 20
    done
  done

  step "Attach the trusted publisher (skips packages already trusted; asks for 2FA if needed)"
  node scripts/npm-trust-all.mjs
fi

step "Release workflow: dry run"
dispatch_and_wait true
confirm "Dry run passed. Publish $version to npm under '$TAG' for real?"

step "Release workflow: publish"
dispatch_and_wait false

step "Verify on the registry"
deadline=$((SECONDS + 900))
while :; do
  missing=()
  while read -r name; do
    got=$(npm view "$name@$version" version --prefer-online 2>/dev/null || true)
    [ "$got" = "$version" ] || missing+=("$name")
  done < <(node scripts/check-publishable.mjs --list)
  [ "${#missing[@]}" = 0 ] && break
  [ "$SECONDS" -lt "$deadline" ] || die "not readable after 15 min: ${missing[*]} — re-run to resume"
  echo "waiting for the registry: ${#missing[@]} package(s) not readable yet"
  sleep 30
done
count=$(node scripts/check-publishable.mjs --list | wc -l | tr -d ' ')
wrong=$(npm view @bugsee/bugsee "dist-tags.$TAG" --prefer-online 2>/dev/null || true)
[ "$wrong" = "$version" ] || die "dist-tag '$TAG' on @bugsee/bugsee is '$wrong', expected $version"
echo "all $count packages readable at $version; dist-tag $TAG -> $version"

if [ "$GH_RELEASE" = 0 ]; then
  echo "skipping tag and GitHub release (--skip-github-release)."
  exit 0
fi

step "Tag $tagname and create the GitHub release"
prev=$(git tag --list 'v*' --sort=-creatordate | head -1 || true)
git tag -a "$tagname" -m "$tagname" "$sha"
git push origin "$tagname"
flags=(--title "$version" --verify-tag)
case "$version" in *-*) flags+=(--prerelease) ;; esac
if [ -n "$prev" ]; then flags+=(--generate-notes --notes-start-tag "$prev"); else flags+=(--generate-notes); fi
gh release create "$tagname" "${flags[@]}"

step "Done: $version is released"
