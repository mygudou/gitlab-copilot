# GitLab AI Copilot 开发者指南

## 🚀 环境准备

### 系统要求
- **Node.js** >= 16.0.0
- **npm** 或 yarn
- **Git**
- **MongoDB** (多租户模式)
- **AI CLI 工具** (Claude Code CLI 或 Codex CLI)

### 开发工具安装
```bash
# 克隆项目
git clone <repository-url>
cd gitlab-copilot

# 安装依赖
npm install

# 安装 AI CLI 工具
# Claude
npm install -g @anthropic-ai/claude-code

# 登录 Claude (如果需要)
claude login
```

## 📦 依赖安装

### 项目依赖
**核心依赖** (package.json 中定义)：
- `@gitbeaker/node` - GitLab API 客户端
- `express` - Web 框架
- `mongodb` - 数据库驱动
- `bcrypt` - 密码加密
- `jsonwebtoken` - JWT 认证
- `express-rate-limit` - 限流中间件
- `winston` - 日志系统

### 开发依赖
- `typescript` - TypeScript 编译器
- `jest` - 测试框架
- `eslint` - 代码检查
- `prettier` - 代码格式化

## 🛠️ 常用脚本

### 构建与开发
```bash
# 开发模式 (热重载)
npm run dev

# 构建项目
npm run build

# 生产环境启动
npm start
```

### 代码质量
```bash
# 代码检查
npm run lint
npm run lint:fix

# 代码格式化
npm run format:check

# 类型检查
npm run type-check
```

### 测试脚本
```bash
# 运行所有测试
npm test

# 运行特定测试
npm run test:security      # 安全测试
npm run test:integration   # 集成测试
npm run test:e2e          # 端到端测试
npm run test:performance   # 性能测试

# 测试覆盖率
npm run test:coverage

# 持续集成测试
npm run test:ci
```

### 数据库管理
```bash
# 创建数据库索引
npm run db:indexes

# 设置用户
npm run setup-user -- \
  --email user@example.com \
  --name "Demo User" \
  --gitlab-url https://gitlab.com \
  --pat your_gitlab_token

# 迁移配置令牌
npm run migrate-config-tokens
```

## 🔧 调试方式

### 开发环境调试
```bash
# 启用调试日志
LOG_LEVEL=debug npm run dev

# 配置调试
npm run config:debug
```

## ⚙️ 配置约定

### 环境变量配置
**基础配置** (.env 文件)：
```bash
# GitLab 配置
GITLAB_BASE_URL=https://gitlab.com
GITLAB_TOKEN=your_gitlab_token
WEBHOOK_SECRET=your_webhook_secret

# AI 配置
AI_EXECUTOR=claude
ANTHROPIC_AUTH_TOKEN=your_anthropic_token

# 服务配置
PORT=3000
WORK_DIR=/tmp/gitlab-copilot-work
LOG_LEVEL=info

# MongoDB 配置 (多租户模式)
MONGODB_URI=mongodb://user:pass@host:20000/?authSource=admin
MONGODB_DB=gitlab-copilot
ENCRYPTION_KEY=your_32_byte_encryption_key
```

### Session 管理配置
```bash
# Session 配置
SESSION_ENABLED=true
SESSION_MAX_IDLE_TIME=7d
SESSION_MAX_SESSIONS=1000
SESSION_CLEANUP_INTERVAL=1h
SESSION_STORE_PATH=/tmp/gitlab-copilot-work/sessions.json
```

### Web UI 配置
```bash
# Web UI 配置
WEB_UI_ENABLED=true
WEB_UI_BASE_PATH=/auth
JWT_SECRET=your_jwt_secret
```

## 🔌 扩展点

### 1. AI Provider 扩展
**位置**：`src/services/providers/`
- `claudeAdapter.ts` - Claude 适配器
- `codexAdapter.ts` - Codex 适配器
- `providerAdapter.ts` - Provider 适配器

**实现方式**：
- 继承 `ProviderAdapter` 基类
- 实现 `execute` 和 `executeWithSession` 方法

### 2. 存储层扩展
**位置**：`src/services/storage/`
- `eventRepository.ts` - 事件存储
- `userRepository.ts` - 用户存储
- `gitlabConfigRepository.ts` - GitLab 配置存储

### 3. 中间件扩展
**位置**：`src/middleware/`
- `auth.ts` - 认证中间件
- `validation.ts` - 验证中间件

### 4. 路由扩展
**位置**：`src/routes/`
- `auth.ts` - 认证路由
- `gitlab-config.ts` - GitLab 配置路由
- `usage-stats.ts` - 使用统计路由

## 📁 项目结构说明

### 源码目录 (src/)
```
src/
├── server/           # 服务器相关
│   ├── webhookServer.ts
│   └── __tests__/
├── services/         # 业务逻辑服务
│   ├── eventProcessor.ts
│   ├── sessionManager.ts
│   ├── aiExecutor.ts
│   ├── streamingAiExecutor.ts
│   ├── projectManager.ts
│   └── storage/      # 数据存储
├── routes/           # API 路由
├── middleware/       # 中间件
├── utils/            # 工具函数
├── types/            # TypeScript 类型定义
└── __tests__/        # 测试文件
```

### 测试目录结构
```
src/__tests__/
├── enhanced-events.test.ts
├── mongoClient.test.ts
├── integration/      # 集成测试
│   └── auth-workflow.test.ts
├── e2e/              # 端到端测试
│   └── auth-flow.test.ts
├── performance/      # 性能测试
│   └── auth-performance.test.ts
└── __tests__/       # 测试的测试
```

## 🎯 开发最佳实践

### 代码规范
- **TypeScript 严格模式**：确保类型安全
- **ESLint 规则**：遵循项目代码风格
- **Prettier 格式化**：统一代码格式

### 测试策略
- **单元测试**：覆盖核心业务逻辑
- **集成测试**：验证模块间协作
- **E2E 测试**：完整工作流验证

### 提交规范
- **约定式提交**：feat/fix/docs 等前缀
- **代码审查**：基于 `CODE_REVIEW_GUIDELINES.md`

## 🔍 调试技巧

### 日志分析
```bash
# 查看实时日志
docker-compose logs -f gitlab-copilot

# 查看错误日志
docker-compose logs gitlab-copilot | grep ERROR
```

### 性能监控
```bash
# 健康检查
curl http://localhost:3000/health

# 性能测试
npm run test:performance
```

## 📊 监控指标

### 关键指标
- **服务可用性** (HTTP 200 响应)
- **内存使用率** (< 80%)
- **Session 数量** (< 配置的最大值)
- **错误日志频率**
- **AI 执行成功率**

## 🛡️ 安全考虑

### 敏感信息处理
- **加密存储**：GitLab Token 等敏感信息使用 AES-256 加密
- **Webhook 签名验证**：确保请求来源可信
- **权限控制**：基于 JWT 的认证系统

### 数据隔离
- **多租户架构**：MongoDB + 加密存储
- **租户数据完全隔离**：企业级安全标准

## 🔄 持续集成

### CI/CD 流程
1. **代码检查**：ESLint + Prettier
2. **测试覆盖**：单元测试 + 集成测试 + E2E 测试
- **自动化部署**：Docker + Kubernetes
- **质量门禁**：测试覆盖率 + 代码质量检查
