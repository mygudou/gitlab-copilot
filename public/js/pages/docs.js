(function() {
  const DocsPage = {
    async init() {
      const app = document.getElementById('app');

      const isAuthenticated = await Navigation.requireAuth();
      if (!isAuthenticated) {
        return;
      }

      this.render();
    },

    render() {
      const app = document.getElementById('app');

      app.innerHTML = createPageWrapper(
        'GitLab Copilot 文档',
        '了解如何使用 GitLab Copilot 提升开发效率',
        this.renderContent(),
        'docs'
      );

      // 添加锚点导航功能
      this.setupAnchorLinks();
    },

    renderContent() {
      const basePath = window.location.pathname.includes('/auth') ? '/auth' : '';
      const origin = window.location.origin;

      return `
        <div class="docs-layout">
          <aside class="docs-sidebar">
            ${createCard(
              '📑 目录',
              `
                <nav class="docs-toc">
                  <ul>
                    <li><a href="#overview">概述</a></li>
                    <li><a href="#quick-start">快速开始</a></li>
                    <li>
                      <a href="#usage">使用指南</a>
                      <ul>
                        <li><a href="#issue-commands">Issue 指令</a></li>
                        <li><a href="#mr-commands">MR 指令</a></li>
                        <li><a href="#code-review">代码评审</a></li>
                      </ul>
                    </li>
                    <li><a href="#configuration">配置说明</a></li>
                    <li><a href="#api">API 接口</a></li>
                    <li><a href="#troubleshooting">常见问题</a></li>
                  </ul>
                </nav>
              `
            )}
            ${createCard(
              '✨ 快捷入口',
              `
                <div class="docs-quick-links">
                  <a class="docs-quick-link" href="${basePath}/config">
                    <span class="docs-quick-link-icon">⚙️</span>
                    <div class="docs-quick-link-content">
                      <span class="docs-quick-link-title">配置管理</span>
                      <span class="docs-quick-link-desc">添加 GitLab 实例与凭证</span>
                    </div>
                  </a>
                  <a class="docs-quick-link" href="${basePath}/stats">
                    <span class="docs-quick-link-icon">📊</span>
                    <div class="docs-quick-link-content">
                      <span class="docs-quick-link-title">使用统计</span>
                      <span class="docs-quick-link-desc">跟踪请求量与 AI 成功率</span>
                    </div>
                  </a>
                  <a class="docs-quick-link" href="${basePath}/dashboard">
                    <span class="docs-quick-link-icon">🏠</span>
                    <div class="docs-quick-link-content">
                      <span class="docs-quick-link-title">返回首页</span>
                      <span class="docs-quick-link-desc">查看系统概览与提示</span>
                    </div>
                  </a>
                </div>
              `,
              '常用页面快速导航'
            )}
          </aside>

          <div class="docs-main">
            <section id="overview" class="docs-section">
              ${createCard(
                '🎯 概述',
                `
                  <div class="docs-callout">
                    <strong>核心价值：</strong> 在 GitLab 中以最小成本引入 AI 编程、评审与自动化流程，帮助团队保持高质量与高效率。
                  </div>

                  <p class="mt-4">GitLab Copilot 是一个智能 AI 助手服务，通过 GitLab Webhook 与 Claude / Codex 等模型集成，为您的开发团队提供强大的 AI 辅助能力。</p>

                  <h4>核心功能</h4>
                  <ul>
                    <li><strong>AI 代码生成</strong>：在 Issue 或 MR 中使用 <code>@claude</code> 或 <code>@codex</code> 触发 AI 编程</li>
                    <li><strong>自动代码评审</strong>：新建或重新打开 MR 时自动进行代码审查</li>
                    <li><strong>智能 MR 创建</strong>：自动生成规范的 Merge Request 与 Commit 信息</li>
                    <li><strong>实时进度反馈</strong>：AI 处理过程实时更新到 GitLab 评论</li>
                    <li><strong>会话持久化</strong>：支持长对话，保持上下文连续性</li>
                    <li><strong>多项目管理</strong>：支持配置多个 GitLab 实例和 Access Token</li>
                  </ul>

                  <h4>支持的 AI Provider</h4>
                  <ul>
                    <li><strong>Claude</strong>：使用 <code>@claude</code> 触发</li>
                    <li><strong>Codex</strong>：使用 <code>@codex</code> 触发</li>
                  </ul>
                `
              )}
            </section>

            <section id="quick-start" class="docs-section">
              ${createCard(
                '🚀 快速开始',
                `
                  <h4>第一步：配置 GitLab Token</h4>
                  <ol>
                    <li>进入 <a href="${basePath}/config">配置管理</a> 页面</li>
                    <li>点击「添加配置」按钮</li>
                    <li>填写以下信息：
                      <ul>
                        <li><strong>配置名称</strong>：为配置起一个易于识别的名称</li>
                        <li><strong>GitLab URL</strong>：您的 GitLab 实例地址（如 https://gitlab.com）</li>
                        <li><strong>Access Token</strong>：具有 <code>api</code>、<code>read_repository</code>、<code>write_repository</code> 权限的 Personal Access Token</li>
                        <li><strong>Webhook Secret</strong>：用于验证 Webhook 请求的密钥</li>
                      </ul>
                    </li>
                    <li>保存配置</li>
                  </ol>

                  <h4>第二步：配置 GitLab Webhook</h4>
                  <ol>
                    <li>在 GitLab 项目中，进入 <strong>Settings &gt; Webhooks</strong></li>
                    <li>添加新的 Webhook：
                      <ul>
                        <li><strong>URL</strong>：<code>${origin}/webhook/YOUR_TOKEN_HERE</code></li>
                        <li><strong>Secret token</strong>：填写您在配置中设置的 Webhook Secret</li>
                        <li><strong>Trigger</strong>：勾选以下事件
                          <ul>
                            <li>✅ Issues events</li>
                            <li>✅ Merge request events</li>
                            <li>✅ Comments</li>
                          </ul>
                        </li>
                      </ul>
                    </li>
                    <li>保存 Webhook</li>
                  </ol>

                  <div class="alert alert-info mt-4">
                    <strong>💡 提示：</strong> <code>YOUR_TOKEN_HERE</code> 是您在配置管理页面生成的用户 Token。
                  </div>
                `
              )}
            </section>

            <section id="usage" class="docs-section">
              ${createCard(
                '📖 使用指南',
                `
                  <h4 id="issue-commands">Issue 指令</h4>
                  <p>在 Issue 描述或评论中使用 <code>@claude</code> 或 <code>@codex</code> 触发 AI 处理：</p>

                  <div class="docs-code">
                    <pre><code>@claude 帮我实现一个用户登录功能
- 支持用户名/密码登录
- 支持 JWT token 认证
- 添加登录失败次数限制</code></pre>
                  </div>

                  <p><strong>处理流程：</strong></p>
                  <ol>
                    <li>AI 接收到指令后，会创建一个新的时间戳分支（格式：<code>claude-YYYYMMDDTHHMMSS-XXXXXX</code>）</li>
                    <li>在该分支上实现您的需求</li>
                    <li>自动创建 Merge Request，包含规范的 Commit 信息和变更说明</li>
                    <li>实时进度会通过评论反馈到原 Issue</li>
                  </ol>

                  <h4 id="mr-commands">MR 指令</h4>
                  <p>在 MR 评论中使用 AI 指令会<strong>直接修改源分支</strong>：</p>

                  <div class="docs-code">
                    <pre><code>@codex 修复 TypeScript 类型错误
将 userRepository.ts 中的类型定义改为严格模式</code></pre>
                  </div>

                  <p><strong>处理流程：</strong></p>
                  <ol>
                    <li>AI 在 MR 的源分支上直接进行修改</li>
                    <li>提交并推送到源分支</li>
                    <li>MR 自动更新，无需创建新的 MR</li>
                    <li>如果推送失败会自动 rebase 并尝试解决冲突</li>
                  </ol>

                  <h4 id="code-review">自动代码评审</h4>
                  <p><strong>触发条件：</strong></p>
                  <ul>
                    <li>新创建的 MR 描述中包含 <code>@claude</code> 或 <code>@codex</code></li>
                    <li>重新打开的 MR 描述中包含 <code>@claude</code> 或 <code>@codex</code></li>
                  </ul>

                  <p><strong>评审内容：</strong></p>
                  <ul>
                    <li>TypeScript / Node.js 最佳实践</li>
                    <li>安全漏洞检测</li>
                    <li>性能优化建议</li>
                    <li>代码风格和可维护性</li>
                    <li>测试覆盖率检查</li>
                  </ul>

                  <p><strong>评审示例：</strong></p>
                  <div class="docs-code">
                    <pre><code>File: src/utils/helper.ts
Line: 42
Comment: 建议使用 async/await 替代 Promise.then()
Severity: warning
Category: style</code></pre>
                  </div>

                  <div class="alert alert-warning mt-4">
                    <strong>⚠️ 注意：</strong> MR 更新时不会触发代码评审，只有新建和重新打开时才会触发。
                  </div>
                `
              )}
            </section>

            <section id="configuration" class="docs-section">
              ${createCard(
                '⚙️ 配置说明',
                `
                  <h4>环境变量</h4>
                  <table class="docs-table">
                    <thead>
                      <tr>
                        <th>变量名</th>
                        <th>说明</th>
                        <th>默认值</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td><code>PORT</code></td>
                        <td>服务监听端口</td>
                        <td>3000</td>
                      </tr>
                      <tr>
                        <td><code>WORK_DIR</code></td>
                        <td>工作目录</td>
                        <td>/tmp/gitlab-copilot-work</td>
                      </tr>
                      <tr>
                        <td><code>LOG_LEVEL</code></td>
                        <td>日志级别</td>
                        <td>info</td>
                      </tr>
                      <tr>
                        <td><code>SESSION_ENABLED</code></td>
                        <td>是否启用会话持久化</td>
                        <td>true</td>
                      </tr>
                      <tr>
                        <td><code>SESSION_MAX_IDLE_TIME</code></td>
                        <td>会话最大空闲时间</td>
                        <td>7d</td>
                      </tr>
                      <tr>
                        <td><code>MONGODB_URI</code></td>
                        <td>MongoDB 连接字符串</td>
                        <td>-</td>
                      </tr>
                    </tbody>
                  </table>

                  <h4 class="mt-6">GitLab Token 权限要求</h4>
                  <p>创建 Personal Access Token 时需要以下权限：</p>
                  <ul>
                    <li><code>api</code> - 完整的 API 访问权限</li>
                    <li><code>read_repository</code> - 读取仓库代码</li>
                    <li><code>write_repository</code> - 写入仓库代码（创建分支、提交等）</li>
                  </ul>
                `
              )}
            </section>

            <section id="api" class="docs-section">
              ${createCard(
                '🔌 API 接口',
                `
                  <h4>认证相关</h4>
                  <ul>
                    <li><code>POST /api/auth/register</code> - 用户注册</li>
                    <li><code>POST /api/auth/login</code> - 用户登录</li>
                    <li><code>POST /api/auth/logout</code> - 用户登出</li>
                    <li><code>GET /api/auth/me</code> - 获取当前用户信息</li>
                  </ul>

                  <h4>配置管理</h4>
                  <ul>
                    <li><code>GET /api/gitlab-configs</code> - 获取配置列表</li>
                    <li><code>POST /api/gitlab-configs</code> - 创建新配置</li>
                    <li><code>PUT /api/gitlab-configs/:id</code> - 更新配置</li>
                    <li><code>DELETE /api/gitlab-configs/:id</code> - 删除配置</li>
                    <li><code>POST /api/gitlab-configs/:id/set-default</code> - 设置默认配置</li>
                  </ul>

                  <h4>统计数据</h4>
                  <ul>
                    <li><code>GET /api/usage-stats/user/comprehensive</code> - 获取用户综合统计</li>
                    <li><code>GET /api/usage-stats/config/:id/comprehensive</code> - 获取配置综合统计</li>
                    <li><code>GET /api/usage-stats/summary</code> - 获取统计摘要</li>
                  </ul>

                  <h4>Webhook</h4>
                  <ul>
                    <li><code>POST /webhook/:userToken</code> - 接收 GitLab Webhook 事件</li>
                  </ul>

                  <div class="alert alert-info mt-4">
                    <strong>💡 提示：</strong> 大部分 API 需要在请求头中携带 <code>Authorization: Bearer &lt;token&gt;</code> 进行认证。
                  </div>
                `
              )}
            </section>

            <section id="troubleshooting" class="docs-section">
              ${createCard(
                '❓ 常见问题',
                `
                  <h4>Q: AI 没有响应怎么办？</h4>
                  <p><strong>A:</strong> 请检查以下几点：</p>
                  <ul>
                    <li>确认 Webhook 配置正确，URL 和 Secret 无误</li>
                    <li>检查 GitLab Token 权限是否完整</li>
                    <li>查看服务日志，确认是否有错误信息</li>
                    <li>确认使用了正确的触发词 <code>@claude</code> 或 <code>@codex</code></li>
                  </ul>

                  <h4>Q: 为什么 MR 更新时不触发代码评审？</h4>
                  <p><strong>A:</strong> 这是设计行为。为避免频繁触发评审，只有新建和重新打开 MR 时才会自动评审。如需对更新后的代码评审，可以：</p>
                  <ul>
                    <li>关闭并重新打开 MR</li>
                    <li>在 MR 评论中使用 <code>@claude review</code> 手动触发</li>
                  </ul>

                  <h4>Q: 会话持久化是什么？</h4>
                  <p><strong>A:</strong> 会话持久化允许 AI 记住之前的对话上下文。例如：</p>
                  <ul>
                    <li>在 Issue 中连续提问，AI 能理解上下文</li>
                    <li>会话默认保持 7 天，超时后自动清理</li>
                    <li>可以通过环境变量调整会话时长</li>
                  </ul>

                  <h4>Q: 如何查看 AI 处理进度？</h4>
                  <p><strong>A:</strong> AI 处理过程会实时更新到 GitLab 评论中，包括：</p>
                  <ul>
                    <li>开始处理通知</li>
                    <li>中间进度更新</li>
                    <li>完成状态和结果</li>
                    <li>如有错误，会显示错误信息</li>
                  </ul>

                  <h4>Q: 可以同时使用多个 GitLab 实例吗？</h4>
                  <p><strong>A:</strong> 可以。在配置管理页面添加多个 GitLab 配置，每个配置对应一个 GitLab 实例和 Token。统计数据可以按用户汇总或按配置单独查看。</p>

                  <h4>Q: AI 生成的代码质量如何保证？</h4>
                  <p><strong>A:</strong> 建议：</p>
                  <ul>
                    <li>使用代码评审功能检查 AI 生成的代码</li>
                    <li>设置项目的 <code>CODE_REVIEW_GUIDELINES.md</code> 自定义评审规则</li>
                    <li>AI 创建的 MR 需要人工审核后再合并</li>
                    <li>配合项目的 CI/CD 流程进行自动化测试</li>
                  </ul>
                `
              )}
            </section>

            <section class="docs-section">
              ${createCard(
                '💬 获取帮助',
                `
                  <p>如果您在使用过程中遇到问题，可以通过以下方式获取帮助：</p>
                  <ul>
                    <li>查看 <a href="${basePath}/stats">统计数据</a> 了解服务运行状态</li>
                    <li>检查服务日志（设置 <code>LOG_LEVEL=debug</code> 获取详细日志）</li>
                    <li>联系系统管理员</li>
                  </ul>
                `
              )}
            </section>
          </div>
        </div>
      `;
    },

    setupAnchorLinks() {
      // 平滑滚动到锚点
      document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function (e) {
          e.preventDefault();
          const target = document.querySelector(this.getAttribute('href'));
          if (target) {
            target.scrollIntoView({
              behavior: 'smooth',
              block: 'start'
            });
          }
        });
      });
    }
  };

  window.DocsPage = DocsPage;

  document.addEventListener('DOMContentLoaded', () => {
    DocsPage.init();
  });
})();
