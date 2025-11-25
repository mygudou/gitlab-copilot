import { resolveGitLabAuth } from '../gitlabAuth';
import { runWithTenantContext } from '../tenantContext';
import { config } from '../config';
import { TenantUserContext } from '../../types/tenant';

describe('resolveGitLabAuth', () => {
  const originalBaseUrl = config.gitlab.baseUrl;
  const originalToken = config.gitlab.token;

  beforeEach(() => {
    config.gitlab.baseUrl = 'https://example.gitlab.com';
    config.gitlab.token = 'legacy-token';
  });

  afterEach(() => {
    config.gitlab.baseUrl = originalBaseUrl;
    config.gitlab.token = originalToken;
  });

  it('falls back to legacy config when no tenant context is active', () => {
    const auth = resolveGitLabAuth();

    expect(auth.baseUrl).toBe('https://example.gitlab.com');
    expect(auth.token).toBe('legacy-token');
    expect(auth.isTenantToken).toBe(false);
    expect(auth.tenant).toBeUndefined();
  });

  it('prefers tenant token from async context when available', () => {
    const tenant: TenantUserContext = {
      userId: 'u1',
      userToken: 'token',
      gitlabBaseUrl: 'https://tenant.gitlab.com',
      gitlabAccessToken: 'tenant-token',
      isLegacyFallback: false,
    };

    runWithTenantContext(tenant, () => {
      const auth = resolveGitLabAuth();

      expect(auth.baseUrl).toBe('https://tenant.gitlab.com');
      expect(auth.token).toBe('tenant-token');
      expect(auth.isTenantToken).toBe(true);
      expect(auth.tenant).toBe(tenant);
    });
  });
});
