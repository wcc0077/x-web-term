# 终端会话管理设计方案

## 目标

1. 前端断开连接时，后端终端继续运行
2. 前端重连后，原样恢复终端屏幕内容和编辑状态
3. 使用 tmux 管理后端进程，使用 script 记录会话

## 架构设计

### 核心组件

```
┌─────────────────────────────────────────────────────────────────┐
│                         前端 (Browser)                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐ │
│  │ xterm.js    │  │ Session     │  │ LocalStorage/IndexedDB  │ │
│  │ Terminal UI │  │ Manager     │  │ - terminalSessions      │ │
│  │             │  │ - reconnect │  │ - screenSnapshots       │ │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                            │
                            │ Socket.IO (with auto-reconnect)
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                       后端 (Node.js Server)                      │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐ │
│  │ Socket.IO   │  │ Script      │  │ TmuxManager             │ │
│  │ Handler     │  │ Manager     │  │ - session lifecycle     │ │
│  │ - auth      │  │ - script    │  │ - pane capture          │ │
│  │ - events    │  │   wrapper   │  │ - input/output          │ │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘ │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │  tmux Server (socket: /tmp/tmux-multi-terminal.sock)        ││
│  │  ┌─────────────┐ ┌─────────────┐ ┌─────────────────────┐   ││
│  │  │ admin-sess1 │ │ admin-sess2 │ │ guest-sess1         │   ││
│  │  │ ┌─────────┐ │ │ ┌─────────┐ │ │ ┌─────────────────┐ │   ││
│  │  │ │ pane 0  │ │ │ │ pane 0  │ │ │ │ pane 0, 1, 2    │ │   ││
│  │  │ └─────────┘ │ │ └─────────┘ │ │ └─────────────────┘ │   ││
│  │  └─────────────┘ └─────────────┘ └─────────────────────┘   ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

## 数据结构

### 后端会话存储

```javascript
// server.js - 会话映射
const sessionRegistry = new Map();
// sessionId -> SessionEntry
// {
//   sessionId: string,
//   tmuxSessionName: string,
//   username: string,
//   scriptProcess: ChildProcess | null,
//   ptyProcess: any,
//   cols: number,
//   rows: number,
//   cwd: string,
//   shell: string,
//   createdAt: number,
//   lastActivity: number,
//   lastDisconnect: number | null,
//   screenContent: string,
//   status: 'attached' | 'detached' | 'running'
// }
```

### 前端会话缓存

```javascript
// app.js - LocalStorage 结构
{
  "mt_terminal_sessions": {
    "admin-1709888000-abc": {
      "termId": "admin-1709888000-abc",
      "tmuxSessionName": "admin_1709888000_abc",
      "cols": 80,
      "rows": 24,
      "shell": "bash",
      "createdAt": 1709888000000,
      "lastScreenContent": "...",
      "lastSyncAt": 1709888100000
    }
  }
}
```

## 实现细节

### 1. Script 管理器 (script-manager.js)

```javascript
/**
 * Script 会话管理器
 * 使用 script 命令包装 tmux 会话，提供完整的会话记录
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

class ScriptManager {
  constructor(baseDir = '/tmp/script-sessions') {
    this.baseDir = baseDir;
    this.sessions = new Map(); // scriptId -> script session info
    this.ensureBaseDir();
  }

  ensureBaseDir() {
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  /**
   * 启动 script 包装的 tmux 会话
   */
  async startScriptSession(sessionId, tmuxSessionName, username) {
    const logFile = path.join(this.baseDir, `${sessionId}.log`);
    const scriptId = sessionId;

    return new Promise((resolve, reject) => {
      // script -q -f logfile -c "tmux attach -t tmuxSessionName"
      const scriptProcess = spawn('script', [
        '-q',           // 不输出启动信息
        '-f', logFile,  // 输出到文件
        '-c', `tmux attach -t ${tmuxSessionName}`
      ], {
        env: { ...process.env, TERM: 'xterm-256color' },
        stdio: ['pipe', 'pipe', 'pipe']
      });

      scriptProcess.on('spawn', () => {
        this.sessions.set(scriptId, {
          scriptId,
          sessionId,
          tmuxSessionName,
          username,
          logFile,
          pid: scriptProcess.pid,
          process: scriptProcess,
          startedAt: Date.now()
        });
        resolve({ scriptId, pid: scriptProcess.pid });
      });

      scriptProcess.on('error', reject);
      scriptProcess.stderr.on('data', (data) => {
        console.error(`script stderr: ${data}`);
      });
    });
  }

  /**
   * 获取 script 会话信息
   */
  getSession(scriptId) {
    return this.sessions.get(scriptId);
  }

  /**
   * 停止 script 会话
   */
  async stopScriptSession(scriptId) {
    const session = this.sessions.get(scriptId);
    if (!session) return false;

    return new Promise((resolve) => {
      if (session.process) {
        session.process.kill('SIGTERM');
        setTimeout(() => {
          this.sessions.delete(scriptId);
          resolve(true);
        }, 100);
      } else {
        this.sessions.delete(scriptId);
        resolve(true);
      }
    });
  }

  /**
   * 获取日志文件内容（用于恢复）
   */
  getSessionLog(scriptId) {
    const session = this.sessions.get(scriptId);
    if (!session) return null;

    try {
      if (fs.existsSync(session.logFile)) {
        return fs.readFileSync(session.logFile, 'utf-8');
      }
    } catch (e) {
      console.error('Failed to read session log:', e.message);
    }
    return null;
  }

  /**
   * 清理日志文件
   */
  cleanupLog(scriptId) {
    const session = this.sessions.get(scriptId);
    if (session && fs.existsSync(session.logFile)) {
      fs.unlinkSync(session.logFile);
    }
  }
}

