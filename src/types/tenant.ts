export interface TenantUserContext {
  /** Mongo 文档 _id，使用字符串形式方便日志与缓存 */
  userId: string;
  /** 用户在平台中的 token，用于 webhook 路由 */
  userToken: string;
  /** GitLab Host（含协议） */
  gitlabBaseUrl: string;
  /** 解密后的个人 Access Token */
  gitlabAccessToken: string;
  displayName?: string;
  email?: string;
  /** 若存在，表示当前请求绑定的 GitLab 配置 ID */
  gitlabConfigId?: string;
  /** 平台用户 ID（用于多配置场景保留原始用户身份） */
  platformUserId?: string;
  /** 是否为回退的单租户模式 */
  isLegacyFallback?: boolean;
}

export interface ResolvedWebhookTenant {
  mode: 'tenant' | 'legacy';
  /** 用于当前请求的 webhook secret */
  secret: string;
  /** 租户上下文（legacy 模式下可选） */
  user?: TenantUserContext;
}
