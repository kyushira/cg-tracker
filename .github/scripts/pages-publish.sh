#!/usr/bin/env bash
# Publish a build into the gh-pages branch that GitHub Pages serves.
#
#   pages-publish.sh root    <dist-dir>            # main build -> site root (keeps preview/)
#   pages-publish.sh preview <dist-dir> <branch>   # branch build -> preview/<slug>/
#   pages-publish.sh remove  <branch>              # delete preview/<slug>/
#   pages-publish.sh slug    <branch>              # print the preview slug
#
# gh-pages is kept as a single snapshot commit, so the branch doesn't grow
# with every push. Writes use --force-with-lease against the snapshot we read,
# so concurrent publishes from different branches retry instead of clobbering
# each other.
#
# If gh-pages has no root site yet (first run), a preview publish also builds
# origin/main into the root. That way switching Pages to "Deploy from a branch"
# never serves an empty site.
set -euo pipefail

mode=${1:?mode: root|preview|remove}
remote=${PAGES_REMOTE:-origin}
branch=${PAGES_BRANCH:-gh-pages}
export GIT_AUTHOR_NAME=${GIT_AUTHOR_NAME:-github-actions[bot]}
export GIT_AUTHOR_EMAIL=${GIT_AUTHOR_EMAIL:-41898282+github-actions[bot]@users.noreply.github.com}
export GIT_COMMITTER_NAME=$GIT_AUTHOR_NAME GIT_COMMITTER_EMAIL=$GIT_AUTHOR_EMAIL

slugify() {
  local s
  s=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//' | cut -c1-60)
  s=${s%-}
  [[ -n $s ]] || { echo "empty slug for branch '$1'" >&2; exit 1; }
  printf '%s' "$s"
}

case $mode in
  slug)    slugify "${2:?branch}"; echo; exit 0 ;;
  root)    src=${2:?dist dir}; label="main" ;;
  preview) src=${2:?dist dir}; slug=$(slugify "${3:?branch}"); label="preview/$slug" ;;
  remove)  slug=$(slugify "${2:?branch}"); label="remove preview/$slug" ;;
  *) echo "unknown mode $mode" >&2; exit 2 ;;
esac
if [[ $mode != remove ]]; then
  [[ -f $src/index.html ]] || { echo "$src/index.html missing - build first" >&2; exit 1; }
  src=$(cd "$src" && pwd)
fi

gitdir=$(git rev-parse --absolute-git-dir)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

build_main_into() { # $1 = output dir
  echo "gh-pages has no root site yet; building $remote/main for the root" >&2
  git fetch -q --depth 1 "$remote" main
  mkdir -p "$tmp/main-src"
  git archive FETCH_HEAD | tar -x -C "$tmp/main-src"
  if [[ ! -f $tmp/main-src/package.json ]]; then
    # main has no app yet (new repo): serve a placeholder root until the first release.
    echo '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CG Marry-Up Tracker</title><body style="font:18px system-ui;margin:2rem"><h1>CG Marry-Up Tracker</h1><p>Not released yet. See <a href="./preview/">branch previews</a>.</p></body>' > "$1/index.html"
    return 0
  fi
  (cd "$tmp/main-src" && npm ci --no-audit --no-fund >&2 && npm run build >&2)
  cp -R "$tmp/main-src/dist/." "$1/"
}

write_preview_index() { # $1 = site dir
  local d=$1/preview
  [[ -d $d ]] || return 0
  {
    echo '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    echo '<title>CG Marry-Up Tracker previews</title><body style="font:16px system-ui;margin:2rem">'
    echo '<h1>Branch previews</h1><p><a href="../">Production (main)</a></p><ul>'
    for p in "$d"/*/; do
      [[ -f $p/index.html ]] || continue
      p=$(basename "$p")
      echo "<li><a href=\"./$p/\">$p</a></li>"
    done
    echo '</ul></body>'
  } > "$d/index.html"
}

for attempt in 1 2 3 4 5; do
  site="$tmp/site"; rm -rf "$site"; mkdir -p "$site"
  # exit 2 = branch missing; any other failure is an error, never "empty site"
  rc=0; git ls-remote --exit-code --heads "$remote" "$branch" >/dev/null || rc=$?
  if [[ $rc == 0 ]]; then
    git fetch -q --depth 1 "$remote" "$branch"
    lease=$(git rev-parse FETCH_HEAD)
    git archive "$lease" | tar -x -C "$site"
  elif [[ $rc == 2 ]]; then
    lease=""   # branch doesn't exist yet; the lease requires that it still doesn't
  else
    echo "cannot reach $remote (git ls-remote exit $rc)" >&2; exit 1
  fi

  case $mode in
    root)
      find "$site" -mindepth 1 -maxdepth 1 ! -name preview -exec rm -rf {} +
      cp -R "$src/." "$site/"
      ;;
    preview)
      [[ -f $site/index.html ]] || build_main_into "$site"
      rm -rf "$site/preview/$slug"; mkdir -p "$site/preview/$slug"
      cp -R "$src/." "$site/preview/$slug/"
      ;;
    remove)
      [[ -d $site/preview/$slug ]] || { echo "no preview/$slug to remove"; exit 0; }
      rm -rf "$site/preview/$slug"
      ;;
  esac
  touch "$site/.nojekyll"   # serve files as-is
  write_preview_index "$site"

  rm -f "$tmp/index"
  GIT_INDEX_FILE="$tmp/index" git --git-dir="$gitdir" --work-tree="$site" -C "$site" add -A -f .
  tree=$(GIT_INDEX_FILE="$tmp/index" git --git-dir="$gitdir" write-tree)
  if [[ -n $lease && $tree == "$(git rev-parse "$lease^{tree}")" ]]; then
    echo "gh-pages already up to date ($label)"; exit 0
  fi
  commit=$(git commit-tree "$tree" -m "Pages: $label (${GITHUB_SHA:-$(git rev-parse --short HEAD)})")
  if git push -q --force-with-lease="refs/heads/$branch:$lease" "$remote" "$commit:refs/heads/$branch"; then
    echo "published $label -> $branch@${commit:0:7}"; exit 0
  fi
  echo "push raced with another publish (attempt $attempt); retrying" >&2
  sleep $((attempt * 3))
done
echo "gave up after 5 attempts" >&2; exit 1
