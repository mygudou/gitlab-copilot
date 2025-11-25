import { config } from './config';
import { getCurrentTenantContext } from './tenantContext';
import { TenantUserContext } from '../types/tenant';
import logger from './logger';

export interface GitLabAuthContext {
  baseUrl: string;
  token: string;
  tenant?: TenantUserContext;
  isTenantToken: boolean;
}

export function resolveGitLabAuth(tenantOverride?: TenantUserContext): GitLabAuthContext {
  const tenant = tenantOverride ?? getCurrentTenantContext();
  const baseUrl = tenant?.gitlabBaseUrl?.trim() || config.gitlab.baseUrl;
  const token = tenant?.gitlabAccessToken?.trim() || config.gitlab.token;

  if (!baseUrl) {
    throw new Error('GitLab base URL is not configured');
  }

  if (!token) {
    throw new Error('No GitLab access token available for the current context');
  }

  if (!tenant && !tenantOverride) {
    logger.warn('resolveGitLabAuth falling back to global credentials', {
      hasGlobalToken: Boolean(config.gitlab.token),
    });
  }

  const maskedToken = token.length > 8 ? `${token.slice(0, 4)}***${token.slice(-4)}` : '***';
  logger.info('Resolved GitLab auth context', {
    baseUrl,
    isTenantToken: Boolean(tenant?.gitlabAccessToken?.trim()),
    tenantUserToken: tenant?.userToken,
    tenantUserId: tenant?.userId,
    tokenSuffix: maskedToken,
  });

  return {
    baseUrl,
    token,
    tenant,
    isTenantToken: Boolean(tenant?.gitlabAccessToken?.trim()),
  };
}
