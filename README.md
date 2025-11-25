# GitLab AI Copilot 🤖

<div align="center">

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D16.0.0-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-4.9+-blue.svg)](https://www.typescriptlang.org/)

**将 AI 助手深度集成到 GitLab 工作流**

在 GitLab Issue 和 MR 中直接使用 `@claude` / `@codex`，实现智能化代码开发、审查和协作

[快速开始](#-快速开始) • [核心特性](#-核心特性) • [部署指南](#-部署指南) • [使用文档](#-使用文档)

</div>

---

## 📖 项目简介

GitLab AI Copilot 通过 GitLab Webhook 将 AI 代码助手（Claude、Codex 等）原生集成到 GitLab 平台，让 AI 成为团队开发流程的一部分。

### ✨ 为什么选择它？

- **零上下文切换**: 直接在 Issue/MR 中与 AI 对话，无需切换工具
- **团队协作友好**: 所有 AI 交互记录在 GitLab 中，透明可追溯
- **自动化工作流**: AI 自动创建分支、提交代码、生成 MR
- **长交互支持**: AI 记住上下文，支持多轮对话式开发

## 🚀 核心特性

### 1. 智能 Issue 处理

#### 代码开发模式
```markdown
# 在 GitLab Issue 中
@claude 添加用户认证功能，包括 JWT、密码加密和权限中间件
```

AI 自动完成：
- ✅ 生成代码
- ✅ 创建时间戳分支
- ✅ 提交并推送代码
- ✅ 创建符合约定式提交规范的 MR

#### 文档规范模式
```markdown
# 在 GitLab Issue 中
/spec 为用户认证功能编写完整的技术规范文档
/plan 制定实施计划
/tasks 生成开发任务清单
```

集成 [Spec Kit](https://github.com/github/spec-kit) 工作流，自动生成结构化文档。

### 2. 自动代码审查

```markdown
# 创建 MR 时（无需任何操作）
AI 自动:
✅ 分析代码变更
✅ 提供结构化反馈（按文件/行号/严重性分类）
✅ 生成 MR Summary（变更概要、影响分析）
✅ 修复不规范的 MR 标题
```

### 3. MR 内直接修复

```markdown
# 在 MR 评论中
@claude 根据审查意见修复安全问题，并添加输入验证

AI 自动:
✅ 修改代码并提交到 MR 源分支
✅ 推送更改，MR 自动更新
✅ 无需创建新分支或新 MR
```

### 4. 多 AI 协同

```markdown
@claude 重构这个模块，提高可读性
@codex 优化性能
```

- 支持 Claude、Codex 等多种 AI
- 每个 AI 维护独立的对话上下文
- 根据任务特点灵活选择

### 5. 企业级多租户

- MongoDB 数据隔离 + 加密存储
- Web 管理界面，可视化配置
- 独立使用统计和 Webhook URL

## 🏗️ 技术架构

```
GitLab Webhook → Event Processor → Session Manager → AI Executor → Git Operations → MR Generator
```

**核心组件**:
- **Session Manager**: 长交互会话管理，记住对话上下文
- **Workspace Manager**: 智能工作区复用，节省资源
- **AI Executor**: 支持多种 AI，流式进度更新
- **GitLab Service**: 完整的 GitLab API 集成

## 🎯 快速开始

### 前置要求

- Node.js >= 16.0.0
- Git
- MongoDB（多租户模式）
- Claude Code CLI（`npm install -g @anthropic-ai/claude-code`）

### 安装步骤

1. **克隆项目**
   ```bash
   git clone https://github.com/your-org/gitlab-copilot.git
   cd gitlab-copilot
   ```

2. **安装依赖**
   ```bash
   npm install
   ```

3. **配置环境**
   ```bash
   cp .env.example .env
   # 编辑 .env 文件
   ```

4. **启动服务**
   ```bash
   npm run dev
   ```

5. **配置 GitLab**

   访问 Web 管理界面进行配置：
   ```
   http://localhost:3000/auth/
   ```

   - 注册账号并登录
   - 在「GitLab 配置」页面添加 GitLab 凭证：
     - GitLab URL: `https://gitlab.com`
     - Personal Access Token: 你的 GitLab PAT
     - 系统会自动生成 Webhook Secret
   - 复制生成的 Webhook URL（格式：`https://your-domain.com/webhook/{userToken}`）
   - 在 GitLab 项目设置中配置 Webhook：
     - URL: 使用上面复制的 Webhook URL
     - Secret Token: 使用自动生成的 Secret
     - 触发器: Issues events, Merge request events, Comments

### Docker 部署

**基础部署**

```bash
docker-compose up -d
```

**配置 AI 认证**

Docker 容器内需要配置 AI CLI 工具的认证信息：

<details>
<summary><strong>Claude 认证配置</strong></summary>

**方法 1: 使用 API Token（推荐）**

在 `.env` 文件中配置 Anthropic API Token：

```bash
ANTHROPIC_AUTH_TOKEN=sk-ant-your-anthropic-api-key-here
```

从 [Anthropic Console](https://console.anthropic.com/) 获取 API Key，重启容器后生效。

**方法 2: Docker 内部登录**

进入容器执行 `claude login`：

```bash
docker exec -it gitlab-copilot claude login
```

**方法 3: 挂载本地认证文件**

如果本地已登录，可以挂载认证文件（在 docker-compose.yml 中取消注释）：

```yaml
volumes:
  - ~/.claude:/home/node/.claude:ro
```

</details>

<details>
<summary><strong>Codex 认证配置（推荐方法）</strong></summary>

```bash
# 1. 在本地机器上先登录 Codex 获取认证文件
codex auth login
# 这会生成 ~/.codex/auth.json

# 2. 将认证文件复制到容器中
docker cp ~/.codex/auth.json gitlab-copilot:/home/node/.codex/auth.json

# 3. 验证认证是否成功
docker exec -it gitlab-copilot codex --version

# 方法 2: 通过 docker-compose.yml 挂载（更方便）
# 在 docker-compose.yml 中添加：
volumes:
  - ~/.codex:/home/node/.codex:ro
```

**注意**:
- 认证文件路径为容器内的 `~/.codex/auth.json`
- 如果使用挂载方式，本地修改认证文件后容器内会自动更新
- 建议使用只读模式 (`:ro`) 挂载以提高安全性
</details>

## ⚙️ 环境配置

### 必需配置

```bash
# MongoDB 配置
MONGODB_URI=mongodb://user:pass@host:27017/?authSource=admin
MONGODB_DB=gitlab-copilot
ENCRYPTION_KEY=your_32_byte_hex_key   # 生成: openssl rand -hex 32

# Web UI 配置
WEB_UI_ENABLED=true
JWT_SECRET=your_jwt_secret            # 生成: openssl rand -base64 32

# AI 配置（全局默认值）
AI_EXECUTOR=claude                    # 默认 AI（claude 或 codex）
CODE_REVIEW_EXECUTOR=codex            # 代码审查默认 AI

# 服务配置
PORT=3000
LOG_LEVEL=info
```

### 可选配置

```bash
# Session 管理
SESSION_ENABLED=true
SESSION_MAX_IDLE_TIME=7d
SESSION_MAX_SESSIONS=1000
SESSION_CLEANUP_INTERVAL=1h

# 工作区管理
WORKSPACE_MAX_IDLE_TIME=24h
WORKSPACE_CLEANUP_INTERVAL=6h

# Anthropic API（如果需要）
ANTHROPIC_BASE_URL=https://api.anthropic.com
ANTHROPIC_AUTH_TOKEN=your_anthropic_token
```

### 配置流程

1. 复制并编辑配置文件：
   ```bash
   cp .env.example .env
   # 编辑 .env 文件，填入上述必需配置
   ```

2. 启动服务：
   ```bash
   npm run dev
   ```

3. 访问 Web UI 完成 GitLab 配置：
   ```
   http://localhost:3000/auth/
   ```

查看完整配置选项: [CLAUDE.md](CLAUDE.md#环境配置)

## 📖 使用文档

### Issue 中使用 AI

```markdown
# 代码开发
@claude 实现用户登录功能

# 继续对话（AI 会记住上下文）
现在添加单元测试
优化一下性能

# 文档生成
/spec 编写技术规范
/plan 生成实施计划
/tasks 生成任务清单
```

### MR 中使用 AI

```markdown
# 自动审查（创建 MR 时自动触发）
标题: feat(api): add user endpoints

# MR 评论中修复代码
@claude 修复审查中发现的安全问题
```

更多详细示例: [使用指南](CLAUDE.md#使用指南)

## 📊 工作流程示例

### 场景 1: 快速开发
```
产品经理在 Issue 中描述需求
  → @claude 实现功能
  → AI 自动生成代码并创建 MR
  → 开发者 review 并合并
```

### 场景 2: 代码质量保障
```
开发者创建 MR
  → AI 自动审查代码
  → AI 自动修复 MR 标题和生成 Summary
  → 在评论中 @claude 修复问题
  → MR 自动更新
  → 人工最终确认
```

### 场景 3: 文档驱动开发
```
产品经理描述需求
  → /spec 生成技术规范
  → /plan 生成实施计划
  → /tasks 生成任务清单
  → 团队评审并执行
```

## 🛠️ 开发指南

### 项目结构

```
src/
├── server/           # Webhook 服务器
├── services/         # 核心业务逻辑
│   ├── eventProcessor.ts
│   ├── sessionManager.ts
│   ├── aiExecutor.ts
│   └── storage/      # 数据存储
├── routes/           # API 路由
├── middleware/       # 中间件
└── types/            # TypeScript 类型
```

### 开发命令

```bash
npm run dev           # 开发模式（热重载）
npm run build         # 构建项目
npm run lint          # 代码检查
npm test              # 运行测试
npm run type-check    # 类型检查
```

### 测试

```bash
npm test                  # 运行所有测试
npm run test:coverage     # 生成覆盖率报告
npm run test:e2e          # 端到端测试
```

## 🐳 部署

### Docker Compose

```bash
docker-compose up -d
docker-compose logs -f gitlab-copilot
```

## 📚 API 文档

### Webhook 端点

**POST** `/webhook/:userToken?`

接收 GitLab webhook 事件

**Headers:**
- `X-Gitlab-Token`: Webhook 验证令牌
- `X-Gitlab-Event`: 事件类型

### 健康检查

**GET** `/health`

获取服务状态和 Session 统计

更多 API 文档: [API Reference](docs/api.md)

## 🔧 故障排除

<details>
<summary><strong>AI 执行失败</strong></summary>

```bash
# 检查 AI CLI 工具
claude --version
claude auth status

# 查看日志
docker-compose logs gitlab-copilot | grep ERROR

# 重新登录
claude login
```
</details>

<details>
<summary><strong>Webhook 验证失败</strong></summary>

1. 验证 `.env` 中的 `WEBHOOK_SECRET` 与 GitLab 配置一致
2. 检查多租户模式下的 userToken 是否正确
3. 确认防火墙和网络配置
</details>

<details>
<summary><strong>Session 问题</strong></summary>

```bash
# 检查 Session 状态
curl http://localhost:3000/health | jq '.sessions'

# 清理过期 Session
rm /tmp/gitlab-copilot-work/sessions.json
```
</details>

更多问题解决: [故障排除指南](docs/troubleshooting.md)

## 🤝 贡献指南

我们欢迎所有形式的贡献！

1. Fork 项目
2. 创建功能分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m 'feat: add amazing feature'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 创建 Pull Request

请遵循：
- [代码规范](docs/code-style.md)
- [提交规范](docs/commit-convention.md)
- [行为准则](CODE_OF_CONDUCT.md)

## 📄 许可证

本项目采用 MIT 许可证 - 查看 [LICENSE](LICENSE) 文件了解详情。

## 🙏 致谢

- [Anthropic Claude](https://www.anthropic.com/) - AI 能力支持
- [OpenAI Codex](https://openai.com/) - 代码生成和优化
- [GitHub Spec Kit](https://github.com/github/spec-kit) - 文档规范工具
- 所有贡献者 ❤️

## 📞 联系我们

- 📧 Email: mygudou@gmail.com
- 🐛 Issues: [GitHub Issues](https://github.com/mygudou/gitlab-copilot/issues)
- 📖 文档: [完整文档](docs/)

---

<div align="center">

**[⬆ 回到顶部](#gitlab-ai-copilot-)**

Made with ❤️ by the GitLab AI Copilot Community

如果这个项目对你有帮助，请给我们一个 ⭐️

</div>
