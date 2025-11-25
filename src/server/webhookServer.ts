import express, { Request, Response } from 'express';
import cookieParser from 'cookie-parser';
import path from 'path';
import { config } from '../utils/config';
import { verifyGitLabSignature, SignatureHeaders } from '../utils/webhook';
import logger from '../utils/logger';
import { GitLabWebhookEvent } from '../types/gitlab';
import { EventProcessor } from '../services/eventProcessor';
import { SessionCleanupService } from '../services/sessionCleanupService';
import { WorkspaceCleanupService } from '../services/workspaceCleanupService';
import {
  recordWebhookEvent,
  markWebhookEventProcessed,
  updateWebhookEventDetails
} from '../services/storage/eventRepository';
import { resolveTenantByToken } from '../services/storage/userRepository';
import { ResolvedWebhookTenant, TenantUserContext } from '../types/tenant';
import { runWithTenantContext } from '../utils/tenantContext';
import { determineEventContext, extractInstructionText, detectAiProvider } from '../utils/eventContextHelper';
import { ensureConfigTokens } from '../services/storage/configTokenMigration';

// Import API routes
import authRouter from '../routes/auth';
import usersRouter from '../routes/users';
import gitlabConfigRouter from '../routes/gitlab-config';
import usageStatsRouter from '../routes/usage-stats';

// Import middleware
import { configureCORS, addRequestId } from '../middleware/auth';

class WebhookAuthError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'WebhookAuthError';
  }
}

export class WebhookServer {
  private app: express.Application;
  private eventProcessor: EventProcessor;
  private cleanupService: SessionCleanupService;
  private workspaceCleanupService: WorkspaceCleanupService;

