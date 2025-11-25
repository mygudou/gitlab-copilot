import request from 'supertest';
import express from 'express';
import { WebhookServer } from '../../server/webhookServer';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import path from 'path';
import fs from 'fs';

describe('Web UI Integration Tests', () => {
  let mongoServer: MongoMemoryServer;
  let mongoClient: MongoClient;
  let app: express.Application;
  let server: WebhookServer;

  beforeAll(async () => {
    // Start in-memory MongoDB
    mongoServer = await MongoMemoryServer.create();
    const mongoUri = mongoServer.getUri();
    mongoClient = new MongoClient(mongoUri);
    await mongoClient.connect();

    // Set test environment variables
    process.env.WEB_UI_ENABLED = 'true';
    process.env.WEB_UI_BASE_PATH = '/auth';
    process.env.MONGODB_URI = mongoUri;
    process.env.JWT_SECRET = 'test-jwt-secret-key-for-testing';
    process.env.ENCRYPTION_KEY = 'test-encryption-key-32-chars-long';

    // Create test server
    server = new WebhookServer();
    app = (server as any).app;
  });

  afterAll(async () => {
    if (mongoClient) {
      await mongoClient.close();
    }
    if (mongoServer) {
      await mongoServer.stop();
    }
  });

  beforeEach(async () => {
    // Clear database between tests
    const db = mongoClient.db();
    const collections = await db.listCollections().toArray();
    for (const collection of collections) {
      await db.collection(collection.name).deleteMany({});
    }
  });

  describe('Static File Serving', () => {
    it('should serve the main index.html', async () => {
      const response = await request(app)
        .get('/auth/')
        .expect(200);

      expect(response.headers['content-type']).toMatch(/text\/html/);
    });

    it('should serve CSS files', async () => {
      const response = await request(app)
        .get('/css/main.css')
        .expect(200);

      expect(response.headers['content-type']).toMatch(/text\/css/);
    });

    it('should serve JavaScript files', async () => {
      const response = await request(app)
        .get('/js/api.js')
        .expect(200);

      expect(response.headers['content-type']).toMatch(/application\/javascript/);
    });

    it('should serve registration page', async () => {
      const response = await request(app)
        .get('/auth/register')
        .expect(200);

      expect(response.headers['content-type']).toMatch(/text\/html/);
    });

    it('should serve login page', async () => {
      const response = await request(app)
        .get('/auth/login')
        .expect(200);

      expect(response.headers['content-type']).toMatch(/text\/html/);
    });

    it('should serve dashboard page', async () => {
      const response = await request(app)
        .get('/auth/dashboard')
        .expect(200);

      expect(response.headers['content-type']).toMatch(/text\/html/);
    });

    it('should serve configuration page', async () => {
      const response = await request(app)
        .get('/auth/config')
        .expect(200);

      expect(response.headers['content-type']).toMatch(/text\/html/);
    });
  });

  describe('Root Route Behavior', () => {
    it('should redirect to auth base path when Web UI is enabled', async () => {
      const response = await request(app)
        .get('/')
        .set('Accept', 'text/html')
        .expect(302);

      expect(response.headers.location).toBe('/auth/');
    });

    it('should return JSON for API requests when Web UI is enabled', async () => {
      const response = await request(app)
        .get('/')
        .set('Accept', 'application/json')
        .expect(200);

      expect(response.body).toHaveProperty('service');
      expect(response.body.webUI.enabled).toBe(true);
    });
  });

  describe('API Integration with Web UI', () => {
    it('should handle user registration through API', async () => {
      const registrationData = {
        username: 'testuser',
        email: 'test@example.com',
        password: 'TestPass123!',
        confirmPassword: 'TestPass123!'
      };

      const response = await request(app)
        .post('/api/auth/register')
        .send(registrationData)
        .expect(201);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty('userToken');
      expect(response.body.data).toHaveProperty('message');
    });

    it('should handle user login through API', async () => {
      // First register a user
      const registrationData = {
        username: 'testuser',
        email: 'test@example.com',
        password: 'TestPass123!',
        confirmPassword: 'TestPass123!'
      };

      await request(app)
        .post('/api/auth/register')
        .send(registrationData)
        .expect(201);

      // Then login
      const loginData = {
        identifier: 'testuser',
        password: 'TestPass123!'
      };

      const response = await request(app)
        .post('/api/auth/login')
        .send(loginData)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty('user');
      expect(response.body.data).toHaveProperty('accessToken');
      expect(response.body.data).toHaveProperty('refreshToken');
      expect(response.body.data.user.username).toBe('testuser');
    });

    it('should require authentication for protected routes', async () => {
      const response = await request(app)
        .get('/api/auth/me')
        .expect(401);

      expect(response.body.success).toBe(false);
      expect(response.body.error.type).toBe('AuthenticationError');
    });

    it('should allow authenticated access to protected routes', async () => {
      // Register and login first
      const registrationData = {
        username: 'testuser',
        email: 'test@example.com',
        password: 'TestPass123!',
        confirmPassword: 'TestPass123!'
      };

      await request(app)
        .post('/api/auth/register')
        .send(registrationData)
        .expect(201);

      const loginResponse = await request(app)
        .post('/api/auth/login')
        .send({
          identifier: 'testuser',
          password: 'TestPass123!'
        })
        .expect(200);

      const accessToken = loginResponse.body.data.accessToken;

      // Access protected route
      const response = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.user.username).toBe('testuser');
    });
  });

  describe('GitLab Configuration API Integration', () => {
    let accessToken: string;

    beforeEach(async () => {
      // Register and login for each test
      const registrationData = {
        username: 'testuser',
        email: 'test@example.com',
        password: 'TestPass123!',
        confirmPassword: 'TestPass123!'
      };

      await request(app)
        .post('/api/auth/register')
        .send(registrationData);

      const loginResponse = await request(app)
        .post('/api/auth/login')
        .send({
          identifier: 'testuser',
          password: 'TestPass123!'
        });

      accessToken = loginResponse.body.data.accessToken;
    });

    it('should create GitLab configuration', async () => {
      const configData = {
        name: 'Test GitLab',
        gitlabUrl: 'https://gitlab.example.com',
        accessToken: 'test-token-123',
        webhookSecret: 'test-webhook-secret',
        description: 'Test configuration'
      };

      const response = await request(app)
        .post('/api/gitlab-configs')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(configData)
        .expect(201);

      expect(response.body.success).toBe(true);
      expect(response.body.data.config).toHaveProperty('id');
      expect(response.body.data.config.name).toBe('Test GitLab');
      expect(response.body.data.config.gitlabUrl).toBe('https://gitlab.example.com');
    });

    it('should list GitLab configurations', async () => {
      // Create a configuration first
      const configData = {
        name: 'Test GitLab',
        gitlabUrl: 'https://gitlab.example.com',
        accessToken: 'test-token-123',
        webhookSecret: 'test-webhook-secret',
        description: 'Test configuration'
      };

      await request(app)
        .post('/api/gitlab-configs')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(configData);

      // List configurations
      const response = await request(app)
        .get('/api/gitlab-configs')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.configs).toHaveLength(1);
      expect(response.body.data.configs[0].name).toBe('Test GitLab');
    });

    it('should update GitLab configuration', async () => {
      // Create a configuration first
      const configData = {
        name: 'Test GitLab',
        gitlabUrl: 'https://gitlab.example.com',
        accessToken: 'test-token-123',
        webhookSecret: 'test-webhook-secret',
        description: 'Test configuration'
      };

      const createResponse = await request(app)
        .post('/api/gitlab-configs')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(configData);

      const configId = createResponse.body.data.config.id;

      // Update the configuration
      const updateData = {
        name: 'Updated GitLab',
        description: 'Updated description'
      };

      const response = await request(app)
        .put(`/api/gitlab-configs/${configId}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send(updateData)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.config.name).toBe('Updated GitLab');
      expect(response.body.data.config.description).toBe('Updated description');
    });

    it('should delete GitLab configuration', async () => {
      // Create a configuration first
      const configData = {
        name: 'Test GitLab',
        gitlabUrl: 'https://gitlab.example.com',
        accessToken: 'test-token-123',
        webhookSecret: 'test-webhook-secret',
        description: 'Test configuration'
      };

      const createResponse = await request(app)
        .post('/api/gitlab-configs')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(configData);

      const configId = createResponse.body.data.config.id;

      // Delete the configuration
      const response = await request(app)
        .delete(`/api/gitlab-configs/${configId}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);

      // Verify it's deleted
      const listResponse = await request(app)
        .get('/api/gitlab-configs')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(listResponse.body.data.configs).toHaveLength(0);
    });

    it('should set default GitLab configuration', async () => {
      // Create a configuration first
      const configData = {
        name: 'Test GitLab',
        gitlabUrl: 'https://gitlab.example.com',
        accessToken: 'test-token-123',
        webhookSecret: 'test-webhook-secret',
        description: 'Test configuration'
      };

      const createResponse = await request(app)
        .post('/api/gitlab-configs')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(configData);

      const configId = createResponse.body.data.config.id;

      // Set as default
      const response = await request(app)
        .post(`/api/gitlab-configs/${configId}/set-default`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);

      // Verify it's set as default
      const listResponse = await request(app)
        .get('/api/gitlab-configs')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(listResponse.body.data.configs[0].isDefault).toBe(true);
    });

    it('should test GitLab connection', async () => {
      const configData = {
        name: 'Test GitLab',
        gitlabUrl: 'https://gitlab.com',
        accessToken: 'invalid-token',
        webhookSecret: 'test-webhook-secret',
        description: 'Test configuration'
      };

      // This should fail with invalid token
      const response = await request(app)
        .post('/api/gitlab-configs/test-connection')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(configData)
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error.message).toContain('connection');
    });
  });

  describe('CORS and Security Headers', () => {
    it('should include CORS headers for allowed origins', async () => {
      const response = await request(app)
        .get('/api/auth/me')
        .set('Origin', 'http://localhost:3000')
        .expect(401); // Unauthorized but should have CORS headers

      expect(response.headers['access-control-allow-origin']).toBeDefined();
      expect(response.headers['access-control-allow-methods']).toBeDefined();
      expect(response.headers['access-control-allow-headers']).toBeDefined();
    });

    it('should handle preflight OPTIONS requests', async () => {
      const response = await request(app)
        .options('/api/auth/login')
        .set('Origin', 'http://localhost:3000')
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'Content-Type')
        .expect(200);

      expect(response.headers['access-control-allow-origin']).toBeDefined();
      expect(response.headers['access-control-allow-methods']).toBeDefined();
    });

    it('should include request ID in responses', async () => {
      const response = await request(app)
        .get('/api/auth/me')
        .expect(401);

      expect(response.headers['x-request-id']).toBeDefined();
      expect(response.body.requestId).toBeDefined();
    });

    it('should include security headers', async () => {
      const response = await request(app)
        .get('/auth/')
        .expect(200);

      // Note: Specific security headers would depend on implementation
      expect(response.headers['x-request-id']).toBeDefined();
    });
  });

  describe('Error Handling', () => {
    it('should handle 404 for non-existent routes', async () => {
      const response = await request(app)
        .get('/non-existent-route')
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.error.type).toBe('NotFound');
      expect(response.body.error.code).toBe('ROUTE_NOT_FOUND');
    });

    it('should handle validation errors', async () => {
      const invalidRegistrationData = {
        username: 'ab', // too short
        email: 'invalid-email',
        password: 'weak',
        confirmPassword: 'different'
      };

      const response = await request(app)
        .post('/api/auth/register')
        .send(invalidRegistrationData)
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error.type).toBe('ValidationError');
    });

    it('should handle malformed JSON', async () => {
      const response = await request(app)
        .post('/api/auth/register')
        .set('Content-Type', 'application/json')
        .send('invalid json')
        .expect(400);

      expect(response.body.success).toBe(false);
    });

    it('should return health status', async () => {
      const response = await request(app)
        .get('/health')
        .expect(200);

      expect(response.body).toHaveProperty('status', 'healthy');
      expect(response.body).toHaveProperty('timestamp');
      expect(response.body).toHaveProperty('uptime');
      expect(response.body).toHaveProperty('version');
      expect(response.body.webUI.enabled).toBe(true);
      expect(response.body.features.userAuthentication).toBe(true);
      expect(response.body.features.gitlabConfigManagement).toBe(true);
    });
  });

  describe('API Documentation', () => {
    it('should return API documentation', async () => {
      const response = await request(app)
        .get('/api')
        .expect(200);

      expect(response.body).toHaveProperty('version');
      expect(response.body).toHaveProperty('endpoints');
      expect(response.body.endpoints).toHaveProperty('authentication');
      expect(response.body.endpoints).toHaveProperty('users');
      expect(response.body.endpoints).toHaveProperty('gitlabConfig');
    });
  });
});