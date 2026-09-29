#!/usr/bin/env bash
# Back up the career-ops USER LAYER into a separate git repo.
#
# Why this exists: career-ops .gitignores every user-layer file by design, so
# the project repo protects the SYSTEM but not your data. Nothing in cv.md,
# config/profile.yml, portals.yml, modes/_profile.md, data/, reports/ or
# output/ is recoverable from git history. This script fixes that.
#
# Paths come from DATA_CONTRACT.md "User Layer". Re-run any time; it commits
# only what changed.
#
# Usage:  ./scripts/backup-user-data.sh [destination]
#         default destination: ~/career-ops-data-backup

set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${1:-$HOME/career-ops-data-backup}"

# DATA_CONTRACT.md — User Layer. Keep in sync with that table.
PATHS=(
  cv.md
  article-digest.md
  config/profile.yml
  modes/_profile.md
  portals.yml
  data
  reports
  output
  interview-prep
  jds
  writing-samples
)

mkdir -p "$DEST"
if [[ ! -d "$DEST/.git" ]]; then
  git -C "$DEST" init -q
  printf 'node_modules/\n.DS_Store\n' > "$DEST/.gitignore"
  cat > "$DEST/README.md" <<'RM'
# career-ops — user data backup

Mirror of the career-ops **User Layer** (see `DATA_CONTRACT.md` in the project).
These files are gitignored in the project repo, so this is the only version
history they have.

**Refresh:** `~/career-ops/scripts/backup-user-data.sh`

**Restore one file:** copy it back into the project, e.g.
`cp modes/_profile.md ~/career-ops/modes/_profile.md`

**Restore an earlier version:** `git log -- <path>` then
`git show <sha>:<path> > ~/career-ops/<path>`

⚠️ Contains personal data: CV, comp targets, application tracker, evaluation
reports and generated documents. Keep this repo private. Do not add a public
remote.
RM
fi

copied=0
for p in "${PATHS[@]}"; do
  [[ -e "$SRC/$p" ]] || continue
  mkdir -p "$DEST/$(dirname "$p")"
  rsync -a --delete "$SRC/$p" "$DEST/$(dirname "$p")/" 2>/dev/null || cp -R "$SRC/$p" "$DEST/$(dirname "$p")/"
  copied=$((copied+1))
done

cd "$DEST"
git add -A
if git diff --cached --quiet; then
  echo "backup: no changes since last run ($DEST)"
else
  n=$(git diff --cached --name-only | wc -l | tr -d ' ')
  git commit -q -m "backup $(date '+%Y-%m-%d %H:%M') — $n files changed"
  echo "backup: committed $n changed files to $DEST"
fi
echo "backup: $copied user-layer paths mirrored, $(du -sh "$DEST" | awk '{print $1}') total"