  constructor() {
    this.app = express();
    this.eventProcessor = new EventProcessor();
    this.cleanupService = new SessionCleanupService(this.eventProcessor.getSessionManager());
    this.workspaceCleanupService = new WorkspaceCleanupService();
    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    // CORS configuration
    this.app.use(configureCORS);

    // Request ID
    this.app.use(addRequestId);

    // Body parsing middleware
    this.app.use(cookieParser());
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));

    // Use raw middleware to preserve original request body for webhook signature verification
    this.app.use('/webhook', express.raw({ type: 'application/json', limit: '10mb' }));

    // Static files for web UI
    if (process.env.WEB_UI_ENABLED === 'true') {
      const webUIBasePath = process.env.WEB_UI_BASE_PATH || '/auth';
      const publicPath = path.join(__dirname, '../../public');

      logger.info(`Web UI enabled at base path: ${webUIBasePath}`, { publicPath });

      // Serve static files from public directory
      this.app.use(express.static(publicPath));

    // Serve web UI assets under the base path
    this.app.use(webUIBasePath, express.static(publicPath));
    }
  }

  private setupRoutes(): void {
    // API Routes
    this.app.use('/api/auth', authRouter);
    this.app.use('/api/users', usersRouter);
    this.app.use('/api/gitlab-configs', gitlabConfigRouter);
    this.app.use('/api/usage-stats', usageStatsRouter);

    // Web UI Routes (SPA routing)
    if (process.env.WEB_UI_ENABLED === 'true') {
      const publicPath = path.join(__dirname, '../../public');

      // Serve specific HTML pages for known routes
      this.app.get('/docs', (req: Request, res: Response) => {
        res.sendFile(path.join(publicPath, 'docs.html'));
      });

      this.app.get('/stats', (req: Request, res: Response) => {
        res.sendFile(path.join(publicPath, 'stats.html'));
      });

      this.app.get('/config', (req: Request, res: Response) => {
        res.sendFile(path.join(publicPath, 'config.html'));
      });

      // Default route serves index.html
      this.app.get('/', (req: Request, res: Response) => {
        res.sendFile(path.join(publicPath, 'index.html'));
      });
    }

    // Legacy webhook route
    this.app.post('/webhook/:userToken?', this.handleWebhook.bind(this));

    // Health check endpoint
    this.app.get('/health', (req: Request, res: Response) => {
      const health = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        version: '1.0.0',
        environment: process.env.NODE_ENV || 'development',
        webUI: {
          enabled: process.env.WEB_UI_ENABLED === 'true',
          basePath: process.env.WEB_UI_BASE_PATH || '/auth'
        },
        sessions: config.session.enabled ? {
          enabled: true,
          cleanupService: this.cleanupService.getStatus(),
          stats: this.eventProcessor.getSessionStats(),
        } : {
          enabled: false,
        },
        workspaces: {
          cleanupService: this.workspaceCleanupService.getStatus(),
        },
        features: {
          userAuthentication: true,
          gitlabConfigManagement: true,
          webSessions: true
        }
      };
      res.json(health);
    });

    // Root endpoint (only if Web UI is not enabled)
    if (process.env.WEB_UI_ENABLED !== 'true') {
      this.app.get('/', (req: Request, res: Response) => {
        res.json({
          service: 'GitLab AI Webhook & Configuration Service',
          version: '1.0.0',
          status: 'running',
          documentation: {
            authAPI: '/api/auth',
            userAPI: '/api/users',
            configAPI: '/api/gitlab-configs',
            health: '/health'
          },
          webUI: {
            enabled: false,
            basePath: process.env.WEB_UI_BASE_PATH || '/auth'
          }
        });
      });
    }

    // API documentation endpoint
    this.app.get('/api', (req: Request, res: Response) => {
      res.json({
        version: '1.0.0',
        endpoints: {
          authentication: {
            register: 'POST /api/auth/register',
            login: 'POST /api/auth/login',
            logout: 'POST /api/auth/logout',
            refresh: 'POST /api/auth/refresh',
            me: 'GET /api/auth/me',
            validate: 'POST /api/auth/validate'
          },
          users: {
            profile: 'GET /api/users/me',
            updateProfile: 'PUT /api/users/me',
            changePassword: 'POST /api/users/me/change-password',
            sessions: 'GET /api/users/me/sessions',
            terminateSession: 'DELETE /api/users/me/sessions/:sessionId',
            terminateAllSessions: 'DELETE /api/users/me/sessions'
          },
          gitlabConfig: {
            list: 'GET /api/gitlab-configs',
            create: 'POST /api/gitlab-configs',
            get: 'GET /api/gitlab-configs/:configId',
            update: 'PUT /api/gitlab-configs/:configId',
            delete: 'DELETE /api/gitlab-configs/:configId',
            setDefault: 'POST /api/gitlab-configs/:configId/set-default',
            getDefault: 'GET /api/gitlab-configs/default',
            testConnection: 'POST /api/gitlab-configs/test-connection'
          }
        },
        security: {
          authentication: 'Bearer token required for most endpoints',
          validation: 'Input validation on all request bodies',
          CORS: 'Configured for web applications'
        }
      });
    });

    // Web UI routes (when enabled)
    if (process.env.WEB_UI_ENABLED === 'true') {
      const webUIBasePath = process.env.WEB_UI_BASE_PATH || '/auth';
      this.setupWebUIRoutes(webUIBasePath);
    }

    // Catch-all for unmatched routes
    this.app.use('*', (req: Request, res: Response) => {
      const requestId = req.requestId || 'unknown';

      logger.warn('Route not found', {
        requestId,
        method: req.method,
        path: req.originalUrl,
        ip: req.ip
      });

      res.status(404).json({
        success: false,
        error: {
          type: 'NotFound',
          message: `Route ${req.method} ${req.originalUrl} not found`,
          code: 'ROUTE_NOT_FOUND'
        },
        timestamp: new Date().toISOString(),
        requestId
      });
    });
  }

  private setupWebUIRoutes(basePath: string): void {
    const publicPath = path.join(__dirname, '../../public');
    const normalizedBasePath = basePath !== '/' && basePath.endsWith('/')
      ? basePath.replace(/\/+$/, '')
      : basePath;

    const servePage = (routePath: string, fileName: string) => {
      this.app.get(routePath, (req: Request, res: Response) => {
        res.sendFile(path.join(publicPath, fileName));
      });
    };

    // Serve main pages
    servePage(`${normalizedBasePath}/`, 'index.html');
    servePage(`${normalizedBasePath}/login`, 'login.html');
    servePage(`${normalizedBasePath}/register`, 'register.html');
    servePage(`${normalizedBasePath}/dashboard`, 'dashboard.html');
    servePage(`${normalizedBasePath}/config`, 'config.html');
    servePage(`${normalizedBasePath}/stats`, 'stats.html');

    // Provide root-level aliases when the web UI is mounted under a sub-path
    if (normalizedBasePath && normalizedBasePath !== '/') {
      servePage('/login', 'login.html');
      servePage('/register', 'register.html');
      servePage('/dashboard', 'dashboard.html');
      servePage('/config', 'config.html');
      servePage('/stats', 'stats.html');
    }

    this.app.get(`${normalizedBasePath}/dashboard`, (req: Request, res: Response) => {
      res.sendFile(path.join(publicPath, 'dashboard.html'));
    });

    // Redirect root path to basePath
    this.app.get('/', (req: Request, res: Response) => {
      if (req.accepts('html')) {
        res.redirect(`${normalizedBasePath || ''}/`.replace(/\/+$/, '/'));
        return;
      }
      // For API requests, continue with JSON response
      res.json({
        service: 'GitLab AI Webhook & Configuration Service',
        version: '1.0.0',
        status: 'running',
        documentation: {
          authAPI: '/api/auth',
          userAPI: '/api/users',
          configAPI: '/api/gitlab-configs',
          health: '/health'
        },
        webUI: {
          enabled: true,
          basePath: basePath
        }
      });
    });

    logger.info(`Web UI routes configured under ${basePath}`);
  }

  private async handleWebhook(req: Request, res: Response): Promise<void> {
    try {
      const signatureHeaders: SignatureHeaders = {
        token: this.extractHeaderValue(req.headers['x-gitlab-token']),
        webhookSignature: this.extractHeaderValue(req.headers['x-gitlab-webhook-signature']),
      };
      const rawBody =
        req.body instanceof Buffer ? req.body.toString('utf8') : JSON.stringify(req.body ?? {});

      const tenant = await this.resolveWebhookTenant(req);

      if (!verifyGitLabSignature(rawBody, signatureHeaders, tenant.secret)) {
        logger.warn('Webhook signature verification failed', {
          mode: tenant.mode,
          hasToken: Boolean(signatureHeaders.token),
          hasWebhookSignature: Boolean(signatureHeaders.webhookSignature),
          expectedSecretLength: tenant.secret?.length,
          hint: 'Make sure to configure the Secret Token in your GitLab webhook settings'
        });
        throw new WebhookAuthError(401, 'Invalid signature');
      }

      const event: GitLabWebhookEvent = req.body instanceof Buffer ? JSON.parse(rawBody) : req.body;

      logger.info(`Received GitLab webhook: ${event.object_kind}`, {
        eventType: event.object_kind,
        projectId: event.project?.id,
        userId: event.user?.id,
        tenantMode: tenant.mode,
        tenantUserId: tenant.user?.userId,
      });

      runWithTenantContext(tenant.user, () => {
        let recordedEventPromise: Promise<unknown | null> = Promise.resolve(null);

        if (config.platform.hasMongoCredentials) {
          // Determine event context
          const eventContextInfo = determineEventContext(event);

          // Try to extract instruction text and detect AI provider from event
          let instructionText = '';
          let detectedProvider: 'claude' | 'codex' | null = null;

          try {
            let contentToCheck = '';

            if (event.object_kind === 'note' && event.object_attributes?.note) {
              contentToCheck = event.object_attributes.note as string;
              instructionText = extractInstructionText(contentToCheck);
            } else if (event.object_kind === 'issue' && event.issue?.description) {
              contentToCheck = event.issue.description;
              instructionText = extractInstructionText(contentToCheck);
            } else if (event.object_kind === 'merge_request' && event.merge_request?.description) {
              contentToCheck = event.merge_request.description;
              instructionText = extractInstructionText(contentToCheck);
            }

            // Detect AI provider from the content
            if (contentToCheck) {
              detectedProvider = detectAiProvider(contentToCheck);
            }
          } catch (error) {
            logger.warn('Failed to extract instruction text', { error });
          }

          // When a merge request is opened, persist the full description as instruction text
          if (
            !instructionText &&
            event.object_kind === 'merge_request' &&
            (event.object_attributes as { action?: string } | undefined)?.action === 'open'
          ) {
            const description =
              event.merge_request?.description ||
              (event.object_attributes as { description?: string } | undefined)?.description ||
              '';
            instructionText = description.substring(0, 2000).trim();
          }

          // Extract additional background fields
          const webhookAction = (event.object_attributes as any)?.action;
          const sourceBranch = event.merge_request?.source_branch || (event.object_attributes as any)?.source_branch;
          const targetBranch = event.merge_request?.target_branch || (event.object_attributes as any)?.target_branch;

          // Build background note
          let note = '';
          if (event.object_kind === 'merge_request') {
            note = `MR ${webhookAction || 'event'} in ${event.project?.name}`;
          } else if (event.object_kind === 'issue') {
            note = `Issue ${webhookAction || 'event'} in ${event.project?.name}`;
          } else if (event.object_kind === 'note') {
            const noteableType = (event.object_attributes as any)?.noteable_type;
            note = `Comment on ${noteableType?.toLowerCase() || 'item'} in ${event.project?.name}`;
          }

          recordedEventPromise = recordWebhookEvent({
            status: 'received',
            userId: tenant.user?.userId,
            userToken: tenant.user?.userToken,
            gitlabConfigId: tenant.user?.gitlabConfigId,
            projectId: event.project?.id,
            projectName: event.project?.name,
            eventType: event.object_kind,
            eventContext: eventContextInfo.context,
            contextId: eventContextInfo.contextId,
            contextTitle: eventContextInfo.contextTitle,
            instructionText: instructionText || undefined,
            aiProvider: detectedProvider || (config.ai.executor as 'claude' | 'codex'),
            payload: event,
            receivedAt: new Date(),

            // Enhanced background fields
            note: note || undefined,
            isProgressResponse: false, // Initial webhook events are not progress responses
            responseType: instructionText ? 'instruction' : undefined,
            webhookAction: webhookAction || undefined,
            sourceBranch: sourceBranch || undefined,
            targetBranch: targetBranch || undefined,
            authorUsername: event.user?.username,
            authorEmail: event.user?.email,
          });
        }

        const processing = runWithTenantContext(tenant.user, () =>
          this.eventProcessor.processEvent(event, tenant.user)
        );

        processing
          .then(async result => {
            try {
              const eventRecordId = await recordedEventPromise;
              if (!eventRecordId) {
                return;
              }

              const status = result.status === 'error' ? 'error' : 'processed';
              await markWebhookEventProcessed(eventRecordId, status, result.error);

              const updatePayload: Parameters<typeof updateWebhookEventDetails>[1] = {};
              if (Number.isFinite(result.executionTimeMs)) {
                updatePayload.executionTimeMs = result.executionTimeMs;
              }

              if (Object.keys(updatePayload).length > 0) {
                await updateWebhookEventDetails(eventRecordId, updatePayload);
              }
            } catch (updateError) {
              logger.error('Failed to update webhook event record', updateError);
            }
          })
          .catch(async error => {
            logger.error('Error processing GitLab event:', error);

            try {
              const eventRecordId = await recordedEventPromise;
              if (!eventRecordId) {
                return;
              }

              await markWebhookEventProcessed(
                eventRecordId,
                'error',
                error instanceof Error ? error.message : String(error)
              );
            } catch (statusUpdateError) {
              logger.error('Failed to record webhook event failure status', statusUpdateError);
            }
          });
      });

      res.status(200).json({ message: 'Webhook received' });
    } catch (error) {
      if (error instanceof WebhookAuthError) {
        logger.warn('Webhook request rejected', {
          status: error.status,
          reason: error.message,
        });
        res.status(error.status).json({ error: error.message });
        return;
      }

      logger.error('Error handling webhook:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  private extractHeaderValue(value: string | string[] | undefined): string | undefined {
    if (Array.isArray(value)) {
      return value[0];
    }

    return typeof value === 'string' ? value : undefined;
  }

  private extractUserToken(req: Request): string | undefined {
    const paramsToken = (req.params as Record<string, string | undefined>)?.userToken;
    const headerValue = req.headers['x-copilot-user'];
    const headerToken = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    const queryValue = req.query?.userToken;
    const queryToken = Array.isArray(queryValue) ? queryValue[0] : queryValue;

    const candidates = [paramsToken, headerToken, queryToken]
      .map(token => (typeof token === 'string' ? token.trim() : undefined))
      .filter((token): token is string => Boolean(token));

    return candidates[0];
  }

  private buildLegacyTenant(): ResolvedWebhookTenant | null {
    if (!config.platform.hasLegacyCredentials) {
      return null;
    }

    const secret = config.webhook.secret;
    if (!secret) {
      return null;
    }

    const gitlabToken = config.gitlab.token;
    const user: TenantUserContext | undefined = gitlabToken
      ? {
          userId: 'legacy-default',
          userToken: 'legacy-default',
          gitlabBaseUrl: config.gitlab.baseUrl,
          gitlabAccessToken: gitlabToken,
          platformUserId: 'legacy-default',
          isLegacyFallback: true,
        }
      : undefined;

    return {
      mode: 'legacy',
      secret,
      user,
    };
  }

  private async resolveWebhookTenant(req: Request): Promise<ResolvedWebhookTenant> {
    const token = this.extractUserToken(req);

    if (token && config.platform.hasMongoCredentials) {
      try {
        const resolved = await resolveTenantByToken(token);
        if (resolved) {
          return {
            mode: 'tenant',
            secret: resolved.secret,
            user: resolved.user,
          };
        }

        const masked = `***${token.slice(-4)}`;
        logger.warn('Tenant token not found', { tokenSuffix: masked });
        throw new WebhookAuthError(404, 'Tenant not found');
      } catch (error) {
        if (error instanceof WebhookAuthError) {
          throw error;
        }

        const masked = `***${token.slice(-4)}`;
        logger.error('Failed to resolve tenant via MongoDB', {
          tokenSuffix: masked,
          error: error instanceof Error ? error.message : String(error),
        });
        throw new WebhookAuthError(503, 'Tenant resolution failed');
      }
    }

    if (!token && config.platform.hasMongoCredentials && !config.platform.hasLegacyCredentials) {
      throw new WebhookAuthError(400, 'Missing tenant token');
    }

    const legacy = this.buildLegacyTenant();
    if (legacy) {
      if (token) {
        logger.warn('Tenant token provided but platform user not found, falling back to legacy', {
          tokenSuffix: `***${token.slice(-4)}`,
        });
      }
      return legacy;
    }

    if (token) {
      const masked = `***${token.slice(-4)}`;
      logger.warn('Tenant token not matched in any store', { tokenSuffix: masked });
      throw new WebhookAuthError(404, 'Tenant not found');
    }

    throw new WebhookAuthError(401, 'No valid webhook credentials configured');
  }

  public async start(): Promise<void> {
    try {
      // Run configToken migration before starting server
      await ensureConfigTokens();

      this.app.listen(config.webhook.port, () => {
        logger.info(`GitLab AI Webhook server started on port ${config.webhook.port}`);

        // Start session cleanup service
        this.cleanupService.start();
        this.workspaceCleanupService.start();
      });
    } catch (error) {
      logger.error('Failed to start server:', error);
      process.exit(1);
    }
  }

  public stop(): void {
    try {
      // Stop session cleanup service
      this.cleanupService.stop();
      this.workspaceCleanupService.stop();

      logger.info('GitLab AI Webhook server stopped');
    } catch (error) {
      logger.error('Error stopping server:', error);
    }
  }
}
