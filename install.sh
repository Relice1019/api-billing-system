#!/bin/bash

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

show_banner() {
    echo -e "${BLUE}"
    echo "╔══════════════════════════════════════════════════════════════╗"
    echo "║                  API计费系统 一键部署脚本                      ║"
    echo "║  🚀 支持OpenAI、Claude、Gemini等多种模型                      ║"
    echo "║  💰 精确Token计费，实时用量统计                               ║"
    echo "╚══════════════════════════════════════════════════════════════╝"
    echo -e "${NC}"
}

check_requirements() {
    log_info "检查系统要求..."
    if [[ "$OSTYPE" != "linux-gnu"* ]]; then
        log_error "此脚本仅支持Linux系统"
        exit 1
    fi
    
    total_mem=$(free -m | awk 'NR==2{printf "%.0f", $2}' 2>/dev/null || echo "2048")
    if [ $total_mem -lt 1024 ]; then
        log_warning "系统内存不足1GB，推荐至少2GB内存"
    fi
    
    log_success "系统要求检查通过"
}

install_docker() {
    if command -v docker &> /dev/null && command -v docker-compose &> /dev/null; then
        log_success "Docker已安装"
        return
    fi
    
    log_info "安装Docker..."
    
    if command -v apt-get &> /dev/null; then
        apt-get update
        apt-get install -y curl
    elif command -v yum &> /dev/null; then
        yum update -y
        yum install -y curl
    fi
    
    curl -fsSL https://get.docker.com | sh
    systemctl start docker
    systemctl enable docker
    usermod -aG docker $USER
    
    curl -L "https://github.com/docker/compose/releases/download/v2.20.0/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
    chmod +x /usr/local/bin/docker-compose
    
    log_success "Docker安装完成"
    log_warning "请重新登录后再次运行此脚本"
    exit 0
}

generate_password() {
    openssl rand -hex 16 2>/dev/null || echo "$(date +%s)$(shuf -i 1000-9999 -n 1)"
}

setup_environment() {
    log_info "配置环境变量..."
    
    if [ -f ".env" ]; then
        read -p "检测到现有配置，是否覆盖? (y/N): " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            log_info "跳过环境变量配置"
            return
        fi
    fi
    
    # 生成安全的随机密码
    DB_PASSWORD=$(generate_password)
    REDIS_PASSWORD=$(generate_password)
    JWT_SECRET=$(openssl rand -hex 32 2>/dev/null || echo "$(date +%s)SecureJWTSecret$(shuf -i 10000-99999 -n 1)")
    NEWAPI_SESSION_SECRET=$(generate_password)
    
    # 获取用户输入
    echo
    log_info "请输入以下配置信息 (可选，直接回车跳过):"
    read -p "域名: " DOMAIN
    read -p "New API管理员Token: " NEWAPI_TOKEN
    
    # 直接创建.env文件，避免sed特殊字符问题
    cat > .env << EOF
# 数据库配置
DB_HOST=postgres
DB_PORT=5432
DB_NAME=api_billing
DB_USER=postgres
DB_PASSWORD=${DB_PASSWORD}

# Redis配置
REDIS_HOST=redis
REDIS_PORT=6379
REDIS_PASSWORD=${REDIS_PASSWORD}

# 应用配置
NODE_ENV=production
PORT=3001
JWT_SECRET=${JWT_SECRET}

# New API配置
NEWAPI_URL=http://newapi:3000
NEWAPI_TOKEN=${NEWAPI_TOKEN}
NEWAPI_SESSION_SECRET=${NEWAPI_SESSION_SECRET}

# 域名配置
DOMAIN=${DOMAIN:-your-domain.com}
EOF
    
    log_success "环境变量配置完成"
}

start_services() {
    log_info "启动服务..."
    
    mkdir -p nginx/ssl data/{postgres,redis,newapi}
    
    docker-compose up -d --build
    
    log_info "等待服务启动..."
    sleep 30
    
    # 检查服务状态
    if docker-compose ps | grep -q "Up"; then
        log_success "服务启动成功!"
    else
        log_error "服务启动失败，请检查日志"
        docker-compose logs --tail=50
        exit 1
    fi
}

show_deployment_info() {
    local_ip=$(hostname -I | awk '{print $1}' 2>/dev/null || echo "localhost")
    
    echo
    log_success "🎉 API计费系统部署完成!"
    echo
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo -e "${GREEN}📊 管理后台:${NC} http://$local_ip"
    echo -e "${GREEN}🔗 API地址:${NC} http://$local_ip/v1"
    echo -e "${GREEN}🏥 健康检查:${NC} http://$local_ip/health"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo
    echo -e "${YELLOW}📝 下一步操作:${NC}"
    echo "1. 访问管理后台注册账户"
    echo "2. 生成API密钥"
    echo "3. 开始使用API服务"
    echo
    echo -e "${YELLOW}📚 常用命令:${NC}"
    echo "• 查看服务状态: docker-compose ps"
    echo "• 查看日志: docker-compose logs -f"
    echo "• 停止服务: docker-compose stop"
    echo "• 重启服务: docker-compose restart"
}

main() {
    show_banner
    
    case "${1:-}" in
        "--help"|"-h")
            echo "使用方法: $0 [选项]"
            echo "选项:"
            echo "  --help, -h     显示此帮助信息"
            exit 0
            ;;
    esac
    
    if [ ! -f "docker-compose.yml" ]; then
        log_error "请在项目根目录中运行此脚本"
        exit 1
    fi
    
    check_requirements
    install_docker
    setup_environment
    start_services
    show_deployment_info
}

trap 'log_error "安装失败，正在清理..."; docker-compose down 2>/dev/null || true; exit 1' ERR

main "$@"
