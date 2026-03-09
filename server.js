const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const pty = require('node-pty');
const os = require('os');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const TmuxManager = require('./tmux-manager');

// Windows 上启用 ANSI 转义序列支持
if (process.platform === 'win32') {
  try {
    const cp = require('child_process');
    // 使用 PowerShell 启用 Virtual Terminal Processing
    cp.execSync('reg add "HKCU\\Console" /v VirtualTerminalLevel /t REG_DWORD /d 1 /f', { stdio: 'ignore' });
    console.log('ANSI escape sequences enabled for Windows');
  } catch (e) {
    console.log('Could not enable ANSI support:', e.message);
  }
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// 中间件
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
// 提供 node_modules 静态文件
app.use('/libs', express.static(path.join(__dirname, 'node_modules')));

// 终端会话存储目录
const SESSIONS_DIR = path.join(__dirname, 'terminal-sessions');
if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// 配置
const JWT_SECRET = process.env.JWT_SECRET || 'multi-terminal-secret-change-in-production';
const TOKEN_EXPIRE = '24h';

// 用户数据 (生产环境应使用数据库)
// 可以通过环境变量配置：USERS=[{"username":"admin","password":"hashed_password"}]
const DEFAULT_USERS = [
  { username: 'admin', password: '$2a$10$rQZ9QxZ9QxZ9QxZ9QxZ9Qe' } // 默认密码：admin123
];

// 初始化用户
let users = [];
async function initUsers() {
  if (process.env.USERS) {
    try {
      users = JSON.parse(process.env.USERS);
    } catch (e) {
      console.error('Failed to parse USERS env:', e.message);
    }
  }

  // 如果没有用户，创建默认用户
  if (users.length === 0) {
    const hashedPassword = await bcrypt.hash('admin123', 10);
    users = [{ username: 'admin', password: hashedPassword }];
    console.log('\n  ⚠️  默认用户已创建：admin / admin123');
    console.log('  ⚠️  请通过环境变量 USERS 配置生产用户!\n');
  }
}

// JWT 验证中间件
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: '未提供认证令牌' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: '令牌无效或已过期' });
  }
}

// ============ 认证 API ============

// 登录
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: '用户名和密码不能为空' });
  }

  const user = users.find(u => u.username === username);

  if (!user) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }

  const isValid = await bcrypt.compare(password, user.password);

  if (!isValid) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }

  // 生成 JWT
  const token = jwt.sign(
    { username: user.username },
    JWT_SECRET,
    { expiresIn: TOKEN_EXPIRE }
  );

  res.json({
    success: true,
    token,
    user: { username: user.username }
  });
});

// 验证 Token
app.get('/api/verify', authMiddleware, (req, res) => {
  res.json({ valid: true, user: req.user });
});

// 登出 (客户端清除 Token 即可)
app.post('/api/logout', (req, res) => {
  res.json({ success: true });
});

// 修改密码
app.post('/api/change-password', authMiddleware, async (req, res) => {
  const { oldPassword, newPassword } = req.body;

  if (!oldPassword || !newPassword) {
    return res.status(400).json({ error: '旧密码和新密码不能为空' });
  }

  if (newPassword.length < 6) {
    return res.status(400).json({ error: '新密码长度至少 6 位' });
  }

  const user = users.find(u => u.username === req.user.username);

  if (!user) {
    return res.status(404).json({ error: '用户不存在' });
  }

  const isValid = await bcrypt.compare(oldPassword, user.password);

  if (!isValid) {
    return res.status(401).json({ error: '旧密码错误' });
  }

  user.password = await bcrypt.hash(newPassword, 10);

  res.json({ success: true, message: '密码修改成功' });
});

