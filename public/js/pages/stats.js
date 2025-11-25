(function() {
  const chartColors = {
    contexts: ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#06B6D4'],
    primary: '#3B82F6',
    primaryBorder: '#2563EB',
    accent: '#6366F1',
    neutral: '#F3F4F6',
  };

  const state = {
    user: null,
    configs: [],
    selectedConfigId: null,
    period: 'week',
    customRange: null,
    comprehensiveStats: null,
    summaryStats: null,
    charts: {},
  };

  const cache = new Map();

  const contextLabels = {
    merge_request: 'Merge Request (含代码评审)',
    merge_request_comment: 'MR 评论',
    issue: 'Issue',
    issue_comment: 'Issue 评论',
  };

  const periodLabels = {
    week: '本周',
    month: '本月',
    year: '本年',
    custom: '自定义',
  };

  const StatsPage = {
    async init() {
      const app = document.getElementById('app');

      const isAuthenticated = await Navigation.requireAuth();
      if (!isAuthenticated) {
        return;
      }

      this.renderLoading('加载统计数据...');

      try {
        await this.bootstrap();
        await this.loadStats();
        this.render();
        this.renderCharts();
      } catch (error) {
        console.error('Failed to initialize statistics page:', error);
        this.renderError('无法加载统计数据，请稍后重试。');
      }
    },

    async bootstrap() {
      const [userResponse, configsResponse, summaryResponse] = await Promise.all([
        api.getCurrentUser(),
        this.loadConfigsSafe(),
        this.loadSummarySafe(),
      ]);

      state.user = userResponse.user;
      state.configs = configsResponse;
      state.summaryStats = summaryResponse;
    },

    async loadConfigsSafe() {
      try {
        const response = await api.getGitLabConfigs();
        return response.configurations || [];
      } catch (error) {
        console.warn('Failed to load GitLab configs:', error);
        return [];
      }
    },

    async loadSummarySafe() {
      try {
        const summaryData = await api.getUsageSummary();
        return summaryData?.summary || null;
      } catch (error) {
        console.warn('Failed to load usage summary:', error);
        return null;
      }
    },

    async loadStats(force = false) {
      const cacheKey = this.getCacheKey();
      if (!force && cache.has(cacheKey)) {
        state.comprehensiveStats = cache.get(cacheKey);
        return;
      }

      const params = this.getRequestParams();

      const data = state.selectedConfigId
        ? await api.getComprehensiveConfigStats(state.selectedConfigId, params)
        : await api.getComprehensiveUserStats(params);

      state.comprehensiveStats = data;
      cache.set(cacheKey, data);
    },

    getCacheKey() {
      if (state.period === 'custom' && state.customRange) {
        return `${state.selectedConfigId || 'user'}::custom::${state.customRange.startDate}::${state.customRange.endDate}`;
      }
      return `${state.selectedConfigId || 'user'}::${state.period}`;
    },

    getRequestParams() {
      if (state.period === 'custom' && state.customRange) {
        return {
          startDate: state.customRange.startDate,
          endDate: state.customRange.endDate,
        };
      }
      return {
        period: state.period,
      };
    },

    renderLoading(message = '加载中...') {
      const app = document.getElementById('app');
      app.innerHTML = createPageWrapper(
        'Usage Statistics',
        'Monitor your GitLab Copilot activity and AI assistance usage',
        createSpinner(message),
        'stats'
      );
    },

    renderError(message) {
      const app = document.getElementById('app');
      app.innerHTML = createPageWrapper(
        'Usage Statistics',
        'Monitor your GitLab Copilot activity and AI assistance usage',
        createAlert(message, 'error'),
        'stats'
      );
    },

    render() {
      const app = document.getElementById('app');
      const statsTitle = this.getScopeTitle();

      app.innerHTML = createPageWrapper(
        'Usage Statistics',
        statsTitle,
        this.renderContent(),
        'stats'
      );

      this.bindInteractions();
    },

    getScopeTitle() {
      if (state.selectedConfigId) {
        const selected = state.configs.find(config => config.id === state.selectedConfigId);
        const name = escapeHtml(selected?.name || 'GitLab 配置');
        return `统计维度: GitLab配置 - ${name}`;
      }
      return `统计维度: 登录用户 - ${escapeHtml(state.user?.username || 'current user')}`;
    },

    renderContent() {
      const comprehensive = state.comprehensiveStats;
      if (!comprehensive) {
        return createSpinner('正在加载统计数据...');
      }

      const summarySection = this.renderSummarySection();
      const quickStatsSection = this.renderQuickStatsSection();
      const trendSection = this.renderTrendSection();
      const chartSection = this.renderChartSection();
      const tablesSection = this.renderTablesSection();
      const modal = this.renderCustomDateModal();

      return `
        ${this.renderDimensionSelector()}
        ${this.renderPeriodSelector()}
        ${summarySection}
        ${quickStatsSection}
        ${trendSection}
        ${chartSection}
        ${tablesSection}
        ${modal}
      `;
    },

    renderDimensionSelector() {
      const options = [
        `<option value="" ${state.selectedConfigId ? '' : 'selected'}>按登录用户统计 (${escapeHtml(state.user?.username || 'current user')})</option>`,
        ...state.configs.map(config => {
          const optionValue = escapeHtml(config.id);
          const configName = escapeHtml(config.name || 'GitLab 配置');
          const configUrl = escapeHtml(config.gitlabUrl || '');
          const selectedAttr = state.selectedConfigId === config.id ? 'selected' : '';
          return `
            <option value="${optionValue}" ${selectedAttr}>
              按GitLab配置统计 - ${configName}${configUrl ? ` (${configUrl})` : ''}
            </option>
          `;
        }),
      ].join('');

      return `
        <div style="margin-bottom: 2rem;">
          ${createCard(
            '📊 统计维度',
            `
              <div style="margin-bottom: 1rem;">
                <label for="statsDimensionSelect" style="display: block; margin-bottom: 0.5rem; font-weight: 600; color: var(--gray-700);">
                  选择统计维度:
                </label>
                <select id="statsDimensionSelect" class="form-input" style="width: 100%; max-width: 420px;">
                  ${options}
                </select>
              </div>
              <div style="padding: 0.75rem; background: var(--gray-50); border-radius: var(--radius-sm); border-left: 3px solid var(--info-color);">
                <p style="margin: 0; color: var(--gray-600); font-size: 0.875rem;">
                  💡 <strong>按登录用户统计:</strong> 显示当前账号下所有 GitLab 配置的汇总数据<br>
                  💡 <strong>按GitLab配置统计:</strong> 仅查看单个 Access Token 的独立数据
                </p>
              </div>
            `
          )}
        </div>
      `;
    },

    renderPeriodSelector() {
      const periodButtons = ['week', 'month', 'year'].map(period => {
        const isActive = state.period === period;
        return `
          <button type="button" class="btn btn-sm btn-secondary ${isActive ? 'active' : ''}" data-period="${period}">
            ${periodLabels[period]}
          </button>
        `;
      }).join('');

      const currentPeriodText = state.period === 'custom' && state.customRange
        ? `<span class="badge" style="margin-left: 1rem; background: var(--gray-200); color: var(--gray-700);">${formatDateRange(state.customRange.startDate, state.customRange.endDate)}</span>`
        : '';

      return `
        <div style="margin-bottom: 2rem;">
          ${createCard(
            '🔧 时间范围',
            `
              <div style="display: flex; gap: 1rem; flex-wrap: wrap; align-items: center;">
                <div id="periodButtons" style="display: flex; gap: 0.75rem; flex-wrap: wrap;">
                  ${periodButtons}
                </div>
                <button type="button" class="btn btn-sm btn-secondary" id="customRangeButton">
                  自定义范围
                </button>
                ${currentPeriodText}
              </div>
            `
          )}
        </div>
      `;
    },

    renderSummarySection() {
      if (state.selectedConfigId || !state.summaryStats) {
        return '';
      }

      const summary = state.summaryStats;

      const thisWeek = summary?.thisWeek || {};
      const thisMonth = summary?.thisMonth || {};
      const topContext = summary?.topContext || ['暂无记录', 0];
      const topProject = summary?.topProject || { projectName: '暂无数据', count: 0 };

      return `
        <div style="margin-bottom: 3rem;">
          ${createCard(
            '✨ 使用摘要',
            `
              <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1.5rem;">
                ${this.renderSummaryCard('📅 本周概览', thisWeek)}
                ${this.renderSummaryCard('📆 本月概览', thisMonth)}
                <div class="card" style="margin: 0; box-shadow: none; border: 1px solid var(--gray-200);">
                  <div class="card-body" style="padding: 1.25rem;">
                    <div style="font-size: 2rem; margin-bottom: 0.75rem;">🎯</div>
                    <h4 style="margin-bottom: 0.75rem; color: var(--gray-800);">热门上下文</h4>
                    <p style="margin: 0; color: var(--gray-600);">
                      <strong>${formatContextLabel(topContext[0])}</strong><br>
                      触发次数：${formatNumber(topContext[1] || 0)}
                    </p>
                  </div>
                </div>
                <div class="card" style="margin: 0; box-shadow: none; border: 1px solid var(--gray-200);">
                  <div class="card-body" style="padding: 1.25rem;">
                    <div style="font-size: 2rem; margin-bottom: 0.75rem;">🏗️</div>
                    <h4 style="margin-bottom: 0.75rem; color: var(--gray-800);">最活跃项目</h4>
                    <p style="margin: 0; color: var(--gray-600);">
                      <strong>${escapeHtml(topProject.projectName || '暂无数据')}</strong><br>
                      事件数：${formatNumber(topProject.count || 0)}
                    </p>
                  </div>
                </div>
              </div>
            `,
            '统计摘要仅展示用户维度的数据'
          )}
        </div>
      `;
    },

    renderSummaryCard(title, data = {}) {
      return `
        <div class="card" style="margin: 0; box-shadow: none; border: 1px solid var(--gray-200);">
          <div class="card-body" style="padding: 1.25rem;">
            <h4 style="margin-bottom: 1rem; color: var(--gray-800);">${title}</h4>
            <ul style="list-style: none; padding: 0; margin: 0; color: var(--gray-600); font-size: 0.9rem;">
              <li style="margin-bottom: 0.5rem;">AI执行任务数：<strong>${formatNumber(data.totalEvents || 0)}</strong></li>
              <li style="margin-bottom: 0.5rem;">Webhook：<strong>${formatNumber(data.totalWebhooks || 0)}</strong></li>
              <li style="margin-bottom: 0.5rem;">成功率：<strong>${formatPercentage(data.successRate)}</strong></li>
              <li>平均响应：<strong>${formatDuration(data.averageExecutionTime)}</strong></li>
            </ul>
          </div>
        </div>
      `;
    },

    renderQuickStatsSection() {
      const usage = state.comprehensiveStats?.usageStats;

      if (!usage) {
        return '';
      }

      const cards = [
        this.createStatsCard('📝', 'AI执行任务数', formatNumber(usage.totalEvents || 0), 'AI tasks executed'),
        this.createStatsCard('✅', '成功请求', formatNumber(usage.successfulEvents || 0), 'Successfully processed'),
        this.createStatsCard('⚠️', '失败请求', formatNumber(usage.failedEvents || 0), 'Processing errors'),
        this.createStatsCard('⚡', '平均响应时间', formatDuration(usage.averageExecutionTime || 0), 'Average response time'),
      ].join('');

      return `
        <div style="margin-bottom: 3rem;">
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 1.5rem;">
            ${cards}
          </div>
        </div>
      `;
    },


    renderTrendSection() {
      const usage = state.comprehensiveStats?.usageStats;
      if (!usage?.trends) {
        return '';
      }

      const trend = usage.trends;
      return `
        <div style="margin-bottom: 3rem;">
          ${createCard(
            '📌 使用概览',
            `
              <div style="display: flex; flex-wrap: wrap; gap: 2rem;">
                <div>
                  <h4 style="margin-bottom: 0.5rem; color: var(--gray-700);">日均事件数</h4>
                  <p style="margin: 0; font-size: 1.5rem; font-weight: 600; color: var(--primary-color);">${formatDecimal(trend.dailyAverage || 0)}</p>
                </div>
                <div>
                  <h4 style="margin-bottom: 0.5rem; color: var(--gray-700);">周均事件数</h4>
                  <p style="margin: 0; font-size: 1.5rem; font-weight: 600; color: var(--primary-color);">${formatDecimal(trend.weeklyAverage || 0)}</p>
                </div>
                <div>
                  <h4 style="margin-bottom: 0.5rem; color: var(--gray-700);">统计区间</h4>
                  <p style="margin: 0; font-size: 1rem; color: var(--gray-600);">${formatDateRange(usage.period?.startDate, usage.period?.endDate)}</p>
                </div>
              </div>
            `
          )}
        </div>
      `;
    },

    renderChartSection() {
      const usage = state.comprehensiveStats?.usageStats;
      const webhookStats = state.comprehensiveStats?.webhookStats;

      const hasContextData = usage && Object.values(usage.eventsByContext || {}).some(count => count > 0);
      const hasDailyStats = usage && usage.dailyStats && usage.dailyStats.length > 0;
      const hasWebhookTypeData = webhookStats && Object.values(webhookStats.webhooksByType || {}).some(count => count > 0);
      const hasWebhookActionData = webhookStats && Object.values(webhookStats.webhooksByAction || {}).some(count => count > 0);
      const hasResponseTypeData = webhookStats && Object.values(webhookStats.responseTypeStats || {}).some(count => count > 0);

      const chartCards = [];

      chartCards.push(
        createCard(
          '📈 活动趋势',
          hasDailyStats
            ? '<canvas id="dailyActivityChart" height="320"></canvas>'
            : createEmptyState('暂无趋势数据', '当前时间范围内没有事件记录'),
          '按日统计的 AI 请求数量'
        )
      );

      chartCards.push(
        createCard(
          '📊 上下文分布',
          hasContextData
            ? '<canvas id="contextChart" height="320"></canvas>'
            : createEmptyState('暂无上下文数据', '没有可用于展示的上下文事件'),
          '不同上下文触发的 AI 请求占比'
        )
      );

      chartCards.push(
        createCard(
          '🔗 Webhook 类型',
          hasWebhookTypeData
            ? '<canvas id="webhookTypeChart" height="320"></canvas>'
            : createEmptyState('暂无类型数据', '没有可展示的 webhook 类型统计'),
          'Webhook 事件类型分布'
        )
      );

      chartCards.push(
        createCard(
          '🛠️ Webhook 动作',
          hasWebhookActionData
            ? '<canvas id="webhookActionChart" height="320"></canvas>'
            : createEmptyState('暂无动作数据', '没有可展示的 webhook 动作统计'),
          'Webhook 请求的 Action 分布'
        )
      );

      chartCards.push(
        createCard(
          '🧭 响应类型',
          hasResponseTypeData
            ? '<canvas id="responseTypeChart" height="320"></canvas>'
            : createEmptyState('暂无响应数据', '没有可展示的响应类型统计'),
          '不同响应类型的占比情况'
        )
      );

      return `
        <div style="margin-bottom: 3rem;">
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 2rem;">
            ${chartCards.join('')}
          </div>
        </div>
      `;
    },

    renderTablesSection() {
      const usage = state.comprehensiveStats?.usageStats;
      const webhookStats = state.comprehensiveStats?.webhookStats;

      // Project detail stats with success rate and execution time
      const projectDetailRows = (usage?.projectDetails || []).map(project => ([
        escapeHtml(project.projectName || 'Unknown'),
        formatNumber(project.totalEvents || 0),
        formatNumber(project.successfulEvents || 0),
        formatNumber(project.failedEvents || 0),
        `${project.successRate || 0}%`,
        formatDuration(project.averageExecutionTime || 0),
      ]));

      const contextEntries = Object.entries(usage?.eventsByContext || {});
      const totalEvents = usage?.totalEvents || 0;
      const contextRows = contextEntries
        .filter(([, count]) => count > 0)
        .sort(([, a], [, b]) => (b - a))
        .map(([context, count]) => ([
          formatContextLabel(context),
          formatNumber(count),
          totalEvents > 0 ? `${((count / totalEvents) * 100).toFixed(1)}%` : '0%',
        ]));

      const webhookTypeRows = Object.entries(webhookStats?.webhooksByType || {})
        .filter(([, count]) => count > 0)
        .sort(([, a], [, b]) => (b - a))
        .map(([type, count]) => ([
          formatWebhookLabel(type),
          formatNumber(count),
        ]));

      const webhookActionRows = Object.entries(webhookStats?.webhooksByAction || {})
        .filter(([, count]) => count > 0)
        .sort(([, a], [, b]) => (b - a))
        .map(([action, count]) => ([
          formatWebhookLabel(action || 'N/A'),
          formatNumber(count),
        ]));

      const responseTypeRows = Object.entries(webhookStats?.responseTypeStats || {})
        .filter(([, count]) => count > 0)
        .map(([type, count]) => ([formatWebhookLabel(type), formatNumber(count)]));

      // Provider context stats
      const providerContextRows = [];
      if (usage?.providerContextStats && usage.providerContextStats.length > 0) {
        for (const providerStat of usage.providerContextStats) {
          const provider = providerStat.provider.toUpperCase();
          const contexts = providerStat.contexts || {};

          providerContextRows.push([
            provider,
            formatNumber(contexts.merge_request || 0),
            formatNumber(contexts.merge_request_comment || 0),
            formatNumber(contexts.issue || 0),
            formatNumber(contexts.issue_comment || 0),
            formatNumber(providerStat.totalEvents || 0),
          ]);
        }
      }

      return `
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 2rem; margin-bottom: 3rem;">
          ${createCard('📋 项目详细统计', createTable(['项目名称', '总事件数', '成功', '失败', '成功率', '平均响应时间'], projectDetailRows, '暂无项目数据'), '按项目统计的详细数据')}
          ${createCard('🤖 AI Provider 上下文分布', createTable(['Provider', 'MR', 'MR评论', 'Issue', 'Issue评论', '总计'], providerContextRows, '暂无 Provider 数据'), '不同 AI Provider 在各上下文下的使用情况')}
          ${createCard('🎯 上下文详情', createTable(['上下文类型', '事件数', '占比'], contextRows, '暂无上下文数据'), '不同上下文的使用情况')}
          ${createCard('🔗 Webhook 类型表', createTable(['Webhook 类型', '触发次数'], webhookTypeRows, '暂无 webhook 类型数据'), 'Webhook 类型分布')}
          ${createCard('🛠️ Webhook 动作表', createTable(['Action', '次数'], webhookActionRows, '暂无 webhook 动作数据'), 'Webhook Action 统计')}
          ${createCard('🧭 响应类型表', createTable(['响应类型', '次数'], responseTypeRows, '暂无响应类型数据'), 'Webhook 响应类型统计')}
        </div>
      `;
    },

    renderCustomDateModal() {
      return createModal(
        'customDateModal',
        '📅 自定义时间范围',
        `
          <div style="margin-bottom: 1.5rem;">
            <label for="startDate" style="display: block; margin-bottom: 0.5rem; font-weight: 600;">开始日期:</label>
            <input type="date" id="startDate" class="form-input" style="width: 100%;">
          </div>
          <div style="margin-bottom: 1.5rem;">
            <label for="endDate" style="display: block; margin-bottom: 0.5rem; font-weight: 600;">结束日期:</label>
            <input type="date" id="endDate" class="form-input" style="width: 100%;">
          </div>
        `,
        `
          <div style="display: flex; gap: 1rem; justify-content: flex-end;">
            <button type="button" class="btn btn-secondary" id="customDateCancel">取消</button>
            <button type="button" class="btn btn-primary" id="customDateApply">应用</button>
          </div>
        `
      );
    },

    bindInteractions() {
      const dimensionSelect = document.getElementById('statsDimensionSelect');
      if (dimensionSelect) {
        dimensionSelect.addEventListener('change', async (event) => {
          await this.handleDimensionChange(event.target.value);
        });
      }

      const periodButtons = document.querySelectorAll('#periodButtons [data-period]');
      periodButtons.forEach(button => {
        button.addEventListener('click', async (event) => {
          const period = event.currentTarget.getAttribute('data-period');
          await this.handlePeriodChange(period);
        });
      });

      const customRangeButton = document.getElementById('customRangeButton');
      if (customRangeButton) {
        customRangeButton.addEventListener('click', () => {
          this.prefillCustomDateModal();
          openModal('customDateModal');
        });
      }

      const cancelButton = document.getElementById('customDateCancel');
      if (cancelButton) {
        cancelButton.addEventListener('click', () => {
          closeModal('customDateModal');
        });
      }

      const applyButton = document.getElementById('customDateApply');
      if (applyButton) {
        applyButton.addEventListener('click', async () => {
          await this.applyCustomDateRange();
        });
      }
    },

    prefillCustomDateModal() {
      const startInput = document.getElementById('startDate');
      const endInput = document.getElementById('endDate');

      if (!startInput || !endInput) {
        return;
      }

      if (state.period === 'custom' && state.customRange) {
        startInput.value = state.customRange.startDate;
        endInput.value = state.customRange.endDate;
      } else {
        const today = new Date();
        const defaultStart = new Date(today.getTime() - (7 * 24 * 60 * 60 * 1000));
        startInput.value = formatDateInput(defaultStart);
        endInput.value = formatDateInput(today);
      }
    },

    async handleDimensionChange(configId) {
      this.renderLoading('切换统计维度中...');

      state.selectedConfigId = configId || null;
      state.period = state.period === 'custom' ? 'week' : state.period;
      state.customRange = null;

      try {
        await this.loadStats();
        this.render();
        this.renderCharts();
      } catch (error) {
        console.error('Failed to switch stats dimension:', error);
        this.renderError('切换统计维度失败，请稍后重试。');
      }
    },

    async handlePeriodChange(period) {
      if (!period || !periodLabels[period]) {
        return;
      }

      this.renderLoading(`加载${periodLabels[period]}统计数据...`);

      state.period = period;
      state.customRange = null;

      try {
        await this.loadStats(true);
        this.render();
        this.renderCharts();
      } catch (error) {
        console.error('Failed to load period statistics:', error);
        this.renderError('加载统计数据失败，请稍后重试。');
      }
    },

    async applyCustomDateRange() {
      const startInput = document.getElementById('startDate');
      const endInput = document.getElementById('endDate');

      if (!startInput || !endInput) {
        return;
      }

      const startDate = startInput.value;
      const endDate = endInput.value;

      if (!startDate || !endDate) {
        UI.showAlert('请选择开始日期和结束日期', 'warning');
        return;
      }

      if (new Date(startDate) > new Date(endDate)) {
        UI.showAlert('开始日期必须早于结束日期', 'warning');
        return;
      }

      closeModal('customDateModal');
      this.renderLoading('加载自定义时间范围统计数据...');

      state.period = 'custom';
      state.customRange = { startDate, endDate };

      try {
        await this.loadStats(true);
        this.render();
        this.renderCharts();
        UI.showAlert(`已加载 ${startDate} 至 ${endDate} 的统计数据`, 'success');
      } catch (error) {
        console.error('Failed to load custom range statistics:', error);
        this.renderError('加载自定义统计数据失败，请稍后重试。');
      }
    },

    createStatsCard(icon, title, value, description) {
      return `
        <div class="card" style="text-align: center;">
          <div class="card-body">
            <div style="font-size: 2.5rem; margin-bottom: 1rem;">${icon}</div>
            <div style="font-size: 2rem; font-weight: 600; color: var(--primary-color); margin-bottom: 0.5rem;">
              ${value}
            </div>
            <h4 style="margin-bottom: 0.5rem; color: var(--gray-800);">${title}</h4>
            <p style="color: var(--gray-600); margin-bottom: 0; font-size: 0.875rem;">${description}</p>
          </div>
        </div>
      `;
    },

    destroyCharts() {
      Object.values(state.charts).forEach(chart => {
        if (chart) {
          chart.destroy();
        }
      });
      state.charts = {};
    },

    renderCharts() {
      const stats = state.comprehensiveStats;
      if (!stats) {
        return;
      }

      this.destroyCharts();

      this.renderDailyActivityChart(stats.usageStats);
      this.renderContextChart(stats.usageStats);
      this.renderWebhookTypeChart(stats.webhookStats);
      this.renderWebhookActionChart(stats.webhookStats);
      this.renderResponseTypeChart(stats.webhookStats);
    },

    renderDailyActivityChart(usageStats) {
      if (!usageStats?.dailyStats || usageStats.dailyStats.length === 0) {
        return;
      }

      const canvas = document.getElementById('dailyActivityChart');
      if (!canvas) {
        return;
      }

      const labels = usageStats.dailyStats.map(item => item.date);
      const data = usageStats.dailyStats.map(item => item.count);

      state.charts.dailyActivity = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
          labels,
          datasets: [
            {
              label: '事件数',
              data,
              borderColor: chartColors.primary,
              backgroundColor: 'rgba(59, 130, 246, 0.15)',
              tension: 0.25,
              fill: true,
              borderWidth: 2,
              pointRadius: 3,
              pointBackgroundColor: chartColors.primary,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          scales: {
            y: { beginAtZero: true },
          },
        },
      });
    },

    renderContextChart(usageStats) {
      if (!usageStats) {
        return;
      }

      const contextData = usageStats.eventsByContext || {};
      const total = Object.values(contextData).reduce((sum, count) => sum + count, 0);
      if (total === 0) {
        return;
      }

      const canvas = document.getElementById('contextChart');
      if (!canvas) {
        return;
      }

      const labels = Object.keys(contextData).map(formatContextLabel);
      const data = Object.values(contextData);

      state.charts.context = new Chart(canvas.getContext('2d'), {
        type: 'doughnut',
        data: {
          labels,
          datasets: [
            {
              data,
              backgroundColor: chartColors.contexts,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { position: 'bottom' },
          },
        },
      });
    },

    renderWebhookTypeChart(webhookStats) {
      if (!webhookStats) {
        return;
      }

      const entries = Object.entries(webhookStats.webhooksByType || {}).filter(([, count]) => count > 0);
      if (entries.length === 0) {
        return;
      }

      const canvas = document.getElementById('webhookTypeChart');
      if (!canvas) {
        return;
      }

      const labels = entries.map(([type]) => formatWebhookLabel(type));
      const data = entries.map(([, count]) => count);

      state.charts.webhookType = new Chart(canvas.getContext('2d'), {
        type: 'bar',
        data: {
          labels,
          datasets: [
            {
              label: 'Webhook Count',
              data,
              backgroundColor: chartColors.primary,
              borderColor: chartColors.primaryBorder,
              borderWidth: 1,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            y: { beginAtZero: true },
          },
          plugins: { legend: { display: false } },
        },
      });
    },

    renderWebhookActionChart(webhookStats) {
      if (!webhookStats) {
        return;
      }

      const entries = Object.entries(webhookStats.webhooksByAction || {}).filter(([, count]) => count > 0);
      if (entries.length === 0) {
        return;
      }

      const canvas = document.getElementById('webhookActionChart');
      if (!canvas) {
        return;
      }

      const labels = entries.map(([action]) => formatWebhookLabel(action || 'N/A'));
      const data = entries.map(([, count]) => count);

      state.charts.webhookAction = new Chart(canvas.getContext('2d'), {
        type: 'bar',
        data: {
          labels,
          datasets: [
            {
              label: 'Action Count',
              data,
              backgroundColor: chartColors.accent,
              borderColor: chartColors.accent,
              borderWidth: 1,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            y: { beginAtZero: true },
          },
          plugins: { legend: { display: false } },
        },
      });
    },

    renderResponseTypeChart(webhookStats) {
      if (!webhookStats) {
        return;
      }

      const entries = Object.entries(webhookStats.responseTypeStats || {}).filter(([, count]) => count > 0);
      if (entries.length === 0) {
        return;
      }

      const canvas = document.getElementById('responseTypeChart');
      if (!canvas) {
        return;
      }

      const labels = entries.map(([type]) => formatWebhookLabel(type));
      const data = entries.map(([, count]) => count);

      state.charts.responseType = new Chart(canvas.getContext('2d'), {
        type: 'doughnut',
        data: {
          labels,
          datasets: [
            {
              data,
              backgroundColor: [
                '#0EA5E9', '#22C55E', '#F97316', '#EF4444', '#A855F7', '#6366F1'
              ],
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { position: 'bottom' },
          },
        },
      });
    },
  };

  function formatNumber(value) {
    if (value === undefined || value === null) {
      return '0';
    }
    return Number(value).toLocaleString(undefined, { maximumFractionDigits: 0 });
  }

  function formatPercentage(value) {
    if (value === undefined || value === null) {
      return '0%';
    }
    if (typeof value === 'string' && value.endsWith('%')) {
      return value;
    }
    const num = Number(value);
    if (Number.isNaN(num)) {
      return '0%';
    }
    return `${Math.round(num)}%`;
  }

  function formatDecimal(value, digits = 2) {
    if (value === undefined || value === null) {
      return '0';
    }
    const num = Number(value);
    if (Number.isNaN(num)) {
      return '0';
    }
    return num.toLocaleString(undefined, {
      minimumFractionDigits: num < 1 && num > 0 ? Math.min(digits, 2) : 0,
      maximumFractionDigits: digits,
    });
  }

  function formatDuration(ms) {
    if (!ms || Number.isNaN(Number(ms))) {
      return '0ms';
    }
    const value = Number(ms);
    if (value < 1000) {
      return `${Math.round(value)}ms`;
    }
    return `${(value / 1000).toFixed(1)}s`;
  }

  function formatContextLabel(context) {
    return contextLabels[context] || formatWebhookLabel(context);
  }

  function formatWebhookLabel(value) {
    if (!value) {
      return 'N/A';
    }
    return value
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function calculateRate(numerator, denominator) {
    const total = Number(denominator);
    const value = Number(numerator);
    if (!total || Number.isNaN(total) || total <= 0) {
      return '0%';
    }
    if (Number.isNaN(value) || value <= 0) {
      return '0%';
    }
    const rate = Math.round((value / total) * 100);
    return Number.isFinite(rate) ? `${rate}%` : '0%';
  }

  function formatDateRange(start, end) {
    if (!start || !end) {
      return '未设置时间范围';
    }
    const startDate = new Date(start);
    const endDate = new Date(end);

    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
      return `${start} ~ ${end}`;
    }

    return `${formatDateInput(startDate)} ~ ${formatDateInput(endDate)}`;
  }

  function formatDateInput(date) {
    const year = date.getFullYear();
    const month = `${date.getMonth() + 1}`.padStart(2, '0');
    const day = `${date.getDate()}`.padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  window.StatsPage = StatsPage;

  document.addEventListener('DOMContentLoaded', () => {
    StatsPage.init();
  });
})();
