/**
 * Multi Terminal Frontend Application
 */

// 配置
const CONFIG = {
  serverUrl: window.location.origin,
  defaultCols: 80,
  defaultRows: 24,
  fontSize: 14,
  fontFamily: '"Cascadia Code", "Fira Code", Consolas, "Courier New", monospace',
  theme: {
    background: '#0d1117',
    foreground: '#c9d1d9',
    cursor: '#58a6ff',
    cursorAccent: '#0d1117',
    selectionBackground: '#264f78',
    black: '#484f58',
    red: '#f85149',
    green: '#3fb950',
    yellow: '#d29922',
    blue: '#58a6ff',
    magenta: '#bc8cff',
    cyan: '#39c5cf',
    white: '#b1bac4',
    brightBlack: '#6e7681',
    brightRed: '#ff7b72',
    brightGreen: '#56d364',
    brightYellow: '#e3b341',
    brightBlue: '#79c0ff',
    brightMagenta: '#d2a8ff',
    brightCyan: '#56d4dd',
    brightWhite: '#f0f6fc'
  }
};

// 认证相关 (从 index.html 传入)
function getToken() {
  return localStorage.getItem('mt_token');
}

function getUser() {
  const user = localStorage.getItem('mt_user');
  return user ? JSON.parse(user) : null;
}

function logout() {
  localStorage.removeItem('mt_token');
  localStorage.removeItem('mt_user');
  window.location.href = '/login.html';
}

// 显示用户信息
function displayUserInfo() {
  const user = getUser();
  const userInfoEl = document.getElementById('user-info');
  if (user && userInfoEl) {
    userInfoEl.textContent = `@${user.username}`;
  }
}

// 全局状态
const state = {
  socket: null,
  terminals: new Map(),
  activeTerminalId: null,
  terminalCounter: 0,
  connected: false,
  restoring: false,
  autoSaveInterval: null // 定时保存 ID
};

// 配置自动保存间隔（毫秒）
const AUTO_SAVE_INTERVAL = 10000; // 10 秒

// DOM 元素
const elements = {
  tabs: document.getElementById('tabs'),
  terminals: document.getElementById('terminals'),
  emptyState: document.getElementById('empty-state'),
  terminalCount: document.getElementById('terminal-count'),
  statusDot: document.querySelector('.status-dot'),
  statusText: document.getElementById('status-text'),
  toastContainer: document.getElementById('toast-container')
};

// 工具函数
function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  elements.toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

function updateTerminalCount() {
  const count = state.terminals.size;
  elements.terminalCount.textContent = `${count} 个终端`;
}

function updateConnectionStatus(connected) {
  state.connected = connected;
  elements.statusDot.classList.toggle('disconnected', !connected);
  elements.statusText.textContent = connected ? '已连接' : '断开连接';
}

// 创建终端
function createTerminal(options = {}) {
  if (!state.connected) {
    showToast('未连接到服务器', 'error');
    return;
  }

  // 检查是否是附加到现有 tmux 会话
  if (options.termId && options.tmuxSessionName) {
    // 直接附加到现有 tmux 会话
    console.log(`Attaching to tmux session: ${options.tmuxSessionName}`);
    state.socket.emit('terminal:attach', options);
    return;
  }

  state.terminalCounter++;
  const localId = state.terminalCounter;

  // 创建终端包装器
  const wrapper = document.createElement('div');
  wrapper.className = 'terminal-wrapper';
  wrapper.id = `terminal-wrapper-${localId}`;

  // 创建终端内容区域
  const content = document.createElement('div');
  content.className = 'terminal-content';
  const termDiv = document.createElement('div');
  termDiv.id = `terminal-${localId}`;
  content.appendChild(termDiv);
  wrapper.appendChild(content);

  // 隐藏空状态
  elements.emptyState.style.display = 'none';
  elements.terminals.appendChild(wrapper);

  // 初始化 xterm
  const xterm = new Terminal({
    cols: CONFIG.defaultCols,
    rows: CONFIG.defaultRows,
    fontSize: CONFIG.fontSize,
    fontFamily: CONFIG.fontFamily,
    theme: CONFIG.theme,
    cursorBlink: true,
    cursorStyle: 'bar',
    scrollback: 10000,
    allowProposedApi: true,
    // 将 \r 转换为 \n，正确处理换行
    convertEol: true
  });

  // 加载插件
  const fitAddon = new FitAddon.FitAddon();
  const webLinksAddon = new WebLinksAddon.WebLinksAddon();

  xterm.loadAddon(fitAddon);
  xterm.loadAddon(webLinksAddon);
  xterm.open(termDiv);

  // 创建标签
  const tab = createTab(localId);
  elements.tabs.appendChild(tab);

  // 适应容器大小 - 使用 requestAnimationFrame 确保 DOM 已渲染
  requestAnimationFrame(() => {
    setTimeout(() => fitAddon.fit(), 100);
  });

  // 存储终端信息（等待服务器返回 termId）
  const terminalInfo = {
    localId,
    termId: null,
    xterm,
    fitAddon,
    wrapper,
    tab,
    attachTo: null // 如果要附加到现有 tmux 会话
  };
  state.terminals.set(`pending-${localId}`, terminalInfo);

  // 请求服务器创建 PTY
  state.socket.emit('terminal:create', {
    cols: xterm.cols,
    rows: xterm.rows
  });

  // 激活此终端
  setActiveTerminal(localId);

  console.log(`Terminal ${localId} creating...`);
}