// 受保护的 REST API
app.get('/api/stats', authMiddleware, (req, res) => {
  res.json(terminalManager.stats());
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============ 混合终端管理器 (Tmux + node-pty) ============

class HybridTerminalManager {
  constructor() {
    this.tmuxManager = new TmuxManager();
    // 回退到 node-pty 的终端存储
    this.ptyTerminals = new Map();
    this.userPtySessions = new Map();

    // 输出处理器存储
    this.outputHandlers = new Map();

    // tmux 会话到 pty 的映射（避免为同一个 tmux 会话创建多个 pty）
    this.tmuxToPty = new Map(); // tmuxSessionName -> { pty, sockets: Set }
  }

  /**
   * 判断是否使用 tmux
   */
  useTmux() {
    return this.tmuxManager.available;
  }

  /**
   * 创建终端
   */
  async createTerminal(socketId, username, options = {}) {
    if (this.useTmux()) {
      try {
        // 使用 node-pty 连接到 tmux 会话
        // 这样可以正确处理终端输出流
        const sessionInfo = await this.tmuxManager.getOrCreateSession(username, options);

        // 使用 node-pty attach 到 tmux 会话
        // 使用 -d 参数分离其他客户端
        const ptyProcess = pty.spawn('tmux', ['attach', '-d', '-t', sessionInfo.tmuxSessionName], {
          name: 'xterm-256color',
          cols: options.cols || 80,
          rows: options.rows || 24,
          cwd: options.cwd || os.homedir(),
          env: {
            ...process.env,
            TERM: 'xterm-256color'
          }
        });

        const terminal = {
          id: sessionInfo.sessionId,
          pty: ptyProcess,
          tmuxSessionName: sessionInfo.tmuxSessionName,
          socketId,
          username,
          cols: options.cols || 80,
          rows: options.rows || 24,
          shell: 'tmux',
          cwd: options.cwd || os.homedir(),
          createdAt: sessionInfo.createdAt,
          lastActivity: Date.now(),
          screenContent: '',
          type: 'tmux-pty'  // 使用 pty 连接 tmux
        };

        // 添加到用户会话
        if (!this.userPtySessions.has(username)) {
          this.userPtySessions.set(username, new Set());
        }
        this.userPtySessions.get(username).add(terminal.id);

        this.ptyTerminals.set(terminal.id, terminal);
        console.log(`Tmux-PTY terminal created: ${terminal.id} (tmux: ${sessionInfo.tmuxSessionName})`);
        return terminal;
      } catch (error) {
        console.error('Failed to create tmux session, falling back to pty:', error.message);
        console.error('Error stack:', error.stack);
        // 回退到 node-pty
        return this.createPtyTerminal(socketId, username, options);
      }
    } else {
      return this.createPtyTerminal(socketId, username, options);
    }
  }

  /**
   * 创建 node-pty 终端（回退方案）
   */
  createPtyTerminal(socketId, username, options = {}) {
    const {
      cols = 80,
      rows = 24,
      cwd = os.homedir(),
      shell = process.platform === 'win32' ? 'powershell.exe' : 'bash'
    } = options;

    const termId = `${username}-pty-${Date.now()}`;

    try {
      // Windows PowerShell 需要特殊处理以支持 ANSI 转义序列
      const ptyProcess = pty.spawn(shell, shell === 'powershell.exe' ? ['-NoProfile', '-ExecutionPolicy', 'Bypass'] : [], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor'
        }
      });

      const terminal = {
        id: termId,
        pty: ptyProcess,
        socketId,
        username,
        cols,
        rows,
        shell,
        cwd,
        createdAt: Date.now(),
        lastActivity: Date.now(),
        screenContent: '',
        type: 'pty'
      };

      // 添加到用户会话
      if (!this.userPtySessions.has(username)) {
        this.userPtySessions.set(username, new Set());
      }
      this.userPtySessions.get(username).add(termId);

      this.ptyTerminals.set(termId, terminal);
      console.log(`PTY terminal created: ${termId}`);
      return terminal;
    } catch (error) {
      throw error;
    }
  }

  /**
   * 为 PTY 终端绑定输出处理器
   */
  attachPtyOutputHandler(termId, socket) {
    const term = this.ptyTerminals.get(termId);
    if (!term) return;

    // 移除旧的监听器（如果存在）
    if (term.outputHandler) {
      term.pty.removeListener('data', term.outputHandler);
    }

    const handler = (data) => {
      term.screenContent += data;
      if (term.screenContent.length > 50000) {
        term.screenContent = term.screenContent.slice(-50000);
      }
      // 直接发送原始数据，让 xterm.js 处理
      socket.emit('terminal:data', {
        termId: term.id,
        data
      });
    };

    term.pty.on('data', handler);
    term.outputHandler = handler;
    term.socketId = socket.id;
  }

  /**
   * 获取用户的所有终端（tmux + pty）
   */
  async getSessionsByUsername(username) {
    const sessions = [];

    // 获取 tmux 会话
    if (this.useTmux()) {
      const tmuxSessions = await this.tmuxManager.listSessions(username);
      for (const session of tmuxSessions) {
        sessions.push({
          ...session,
          type: 'tmux',
          screenContent: '' // tmux 会话需要单独 capture
        });
      }
    }

    // 获取 node-pty 会话
    const ptySessionIds = this.userPtySessions.get(username);
    if (ptySessionIds) {
      for (const termId of ptySessionIds) {
        const term = this.ptyTerminals.get(termId);
        if (term) {
          sessions.push({
            id: term.id,
            cols: term.cols,
            rows: term.rows,
            shell: term.shell,
            createdAt: term.createdAt,
            lastActivity: term.lastActivity,
            screenContent: term.screenContent,
            type: 'pty'
          });
        }
      }
    }

    return sessions;
  }

  /**
   * 附加到 tmux 会话
   */
  async attachSession(sessionId, socketId) {
    if (this.useTmux()) {
      return await this.tmuxManager.attachSession(sessionId, socketId);
    }
    return false;
  }

  /**
   * 从 tmux 捕获屏幕内容
   */
  async captureTmuxPane(sessionId, lines = 100) {
    if (this.useTmux()) {
      return await this.tmuxManager.capturePane(sessionId, lines);
    }
    return '';
  }

  /**
   * 发送输入到终端
   */
  async write(termId, data, type = 'auto') {
    if (type === 'tmux' || (type === 'auto' && this.useTmux())) {
      // 检查是否是 tmux 会话
      const session = this.tmuxManager.getSession(termId);
      if (session) {
        return await this.tmuxManager.sendInput(termId, data);
      }
    }

    // 回退到 node-pty
    const term = this.ptyTerminals.get(termId);
    if (term) {
      term.lastActivity = Date.now();
      term.pty.write(data);
      return true;
    }
    return false;
  }

  /**
   * 调整终端大小
   */
  async resize(termId, cols, rows, type = 'auto') {
    if (type === 'tmux' || (type === 'auto' && this.useTmux())) {
      const session = this.tmuxManager.getSession(termId);
      if (session) {
        return await this.tmuxManager.resize(termId, cols, rows);
      }
    }

    const term = this.ptyTerminals.get(termId);
    if (term) {
      try {
        term.pty.resize(cols, rows);
        term.cols = cols;
        term.rows = rows;
        return true;
      } catch (e) {
        console.error('Resize error:', e.message);
        return false;
      }
    }
    return false;
  }

  /**
   * 杀死终端
   */
  async kill(termId, type = 'auto') {
    if (type === 'tmux' || (type === 'auto' && this.useTmux())) {
      const killed = await this.tmuxManager.killSession(termId);
      if (killed) return true;
    }

    const term = this.ptyTerminals.get(termId);
    if (term) {
      try {
        term.pty.kill();
      } catch (e) {}
      this.removePtyTerminal(termId);
      return true;
    }
    return false;
  }

  /**
   * 移除 node-pty 终端
   */
  removePtyTerminal(termId) {
    const term = this.ptyTerminals.get(termId);
    if (term) {
      const userSessions = this.userPtySessions.get(term.username);
      if (userSessions) {
        userSessions.delete(termId);
        if (userSessions.size === 0) {
          this.userPtySessions.delete(term.username);
        }
      }
      this.ptyTerminals.delete(termId);
    }
  }

  /**
   * 获取终端信息
   */
  get(termId) {
    return this.ptyTerminals.get(termId) || this.tmuxManager.getSession(termId);
  }

  /**
   * 统计信息
   */
  stats() {
    return {
      tmuxAvailable: this.tmuxManager.available,
      tmuxSessions: this.tmuxManager.sessions.size,
      ptyTerminals: this.ptyTerminals.size,
      total: this.tmuxManager.sessions.size + this.ptyTerminals.size
    };
  }

  /**
   * Graceful shutdown
   */
  shutdown() {
    console.log('HybridTerminalManager shutting down...');
    this.tmuxManager.shutdown();
    // 保持 PTY 运行，不主动 kill
  }
}

