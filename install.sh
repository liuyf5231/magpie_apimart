#!/usr/bin/env bash
# Give one machine the APIMart provider plugin for magpie. Run it on every
# machine that should have it, since magpie's WebDAV sync carries its library,
# providers, settings, profiles and agents — not plugins.
#
#   ./install.sh                       # key from APIMART_API_KEY, else the macOS Keychain
#   APIMART_API_KEY=sk-… ./install.sh
#   MAGPIE_APIMART_DIR=~/code/magpie-apimart-image ./install.sh
#
# The MCP half needs nothing here: its registration (and the key in its env)
# lives in magpie's library and arrives with the next sync.
#
# Why a clone and not `magpie plugin add github:…`: the repo is private, and
# Bun resolves such a spec through GitHub's tarball API without credentials
# (404). git has the user's credentials, so the clone goes through.
set -euo pipefail

MAGPIE="${MAGPIE:-magpie}"
URL="${MAGPIE_APIMART_URL:-https://github.com/liuyf5231/magpie_apimart.git}"
DIR="${MAGPIE_APIMART_DIR:-$HOME/.local/share/magpie-apimart-image}"
PROVIDER=apimart

say() { printf '%s\n' "$*"; }

if ! command -v "$MAGPIE" >/dev/null 2>&1; then
  say "magpie isn't on PATH: install it first, or set MAGPIE=/path/to/magpie"
  exit 1
fi

if [ -d "$DIR/.git" ]; then
  say "▸ updating $DIR"
  git -C "$DIR" pull --ff-only
else
  say "▸ cloning into $DIR"
  mkdir -p "$(dirname "$DIR")"
  git clone "$URL" "$DIR"
fi

say "▸ adding the plugin $DIR"
"$MAGPIE" plugin add "$DIR"

key="${APIMART_API_KEY:-}"
if [ -z "$key" ] && command -v security >/dev/null 2>&1; then
  key="$(security find-generic-password -s APIMART_API_KEY -w 2>/dev/null || true)"
fi
if [ -n "$key" ]; then
  say "▸ signing in to $PROVIDER"
  printf '%s\n' "$key" | "$MAGPIE" plugin login "$PROVIDER"
else
  say "! no key found: run \`$MAGPIE plugin login $PROVIDER\` yourself"
  say "  (or set APIMART_API_KEY, or store one in the Keychain:"
  say "   security add-generic-password -s APIMART_API_KEY -a $PROVIDER -w sk-…)"
fi

say "▸ done"
"$MAGPIE" plugin
say
say "try it:"
say "  curl -s http://127.0.0.1:3425/v1/images/generations \\"
say "    -H 'Authorization: Bearer magpie' -H 'Content-Type: application/json' \\"
say "    -d '{\"model\":\"$PROVIDER/gpt-image-2.5-flare\",\"prompt\":\"a cat\",\"size\":\"1024x1024\"}'"