// 创建标签
function createTab(localId, type = 'unknown') {
  const tab = document.createElement('div');
  tab.className = 'tab active';
  tab.id = `tab-${localId}`;
  tab.dataset.localId = localId;

  const typeIndicator = type === 'tmux' ? '[tmux] ' : '';

  tab.innerHTML = `
    <span class="tab-title">${typeIndicator}终端 ${localId}</span>
    <span class="close-btn" onclick="event.stopPropagation(); killTerminal(${localId})">×</span>
  `;

  tab.addEventListener('click', () => setActiveTerminal(localId));

  return tab;
}

// 设置活动终端
function setActiveTerminal(localId) {
  state.activeTerminalId = localId;

  // 更新标签状态
  document.querySelectorAll('.tab').forEach(tab => {
    tab.classList.toggle('active', parseInt(tab.dataset.localId) === localId);
  });

  // 更新终端显示
  document.querySelectorAll('.terminal-wrapper').forEach(wrapper => {
    const wrapperLocalId = parseInt(wrapper.id.replace('terminal-wrapper-', ''));
    wrapper.classList.toggle('active', wrapperLocalId === localId);
  });

  // 聚焦终端
  const terminal = findTerminalByLocalId(localId);
  if (terminal) {
    setTimeout(() => {
      terminal.xterm.focus();
      terminal.fitAddon.fit();
    }, 0);
  }
}

// 查找终端
function findTerminalByLocalId(localId) {
  for (const [_, term] of state.terminals.entries()) {
    if (term.localId === localId) {
      return term;
    }
  }
  return null;
}

function findTerminalByTermId(termId) {
  return state.terminals.get(termId);
}

// 恢复终端（从服务器会话）
function restoreTerminal(termId, cols, rows, shell, createdAt, screenContent, needReconnect = false, type = 'unknown') {
  state.terminalCounter++;
  const localId = state.terminalCounter;

  // 创建终端包装器
  const wrapper = document.createElement('div');
  wrapper.className = 'terminal-wrapper';
  wrapper.id = `terminal-wrapper-${localId}`;

  // 创建终端内容区域
  const content = document.createElement('div');
  content.className = 'terminal-content';
  const termDiv = document.createElement('div');
  termDiv.id = `terminal-${localId}`;
  content.appendChild(termDiv);
  wrapper.appendChild(content);

  // 隐藏空状态
  elements.emptyState.style.display = 'none';
  elements.terminals.appendChild(wrapper);

  // 初始化 xterm
  const xterm = new Terminal({
    cols: cols || CONFIG.defaultCols,
    rows: rows || CONFIG.defaultRows,
    fontSize: CONFIG.fontSize,
    fontFamily: CONFIG.fontFamily,
    theme: CONFIG.theme,
    cursorBlink: true,
    cursorStyle: 'bar',
    scrollback: 10000,
    allowProposedApi: true,
    convertEol: true
  });

  // 加载插件
  const fitAddon = new FitAddon.FitAddon();
  const webLinksAddon = new WebLinksAddon.WebLinksAddon();

  xterm.loadAddon(fitAddon);
  xterm.loadAddon(webLinksAddon);
  xterm.open(termDiv);

  // 创建标签
  const tab = createTab(localId, type);
  elements.tabs.appendChild(tab);

  // 适应容器大小 - 使用 requestAnimationFrame 确保 DOM 已渲染
  requestAnimationFrame(() => {
    setTimeout(() => fitAddon.fit(), 100);
  });

  // 存储终端信息
  const terminalInfo = {
    localId,
    termId,
    xterm,
    fitAddon,
    wrapper,
    tab,
    restored: true,
    needReconnect, // 标记是否需要重新连接 PTY
    type // 'tmux' or 'pty'
  };
  state.terminals.set(termId, terminalInfo);

  // 恢复屏幕内容
  if (screenContent) {
    xterm.write(screenContent);
  }

  // 绑定输入事件
  xterm.onData((data) => {
    if (state.connected) {
      state.socket.emit('terminal:input', { termId, data });
    }
  });

  // 启动定时同步
  startAutoSave();

  console.log(`Terminal ${localId} restored with termId: ${termId} (type: ${type})`);

  // 激活此终端
  setActiveTerminal(localId);
  updateTerminalCount();
}

