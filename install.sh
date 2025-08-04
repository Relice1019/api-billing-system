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
    log_success "系统要求检查通过"
}

install_docker() {
    if command -v docker &> /dev/null && command -v docker-compose &> /dev/null; then
        log_success "Docker已安装"
        return
    fi
    
    log_info "安装Docker..."
    curl -fsSL https://get.docker.com | sh
    sudo systemctl start docker
    sudo systemctl enable docker
    sudo usermod -aG docker $USER
    
    sudo curl -L "https://github.com/docker/compose/releases/download/v2.20.0/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
    sudo chmod +x /usr/local/bin/docker-compose
    
    log_success "Docker安装完成"
    log_warning "请重新登录后再次运行此脚本"
    exit 0
}

generate_password() {
    openssl rand -base64 32 | tr -d "=+/" | cut -c1-25
}

setup_environment() {
    log_info "配置环境变量..."
    
    if [ -f ".env" ]; then
        read -p "检测到现有配置，是否覆盖? (y/N): " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            return
        fi
    fi
    
    cp .env.example .env
    
    DB_PASSWORD=$(generate_password)
    REDIS_PASSWORD=$(generate_password)
    JWT_SECRET=$(openssl rand -base64 64 | tr -d "\n")
    NEWAPI_SESSION_SECRET=$(generate_password)
    
    sed -i "s/your_very_secure_db_password_123456/$DB_PASSWORD/g" .env
    sed -i "s/your_very_secure_redis_password_123456/$REDIS_PASSWORD/g" .env
    sed -i "s/your_very_long_jwt_secret_at_least_64_characters_long_please_change_this_to_random_string/$JWT_SECRET/g" .env
    sed -i "s/your_newapi_session_secret_change_this/$NEWAPI_SESSION_SECRET/g" .env
    
    log_success "环境变量配置完成"
}

start_services() {
    log_info "启动服务..."
    
    mkdir -p nginx/ssl data/{postgres,redis,newapi}
    
    docker-compose up -d --build
    
    log_info "等待服务启动..."
    sleep 30
    
    if docker-compose ps | grep -q "Up"; then
        log_success "服务启动成功!"
    else
        log_error "服务启动失败"
        docker-compose logs
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
    echo -e "${YELLOW}下一步操作:${NC}"
    echo "1. 访问管理后台注册账户"
    echo "2. 生成API密钥"
    echo "3. 开始使用API服务"
}

main() {
    show_banner
    
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
