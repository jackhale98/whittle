#!/usr/bin/env bash
# Installs Playwright browsers on a CI runner (ADR-083 amendment). The Ubuntu package mirrors that
# `--with-deps` needs are occasionally unreachable (DNS failures on the runner), which used to fail
# every browser job of a run at once. Retry with a back-off; if the mirrors stay down, install the
# browser alone: GitHub's ubuntu images already carry Chromium's system libraries.
# Usage: scripts/ci-install-browsers.sh <pnpm filter> <browser>
set -uo pipefail
filter="$1"
browser="$2"
for delay in 0 20 60; do
  sleep "$delay"
  if pnpm --filter "$filter" exec playwright install --with-deps "$browser"; then exit 0; fi
  echo "playwright install --with-deps $browser failed; retrying after a pause" >&2
done
echo "::warning::System packages for $browser could not be installed; installing the browser only" >&2
pnpm --filter "$filter" exec playwright install "$browser"