// 关闭终端
function killTerminal(localId) {
  const terminal = findTerminalByLocalId(localId);
  if (!terminal) return;

  if (terminal.termId) {
    // 关闭前先保存屏幕内容
    saveTerminalScreen(terminal.termId);
    state.socket.emit('terminal:kill', { termId: terminal.termId });
  }

  // 移除 DOM 元素
  terminal.wrapper.remove();
  terminal.tab.remove();

  // 从状态中移除
  for (const [key, term] of state.terminals.entries()) {
    if (term.localId === localId) {
      state.terminals.delete(key);
      break;
    }
  }

  updateTerminalCount();

  // 如果没有终端了，显示空状态并停止定时保存
  if (state.terminals.size === 0) {
    elements.emptyState.style.display = 'flex';
    state.activeTerminalId = null;
    stopAutoSave();
  } else {
    // 激活另一个终端
    const remaining = Array.from(state.terminals.values())[0];
    if (remaining) {
      setActiveTerminal(remaining.localId);
    }
  }

  console.log(`Terminal ${localId} killed`);
}

// 关闭所有终端
function killAllTerminals() {
  const localIds = Array.from(state.terminals.values()).map(t => t.localId);
  localIds.forEach(id => killTerminal(id));
  // 重置计数器，让下一个终端从 1 开始编号
  state.terminalCounter = 0;
}