module.exports = ScriptManager;
```

### 2. 后端服务器改动 (server.js)

```javascript
// ============ Socket.IO 连接处理 ============

// 维护一个全局的会话注册表
const sessionRegistry = new Map();
// sessionId -> { sessionId, tmuxSessionName, username, scriptProcess, ptyProcess, ... }

// 重连窗口（毫秒）- 在此时间内重连可以恢复会话
const RECONNECT_WINDOW = 30 * 60 * 1000; // 30 分钟

io.on('connection', async (socket) => {
  console.log(`\n===== Client connected: ${socket.id} (user: ${socket.user?.username}) =====`);

  const username = socket.user.username;

  // 步骤 1: 获取用户的所有 tmux 会话（从 tmux server 查询）
  const tmuxSessions = await terminalManager.tmuxManager.listSessions(username);

  // 步骤 2: 检查是否有断开的会话需要恢复
  const sessionsToRestore = [];

  for (const tmuxSession of tmuxSessions) {
    // 查找是否有对应的 script 会话
    const existingEntry = sessionRegistry.get(tmuxSession.id);

    if (existingEntry) {
      // 会话已存在，直接附加
      sessionsToRestore.push({
        ...existingEntry,
        status: 'restored'
      });
    } else {
      // 从 tmux server 恢复的会话（服务器重启场景）
      const restoredEntry = {
        sessionId: tmuxSession.id,
        tmuxSessionName: tmuxSession.tmuxSessionName,
        username,
        cols: tmuxSession.cols,
        rows: tmuxSession.rows,
        shell: tmuxSession.shell || 'bash',
        cwd: os.homedir(),
        createdAt: tmuxSession.createdAt,
        lastActivity: Date.now(),
        lastDisconnect: null,
        screenContent: '',
        status: 'detached',
        ptyProcess: null,
        scriptProcess: null
      };
      sessionRegistry.set(tmuxSession.id, restoredEntry);
      sessionsToRestore.push(restoredEntry);
    }
  }

  // 步骤 3: 通知前端有可恢复的会话
  for (const session of sessionsToRestore) {
    // 捕获当前屏幕内容
    const screenContent = await terminalManager.captureTmuxPane(session.sessionId, 100);
    session.screenContent = screenContent;

    socket.emit('terminal:session-available', {
      termId: session.sessionId,
      tmuxSessionName: session.tmuxSessionName,
      cols: session.cols,
      rows: session.rows,
      shell: session.shell,
      createdAt: session.createdAt,
      screenContent: screenContent,
      type: 'tmux'
    });
  }

  // ... 其他事件处理
});
```

### 3. 前端会话管理器 (app.js)

```javascript
// ============ 会话管理器 ============

