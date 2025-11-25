# CLAUDE.md
language_preference: 中文

本文件为 Claude Code (claude.ai/code) 提供在本仓库中工作时的指导。

## 开发命令

```bash
# 构建项目
npm run build

# 开发模式（热重载，需要非 root 权限）
npm run dev

# 代码检查
npm run lint

# 运行测试
npm test                      # 运行所有测试
npm run test:watch            # 监听模式运行测试
npm run test:coverage         # 运行测试并生成覆盖率报告
npm run test:security         # 运行安全测试
npm run test:integration      # 运行集成测试
npm run test:e2e              # 运行端到端测试
npm run test:performance      # 运行性能测试
npm run test:all              # 运行所有测试套件
npm run test:ci               # CI 环境测试

# 类型检查和代码格式化
npm run type-check            # TypeScript 类型检查
npm run format:check          # 检查代码格式

# 数据库操作
npm run db:indexes            # 创建数据库索引

# 多租户设置
npm run setup-user            # 创建或更新租户用户

# 生产环境启动
npm start

# Docker 开发
docker-compose up -d
docker-compose logs -f gitlab-copilot
```

## 架构概览

这是一个 GitLab webhook 服务，集成 Claude Code CLI，直接从 GitLab issues、merge requests 和评论中提供 AI 驱动的代码辅助。

### 工作区与会话策略

- **工作区分配**
  - Issues 和长对话复用 `workspaceId = projectId:issueIid[:ownerId]`
  - Merge Requests 对*所有* MR 相关操作（评论修复、自动审查等）复用 `workspaceId = mr:<projectId>:<mrIid>`，确保共享 git 状态
  - 仅当处理程序显式禁用会话时才回退到一次性工作区（当前流程不使用此路径）
- **会话处理**
  - `executeWithSession` 用于 Issue 对话*和* MR 评论；`SessionManager` 持久化 `sessionId`、讨论元数据和分支/基础分支，以便重复的 @codex 请求同时复用代码和对话上下文
  - 代码审查运行通过 `executeWithStreaming` 有意保持无状态（每次审查重新分析当前差异）
- **清理维护**
  - `WorkspaceCleanupService` 根据 `WORKSPACE_MAX_IDLE_TIME` / `WORKSPACE_CLEANUP_INTERVAL` 清理空闲工作区
  - 当会话失效时（例如，Claude 对话过期），处理器会移除它并使用新会话重试

### 核心流程

1. **Webhook 接收** (`src/server/webhookServer.ts`) - Express 服务器接收 GitLab webhooks
2. **事件处理** (`src/services/eventProcessor.ts`) - 主协调器，提取 `@claude` 指令并管理工作流
3. **项目管理** (`src/services/projectManager.ts`) - 处理 git 操作、克隆和分支管理
4. **Claude 执行** (`src/services/streamingClaudeExecutor.ts`) - 执行 Claude Code CLI 并提供流式进度更新
5. **MR 生成** (`src/utils/mrGenerator.ts`) - 创建智能合并请求，包含约定式提交标题和结构化描述
6. **GitLab 集成** (`src/services/gitlabService.ts`) - 处理所有 GitLab API 交互

### 关键组件

**EventProcessor** - 中央协调器：

- 使用 `@claude` 模式从 webhook 事件中提取 Claude 指令
- 为 Claude 更改创建基于时间戳的分支
- 管理从指令到创建合并请求的完整工作流
- 通过 GitLab 评论提供实时反馈

**StreamingClaudeExecutor** - 执行 Claude Code CLI：

- 实时进度流式传输回 GitLab
- 自动更改检测和 git 操作
- 增强的错误处理和调试能力
- 全面的日志记录以排查间歇性执行失败

**MRGenerator** - 智能合并请求创建：

- 分析指令内容和文件更改以确定类型（feat、fix、docs 等）
- 从文件路径自动检测范围
- 生成约定式提交格式的标题
- 创建包含测试清单的结构化描述

**ProjectManager** - Git 操作包装器：

- 将仓库克隆到临时目录
- 处理分支创建和切换
- 管理提交和推送并进行适当清理

## 环境配置

### 必需环境变量

**MongoDB 配置**：
- `MONGODB_URI` - MongoDB 连接字符串
- `MONGODB_DB` - 数据库名称（如 `gitlab-copilot`）
- `ENCRYPTION_KEY` - 32 字节十六进制加密密钥
  - 生成方法：`openssl rand -hex 32`

