# Multi-Terminal Linux 部署指南

## 快速部署

### 方式一：自动部署脚本

```bash
# 1. 上传项目到服务器
scp -r multi-terminal user@server:/tmp/

# 2. 运行部署脚本
cd /tmp/multi-terminal
sudo bash deploy.sh
```

### 方式二：手动部署

#### 1. 安装系统依赖

```bash
# Ubuntu/Debian
sudo apt-get update
sudo apt-get install -y build-essential python3 curl

# CentOS/RHEL
sudo yum groupinstall -y "Development Tools"
sudo yum install -y python3 curl
```

#### 2. 安装 Node.js

```bash
# 使用 NodeSource 安装 Node.js 18
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo bash -
sudo apt-get install -y nodejs

# 或 CentOS
curl -fsSL https://rpm.nodesource.com/setup_18.x | sudo bash -
sudo yum install -y nodejs
```

#### 3. 安装 PM2

```bash
sudo npm install -g pm2
```

#### 4. 部署项目

```bash
# 创建目录
sudo mkdir -p /opt/multi-terminal

# 复制项目文件
sudo cp -r ./* /opt/multi-terminal/

# 安装依赖
cd /opt/multi-terminal
sudo npm install --production
```

#### 5. 启动服务

```bash
# 创建 PM2 配置
cat > ecosystem.config.js << 'EOF'
module.exports = {
  apps: [{
    name: 'multi-terminal',
    script: 'server.js',
    cwd: '/opt/multi-terminal',
    instances: 1,
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
      JWT_SECRET: 'your-secret-key-change-me'
    }
  }]
};
EOF

# 启动
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

## 用户认证

### 默认账户

首次部署默认账户: `admin` / `admin123`

**⚠️ 生产环境必须修改默认密码或配置自定义用户！**

### 配置用户

#### 方式一：环境变量

```bash
# 生成密码哈希
node -e "const bcrypt = require('bcryptjs'); console.log(bcrypt.hashSync('your-password', 10));"

# 设置环境变量 (PM2)
export USERS='[{"username":"admin","password":"$2a$10$...hashed..."}]'
export JWT_SECRET='your-secure-secret-key'

pm2 restart multi-terminal
```

#### 方式二：修改密码 API

登录后调用修改密码接口：

```bash
curl -X POST http://localhost:3000/api/change-password \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"oldPassword":"admin123","newPassword":"new-secure-password"}'
```

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | 3000 | 服务端口 |
| `NODE_ENV` | development | 运行环境 |
| `JWT_SECRET` | (随机) | JWT 签名密钥，**生产必须设置** |
| `USERS` | admin/admin123 | 用户列表 JSON |

## Nginx 反向代理（推荐）

```bash
# 运行 Nginx 配置脚本
sudo bash nginx-setup.sh your-domain.com

# 或手动配置
sudo bash nginx-setup.sh
```

### 手动 Nginx 配置

```nginx
# /etc/nginx/sites-available/multi-terminal
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        # WebSocket 支持
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;

        # 长连接超时
        proxy_read_timeout 3600s;
    }
}
```

## HTTPS 配置（Certbot）

```bash
# 安装 Certbot
sudo apt-get install -y certbot python3-certbot-nginx

# 获取证书并自动配置 Nginx
sudo certbot --nginx -d your-domain.com

# 自动续期
sudo certbot renew --dry-run
```

## 防火墙配置

```bash
# Ubuntu (ufw)
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 3000/tcp  # 如果不使用 Nginx

# CentOS (firewalld)
sudo firewall-cmd --permanent --add-port=80/tcp
sudo firewall-cmd --permanent --add-port=443/tcp
sudo firewall-cmd --permanent --add-port=3000/tcp
sudo firewall-cmd --reload
```

## 常用管理命令

```bash
# 查看服务状态
pm2 status

# 查看日志
pm2 logs multi-terminal

# 重启服务
pm2 restart multi-terminal

# 停止服务
pm2 stop multi-terminal

# 监控面板
pm2 monit
```

## Docker 部署（可选）

```dockerfile
FROM node:18-slim

RUN apt-get update && apt-get install -y \
    build-essential \
    python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --production

COPY . .
EXPOSE 3000

CMD ["node", "server.js"]
```

```bash
# 构建镜像
docker build -t multi-terminal .

# 运行容器
docker run -d \
  --name multi-terminal \
  -p 3000:3000 \
  --restart unless-stopped \
  multi-terminal
```

## 安全建议

1. **使用 HTTPS** - 防止流量被劫持
2. **添加认证** - 终端访问应受限
3. **限制网络** - 仅允许可信 IP 访问
4. **定期更新** - 保持依赖最新

### 添加基础认证

```nginx
# 创建密码文件
sudo apt-get install apache2-utils
sudo htpasswd -c /etc/nginx/.htpasswd admin

# Nginx 配置添加
location / {
    auth_basic "Multi-Terminal";
    auth_basic_user_file /etc/nginx/.htpasswd;
    # ... 其他配置
}
```

## 故障排查

### node-pty 编译失败

```bash
# 确保安装了编译工具
sudo apt-get install -y build-essential python3

# 清理并重新安装
rm -rf node_modules
npm install
```

### WebSocket 连接失败

检查 Nginx 是否正确配置了 WebSocket 支持：
- `proxy_set_header Upgrade $http_upgrade;`
- `proxy_set_header Connection "upgrade";`

### 端口被占用

```bash
# 查看端口占用
sudo lsof -i :3000

# 杀死进程
sudo kill -9 <PID>
```