class SessionManager {
  constructor() {
    this.storageKey = 'mt_terminal_sessions';
    this.sessions = this.loadSessions();
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelays = [1000, 2000, 4000, 8000, 15000, 15000, 15000, 15000, 15000, 15000];
  }

  loadSessions() {
    try {
      const data = localStorage.getItem(this.storageKey);
      return data ? JSON.parse(data) : {};
    } catch (e) {
      console.error('Failed to load sessions:', e);
      return {};
    }
  }

  saveSessions() {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(this.sessions));
    } catch (e) {
      console.error('Failed to save sessions:', e);
    }
  }

  /**
   * 保存会话信息
   */
  saveSession(termId, sessionData) {
    this.sessions[termId] = {
      ...this.sessions[termId],
      ...sessionData,
      lastSyncAt: Date.now()
    };
    this.saveSessions();
  }

  /**
   * 获取保存的会话
   */
  getSession(termId) {
    return this.sessions[termId] || null;
  }

  /**
   * 获取所有会话
   */
  getAllSessions() {
    return { ...this.sessions };
  }

  /**
   * 移除会话
   */
  removeSession(termId) {
    delete this.sessions[termId];
    this.saveSessions();
  }

  /**
   * 清除所有会话
   */
  clearAllSessions() {
    this.sessions = {};
    this.saveSessions();
  }

  /**
   * 计算重连延迟
   */
  getNextReconnectDelay() {
    const delay = this.reconnectDelays[this.reconnectAttempts] || 15000;
    this.reconnectAttempts = Math.min(this.reconnectAttempts + 1, this.maxReconnectAttempts);
    return delay;
  }

  /**
   * 重置重连计数
   */
  resetReconnectCount() {
    this.reconnectAttempts = 0;
  }

  /**
   * 同步终端屏幕内容
   */
  async syncScreenContent(termId, xterm) {
    if (!xterm) return;

    try {
      // 使用 serialize 插件获取屏幕内容
      if (xterm.serialize) {
        const content = xterm.serialize({
          scrollback: 0,
          maxLines: xterm.rows
        });
        this.saveSession(termId, { lastScreenContent: content });
      }
    } catch (e) {
      console.error('Failed to sync screen content:', e);
    }
  }
}

// 全局会话管理器
const sessionManager = new SessionManager();
```

### 4. 前端重连逻辑

```javascript
// ============ Socket.IO 初始化（带重连） ============

function initSocket() {
  const token = getToken();
  if (!token) {
    logout();
    return;
  }

  state.socket = io(CONFIG.serverUrl, {
    transports: ['websocket', 'polling'],
    auth: { token },
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 15000,
    randomizationFactor: 0.5
  });

  // 连接成功
  state.socket.on('connect', () => {
    console.log('Connected to server');
    updateConnectionStatus(true);
    sessionManager.resetReconnectCount();
    showToast('已连接到服务器', 'success');

    // 恢复本地缓存的会话
    restoreLocalSessions();
  });

  // 即将重连
  state.socket.on('reconnect_attempt', (attemptNumber) => {
    console.log(`Reconnect attempt ${attemptNumber}`);
    showToast(`正在重连 (${attemptNumber}/10)...`, 'info');
  });

  // 重连失败
  state.socket.on('reconnect_failed', () => {
    console.error('Reconnect failed');
    updateConnectionStatus(false);
    showToast('重连失败，请刷新页面', 'error');
  });

  // 断开连接
  state.socket.on('disconnect', (reason) => {
    console.log('Disconnected from server:', reason);
    updateConnectionStatus(false);

    if (reason === 'io server disconnect') {
      // 服务器主动断开，需要重连
      state.socket.connect();
    }

    // 保存所有终端的屏幕内容到本地缓存
    for (const [termId, terminal] of state.terminals.entries()) {
      sessionManager.syncScreenContent(termId, terminal.xterm);
    }

    showToast('与服务器的连接已断开，尝试重连...', 'error');
  });

  // 可恢复的会话
  state.socket.on('terminal:session-available', ({ termId, tmuxSessionName, screenContent, ...data }) => {
    console.log(`[SESSION AVAILABLE] ${tmuxSessionName}`);

    // 更新本地缓存
    sessionManager.saveSession(termId, {
      tmuxSessionName,
      lastScreenContent: screenContent,
      ...data
    });

    // 通知用户有会话可恢复
    showSessionRestoreNotification(termId, tmuxSessionName, screenContent);
  });

  // ... 其他事件处理
}