**Web UI 配置**：
- `WEB_UI_ENABLED` (默认: true) - 启用 Web 管理界面
- `JWT_SECRET` - JWT 密钥
  - 生成方法：`openssl rand -base64 32`

**AI 提供商配置**：
- `AI_EXECUTOR` (默认: claude) - 用于 Issue 对话、代码修改等常规任务的默认 AI
  - 可选值: 'claude' 或 'codex'
  - 用户可通过 `@claude` 或 `@codex` 在每次请求时覆盖
- `CODE_REVIEW_EXECUTOR` (默认: codex) - 专门用于 MR 自动代码审查的默认 AI
  - 可选值: 'claude' 或 'codex'
  - 同样支持通过提及覆盖

### 可选环境变量

**AI API 配置**：
- `ANTHROPIC_AUTH_TOKEN` - Anthropic API 令牌（可选，依赖 `claude login` 本地凭证时可跳过）
- `ANTHROPIC_BASE_URL` (默认: https://api.anthropic.com)

**服务配置**：
- `PORT` (默认: 3000)
- `WORK_DIR` (默认: /tmp/gitlab-copilot-work)
- `LOG_LEVEL` (默认: info)

**会话管理配置**：
- `SESSION_ENABLED` (默认: true) - 启用/禁用长交互会话
- `SESSION_MAX_IDLE_TIME` (默认: 7d) - 会话过期前的最大空闲时间
- `SESSION_MAX_SESSIONS` (默认: 1000) - 并发会话的最大数量
- `SESSION_CLEANUP_INTERVAL` (默认: 1h) - 会话清理任务的频率

**工作区清理配置**：
- `WORKSPACE_MAX_IDLE_TIME` (默认: 24h) - 工作区清理前的最大空闲时间
- `WORKSPACE_CLEANUP_INTERVAL` (默认: 6h) - 工作区清理任务的频率

**注意事项**：
- 当省略 `ANTHROPIC_AUTH_TOKEN` 时，确保服务在已执行 `claude login` 的用户账户下运行
- 所有 GitLab 凭证通过 Web UI 配置，存储在 MongoDB 中并加密

## GitLab Webhook 设置

### 1. 通过 Web UI 配置

访问 Web 管理界面：`http://your-domain:3000/auth/`

- 注册并登录账号
- 在「GitLab 配置」页面添加配置：
  - GitLab URL（如 `https://gitlab.com`）
  - Personal Access Token（需要权限：`api`, `read_repository`, `write_repository`）
  - 描述（可选）
- 系统自动生成：
  - Webhook Secret（加密存储在 MongoDB）
  - 唯一的 Webhook URL：`https://your-domain.com/webhook/{userToken}`

### 2. 在 GitLab 项目中配置 Webhook

进入 GitLab 项目 → Settings → Webhooks：
- **URL**: 使用 Web UI 中生成的完整 Webhook URL
- **Secret Token**: 使用 Web UI 中显示的 Webhook Secret
- **触发器**: 勾选以下事件
  - Issues events
  - Merge request events
  - Comments (Issue comments, MR comments)
- **启用**: Enable SSL verification

### 支持的 AI 指令

服务在以下位置检测 AI 指令：

- Issue 描述和评论：支持 `@claude`、`@codex`、`/spec`、`/plan`、`/tasks`
- Merge request 描述和评论：支持 `@claude`、`@codex`
- 任何 webhook 事件内容

**智能 Issue 指令识别**：
- **代码开发模式**：`@claude`、`@codex` 或不加任何前缀（默认使用 Claude）
- **文档规范模式**：`/spec`、`/plan`、`/tasks` 触发 Spec Kit 工作流，强制使用 Claude
- **AI 选择策略**：文档模式不支持 `@codex`，强制使用 Claude；代码开发模式可自由选择 AI
- **上下文捕获**：服务捕获完整的上下文（指令前后的文本）以为 AI 处理提供更丰富的上下文

## Claude Code CLI 集成

服务需要安装并可访问 Claude Code CLI。对于 Docker 部署，它在容器中全局安装。对于本地开发，使用以下命令安装：

```bash
npm install -g @anthropic-ai/claude-code
```

**重要**：由于 Claude Code 的 `--dangerously-skip-permissions` 参数要求，必须使用非 root 权限运行。

## 分支和 MR 工作流

### 智能 Issue 双模式系统

#### 🚀 代码开发模式 (`@claude` / `@codex` / 默认)
1. 服务创建时间戳分支（格式：`claude-YYYYMMDDTHHMMSS-XXXXXX`）
2. Claude Code CLI 在项目上下文中执行
3. 更改被提交并推送到新分支
4. 创建智能合并请求：
   - 约定式提交标题（例如，`feat(api): add user authentication`）
   - 包含更改分类的结构化描述
   - 适合更改类型的测试清单
5. 进度更新以评论形式流式传输回原始 GitLab issue

#### 📋 文档规范模式 (`/spec` / `/plan` / `/tasks`)
1. **Spec Kit 检测**：自动检查项目是否已初始化 Spec Kit（存在 `.specify` 目录）
2. **自动初始化**：如果未初始化，自动执行 `specify init` 创建基础配置
3. **文档生成**：调用相应的 Spec Kit 命令：
   - `/spec` → `/speckit.specify` 生成需求规范文档
   - `/plan` → `/speckit.plan` 生成实施计划文档
   - `/tasks` → `/speckit.tasks` 生成任务清单文档
4. **分支和提交**：创建时间戳分支，提交生成的文档
5. **MR 创建**：创建用于文档评审的合并请求
6. **文档展示**：在 Issue 中直接展示生成的文档内容
7. **状态管理**：自动跟踪和管理不同阶段的文档状态

**重要说明**：文档规范模式强制使用 Claude，不支持 `@codex`。这是因为 Spec Kit 工作流需要 Claude 的特定能力和指令集成。

**Spec Kit 集成特性**：
- **智能检测**：自动识别项目 Spec Kit 初始化状态
- **无缝集成**：原生集成 GitHub Spec Kit 工作流
- **文档管理**：自动收集 `specs/` 目录下的 Markdown 文档
- **状态跟踪**：跟踪 `spec`、`plan`、`tasks` 三个阶段的文档状态
- **上下文保持**：在同一 Issue 中保持文档开发的连续性

### MR 评论
1. Claude Code CLI 在 MR 的源分支上下文中执行
2. 更改被提交并直接推送到源分支
3. 现有合并请求自动更新
4. 进度更新以评论形式流式传输到 MR
5. 不创建新分支或合并请求

## 代码审查功能

### 自动代码审查
- **新 MRs**：
  - 当提及 `@claude` 或 `@codex` 时,使用指定的 AI 进行代码审查
  - 如果没有显式提及任何 AI,使用 `CODE_REVIEW_EXECUTOR` 配置的默认 AI 进行代码审查（默认为 `@codex`）
  - 不需要审查关键字,只要是新建的 MR 就会触发
- **重新打开的 MRs**：
  - 当提及 `@claude` 或 `@codex` 时,使用指定的 AI 进行代码审查
  - 如果没有显式提及任何 AI,使用 `CODE_REVIEW_EXECUTOR` 配置的默认 AI 进行代码审查（默认为 `@codex`）
  - 不需要审查关键字,只要是重新打开的 MR 就会触发
- **更新的 MRs**：所有 `@claude`/`@codex` 提及都被忽略（完全不处理）
- 审查遵循 `CODE_REVIEW_GUIDELINES.md` 中定义的项目特定指南

### MR 评论代码更改
- **MR 评论**：当在合并请求评论中使用 `@claude` 时，Claude 将直接修改源分支
- 更改被提交并自动推送到 MR 的源分支
- 合并请求自动更新为新更改
- 不为基于评论的修改创建新分支或合并请求
- 由于历史分歧导致的推送失败会触发自动 `git pull --rebase`，随后进行 AI 驱动的冲突解决尝试；未解决的冲突会返回给用户并列出受影响的文件

### 审查指南
服务使用来自 `CODE_REVIEW_GUIDELINES.md` 的项目特定代码审查指南，包括：
- TypeScript/Node.js 最佳实践
- 安全漏洞检测
- 性能优化建议
- GitLab webhook 集成模式
- 测试要求和覆盖率

### 审查输出格式
审查以以下格式提供结构化反馈：
```
**文件:** path/to/file.ts
**行号:** 123
**评论:** 问题描述和建议
**严重性:** error|warning|info
**类别:** security|performance|style|logic|maintainability|testing
```

## 关键文件位置

- `/src/types/gitlab.ts` - GitLab webhook 事件类型定义
- `/src/types/common.ts` - 共享接口（ProcessResult、FileChange）
- `/src/utils/webhook.ts` - Webhook 签名验证和指令提取
- `/src/utils/config.ts` - 环境配置加载
- `/src/utils/logger.ts` - 基于 Winston 的日志配置

## 故障排除

### 常见问题

**Spec Kit 执行失败**：
- 检查服务器上是否已安装 Spec Kit CLI：`specify --version`
- 如果未安装，请执行：`uv tool install specify-cli --from git+https://github.com/github/spec-kit.git`
- 确认 `specify` 命令已加入 PATH
- 检查项目目录权限，确保有权限创建 `.specify` 目录
- 查看日志以获取具体的初始化错误信息

**Claude Code 执行失败**：
- 检查日志以获取详细错误信息和执行上下文
- 验证 Claude Code CLI 是否正确安装（`claude --version`）
- 如果使用 API 令牌，确保 `ANTHROPIC_AUTH_TOKEN` 有效且有足够的额度
- 如果依赖本地登录，为运行服务的同一用户账户重新运行 `claude login`
- 查看执行日志以了解身份验证或网络问题

**间歇性"执行错误"消息**：
- **已修复**：问题是由激进的探索系统提示引起的，该提示强制 Claude 探索整个项目结构，导致大型仓库超时
- **已修复**：移除了可能导致参数解析问题的 `Bash(git:*)` 工具限制
- **已修复**：简化了系统提示以避免导致超时的强制探索
- 增强的日志记录捕获 Claude Code stdout/stderr 以进行调试
- 使用 `LOG_LEVEL=debug` 检查服务日志以获取详细的执行跟踪
- 验证系统资源和网络连接

**权限问题**：
- 服务必须使用非 root 权限运行
- 确保工作目录的正确文件系统权限
- Docker 容器应使用非 root 用户

## Docker 部署

服务已容器化并包括：

- `/health` 端点上的健康检查
- 临时工作目录的正确卷挂载
- 具有自定义子网的网络隔离
- 自动重启策略

### AI 认证配置

Docker 容器内需要配置 AI CLI 工具的认证：

**Claude 认证**:

1. **使用 API Token（推荐）**: 在 `.env` 文件中配置
   ```bash
   ANTHROPIC_AUTH_TOKEN=sk-ant-your-api-key
   ```
   从 [Anthropic Console](https://console.anthropic.com/) 获取，重启容器生效。

2. **Docker 内部登录**: 进入容器执行
   ```bash
   docker exec -it gitlab-copilot claude login
   ```

3. **挂载本地认证文件**: 在 docker-compose.yml 中取消注释
   ```yaml
   - ~/.claude:/home/node/.claude:ro
   ```

**Codex 认证**:

1. **复制认证文件（推荐）**:
   ```bash
   # 本地登录生成认证文件
   codex auth login

   # 复制到容器
   docker cp ~/.codex/auth.json gitlab-copilot:/home/node/.codex/auth.json
   ```

2. **挂载本地认证文件**: 在 docker-compose.yml 中取消注释
   ```yaml
   - ~/.codex:/home/node/.codex:ro
   ```

**注意**:
- Claude 推荐使用 API Token 方式，更简单
- Codex 需要复制或挂载 `auth.json` 文件
- 容器内路径: `/home/node/.claude/` 和 `/home/node/.codex/`

## 多租户设置

### 快速设置新租户

使用 CLI 工具快速创建新租户：

```bash
# 创建新租户
npm run setup-user -- \
  --email user@example.com \
  --name "Demo User" \
  --gitlab-url https://gitlab.com \
  --pat your_gitlab_personal_access_token

# 更新现有租户的 GitLab token
npm run setup-user -- \
  --user-token existing_user_token \
  --pat new_gitlab_token
```

创建成功后，该租户的 webhook URL 为：
```
https://your-domain.com/webhook/{userToken}
```

### 数据库索引管理

确保数据库性能的关键索引：

```bash
# 创建所有必要的数据库索引
MONGODB_URI='your_connection_string' \
MONGODB_DB='gitlab-copilot' \
npm run db:indexes
```

这将创建以下索引：
- users 集合：email (唯一)、userToken (唯一)
- workspaces 集合：workspaceId (唯一)、lastUsed
- sessions 集合（如使用 MongoDB 存储）

## 引导文档

引导文档为在此代码库中工作的 AI 代理提供额外的项目特定指导。

### 可用的引导文档

- **中文语言** (`.claude/steering/chinese-language.md`) - 中文语言使用规范，所有交流、注释、文档必须使用中文