// 初始化 Socket.IO
function initSocket() {
  const token = getToken();
  if (!token) {
    logout();
    return;
  }

  state.socket = io(CONFIG.serverUrl, {
    transports: ['websocket', 'polling'],
    auth: { token }
  });

  // 连接成功
  state.socket.on('connect', () => {
    console.log('Connected to server');
    updateConnectionStatus(true);
    showToast('已连接到服务器', 'success');

    // 不需要主动请求恢复，后端会在连接时自动发送恢复的会话
    // 但保留 terminal:list 用于手动刷新场景
  });

  // 断开连接
  state.socket.on('disconnect', () => {
    console.log('Disconnected from server');
    updateConnectionStatus(false);
    showToast('与服务器的连接已断开', 'error');
  });

  // 认证错误
  state.socket.on('connect_error', (err) => {
    console.error('Connection error:', err.message);
    if (err.message === '未认证' || err.message === '令牌无效') {
      showToast('登录已过期，请重新登录', 'error');
      setTimeout(logout, 1500);
    }
  });

  // 后端恢复的终端（内存中的会话或 tmux 会话）
  state.socket.on('terminal:restored', ({ termId, cols, rows, shell, createdAt, screenContent, type }) => {
    console.log(`[RECEIVED] terminal:restored - termId: ${termId}, type: ${type || 'unknown'}, screenContent: ${screenContent?.length || 0} chars`);

    // 检查是否已存在该终端，避免重复创建
    if (state.terminals.has(termId)) {
      console.log(`Terminal ${termId} already exists, skipping...`);
      return;
    }

    const restored = restoreTerminal(termId, cols, rows, shell, createdAt, screenContent, false, type);
    console.log(`[RESTORED] Terminal ${termId} restored successfully`);
  });

  // 后端保存的终端会话（文件中的会话）
  state.socket.on('terminal:session-saved', ({ termId, cols, rows, shell, cwd, createdAt, lastSavedAt, screenContent }) => {
    console.log(`Terminal session loaded from file: ${termId}`);
    // 检查是否已经存在（内存中的会话优先）
    if (!state.terminals.has(termId)) {
      // 从文件恢复的终端需要重新连接 PTY
      restoreTerminal(termId, cols, rows, shell, createdAt, screenContent, true);
    }
  });

  // 有新的 tmux 会话可用（后端重启后会话依然存在）
  state.socket.on('terminal:session-available', ({ termId, tmuxSessionName, cols, rows, shell, createdAt, type }) => {
    console.log(`[SESSION AVAILABLE] tmux session: ${tmuxSessionName}`);

    // 检查是否已存在该终端，避免重复创建
    if (state.terminals.has(termId)) {
      console.log(`Terminal ${termId} already exists, skipping...`);
      return;
    }

    // 创建一个新终端并附加到 tmux 会话
    createTerminal({ termId, tmuxSessionName });
  });

  // 终端列表（用于恢复）
  state.socket.on('terminal:list', (list) => {
    console.log('Terminal list received:', list);
    if (state.restoring && list.length > 0) {
      // 恢复所有终端
      list.forEach(term => {
        restoreTerminal(term.id, term.cols, term.rows, term.shell, term.createdAt, term.screenContent);
      });
      state.restoring = false;
      showToast(`已恢复 ${list.length} 个终端`, 'success');
    }
  });

  // 终端创建成功
  state.socket.on('terminal:created', ({ termId, cols, rows, type, screenContent }) => {
    console.log(`Terminal created on server: ${termId} (type: ${type || 'unknown'})`);

    // 找到最新的 pending 终端
    let latestPending = null;
    let latestKey = null;

    for (const [key, term] of state.terminals.entries()) {
      if (typeof key === 'string' && key.startsWith('pending-') && term.termId === null) {
        if (!latestPending || term.localId > latestPending.localId) {
          latestPending = term;
          latestKey = key;
        }
      }
    }

    if (latestPending) {
      // 更新 termId 和类型
      latestPending.termId = termId;
      latestPending.type = type || 'unknown';

      // 移动到正确的 key
      state.terminals.delete(latestKey);
      state.terminals.set(termId, latestPending);

      // 绑定输入事件
      latestPending.xterm.onData((data) => {
        if (state.connected) {
          state.socket.emit('terminal:input', { termId, data });
        }
      });

      // 如果有初始屏幕内容（tmux），显示它
      if (screenContent) {
        latestPending.xterm.write(screenContent);
      }

      // 启动定时保存
      startAutoSave();

      // 更新标签显示类型
      const tabTitle = latestPending.tab.querySelector('.tab-title');
      if (type === 'tmux' && tabTitle) {
        tabTitle.textContent = `[tmux] 终端 ${latestPending.localId}`;
      }

      // 更新终端数量
      updateTerminalCount();
    }
  });

  // 附加到 tmux 会话成功
  state.socket.on('terminal:attached', ({ termId, tmuxSessionName, type }) => {
    console.log(`Attached to tmux session: ${tmuxSessionName} (${termId})`);

    // 找到对应的 pending 终端
    let latestPending = null;
    let latestKey = null;

    for (const [key, term] of state.terminals.entries()) {
      if (key.startsWith('pending-') && term.termId === null) {
        if (!latestPending || term.localId > latestPending.localId) {
          latestPending = term;
          latestKey = key;
        }
      }
    }

    if (latestPending) {
      latestPending.termId = termId;
      latestPending.type = type;

      state.terminals.delete(latestKey);
      state.terminals.set(termId, latestPending);

      // 绑定输入事件
      latestPending.xterm.onData((data) => {
        if (state.connected) {
          state.socket.emit('terminal:input', { termId, data });
        }
      });

      startAutoSave();

      const tabTitle = latestPending.tab.querySelector('.tab-title');
      if (tabTitle) {
        tabTitle.textContent = `[tmux] 终端 ${latestPending.localId}`;
      }

      updateTerminalCount();
      showToast(`已连接到 tmux 会话：${tmuxSessionName}`, 'success');
    }
  });

  // 接收终端输出
  state.socket.on('terminal:data', ({ termId, data }) => {
    const terminal = findTerminalByTermId(termId);
    if (terminal) {
      terminal.xterm.write(data);
    }
  });

  // 终端退出
  state.socket.on('terminal:exit', ({ termId, exitCode }) => {
    const terminal = findTerminalByTermId(termId);
    if (terminal) {
      terminal.xterm.writeln(`\r\n\x1b[33m进程已退出，退出码: ${exitCode}\x1b[0m`);
      terminal.tab.style.opacity = '0.5';
      terminal.tab.querySelector('.tab-title').textContent += ' (已退出)';
    }
  });

  // 终端被关闭
  state.socket.on('terminal:killed', ({ termId }) => {
    console.log(`Terminal ${termId} killed by server`);
  });

  // 错误
  state.socket.on('terminal:error', ({ message }) => {
    showToast(message, 'error');
  });

  // 终端列表
  state.socket.on('terminal:list', (list) => {
    console.log('Terminal list:', list);
  });
}

// 窗口大小变化处理
function handleResize() {
  const terminal = findTerminalByLocalId(state.activeTerminalId);
  if (terminal && terminal.fitAddon) {
    terminal.fitAddon.fit();

    if (terminal.termId) {
      state.socket.emit('terminal:resize', {
        termId: terminal.termId,
        cols: terminal.xterm.cols,
        rows: terminal.xterm.rows
      });
    }
  }
}

