#!/bin/sh
set -euo pipefail

# Nx project-graph caching/daemon can get into a bad state across container restarts and then fail
# with "Cannot find configuration for task server:next:dev". Reset it on boot for stability.
export NX_DAEMON="${NX_DAEMON:-false}"
export NX_CACHE_DIRECTORY="${NX_CACHE_DIRECTORY:-/tmp/nx-cache}"
export NX_WORKSPACE_DATA_DIRECTORY="${NX_WORKSPACE_DATA_DIRECTORY:-/tmp/nx-workspace-data}"
export NX_PROJECT_GRAPH_CACHE_DIRECTORY="${NX_PROJECT_GRAPH_CACHE_DIRECTORY:-/tmp/nx-workspace-data}"
rm -rf "$NX_CACHE_DIRECTORY" "$NX_WORKSPACE_DATA_DIRECTORY" >/dev/null 2>&1 || true
mkdir -p "$NX_CACHE_DIRECTORY" "$NX_WORKSPACE_DATA_DIRECTORY" >/dev/null 2>&1 || true

cd /app
npx --no-install nx reset >/dev/null 2>&1 || true

DB_PASSWORD=""
SECRET_FILE="/run/secrets/db_password_server"
if [ -f "$SECRET_FILE" ]; then
  DB_PASSWORD=$(tr -d '\r\n' < "$SECRET_FILE")
elif [ -n "${DB_PASSWORD_SERVER:-}" ]; then
  DB_PASSWORD="${DB_PASSWORD_SERVER}"
else
  echo "[server-dev-entrypoint] ERROR: db password not found in /run/secrets/db_password_server or DB_PASSWORD_SERVER env" >&2
  exit 1
fi

# The production entrypoint normally exposes the Docker-mounted NextAuth secret to
# the process environment. This source-dev entrypoint replaces that entrypoint, so
# mirror the required behavior here. Edge auth reads NEXTAUTH_SECRET directly from
# process.env and cannot use the filesystem secret provider on its own.
if [ -z "${NEXTAUTH_SECRET:-}" ]; then
  NEXTAUTH_SECRET_FILE="/run/secrets/nextauth_secret"
  if [ -f "$NEXTAUTH_SECRET_FILE" ]; then
    NEXTAUTH_SECRET=$(tr -d '\r\n' < "$NEXTAUTH_SECRET_FILE")
    export NEXTAUTH_SECRET
  else
    echo "[server-dev-entrypoint] ERROR: NEXTAUTH_SECRET is not set and /run/secrets/nextauth_secret is missing" >&2
    exit 1
  fi
fi

PG_HOST="${PGBOUNCER_HOST:-pgbouncer}"
PG_PORT="${PGBOUNCER_PORT:-6432}"
export DATABASE_URL="postgresql://app_user:${DB_PASSWORD}@${PG_HOST}:${PG_PORT}/server"
export DB_HOST="${PG_HOST}"
export DB_PORT="${PG_PORT}"
export REDIS_HOST="${REDIS_HOST:-redis}"
export REDIS_PORT="${REDIS_PORT:-6379}"
export HOCUSPOCUS_URL="${HOCUSPOCUS_URL:-ws://hocuspocus:1234}"

NEXT_RUNTIME="${ALGA_NEXT_RUNTIME:-development}"
case "$NEXT_RUNTIME" in
  production)
    export NODE_ENV="production"
    ;;
  development)
    export NODE_ENV="development"
    ;;
  *)
    echo "[server-dev-entrypoint] ERROR: ALGA_NEXT_RUNTIME must be 'development' or 'production'" >&2
    exit 1
    ;;
esac

# Some startup tasks (e.g. standard invoice template sync) require the AssemblyScript compiler.
# The template compiler lives in a nested package with its own node_modules.
ASC_JS="/app/server/src/invoice-templates/assemblyscript/node_modules/assemblyscript/dist/asc.js"
if [ ! -f "$ASC_JS" ]; then
  echo "[server-dev-entrypoint] Installing AssemblyScript deps for invoice templates..."
  mkdir -p /app/.npm-cache >/dev/null 2>&1 || true
  (cd /app/server/src/invoice-templates/assemblyscript && npm install --cache /app/.npm-cache --silent)
fi

# The stock source-development image does not prebuild every workspace package.
# Some server imports therefore fall through package exports to dist/ entrypoints
# that are missing at runtime (for example marketing -> opportunities). The normal
# CE production build already uses `nx build-deps server`; enable that same
# dependency build for the isolated vendor test stack so the complete dependency
# closure exists before Next starts.
if [ "${ALGA_BUILD_SERVER_DEPS:-0}" = "1" ]; then
  echo "[server-dev-entrypoint] Building complete server workspace dependency graph..."
  cd /app
  npx --no-install nx build-deps server --output-style=static
fi

cd /app/server

if [ "$NEXT_RUNTIME" = "production" ]; then
  # The vendor test VM is intended for realistic UI/integration testing rather
  # than hot-reload development. Build the optimized Next bundle once when the
  # container is recreated, then serve it without per-route dev compilation.
  echo "[server-dev-entrypoint] Building optimized Next.js production bundle..."
  NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=8192}" npx --no-install next build --webpack
  echo "[server-dev-entrypoint] Starting optimized Next.js server..."
  exec npx --no-install next start -H 0.0.0.0 -p 3000
fi

# Development mode remains available for debugging and hot reload when needed.
# Next 16 defaults to Turbopack; keep that default. Webpack can be forced for debugging via ALGA_NEXT_WEBPACK=1.
NEXT_DEV_FLAGS="--hostname 0.0.0.0 --port 3000"
if [ "${ALGA_NEXT_WEBPACK:-0}" = "1" ]; then
  NEXT_DEV_FLAGS="--webpack ${NEXT_DEV_FLAGS}"
fi
exec npx --no-install next dev ${NEXT_DEV_FLAGS}
