#!/bin/bash
# Multi-Terminal 部署脚本
# 支持 Ubuntu/Debian 和 CentOS/RHEL
# 使用: sudo bash deploy.sh

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# 检查 root 权限
if [[ $EUID -ne 0 ]]; then
   log_error "此脚本需要 root 权限，请使用 sudo bash deploy.sh"
   exit 1
fi

# 检测系统类型
if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS=$ID
else
    log_error "无法检测系统类型"
    exit 1
fi

log_info "检测到系统: $OS"

# 配置变量
APP_NAME="multi-terminal"
APP_DIR="/opt/$APP_NAME"
APP_USER="www-data"
APP_PORT=3000
NODE_VERSION="18"

# 1. 安装系统依赖
log_info "安装系统依赖..."

if [[ "$OS" == "ubuntu" ]] || [[ "$OS" == "debian" ]]; then
    apt-get update
    apt-get install -y curl wget git build-essential python3
elif [[ "$OS" == "centos" ]] || [[ "$OS" == "rhel" ]] || [[ "$OS" == "rocky" ]] || [[ "$OS" == "almalinux" ]]; then
    yum groupinstall -y "Development Tools"
    yum install -y curl wget git python3
else
    log_warn "未知系统类型，尝试通用安装..."
    apt-get update 2>/dev/null || yum update -y
    apt-get install -y curl wget git build-essential python3 2>/dev/null || \
    yum groupinstall -y "Development Tools" && yum install -y curl wget git python3
fi

log_info "系统依赖安装完成"

# 2. 安装 Node.js
log_info "检查 Node.js..."

if ! command -v node &> /dev/null; then
    log_info "安装 Node.js $NODE_VERSION..."
    curl -fsSL https://rpm.nodesource.com/setup_$NODE_VERSION.x | bash - 2>/dev/null || \
    curl -fsSL https://deb.nodesource.com/setup_$NODE_VERSION.x | bash -
    apt-get install -y nodejs 2>/dev/null || yum install -y nodejs
else
    NODE_VER=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [[ $NODE_VER -lt 16 ]]; then
        log_warn "Node.js 版本过低，建议升级到 18+"
    fi
fi

log_info "Node.js 版本: $(node -v)"
log_info "npm 版本: $(npm -v)"

# 3. 安装 PM2
log_info "安装 PM2..."
npm install -g pm2

# 4. 创建应用目录
log_info "创建应用目录..."
mkdir -p $APP_DIR

# 5. 复制项目文件（如果当前目录有项目）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/server.js" ]]; then
    log_info "复制项目文件..."
    cp -r "$SCRIPT_DIR"/* $APP_DIR/
else
    log_warn "当前目录未找到项目文件，请手动复制项目到 $APP_DIR"
fi

# 6. 安装项目依赖
log_info "安装项目依赖..."
cd $APP_DIR
npm install --production

# 7. 设置权限
log_info "设置文件权限..."
if id "$APP_USER" &>/dev/null; then
    chown -R $APP_USER:$APP_USER $APP_DIR
else
    log_warn "用户 $APP_USER 不存在，使用 root"
    APP_USER="root"
fi

# 8. 创建 PM2 配置文件
log_info "创建 PM2 配置..."

# 生成随机 JWT_SECRET
JWT_SECRET=$(openssl rand -hex 32 2>/dev/null || node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

cat > $APP_DIR/ecosystem.config.js << EOF
module.exports = {
  apps: [{
    name: '$APP_NAME',
    script: 'server.js',
    cwd: '$APP_DIR',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    env: {
      NODE_ENV: 'production',
      PORT: $APP_PORT,
      JWT_SECRET: '$JWT_SECRET'
    },
    error_file: '/var/log/$APP_NAME/error.log',
    out_file: '/var/log/$APP_NAME/out.log',
    log_file: '/var/log/$APP_NAME/combined.log',
    time: true
  }]
};
EOF

# 创建日志目录
mkdir -p /var/log/$APP_NAME
chown -R $APP_USER:$APP_USER /var/log/$APP_NAME

# 9. 启动服务
log_info "启动服务..."
pm2 start ecosystem.config.js
pm2 save
pm2 startup | bash || true

log_info "部署完成!"
echo ""
echo "======================================"
echo "  Multi-Terminal 部署成功!"
echo "======================================"
echo ""
echo "  访问地址: http://服务器IP:$APP_PORT"
echo "  应用目录: $APP_DIR"
echo "  日志目录: /var/log/$APP_NAME"
echo ""
echo "  常用命令:"
echo "    pm2 status           # 查看状态"
echo "    pm2 logs $APP_NAME   # 查看日志"
echo "    pm2 restart $APP_NAME # 重启服务"
echo "    pm2 stop $APP_NAME   # 停止服务"
echo ""