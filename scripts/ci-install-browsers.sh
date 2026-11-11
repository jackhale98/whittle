#!/usr/bin/env bash
# Installs Playwright browsers on a CI runner (ADR-083 amendment). The Ubuntu package mirrors that
# `--with-deps` needs are sometimes unreachable from the runners, and apt then hangs on DNS
# timeouts for many minutes. Give `--with-deps` one attempt of at most 4 minutes; if that fails,
# install the browser alone. GitHub's ubuntu images already carry Chromium's system libraries
# (run #83: the perf job passed on that path while the mirrors were down).
# Usage: scripts/ci-install-browsers.sh <pnpm filter> <browser>
set -uo pipefail
filter="$1"
browser="$2"
if timeout 240 pnpm --filter "$filter" exec playwright install --with-deps "$browser"; then exit 0; fi
echo "::warning::System packages for $browser could not be installed (mirrors unreachable?); installing the browser only" >&2
pnpm --filter "$filter" exec playwright install "$browser"
