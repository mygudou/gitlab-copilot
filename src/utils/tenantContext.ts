import { AsyncLocalStorage } from 'async_hooks';
import { TenantUserContext } from '../types/tenant';

const tenantStorage = new AsyncLocalStorage<TenantUserContext | undefined>();

export function runWithTenantContext<T>(
  tenant: TenantUserContext | undefined,
  callback: () => T
): T {
  return tenantStorage.run(tenant, callback);
}

export function getCurrentTenantContext(): TenantUserContext | undefined {
  return tenantStorage.getStore();
}
