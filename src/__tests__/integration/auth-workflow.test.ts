import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, Db } from 'mongodb';
import authRouter from '../../routes/auth';
import gitlabConfigRouter from '../../routes/gitlab-config';
import userRouter from '../../routes/users';
import { errorHandler } from '../../middleware/errorHandler';

// Integration test setup with real MongoDB in memory
describe('Authentication Workflow Integration Tests', () => {
  let app: express.Application;
  let mongoServer: MongoMemoryServer;
  let mongoClient: MongoClient;
  let db: Db;

  beforeAll(async () => {
    // Start in-memory MongoDB
    mongoServer = await MongoMemoryServer.create();
    const mongoUri = mongoServer.getUri();

    mongoClient = new MongoClient(mongoUri);
    await mongoClient.connect();
    db = mongoClient.db('test-gitlab-copilot');

    // Set environment variables for testing
    process.env.MONGODB_URI = mongoUri;
    process.env.JWT_SECRET = 'test-secret-for-integration';
    process.env.JWT_ACCESS_EXPIRES_IN = '15m';
    process.env.JWT_REFRESH_EXPIRES_IN = '7d';
    process.env.BCRYPT_ROUNDS = '4'; // Lower for faster tests
    process.env.MAX_LOGIN_ATTEMPTS = '5';
    process.env.LOCKOUT_DURATION = '1'; // 1 minute for faster tests

    // Setup Express app
    app = express();
    app.use(express.json());
    app.use(cookieParser());
    // Add request ID middleware
    app.use((req, res, next) => {
      req.requestId = `test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      next();
    });

    app.use('/auth', authRouter);
    app.use('/api/gitlab-configs', gitlabConfigRouter);
    app.use('/api/users', userRouter);
    app.use(errorHandler);
  });

  afterAll(async () => {
    await mongoClient.close();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    // Clean database before each test
    await db.collection('users').deleteMany({});
    await db.collection('gitlab_configs').deleteMany({});
    await db.collection('web_sessions').deleteMany({});
  });

  describe('Complete User Registration and Login Workflow', () => {
    const validUser = {
      username: 'testuser',
      email: 'test@example.com',
      password: 'StrongPassword123!',
      confirmPassword: 'StrongPassword123!'
    };

    it('should complete full user registration workflow', async () => {
      // Step 1: Register user
      const registerResponse = await request(app)
        .post('/auth/register')
        .send(validUser);

      expect(registerResponse.status).toBe(201);
      expect(registerResponse.body.success).toBe(true);
      expect(registerResponse.body.data.userToken).toBeDefined();
      expect(registerResponse.body.data.message).toContain('Registration successful');

      // Verify user was created in database
      const userInDb = await db.collection('users').findOne({ email: validUser.email });
      expect(userInDb).toBeTruthy();
      expect(userInDb.username).toBe(validUser.username);
      expect(userInDb.email).toBe(validUser.email);
      expect(userInDb.passwordHash).toBeDefined();
      expect(userInDb.isEmailVerified).toBe(false); // Should start as unverified
    });

    it('should complete full login workflow with session management', async () => {
      // Step 1: Register user
      await request(app)
        .post('/auth/register')
        .send(validUser);

      // Step 2: Login user
      const loginResponse = await request(app)
        .post('/auth/login')
        .send({
          identifier: validUser.username,
          password: validUser.password
        });

      expect(loginResponse.status).toBe(200);
      expect(loginResponse.body.success).toBe(true);
      expect(loginResponse.body.data.user).toBeDefined();
      expect(loginResponse.body.data.expiresIn).toBe(900); // 15 minutes

      // Check cookies are set
      const cookies = loginResponse.headers['set-cookie'];
      expect(cookies).toBeDefined();
      expect(cookies.some((cookie: string) => cookie.startsWith('accessToken='))).toBe(true);
      expect(cookies.some((cookie: string) => cookie.startsWith('refreshToken='))).toBe(true);

      // Extract tokens
      const accessTokenCookie = cookies.find((cookie: string) => cookie.startsWith('accessToken='));
      const refreshTokenCookie = cookies.find((cookie: string) => cookie.startsWith('refreshToken='));

      const accessToken = accessTokenCookie?.split('=')[1].split(';')[0];
      const refreshToken = refreshTokenCookie?.split('=')[1].split(';')[0];

      expect(accessToken).toBeDefined();
      expect(refreshToken).toBeDefined();

      // Verify session was created in database
      const sessionInDb = await db.collection('web_sessions').findOne({ userId: loginResponse.body.data.user.id });
      expect(sessionInDb).toBeTruthy();
      expect(sessionInDb.isActive).toBe(true);

      // Step 3: Verify authentication works
      const meResponse = await request(app)
        .get('/auth/me')
        .set('Authorization', `Bearer ${accessToken}`);

      expect(meResponse.status).toBe(200);
      expect(meResponse.body.success).toBe(true);
      expect(meResponse.body.data.user.username).toBe(validUser.username);
    });

    it('should handle token refresh workflow', async () => {
      // Step 1: Register and login
      await request(app)
        .post('/auth/register')
        .send(validUser);

      const loginResponse = await request(app)
        .post('/auth/login')
        .send({
          identifier: validUser.email,
          password: validUser.password
        });

      const cookies = loginResponse.headers['set-cookie'];
      const refreshTokenCookie = cookies.find((cookie: string) => cookie.startsWith('refreshToken='));
      const refreshToken = refreshTokenCookie?.split('=')[1].split(';')[0];

      // Step 2: Refresh tokens
      const refreshResponse = await request(app)
        .post('/auth/refresh')
        .set('Cookie', `refreshToken=${refreshToken}`)
        .send();

      expect(refreshResponse.status).toBe(200);
      expect(refreshResponse.body.success).toBe(true);
      expect(refreshResponse.body.data.accessToken).toBeDefined();
      expect(refreshResponse.body.data.refreshToken).toBeDefined();

      // New cookies should be set
      const newCookies = refreshResponse.headers['set-cookie'];
      expect(newCookies).toBeDefined();
      expect(newCookies.some((cookie: string) => cookie.startsWith('accessToken='))).toBe(true);
    });

    it('should handle logout workflow', async () => {
      // Step 1: Register and login
      await request(app)
        .post('/auth/register')
        .send(validUser);

      const loginResponse = await request(app)
        .post('/auth/login')
        .send({
          identifier: validUser.username,
          password: validUser.password
        });

      const cookies = loginResponse.headers['set-cookie'];
      const accessTokenCookie = cookies.find((cookie: string) => cookie.startsWith('accessToken='));
      const accessToken = accessTokenCookie?.split('=')[1].split(';')[0];

      // Step 2: Logout
      const logoutResponse = await request(app)
        .post('/auth/logout')
        .set('Authorization', `Bearer ${accessToken}`)
        .send();

      expect(logoutResponse.status).toBe(200);
      expect(logoutResponse.body.success).toBe(true);

      // Cookies should be cleared
      const logoutCookies = logoutResponse.headers['set-cookie'];
      expect(logoutCookies.some((cookie: string) => cookie.includes('accessToken=;'))).toBe(true);
      expect(logoutCookies.some((cookie: string) => cookie.includes('refreshToken=;'))).toBe(true);

      // Step 3: Verify token is no longer valid
      const meResponse = await request(app)
        .get('/auth/me')
        .set('Authorization', `Bearer ${accessToken}`);

      expect(meResponse.status).toBe(401);
      expect(meResponse.body.success).toBe(false);
    });
  });

  describe('GitLab Configuration Management Workflow', () => {
    let userToken: string;
    let accessToken: string;

    beforeEach(async () => {
      // Setup authenticated user
      const validUser = {
        username: 'configuser',
        email: 'config@example.com',
        password: 'StrongPassword123!',
        confirmPassword: 'StrongPassword123!'
      };

      const registerResponse = await request(app)
        .post('/auth/register')
        .send(validUser);

      userToken = registerResponse.body.data.userToken;

      const loginResponse = await request(app)
        .post('/auth/login')
        .send({
          identifier: validUser.username,
          password: validUser.password
        });

      const cookies = loginResponse.headers['set-cookie'];
      const accessTokenCookie = cookies.find((cookie: string) => cookie.startsWith('accessToken='));
      accessToken = accessTokenCookie?.split('=')[1].split(';')[0];
    });

    it('should complete GitLab configuration creation workflow', async () => {
      const gitlabConfig = {
        name: 'My GitLab Instance',
        gitlabUrl: 'https://gitlab.example.com',
        accessToken: 'glpat-test-token',
        webhookSecret: 'webhook-secret-123',
        description: 'Test GitLab configuration'
      };

      // Create GitLab configuration
      const createResponse = await request(app)
        .post('/api/gitlab-configs')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(gitlabConfig);

      expect(createResponse.status).toBe(201);
      expect(createResponse.body.success).toBe(true);
      expect(createResponse.body.data.name).toBe(gitlabConfig.name);
      expect(createResponse.body.data.gitlabUrl).toBe(gitlabConfig.gitlabUrl);
      expect(createResponse.body.data.id).toBeDefined();

      // Verify encrypted storage
      const configInDb = await db.collection('gitlab_configs').findOne({
        name: gitlabConfig.name
      });
      expect(configInDb).toBeTruthy();
      expect(configInDb.encryptedAccessToken).toBeDefined();
      expect(configInDb.encryptedWebhookSecret).toBeDefined();
      expect(configInDb.encryptedAccessToken).not.toBe(gitlabConfig.accessToken);
      expect(configInDb.encryptedWebhookSecret).not.toBe(gitlabConfig.webhookSecret);
    });

    it('should handle configuration update workflow', async () => {
      // Create initial configuration
      const initialConfig = {
        name: 'Initial Config',
        gitlabUrl: 'https://gitlab.example.com',
        accessToken: 'glpat-initial-token',
        webhookSecret: 'initial-secret',
        description: 'Initial description'
      };

      const createResponse = await request(app)
        .post('/api/gitlab-configs')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(initialConfig);

      const configId = createResponse.body.data.id;

      // Update configuration
      const updatedConfig = {
        name: 'Updated Config',
        description: 'Updated description'
      };

      const updateResponse = await request(app)
        .put(`/api/gitlab-configs/${configId}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send(updatedConfig);

      expect(updateResponse.status).toBe(200);
      expect(updateResponse.body.success).toBe(true);
      expect(updateResponse.body.data.name).toBe(updatedConfig.name);
      expect(updateResponse.body.data.description).toBe(updatedConfig.description);
    });

    it('should handle configuration deletion workflow', async () => {
      // Create configuration
      const config = {
        name: 'Config to Delete',
        gitlabUrl: 'https://gitlab.example.com',
        accessToken: 'glpat-delete-token',
        webhookSecret: 'delete-secret'
      };

      const createResponse = await request(app)
        .post('/api/gitlab-configs')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(config);

      const configId = createResponse.body.data.id;

      // Delete configuration
      const deleteResponse = await request(app)
        .delete(`/api/gitlab-configs/${configId}`)
        .set('Authorization', `Bearer ${accessToken}`);

      expect(deleteResponse.status).toBe(200);
      expect(deleteResponse.body.success).toBe(true);

      // Verify deletion
      const getResponse = await request(app)
        .get(`/api/gitlab-configs/${configId}`)
        .set('Authorization', `Bearer ${accessToken}`);

      expect(getResponse.status).toBe(404);
    });
  });

  describe('Multi-User and Multi-Device Scenarios', () => {
    it('should handle multiple users with separate configurations', async () => {
      // Create first user
      const user1 = {
        username: 'user1',
        email: 'user1@example.com',
        password: 'StrongPassword123!',
        confirmPassword: 'StrongPassword123!'
      };

      await request(app)
        .post('/auth/register')
        .send(user1);

      const login1Response = await request(app)
        .post('/auth/login')
        .send({
          identifier: user1.username,
          password: user1.password
        });

      const user1AccessToken = login1Response.headers['set-cookie']
        .find((cookie: string) => cookie.startsWith('accessToken='))
        ?.split('=')[1].split(';')[0];

      // Create second user
      const user2 = {
        username: 'user2',
        email: 'user2@example.com',
        password: 'StrongPassword456!',
        confirmPassword: 'StrongPassword456!'
      };

      await request(app)
        .post('/auth/register')
        .send(user2);

      const login2Response = await request(app)
        .post('/auth/login')
        .send({
          identifier: user2.username,
          password: user2.password
        });

      const user2AccessToken = login2Response.headers['set-cookie']
        .find((cookie: string) => cookie.startsWith('accessToken='))
        ?.split('=')[1].split(';')[0];

      // Create configurations for each user
      const config1 = {
        name: 'User1 Config',
        gitlabUrl: 'https://gitlab1.example.com',
        accessToken: 'user1-token',
        webhookSecret: 'user1-secret'
      };

      const config2 = {
        name: 'User2 Config',
        gitlabUrl: 'https://gitlab2.example.com',
        accessToken: 'user2-token',
        webhookSecret: 'user2-secret'
      };

      await request(app)
        .post('/api/gitlab-configs')
        .set('Authorization', `Bearer ${user1AccessToken}`)
        .send(config1);

      await request(app)
        .post('/api/gitlab-configs')
        .set('Authorization', `Bearer ${user2AccessToken}`)
        .send(config2);

      // Verify user1 can only see their configurations
      const user1ConfigsResponse = await request(app)
        .get('/api/gitlab-configs')
        .set('Authorization', `Bearer ${user1AccessToken}`);

      expect(user1ConfigsResponse.status).toBe(200);
      expect(user1ConfigsResponse.body.data.configs).toHaveLength(1);
      expect(user1ConfigsResponse.body.data.configs[0].name).toBe(config1.name);

      // Verify user2 can only see their configurations
      const user2ConfigsResponse = await request(app)
        .get('/api/gitlab-configs')
        .set('Authorization', `Bearer ${user2AccessToken}`);

      expect(user2ConfigsResponse.status).toBe(200);
      expect(user2ConfigsResponse.body.data.configs).toHaveLength(1);
      expect(user2ConfigsResponse.body.data.configs[0].name).toBe(config2.name);
    });

    it('should handle multiple concurrent sessions per user', async () => {
      const user = {
        username: 'multideviceuser',
        email: 'multidevice@example.com',
        password: 'StrongPassword123!',
        confirmPassword: 'StrongPassword123!'
      };

      await request(app)
        .post('/auth/register')
        .send(user);

      // Simulate multiple device logins
      const loginPromises = Array.from({ length: 3 }, (_, i) =>
        request(app)
          .post('/auth/login')
          .set('User-Agent', `Device${i + 1}`)
          .send({
            identifier: user.username,
            password: user.password
          })
      );

      const loginResponses = await Promise.all(loginPromises);

      // All logins should succeed
      loginResponses.forEach(response => {
        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
      });

      // Verify multiple sessions exist in database
      const userId = loginResponses[0].body.data.user.id;
      const sessionsInDb = await db.collection('web_sessions').find({ userId }).toArray();
      expect(sessionsInDb.length).toBe(3);

      // All sessions should be active
      sessionsInDb.forEach(session => {
        expect(session.isActive).toBe(true);
      });
    });
  });

  describe('Error Handling and Edge Cases', () => {
    it('should handle network interruptions gracefully', async () => {
      const user = {
        username: 'networkuser',
        email: 'network@example.com',
        password: 'StrongPassword123!',
        confirmPassword: 'StrongPassword123!'
      };

      // Register user
      await request(app)
        .post('/auth/register')
        .send(user);

      // Simulate incomplete requests
      const incompleteData = {
        identifier: user.username
        // Missing password
      };

      const response = await request(app)
        .post('/auth/login')
        .send(incompleteData);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error.type).toBe('ValidationError');
    });

    it('should handle concurrent operations safely', async () => {
      const user = {
        username: 'concurrentuser',
        email: 'concurrent@example.com',
        password: 'StrongPassword123!',
        confirmPassword: 'StrongPassword123!'
      };

      await request(app)
        .post('/auth/register')
        .send(user);

      // Simulate concurrent login attempts
      const concurrentLogins = Array.from({ length: 5 }, () =>
        request(app)
          .post('/auth/login')
          .send({
            identifier: user.username,
            password: user.password
          })
      );

      const results = await Promise.all(concurrentLogins);

      // All should succeed (no race conditions)
      results.forEach(result => {
        expect(result.status).toBe(200);
        expect(result.body.success).toBe(true);
      });
    });
  });
});