// 键盘快捷键
function handleKeyboard(e) {
  // Ctrl+Shift+T: 新建终端
  if (e.ctrlKey && e.shiftKey && e.key === 'T') {
    e.preventDefault();
    createTerminal();
  }

  // Ctrl+W: 关闭当前终端
  if (e.ctrlKey && e.key === 'w') {
    e.preventDefault();
    if (state.activeTerminalId) {
      killTerminal(state.activeTerminalId);
    }
  }

  // Ctrl+Tab: 切换到下一个终端
  if (e.ctrlKey && e.key === 'Tab') {
    e.preventDefault();
    const terminals = Array.from(state.terminals.values());
    if (terminals.length > 1) {
      const currentIndex = terminals.findIndex(t => t.localId === state.activeTerminalId);
      const nextIndex = (currentIndex + 1) % terminals.length;
      setActiveTerminal(terminals[nextIndex].localId);
    }
  }
}

// 初始化应用
function init() {
  displayUserInfo();

  // 清理旧的 DOM 元素（页面刷新时保留的内容）
  const oldWrappers = document.querySelectorAll('.terminal-wrapper');
  const oldTabs = document.querySelectorAll('.tab');
  oldWrappers.forEach(el => el.remove());
  oldTabs.forEach(el => el.remove());

  // 重置状态
  state.terminals.clear();
  state.activeTerminalId = null;
  state.terminalCounter = 0;

  // 显示空状态
  elements.emptyState.style.display = 'flex';

  initSocket();

  window.addEventListener('resize', handleResize);
  document.addEventListener('keydown', handleKeyboard);

  // 页面关闭/刷新时不终止终端，保持后台运行
  window.addEventListener('beforeunload', (e) => {
    // 保存所有终端的屏幕内容
    if (state.socket && state.connected) {
      state.socket.emit('terminal:detach');
    }
  });

  console.log('Multi Terminal initialized');
}

// 同步终端屏幕内容到后端（定时调用）
function syncTerminalScreen(termId) {
  const terminal = findTerminalByTermId(termId);
  if (!terminal) return;

  // 使用 xterm.js 的 serialize 插件获取屏幕内容
  // 如果没有 serialize 插件，使用简单的文本内容
  try {
    // 尝试获取序列化的内容（需要 xterm-addon-serialize）
    if (terminal.xterm.serialize) {
      const content = terminal.xterm.serialize({
        scrollback: 0,  // 只保存当前屏幕
        maxLines: terminal.rows
      });
      state.socket.emit('terminal:sync', { termId, screenContent: content });
    } else {
      // 简单方式：只保存文本内容
      const content = `Screen: ${terminal.xterm.cols}x${terminal.rows}\r\nLast activity: ${new Date().toISOString()}`;
      state.socket.emit('terminal:sync', { termId, screenContent: content });
    }
  } catch (e) {
    console.error('Failed to serialize terminal:', e);
  }
}

// 保存终端屏幕内容到文件
function saveTerminalScreen(termId) {
  const terminal = findTerminalByTermId(termId);
  if (!terminal) return;

  try {
    if (terminal.xterm.serialize) {
      const content = terminal.xterm.serialize({
        scrollback: 0,
        maxLines: terminal.rows
      });
      state.socket.emit('terminal:save', { termId, screenContent: content });
    }
  } catch (e) {
    console.error('Failed to save terminal screen:', e);
  }
}

// 启动定时保存
function startAutoSave() {
  if (state.autoSaveInterval) return;
  state.autoSaveInterval = setInterval(() => {
    for (const [termId, _] of state.terminals.entries()) {
      syncTerminalScreen(termId);
    }
  }, AUTO_SAVE_INTERVAL);
  console.log('Auto-save started');
}

// 停止定时保存
function stopAutoSave() {
  if (state.autoSaveInterval) {
    clearInterval(state.autoSaveInterval);
    state.autoSaveInterval = null;
  }
}

// 全局函数暴露
window.createTerminal = createTerminal;
window.killTerminal = killTerminal;
window.killAllTerminals = killAllTerminals;
window.logout = logout;
// 恢复 tmux 会话
window.restoreTmuxSession = function(termId, tmuxSessionName) {
  console.log(`Restoring tmux session: ${tmuxSessionName}`);
  state.socket.emit('terminal:attach', { termId, tmuxSessionName });
};

// 启动
document.addEventListener('DOMContentLoaded', init);