#!/usr/bin/env bash
#
# Print the CHANGELOG.md section for a single version.
#
#   Usage: extract-changelog.sh <version> [changelog-path]
#   e.g.   extract-changelog.sh 1.0.4
#
# Reads from the "## [<version>]" heading up to the next "## [" heading, and
# trims surrounding blank lines. Exits non-zero when the version has no entry,
# so the publish workflow fails before the irreversible npm publish rather than
# cutting a release with empty notes.

set -euo pipefail

version="${1:?usage: extract-changelog.sh <version> [changelog-path]}"
changelog="${2:-CHANGELOG.md}"

if [ ! -f "$changelog" ]; then
  echo "extract-changelog: no such file: $changelog" >&2
  exit 1
fi

notes=$(
  awk -v ver="$version" '
    # Match the heading for exactly this version. ver is interpolated into a
    # regex, so the dots are escaped by the caller-independent bracket form.
    $0 ~ "^## \\[" ver "\\]" { found = 1; next }
    found && /^## \[/        { exit }
    found                    { print }
  ' "$changelog" |
    # Drop leading blank lines, then trailing ones.
    awk 'NF { p = 1 } p' |
    awk '{ a[NR] = $0 }
         END {
           last = NR
           while (last > 0 && a[last] == "") last--
           for (i = 1; i <= last; i++) print a[i]
         }'
)

if [ -z "$notes" ]; then
  echo "extract-changelog: no entry found for version $version in $changelog" >&2
  echo "Add a '## [$version] - <date>' section before tagging a release." >&2
  exit 1
fi

printf '%s\n' "$notes"