const terminalManager = new HybridTerminalManager();

// ============ Socket.IO 认证 ============

io.use((socket, next) => {
  const token = socket.handshake.auth.token || socket.handshake.query.token;

  if (!token) {
    return next(new Error('未认证'));
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.user = decoded;
    next();
  } catch (err) {
    next(new Error('令牌无效'));
  }
});

// Socket.IO 连接处理
io.on('connection', async (socket) => {
  console.log(`\n===== Client connected: ${socket.id} (user: ${socket.user?.username}) =====`);
  console.log(`Tmux available: ${terminalManager.useTmux()}`);

  // 恢复用户的终端会话（tmux 会话在后台运行，不需要恢复，直接重连即可）
  const savedSessions = await terminalManager.getSessionsByUsername(socket.user.username);
  console.log(`getSessionsByUsername returned ${savedSessions.length} sessions`);

  if (savedSessions.length > 0) {
    console.log(`Found ${savedSessions.length} saved sessions for user ${socket.user.username}`);

    // 对于 tmux 会话，我们通知前端有哪些会话可以恢复
    for (const session of savedSessions) {
      if (session.type === 'tmux') {
        // 发送会话信息给前端，让前端用户可以点击恢复
        socket.emit('terminal:session-available', {
          termId: session.id,
          tmuxSessionName: session.tmuxSessionName,
          cols: session.cols,
          rows: session.rows,
          shell: session.shell,
          createdAt: session.createdAt,
          type: 'tmux'
        });
        console.log(`Notified frontend of available tmux session: ${session.id}`);
      } else {
        // node-pty 会话 - 直接附加
        terminalManager.attachPtyOutputHandler(session.id, socket);
        socket.emit('terminal:restored', {
          termId: session.id,
          cols: session.cols,
          rows: session.rows,
          shell: session.shell,
          createdAt: session.createdAt,
          screenContent: session.screenContent,
          type: session.type
        });
      }
    }

    console.log(`Notified frontend of ${savedSessions.length} available sessions`);
  } else {
    console.log(`No saved sessions found for user ${socket.user.username}`);
  }
  console.log('===== Connection handling complete =====\n');

  // 创建新终端
  socket.on('terminal:create', async (options = {}) => {
    try {
      const terminal = await terminalManager.createTerminal(socket.id, socket.user.username, options);

      if (terminal.type === 'tmux') {
        console.log(`Tmux terminal created: ${terminal.id}`);

        // 捕获初始屏幕内容
        const screenContent = await terminalManager.captureTmuxPane(terminal.id, 50);

        socket.emit('terminal:created', {
          termId: terminal.id,
          cols: terminal.cols,
          rows: terminal.rows,
          type: 'tmux',
          screenContent
        });
      } else {
        console.log(`PTY terminal created: ${terminal.id}`);

        // 绑定输出处理器
        terminalManager.attachPtyOutputHandler(terminal.id, socket);

        // 设置退出处理器
        terminal.pty.onExit(({ exitCode, signal }) => {
          socket.emit('terminal:exit', {
            termId: terminal.id,
            exitCode,
            signal
          });
          terminalManager.removePtyTerminal(terminal.id);
        });

        socket.emit('terminal:created', {
          termId: terminal.id,
          cols: terminal.cols,
          rows: terminal.rows,
          type: 'pty'
        });
      }
    } catch (error) {
      socket.emit('terminal:error', {
        message: `Failed to create terminal: ${error.message}`
      });
    }
  });

  // 终端输入
  socket.on('terminal:input', async ({ termId, data }) => {
    await terminalManager.write(termId, data);
  });

  // 终端大小调整
  socket.on('terminal:resize', async ({ termId, cols, rows }) => {
    await terminalManager.resize(termId, cols, rows);
  });

  // 杀死终端
  socket.on('terminal:kill', async ({ termId }) => {
    const killed = await terminalManager.kill(termId);
    if (killed) {
      socket.emit('terminal:killed', { termId });
      console.log(`Terminal killed: ${termId}`);
    }
  });

  // 列出终端
  socket.on('terminal:list', async () => {
    const list = await terminalManager.getSessionsByUsername(socket.user.username);
    socket.emit('terminal:list', list);
  });

  // 附加到现有的 tmux 会话
  socket.on('terminal:attach', async ({ termId, tmuxSessionName }) => {
    try {
      console.log(`Attaching to tmux session: ${tmuxSessionName}`);

      // 检查是否已存在该 tmux 会话的 pty 连接
      let ptyProcess = null;
      let existingMapping = terminalManager.tmuxToPty.get(tmuxSessionName);

      if (existingMapping) {
        // 复用现有的 pty 连接
        console.log(`Reusing existing pty for tmux session: ${tmuxSessionName}`);
        ptyProcess = existingMapping.pty;
        existingMapping.sockets.add(socket.id);
      } else {
        // 创建新的 pty 连接
        ptyProcess = pty.spawn('tmux', ['attach-session', '-d', '-t', tmuxSessionName], {
          name: 'xterm-256color',
          cols: 80,
          rows: 24,
          env: {
            ...process.env,
            TERM: 'xterm-256color'
          }
        });

        // 存储映射
        terminalManager.tmuxToPty.set(tmuxSessionName, {
          pty: ptyProcess,
          sockets: new Set([socket.id])
        });

        // 绑定输出处理器（广播到所有连接的 socket）
        ptyProcess.onData((data) => {
          const mapping = terminalManager.tmuxToPty.get(tmuxSessionName);
          if (mapping) {
            // 发送到所有连接的 socket
            mapping.sockets.forEach(sid => {
              const s = io.sockets.sockets.get(sid);
              if (s) {
                s.emit('terminal:data', { termId, data });
              }
            });
          }
        });

        ptyProcess.onExit(({ exitCode, signal }) => {
          console.log(`Pty exited for tmux session: ${tmuxSessionName}`);
          terminalManager.tmuxToPty.delete(tmuxSessionName);
        });
      }

      const terminal = {
        id: termId,
        pty: ptyProcess,
        tmuxSessionName,
        socketId: socket.id,
        username: socket.user.username,
        cols: 80,
        rows: 24,
        shell: 'tmux',
        createdAt: Date.now(),
        lastActivity: Date.now(),
        screenContent: '',
        type: 'tmux-pty'
      };

      // 添加到用户会话
      if (!terminalManager.userPtySessions.has(socket.user.username)) {
        terminalManager.userPtySessions.set(socket.user.username, new Set());
      }
      terminalManager.userPtySessions.get(socket.user.username).add(termId);
      terminalManager.ptyTerminals.set(termId, terminal);

      socket.emit('terminal:attached', {
        termId,
        tmuxSessionName,
        type: 'tmux-pty'
      });

      console.log(`Attached to tmux session: ${tmuxSessionName}`);
    } catch (error) {
      socket.emit('terminal:error', {
        message: `Failed to attach to tmux session: ${error.message}`
      });
      console.error(`Failed to attach to tmux session ${tmuxSessionName}:`, error.message);
    }
  });

  // 断开连接
  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}, terminals kept alive`);

    // 从 tmuxToPty 映射中移除该 socket
    for (const [tmuxSessionName, mapping] of terminalManager.tmuxToPty.entries()) {
      if (mapping.sockets.has(socket.id)) {
        mapping.sockets.delete(socket.id);
        console.log(`Removed socket ${socket.id} from tmux session ${tmuxSessionName}`);
      }
    }

    // 清理 node-pty 终端的输出处理器
    for (const [termId, term] of terminalManager.ptyTerminals.entries()) {
      if (term.socketId === socket.id) {
        // 移除输出处理器，但保持 pty 运行
        if (term.outputHandler) {
          term.pty.removeListener('data', term.outputHandler);
          console.log(`Removed output handler for pty terminal ${termId}`);
        }
        // 不删除 term，让它在后台继续运行
      }
    }

    // 不杀终端，保持运行
  });
});

// 认证错误处理
io.on('connection_error', (err) => {
  console.log(`Connection error: ${err.message}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  terminalManager.shutdown();
  process.exit(0);
});

// 启动服务器
async function start() {
  await initUsers();

  // 检查 tmux 可用性
  await terminalManager.tmuxManager.checkTmuxInstalled();

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`\n  Multi-Terminal Server running at http://localhost:${PORT}`);
    console.log(`  Platform: ${process.platform}`);
    console.log(`  Tmux available: ${terminalManager.useTmux()}`);
    console.log(`  Default shell: ${process.platform === 'win32' ? 'powershell.exe' : 'bash'}`);
    console.log('\n  Press Ctrl+C to stop\n');
  });
}

start();
