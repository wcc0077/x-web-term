# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start          # Start server on port 3000
npm run dev        # Start with nodemon for development
npm install        # Install dependencies (requires native build for node-pty)
```

Windows requires native build tools for node-pty:
```bash
npm install --global windows-build-tools
```

## Architecture Overview

This is a web-based multi-terminal manager built with:

**Backend** (`server.js`):
- Express server serving static files and REST API
- Socket.IO for real-time bidirectional terminal communication
- node-pty for spawning pseudo-terminals
- JWT + bcrypt for authentication

**Frontend** (`public/`):
- `index.html` - Main terminal UI with GitHub-style dark theme
- `login.html` - Login page with JWT token storage in localStorage
- `app.js` - Terminal application logic using xterm.js

**Terminal Flow**:
1. User creates terminal via UI button or `Ctrl+Shift+T`
2. Frontend emits `terminal:create` Socket.IO event
3. Backend spawns PTY process via `TerminalManager.create()`
4. Backend emits `terminal:created` with `termId`
5. Frontend binds xterm.js to PTY via `terminal:input`/`terminal:data` events

**Socket.IO Events**:

| Client → Server | Server → Client |
|-----------------|-----------------|
| `terminal:create` | `terminal:created` |
| `terminal:input` | `terminal:data` |
| `terminal:resize` | `terminal:exit` |
| `terminal:kill` | `terminal:killed` |
| `terminal:list` | `terminal:list` |
| | `terminal:error` |

**REST API**:
- `POST /api/login` - JWT token authentication
- `GET /api/verify` - Verify token validity
- `POST /api/logout` - Logout endpoint
- `POST /api/change-password` - Password change
- `GET /api/stats` - Terminal statistics (auth required)
- `GET /health` - Health check endpoint

**Configuration** (via environment variables):
- `PORT` (default: 3000)
- `JWT_SECRET` (default: insecure string, must change in production)
- `USERS` - JSON array of `{username, password}` objects
- `NODE_ENV` - Controls production mode

**Deployment**:
- `deploy.sh` - Auto-deployment script for Linux (Ubuntu/Debian/CentOS)
- `docker-compose.yml` - Docker Compose configuration
- `Dockerfile` - Builds from node:18-slim with native build tools
- PM2 used for process management in production

**Keyboard Shortcuts**:
- `Ctrl+Shift+T` - New terminal
- `Ctrl+W` - Close current terminal
- `Ctrl+Tab` - Switch to next terminal
