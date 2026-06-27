#!/bin/sh
set -e

# Apply migrations (idempotent) then boot the API. In the production stack a
# dedicated one-shot `migrate` service owns this so api + worker boot with
# SKIP_MIGRATIONS=true (single writer, deterministic ordering, scale-ready). The
# dev compose sets nothing, so it still migrates on boot exactly as before.
if [ "$SKIP_MIGRATIONS" != "true" ]; then
  echo "Applying database migrations..."
  npx prisma migrate deploy
fi

echo "Starting Patrice API..."
exec node dist/main.js
