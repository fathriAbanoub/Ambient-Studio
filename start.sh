#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Ambient Studio — startup script
# Starts the FastAPI backend and Next.js frontend in parallel.
# Usage: ./start.sh
# ─────────────────────────────────────────────────────────────────────────────

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/backend"
FRONTEND_DIR="$SCRIPT_DIR/frontend"

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RESET='\033[0m'

log()  { echo -e "${CYAN}[ambient]${RESET} $*"; }
ok()   { echo -e "${GREEN}[ok]${RESET} $*"; }
warn() { echo -e "${YELLOW}[warn]${RESET} $*"; }
err()  { echo -e "${RED}[error]${RESET} $*"; }

# ── Dependency checks ─────────────────────────────────────────────────────────
check_dep() {
    if ! command -v "$1" &>/dev/null; then
        err "'$1' not found. $2"
        exit 1
    fi
}

check_dep python3  "Install Python 3.10+ from https://python.org"
check_dep node     "Install Node.js 18+ from https://nodejs.org"
check_dep ffmpeg   "Install ffmpeg: sudo apt install ffmpeg  (or brew install ffmpeg)"

# npm or bun — prefer bun if available
if command -v bun &>/dev/null; then
    PKG_MGR="bun"
else
    check_dep npm "Install Node.js (includes npm) from https://nodejs.org"
    PKG_MGR="npm"
fi

log "Using package manager: $PKG_MGR"

# ── Backend setup ─────────────────────────────────────────────────────────────
log "Setting up backend..."

VENV_DIR="$BACKEND_DIR/.venv"
if [ ! -d "$VENV_DIR" ]; then
    log "Creating Python virtual environment..."
    python3 -m venv "$VENV_DIR"
    ok "Virtual environment created at $VENV_DIR"
fi

# Activate venv
source "$VENV_DIR/bin/activate"

# Add CUDA libraries to LD_LIBRARY_PATH for GPU-accelerated rendering
export LD_LIBRARY_PATH=/usr/local/cuda/lib64:/usr/local/cuda-12/lib64:$LD_LIBRARY_PATH
log "CUDA library path configured"

log "Installing Python dependencies..."
pip install -q --upgrade pip
pip install -q -r "$BACKEND_DIR/requirements.txt"
ok "Backend dependencies installed"

# ── Frontend setup ────────────────────────────────────────────────────────────
log "Setting up frontend..."

log "Installing frontend dependencies..."
if [ "$PKG_MGR" = "bun" ]; then
    bun install --cwd "$FRONTEND_DIR" --silent
else
    npm install --prefix "$FRONTEND_DIR" --silent
fi
ok "Frontend dependencies installed"

# ── Ensure .env.local exists ──────────────────────────────────────────────────
ENV_FILE="$FRONTEND_DIR/.env.local"
if [ ! -f "$ENV_FILE" ]; then
    echo "NEXT_PUBLIC_API_URL=http://localhost:3003" > "$ENV_FILE"
    ok "Created $ENV_FILE"
fi

# ── Cleanup on exit ───────────────────────────────────────────────────────────
BACKEND_PID=""
FRONTEND_PID=""

cleanup() {
    echo ""
    log "Shutting down..."
    [ -n "$BACKEND_PID" ]  && kill "$BACKEND_PID"  2>/dev/null
    [ -n "$FRONTEND_PID" ] && kill "$FRONTEND_PID" 2>/dev/null
    wait 2>/dev/null
    ok "Stopped."
}

trap cleanup EXIT INT TERM

# ── Start backend ─────────────────────────────────────────────────────────────
log "Starting backend on http://localhost:3003 ..."
cd "$BACKEND_DIR"
python3 -m uvicorn main:app --host 0.0.0.0 --port 3003 --reload &
BACKEND_PID=$!

# Give the backend a moment to bind
sleep 2

# Quick health check
if curl -sf http://localhost:3003/health >/dev/null 2>&1; then
    ok "Backend is up"
else
    warn "Backend health check failed — it may still be starting"
fi

# ── Start frontend ────────────────────────────────────────────────────────────
log "Starting frontend on http://localhost:3002 ..."
cd "$FRONTEND_DIR"

if [ "$PKG_MGR" = "bun" ]; then
    PORT=3002 bun run dev &
else
    PORT=3002 node_modules/.bin/next dev -p 3002 &
fi
FRONTEND_PID=$!

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${GREEN}  Ambient Studio is running${RESET}"
echo -e "${GREEN}  Frontend  →  http://localhost:3002${RESET}"
echo -e "${GREEN}  Backend   →  http://localhost:3003${RESET}"
echo -e "${GREEN}  API docs  →  http://localhost:3003/docs${RESET}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "  Press ${YELLOW}Ctrl+C${RESET} to stop both servers"
echo ""

# Wait for both processes
wait $BACKEND_PID $FRONTEND_PID

