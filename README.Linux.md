# Multi-Terminal Linux 部署文档

## 快速部署

### 1. 上传项目到 Linux 服务器

```bash
# 方式一：使用 git clone
git clone git@github.com:wcc0077/x-web-term.git
cd multi-terminal

# 方式二：使用 scp 上传
scp -r multi-terminal root@your-server:/root/
```

### 2. 执行一键部署脚本

```bash
chmod +x install.sh  # 添加执行权限

sudo ./install.sh
```

脚本会自动完成：
- 安装 Node.js 18.x
- 安装 tmux
- 安装 PM2
- 安装 npm 依赖
- 配置环境变量
- 启动服务并设置开机自启

### 3. 访问服务

```
http://服务器IP:3000
默认账号：admin / admin123
```

---

## 手动部署

如果不使用一键脚本，可以手动执行：

### 安装依赖

```bash
# Debian/Ubuntu
sudo apt-get update
sudo apt-get install -y curl git tmux nodejs npm

# CentOS/RHEL
sudo yum install -y curl git tmux nodejs npm

# 或使用 NodeSource 安装 Node.js 18
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo bash -  # Debian/Ubuntu
curl -fsSL https://rpm.nodesource.com/setup_18.x | sudo bash -  # CentOS/RHEL
sudo apt-get install -y nodejs  # Debian/Ubuntu
sudo yum install -y nodejs      # CentOS/RHEL
```

### 部署应用

```bash
cd /opt/multi-terminal

# 安装依赖
npm install --production

# 创建环境变量
cat > .env << EOF
NODE_ENV=production
PORT=3000
JWT_SECRET=your-secret-key
USERS='[{"username":"admin","password":"admin123"}]'
EOF

# 使用 PM2 启动
npm install -g pm2
pm2 start server.js --name multi-terminal
pm2 save
pm2 startup
```

---

## 环境变量配置

在 `/opt/multi-terminal/.env` 文件中配置：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 服务端口 | 3000 |
| `JWT_SECRET` | JWT 密钥（请修改为随机字符串） | 自动生成 |
| `USERS` | 用户列表（JSON 格式） | admin/admin123 |
| `NODE_ENV` | 运行环境 | production |

### 多用户配置示例

```bash
USERS='[
  {"username":"admin","password":"admin123"},
  {"username":"user1","password":"user123"},
  {"username":"dev","password":"dev123"}
]'
```

---

## 常用命令

### PM2 管理

```bash
pm2 logs multi-terminal          # 查看日志
pm2 restart multi-terminal       # 重启服务
pm2 stop multi-terminal          # 停止服务
pm2 start multi-terminal         # 启动服务
pm2 status                       # 查看状态
pm2 delete multi-terminal        # 删除服务
```

### tmux 使用

```bash
tmux                    # 创建新会话
tmux attach             # 附加到会话
tmux ls                 # 列出会话
tmux kill-session -t 0  # 删除会话
```

在 tmux 会话中：
- `Ctrl+b d` - 分离会话
- `Ctrl+b c` - 创建新窗口
- `Ctrl+b n/p` - 下一个/上一个窗口
- `Ctrl+b w` - 窗口列表

---

## 故障排查

### 查看日志

```bash
# PM2 日志
pm2 logs multi-terminal --lines 100

# 系统日志
journalctl -u multi-terminal -f
```

### node-pty 编译失败

```bash
# 安装编译工具
sudo apt-get install -y build-essential python3
# 或
sudo yum install -y gcc-c++ make python3

# 重新安装依赖
npm rebuild node-pty
```

### 端口被占用

```bash
# 修改端口
export PORT=3001
# 或在 .env 中修改 PORT=3001
```

### 服务无法启动

```bash
# 检查 PM2 状态
pm2 status

# 查看详细错误
pm2 logs multi-terminal --err

# 手动启动测试
cd /opt/multi-terminal
node server.js
```

---

## 默认凭据

| 用户名 | 密码 |
|--------|------|
| admin | admin123 |

⚠️ **首次部署后请立即修改默认密码！**

---

## 系统要求

- **操作系统**: Ubuntu 18.04+ / Debian 10+ / CentOS 7+ / RHEL 7+
- **内存**: 最低 256MB，推荐 512MB+
- **磁盘**: 最低 200MB 可用空间
- **Node.js**: 18.x 或更高版本
