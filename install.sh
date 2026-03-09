#!/bin/bash

#############################################################################
# Multi-Terminal 一键部署脚本
# 自动安装 Node.js + tmux + 部署应用
#############################################################################

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log() { echo -e "${BLUE}[INFO]${NC} $1"; }
ok() { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
err() { echo -e "${RED}[ERROR]${NC} $1"; }

# 检查 root
if [ $EUID -ne 0 ]; then
    err "请使用 sudo 运行：sudo $0"
    exit 1
fi

# 检测包管理器
if command -v apt-get &> /dev/null; then
    PM="apt"
    INSTALL="apt-get install -y"
elif command -v yum &> /dev/null; then
    PM="yum"
    INSTALL="yum install -y"
else
    err "不支持的系统，仅支持 Debian/Ubuntu/CentOS"
    exit 1
fi

log "更新软件包列表..."
if [ "$PM" = "apt" ]; then
    apt-get update -qq
else
    yum makecache -q || true
fi

# 安装系统依赖
log "安装基础依赖..."
$INSTALL curl git tmux

# 安装 Node.js 18
log "安装 Node.js 18..."
if command -v node &> /dev/null; then
    NODE_VER=$(node -v | cut -d. -f1 | tr -d 'v')
    if [ "$NODE_VER" -ge 18 ]; then
        ok "Node.js 已安装 $(node -v)"
    else
        warn "Node.js 版本过低，重新安装..."
        if [ "$PM" = "apt" ]; then
            curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
            $INSTALL nodejs
        else
            curl -fsSL https://rpm.nodesource.com/setup_18.x | bash -
            $INSTALL nodejs
        fi
    fi
else
    if [ "$PM" = "apt" ]; then
        curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
        $INSTALL nodejs
    else
        curl -fsSL https://rpm.nodesource.com/setup_18.x | bash -
        $INSTALL nodejs
    fi
fi

ok "Node.js $(node -v) 已安装"

# 部署目录
APP_DIR="/opt/multi-terminal"
log "部署到 $APP_DIR"

mkdir -p $APP_DIR
cd $APP_DIR

# 复制文件
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/server.js" ]; then
    cp -r $SCRIPT_DIR/* $APP_DIR/
    cp -r $SCRIPT_DIR/.* $APP_DIR/ 2>/dev/null || true
else
    # 如果没有本地文件，尝试从 GitHub 克隆
    warn "未找到本地项目文件，尝试从 GitHub 克隆..."
    if command -v git &> /dev/null; then
        rm -rf $APP_DIR
        git clone https://github.com/YOUR_USERNAME/multi-terminal.git $APP_DIR
        cd $APP_DIR
    else
        err "未找到 server.js，请确保脚本与项目文件一起上传，或安装 git"
        exit 1
    fi
fi

# 检查是否有代码
if [ ! -f "server.js" ]; then
    err "未找到 server.js，请确保脚本与项目文件一起上传"
    exit 1
fi

# 安装依赖
log "安装 npm 依赖..."
npm install --production

# 生成随机密钥
JWT_SECRET=$(cat /dev/urandom | tr -dc 'a-zA-Z0-9' | fold -w 32 | head -n 1)

# 创建 .env
cat > $APP_DIR/.env << EOF
NODE_ENV=production
PORT=3000
JWT_SECRET=$JWT_SECRET
USERS='[{"username":"admin","password":"admin123"}]'
EOF

# 安装 PM2
log "安装 PM2..."
npm install -g pm2

# PM2 启动
log "启动服务..."
pm2 start server.js --name multi-terminal
pm2 save
pm2 startup 2>/dev/null || true

echo ""
echo "========================================"
ok "部署完成!"
echo "========================================"
echo ""
echo "访问：http://\$(hostname -I | awk '{print \$1}'):3000"
echo ""
echo "默认账号：admin / admin123"
echo ""
echo "常用命令:"
echo "  pm2 logs multi-terminal     # 查看日志"
echo "  pm2 restart multi-terminal  # 重启"
echo "  pm2 stop multi-terminal     # 停止"
echo "  tmux                        # 进入 tmux 会话"
echo ""