/**
 * 恢复本地缓存的会话
 */
function restoreLocalSessions() {
  const savedSessions = sessionManager.getAllSessions();
  const sessionIds = Object.keys(savedSessions);

  if (sessionIds.length === 0) return;

  console.log(`Found ${sessionIds.length} saved sessions to restore`);

  // 向服务器请求恢复会话
  state.socket.emit('terminal:restore-sessions', {
    sessionIds
  });
}

/**
 * 显示会话恢复通知
 */
function showSessionRestoreNotification(termId, tmuxSessionName, screenContent) {
  // 创建一个可点击的通知
  const notification = document.createElement('div');
  notification.className = 'toast toast-info session-restore';
  notification.innerHTML = `
    <div>
      <strong>发现断开的终端会话</strong>
      <p style="font-size:12px;margin:4px 0 0;color:#8b949e">
        ${tmuxSessionName}
      </p>
      <button class="btn btn-small btn-primary" style="margin-top:8px" onclick="restoreSession('${termId}')">
        恢复会话
      </button>
    </div>
  `;
  elements.toastContainer.appendChild(notification);

  // 5 秒后自动移除
  setTimeout(() => {
    notification.style.opacity = '0';
    setTimeout(() => notification.remove(), 300);
  }, 10000);
}

/**
 * 恢复会话（全局函数）
 */
window.restoreSession = function(termId) {
  const savedSession = sessionManager.getSession(termId);
  if (!savedSession) {
    showToast('会话不存在', 'error');
    return;
  }

  console.log(`Restoring session: ${termId}`);

  // 通知服务器附加到此会话
  state.socket.emit('terminal:attach', {
    termId,
    tmuxSessionName: savedSession.tmuxSessionName
  });

  // 移除通知
  document.querySelectorAll('.session-restore').forEach(el => el.remove());
};
```

### 5. 定时同步机制

```javascript
// ============ 定时同步 ============

const AUTO_SYNC_INTERVAL = 5000; // 5 秒同步一次
let autoSyncTimer = null;

/**
 * 启动定时同步
 */
function startAutoSync() {
  if (autoSyncTimer) return;

  autoSyncTimer = setInterval(() => {
    for (const [termId, terminal] of state.terminals.entries()) {
      // 同步到服务器
      syncTerminalScreen(termId);
      // 同步到本地缓存
      sessionManager.syncScreenContent(termId, terminal.xterm);
    }
  }, AUTO_SYNC_INTERVAL);

  console.log('Auto-sync started');
}

/**
 * 停止定时同步
 */
function stopAutoSync() {
  if (autoSyncTimer) {
    clearInterval(autoSyncTimer);
    autoSyncTimer = null;
  }
}

/**
 * 同步终端屏幕到服务器
 */
function syncTerminalScreen(termId) {
  const terminal = findTerminalByTermId(termId);
  if (!terminal || !state.connected) return;

  try {
    if (terminal.xterm.serialize) {
      const content = terminal.xterm.serialize({
        scrollback: 0,
        maxLines: terminal.xterm.rows
      });
      state.socket.emit('terminal:sync', { termId, screenContent: content });
    }
  } catch (e) {
    console.error('Failed to sync terminal:', e);
  }
}

