const { execSync, spawn } = require('child_process');
const os = require('os');
const path = require('path');

/**
 * TmuxManager - 管理 tmux 终端会话
 *
 * 会话命名格式：<username>-<timestamp>-<random>
 * 例如：admin-1709980800000-a1b2c3
 */
class TmuxManager {
  constructor() {
    this.available = false;
    this.sessions = new Map(); // sessionId -> { tmuxSessionName, username, socketId, cols, rows, createdAt }
    this.socketToSession = new Map(); // socketId -> sessionId

    // 检查 tmux 是否可用
    this.checkTmuxInstalled();
  }

  /**
   * 检查 tmux 是否已安装
   */
  checkTmuxInstalled() {
    // Windows 平台不推荐使用 tmux（WSL 环境问题）
    if (process.platform === 'win32') {
      this.available = false;
      console.log('Tmux disabled on Windows (using node-pty instead)');
      return false;
    }

    try {
      execSync('which tmux', { stdio: 'pipe' });
      this.available = true;
      this.useWsl = false;
      console.log('Tmux available');
      return true;
    } catch (error) {
      this.available = false;
      console.log('Tmux not available:', error.message);
      return false;
    }
  }

  /**
   * 执行 tmux 命令
   * @param {string|string[]} args - 命令参数（字符串或数组）
   * @param {object} options - execSync 选项
   */
  execTmux(args, options = {}) {
    if (!this.available) {
      throw new Error('Tmux not available');
    }

    let cmd;
    if (typeof args === 'string') {
      // 字符串格式：直接拼接
      if (this.useWsl) {
        cmd = `wsl tmux ${args}`;
      } else if (this.tmuxPath) {
        cmd = `"${this.tmuxPath}" ${args}`;
      } else {
        cmd = `tmux ${args}`;
      }
    } else {
      // 数组格式：拼接
      if (this.useWsl) {
        cmd = ['wsl', 'tmux', ...args].join(' ');
      } else if (this.tmuxPath) {
        cmd = [`"${this.tmuxPath}"`, ...args].join(' ');
      } else {
        cmd = ['tmux', ...args].join(' ');
      }
    }

    return execSync(cmd, {
      encoding: 'utf8',
      ...options
    });
  }

  /**
   * 生成唯一的会话 ID
   */
  generateSessionId(username) {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    const sessionId = `${username}-${timestamp}-${random}`;
    // tmux 会话名只能包含字母、数字、连字符
    const tmuxSessionName = sessionId.replace(/[^a-zA-Z0-9-]/g, '-');
    return { sessionId, tmuxSessionName };
  }

  /**
   * 创建或获取 tmux 会话
   * @param {string} username - 用户名
   * @param {object} options - 选项 { cols, rows, cwd }
   */
  async getOrCreateSession(username, options = {}) {
    const { sessionId, tmuxSessionName } = this.generateSessionId(username);
    const cwd = options.cwd || os.homedir();
    const cols = options.cols || 80;
    const rows = options.rows || 24;

    try {
      // 创建分离的 tmux 会话 (-d 参数)
      const args = `new-session -d -s ${tmuxSessionName} -c "${cwd}"`;

      this.execTmux(args, { stdio: 'pipe' });

      // 存储会话信息
      const sessionInfo = {
        sessionId,
        tmuxSessionName,
        username,
        cols,
        rows,
        cwd,
        createdAt: Date.now(),
        shell: 'bash'
      };

      this.sessions.set(sessionId, sessionInfo);

      console.log(`Tmux session created: ${sessionId} (tmux: ${tmuxSessionName})`);
      return sessionInfo;
    } catch (error) {
      console.error('Failed to create tmux session:', error.message);
      throw error;
    }
  }

  /**
   * 列出用户的所有 tmux 会话
   * @param {string} username - 用户名
   */
  async listSessions(username) {
    try {
      // 获取所有 tmux 会话
      const output = this.execTmux('list-sessions -F "#{session_name}"', { stdio: 'pipe' });
      const allSessions = output.trim().split('\n').filter(s => s);

      // 过滤出该用户的会话
      const userSessions = [];
      for (const tmuxSessionName of allSessions) {
        // 检查会话名是否以 username- 开头
        if (tmuxSessionName.startsWith(`${username}-`)) {
          userSessions.push({
            id: tmuxSessionName,
            sessionId: tmuxSessionName,
            tmuxSessionName,
            username,
            cols: 80,
            rows: 24,
            shell: 'tmux',
            createdAt: Date.now(),
            lastActivity: Date.now()
          });
        }
      }

      return userSessions;
    } catch (error) {
      console.error('Failed to list tmux sessions:', error.message);
      return [];
    }
  }

