import { WebhookServer } from '../../server/webhookServer';
import { config } from '../../utils/config';
import type { Request, Response } from 'express';
import { ResolvedWebhookTenant } from '../../types/tenant';

describe('WebhookServer webhook authentication', () => {
  const originalPlatformConfig = { ...config.platform };

  beforeEach(() => {
    config.platform.hasMongoCredentials = false;
  });

  afterEach(() => {
    config.platform.hasMongoCredentials = originalPlatformConfig.hasMongoCredentials;
    config.platform.hasLegacyCredentials = originalPlatformConfig.hasLegacyCredentials;
    jest.restoreAllMocks();
  });

  function createResponseMock(): Response {
    const res: Partial<Response> = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res as Response;
  }

  function createRequestMock(headers: Record<string, string>, body: unknown = {}): Request {
    const rawBody = Buffer.from(JSON.stringify(body));
    return {
      headers,
      body: rawBody,
      params: {},
      query: {},
    } as unknown as Request;
  }

  it('returns 401 and skips processing when signature verification fails', async () => {
    const server = new WebhookServer();
    const eventProcessor = (server as any).eventProcessor;
    const processEventSpy = jest.spyOn(eventProcessor, 'processEvent').mockResolvedValue(undefined);

    const tenant: ResolvedWebhookTenant = {
      mode: 'tenant',
      secret: 'expected-secret',
      user: undefined,
    };

    jest.spyOn(server as any, 'resolveWebhookTenant').mockResolvedValue(tenant);

    const req = createRequestMock({ 'x-gitlab-token': 'wrong-secret' }, { object_kind: 'note', project: { id: 1 } });
    const res = createResponseMock();

    await (server as any).handleWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid signature' });
    expect(processEventSpy).not.toHaveBeenCalled();
  });

  it('processes event when direct token matches secret', async () => {
    const server = new WebhookServer();
    const eventProcessor = (server as any).eventProcessor;
    const processEventSpy = jest.spyOn(eventProcessor, 'processEvent').mockResolvedValue(undefined);

    const tenant: ResolvedWebhookTenant = {
      mode: 'tenant',
      secret: 'expected-secret',
      user: { userId: 'u1', userToken: 'token', gitlabBaseUrl: '', gitlabAccessToken: '', isLegacyFallback: false },
    };

    jest.spyOn(server as any, 'resolveWebhookTenant').mockResolvedValue(tenant);

    const body = { object_kind: 'note', project: { id: 1 }, user: { id: 2 } };
    const req = createRequestMock({ 'x-gitlab-token': 'expected-secret' }, body);
    const res = createResponseMock();

    await (server as any).handleWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ message: 'Webhook received' });
    expect(processEventSpy).toHaveBeenCalledTimes(1);
    expect(processEventSpy.mock.calls[0][0]).toEqual(body);
    expect(processEventSpy.mock.calls[0][1]).toEqual(tenant.user);
  });
});
