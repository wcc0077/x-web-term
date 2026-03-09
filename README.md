# Multi Terminal

基于 xterm.js + node-pty 的 Web 多终端管理器。

## 功能

- 创建多个独立终端
- 标签页切换
- 动态调整终端大小
- 关闭单个/全部终端
- 键盘快捷键支持
- 实时连接状态显示

## 安装

```bash
# 安装依赖
npm install

# Windows 需要安装构建工具
npm install --global windows-build-tools
```

## 运行

```bash
npm start
```

打开浏览器访问 http://localhost:3000

## 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Ctrl+Shift+T` | 新建终端 |
| `Ctrl+W` | 关闭当前终端 |
| `Ctrl+Tab` | 切换终端 |

## 项目结构

```
multi-terminal/
├── server.js           # 后端服务
├── package.json        # 项目配置
└── public/
    ├── index.html      # 前端页面
    └── app.js          # 前端逻辑
```

## 技术栈

- **后端**: Node.js + Express + Socket.IO + node-pty
- **前端**: xterm.js + Socket.IO Client

## 注意事项

### Windows

Windows 上 node-pty 需要编译原生模块，确保已安装：
- Visual Studio Build Tools
- Python 3

```bash
npm install --global windows-build-tools
```

### Linux

```bash
# Ubuntu/Debian
sudo apt-get install build-essential

# CentOS/RHEL
sudo yum groupinstall "Development Tools"
```

### macOS

```bash
xcode-select --install
```

## API

### Socket.IO 事件

**客户端 -> 服务器**

| 事件 | 参数 | 说明 |
|------|------|------|
| `terminal:create` | `{ cols, rows, cwd?, shell? }` | 创建终端 |
| `terminal:input` | `{ termId, data }` | 发送输入 |
| `terminal:resize` | `{ termId, cols, rows }` | 调整大小 |
| `terminal:kill` | `{ termId }` | 关闭终端 |
| `terminal:list` | - | 获取终端列表 |

**服务器 -> 客户端**

| 事件 | 参数 | 说明 |
|------|------|------|
| `terminal:created` | `{ termId, cols, rows }` | 终端创建成功 |
| `terminal:data` | `{ termId, data }` | 终端输出 |
| `terminal:exit` | `{ termId, exitCode }` | 终端退出 |
| `terminal:killed` | `{ termId }` | 终端已关闭 |
| `terminal:error` | `{ message }` | 错误信息 |

## License

MIT