  /**
   * 获取特定会话详情
   * @param {string} sessionId - 会话 ID
   */
  getSession(sessionId) {
    return this.sessions.get(sessionId);
  }

  /**
   * 附加到会话
   * @param {string} sessionId - 会话 ID
   * @param {string} socketId - Socket.IO 连接 ID
   */
  async attachSession(sessionId, socketId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      // 尝试从 tmux 中查找会话
      const tmuxSessionName = sessionId;
      try {
        this.execTmux(['list-sessions', '-t', tmuxSessionName], { stdio: 'pipe' });
        // 会话存在，创建记录
        const newSession = {
          sessionId,
          tmuxSessionName,
          username: socketId.split('-')[0], // 近似
          cols: 80,
          rows: 24,
          createdAt: Date.now()
        };
        this.sessions.set(sessionId, newSession);
        this.socketToSession.set(socketId, sessionId);
        return true;
      } catch {
        return false;
      }
    }

    this.socketToSession.set(socketId, sessionId);
    return true;
  }

  /**
   * 捕获会话屏幕内容
   * @param {string} sessionId - 会话 ID
   * @param {number} lines - 捕获行数
   */
  async capturePane(sessionId, lines = 100) {
    try {
      // 使用 sessionId 作为 tmux session name
      const output = this.execTmux(`capture-pane -p -S -${lines} -t "${sessionId}"`, { stdio: 'pipe' });
      return output;
    } catch (error) {
      console.error(`Failed to capture pane for ${sessionId}:`, error.message);
      return '';
    }
  }

  /**
   * 发送输入到会话
   * @param {string} sessionId - 会话 ID
   * @param {string} data - 输入数据
   */
  async sendInput(sessionId, data) {
    try {
      // 使用 tmux send-keys 发送输入
      this.execTmux(`send-keys -t "${sessionId}" "${data}"`, { stdio: 'pipe' });
      return true;
    } catch (error) {
      console.error(`Failed to send input to ${sessionId}:`, error.message);
      return false;
    }
  }

  /**
   * 调整会话大小
   * @param {string} sessionId - 会话 ID
   * @param {number} cols - 列数
   * @param {number} rows - 行数
   */
  async resize(sessionId, cols, rows) {
    try {
      // 调整 tmux 窗口大小
      this.execTmux(`resize-pane -t "${sessionId}" -x ${cols} -y ${rows}`, { stdio: 'pipe' });

      // 更新会话信息
      const session = this.sessions.get(sessionId);
      if (session) {
        session.cols = cols;
        session.rows = rows;
      }

      return true;
    } catch (error) {
      console.error(`Failed to resize ${sessionId}:`, error.message);
      return false;
    }
  }

  /**
   * 杀死会话
   * @param {string} sessionId - 会话 ID
   */
  async killSession(sessionId) {
    try {
      this.execTmux(`kill-session -t "${sessionId}"`, { stdio: 'pipe' });
      this.sessions.delete(sessionId);

      // 清理 socket 映射
      for (const [socketId, sid] of this.socketToSession.entries()) {
        if (sid === sessionId) {
          this.socketToSession.delete(socketId);
          break;
        }
      }

      console.log(`Tmux session killed: ${sessionId}`);
      return true;
    } catch (error) {
      console.error(`Failed to kill session ${sessionId}:`, error.message);
      // 会话可能已经不存在
      this.sessions.delete(sessionId);
      return false;
    }
  }

  /**
   * 清理长时间不活动的会话（可选）
   * @param {number} maxAge - 最大年龄（毫秒）
   */
  cleanupInactiveSessions(maxAge = 3600000) {
    const now = Date.now();
    for (const [sessionId, session] of this.sessions.entries()) {
      if (now - session.createdAt > maxAge) {
        this.killSession(sessionId);
      }
    }
  }

  /**
   * 关闭所有会话
   */
  shutdown() {
    console.log('TmuxManager shutting down, keeping sessions alive...');
    // 不主动杀死 tmux 会话，让它们继续在后台运行
    this.sessions.clear();
    this.socketToSession.clear();
  }
}

module.exports = TmuxManager;
