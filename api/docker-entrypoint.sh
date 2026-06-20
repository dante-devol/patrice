#!/bin/sh
set -e

# Apply migrations (idempotent) then boot the API.
echo "Applying database migrations..."
npx prisma migrate deploy

echo "Starting Patrice API..."
exec node dist/main.js