// 在创建终端时启动同步
// 在页面卸载前执行一次同步
window.addEventListener('beforeunload', () => {
  if (state.socket && state.connected) {
    for (const [termId, terminal] of state.terminals.entries()) {
      syncTerminalScreen(termId);
    }
  }
});
```

## 会话恢复流程

```
时间线:
t0: 用户创建终端
    → 后端创建 tmux 会话 (admin_session_001)
    → 后端启动 script 包装
    → 前端显示终端，绑定输入输出
    → 定时同步屏幕内容

t1: 前端网络断开
    → socket.on('disconnect') 触发
    → 前端保存当前屏幕到 IndexedDB
    → 启动重连逻辑

t2: 后端检测到 socket 断开
    → 不杀 tmux 会话
    → 记录 lastDisconnect 时间
    → tmux 会话继续运行，进程继续输出

t3: 前端重连成功
    → socket.on('connect') 触发
    → 后端查询 tmux server 获取用户会话
    → 发送 terminal:session-available 事件

t4: 前端收到可恢复会话
    → 显示恢复通知
    → 用户点击"恢复"
    → 前端创建 xterm 实例
    → 发送 terminal:attach 请求

t5: 后端处理 attach
    → 查找 tmux 会话
    → 使用 tmux capture-pane 获取屏幕
    → 发送屏幕内容给前端

t6: 前端渲染屏幕
    → xterm.write(screenContent)
    → 绑定输入输出事件
    → 恢复完成，用户继续编辑
```

## 配置文件

### .env 示例

```bash
PORT=3000
JWT_SECRET=your-secret-change-in-production
USERS=[{"username":"admin","password":"$2a$10$..."}]

# Tmux 配置
TMUX_SOCKET_FILE=/tmp/tmux-multi-terminal.sock

# 会话配置
SESSION_TIMEOUT_MS=1800000
# 30 分钟，超时后会话被清理

# Script 配置
SCRIPT_LOG_DIR=/tmp/script-sessions
```

### tmux.conf 推荐配置

```bash
# ~/.tmux.conf 或项目专用配置

# 终端颜色
set -g default-terminal "xterm-256color"

# 鼠标支持
set -g mouse on

# 历史滚动
set -g history-limit 10000

# 前缀键 (默认 Ctrl+b)
# set -g prefix C-a

# 自动重命名窗口
set-option -g automatic-rename on

# 窗口自动监控活动
set-window-option -g monitor-activity on
set-window-option -g window-status-activity-style fg=yellow
```

## 部署脚本

```bash
#!/bin/bash
# deploy.sh - 部署脚本

# 检查 tmux
if ! command -v tmux &> /dev/null; then
    echo "tmux not found, installing..."
    apt-get update && apt-get install -y tmux
fi

# 检查 script (util-linux)
if ! command -v script &> /dev/null; then
    echo "script not found, installing util-linux..."
    apt-get update && apt-get install -y util-linux
fi

# 创建必要的目录
mkdir -p /tmp/script-sessions
mkdir -p /tmp/tmux-sessions

# 启动服务
npm install
npm start
```

## 测试场景

1. **正常断开重连**
   - 创建终端，执行 `top`
   - 关闭浏览器标签
   - 重新打开，点击恢复
   - 验证 `top` 仍在运行

2. **网络故障模拟**
   - 创建终端，执行 `ping 8.8.8.8`
   - 禁用网络适配器
   - 等待 10 秒
   - 启用网络适配器
   - 验证自动重连和恢复

3. **多终端恢复**
   - 创建 3 个终端，分别执行不同命令
   - 关闭浏览器
   - 重新打开
   - 验证所有 3 个终端都可恢复

4. **服务器重启**
   - 创建终端，执行长运行命令
   - 重启 Node.js 服务器
   - 前端重新连接
   - 验证 tmux 会话仍存在，可恢复

## 注意事项

1. **安全性**: script 日志可能包含敏感信息，定期清理
2. **性能**: 大量会话时，定时同步可能影响性能，考虑增量同步
3. **存储**: 本地缓存使用 IndexedDB 而非 localStorage 处理大数据
4. **超时**: 设置合理的会话超时时间，避免资源泄漏
