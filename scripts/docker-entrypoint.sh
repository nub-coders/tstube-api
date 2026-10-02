#!/bin/sh
set -eu

# Optional read-only runtime cookie seed. yt-dlp needs a private writable copy
# because it saves its cookie jar on exit; browser refreshes update this copy.
if [ -n "${COOKIES_SEED_FILE:-}" ]; then
  umask 077
  cookie_target="${COOKIES_FILE:-cookies.txt}"
  mkdir -p "$(dirname "$cookie_target")"
  cp "$COOKIES_SEED_FILE" "$cookie_target"
  chmod 600 "$cookie_target"
fi

exec "$@"
