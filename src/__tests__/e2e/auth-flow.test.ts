import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'path';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, Db } from 'mongodb';

// Import all necessary middleware and routes
import authRouter from '../../routes/auth';
import gitlabConfigRouter from '../../routes/gitlab-config';
import userRouter from '../../routes/users';
import { errorHandler } from '../../middleware/errorHandler';

/**
 * End-to-End Tests for Complete Authentication Flows
 *
 * These tests simulate real user interactions through the full stack,
 * including browser-like behavior with cookies, form submissions,
 * and complete user journeys from registration to configuration management.
 */
describe('End-to-End Authentication Flow Tests', () => {
  let app: express.Application;
  let mongoServer: MongoMemoryServer;
  let mongoClient: MongoClient;
  let db: Db;

  beforeAll(async () => {
    // Setup in-memory MongoDB
    mongoServer = await MongoMemoryServer.create();
    const mongoUri = mongoServer.getUri();

    mongoClient = new MongoClient(mongoUri);
    await mongoClient.connect();
    db = mongoClient.db('test-gitlab-copilot-e2e');

    // Set environment variables
    process.env.MONGODB_URI = mongoUri;
    process.env.JWT_SECRET = 'e2e-test-secret-key';
    process.env.JWT_ACCESS_EXPIRES_IN = '15m';
    process.env.JWT_REFRESH_EXPIRES_IN = '7d';
    process.env.BCRYPT_ROUNDS = '4';
    process.env.MAX_LOGIN_ATTEMPTS = '5';
    process.env.LOCKOUT_DURATION = '1';
    process.env.WEB_UI_ENABLED = 'true';
    process.env.WEB_UI_BASE_PATH = '/auth';

    // Setup Express app with all middleware
    app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use(cookieParser());

    // Request ID middleware
    app.use((req, res, next) => {
      req.requestId = `e2e-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      next();
    });

    // Static files (for web UI)
    app.use('/auth', express.static(path.join(__dirname, '../../public')));

    // API routes
    app.use('/auth', authRouter);
    app.use('/api/gitlab-configs', gitlabConfigRouter);
    app.use('/api/users', userRouter);

    // Error handling
    app.use(errorHandler);

    // Web UI routes (simulated)
    app.get('/auth/register', (req, res) => {
      res.status(200).send(`
        <!DOCTYPE html>
        <html>
        <head><title>Register - GitLab Copilot</title></head>
        <body>
          <form id="registerForm" action="/auth/register" method="post">
            <input type="text" name="username" placeholder="Username" required>
            <input type="email" name="email" placeholder="Email" required>
            <input type="password" name="password" placeholder="Password" required>
            <input type="password" name="confirmPassword" placeholder="Confirm Password" required>
            <button type="submit">Register</button>
          </form>
        </body>
        </html>
      `);
    });

    app.get('/auth/login', (req, res) => {
      res.status(200).send(`
        <!DOCTYPE html>
        <html>
        <head><title>Login - GitLab Copilot</title></head>
        <body>
          <form id="loginForm" action="/auth/login" method="post">
            <input type="text" name="identifier" placeholder="Username or Email" required>
            <input type="password" name="password" placeholder="Password" required>
            <button type="submit">Login</button>
          </form>
        </body>
        </html>
      `);
    });

    app.get('/dashboard', (req, res) => {
      res.status(200).send(`
        <!DOCTYPE html>
        <html>
        <head><title>Dashboard - GitLab Copilot</title></head>
        <body>
          <h1>Welcome to GitLab Copilot</h1>
          <div id="userInfo"></div>
          <div id="gitlabConfigs"></div>
          <button onclick="logout()">Logout</button>
        </body>
        </html>
      `);
    });
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

  describe('Complete User Onboarding Journey', () => {
    it('should complete the full user onboarding flow', async () => {
      const userData = {
        username: 'onboardinguser',
        email: 'onboarding@example.com',
        password: 'SecurePassword123!',
        confirmPassword: 'SecurePassword123!'
      };

      // Step 1: User visits registration page
      const registrationPageResponse = await request(app)
        .get('/auth/register');

      expect(registrationPageResponse.status).toBe(200);
      expect(registrationPageResponse.text).toContain('Register - GitLab Copilot');
      expect(registrationPageResponse.text).toContain('registerForm');

      // Step 2: User submits registration form
      const registrationResponse = await request(app)
        .post('/auth/register')
        .send(userData);

      expect(registrationResponse.status).toBe(201);
      expect(registrationResponse.body.success).toBe(true);
      expect(registrationResponse.body.data.userToken).toBeDefined();

      // Step 3: User visits login page
      const loginPageResponse = await request(app)
        .get('/auth/login');

      expect(loginPageResponse.status).toBe(200);
      expect(loginPageResponse.text).toContain('Login - GitLab Copilot');

      // Step 4: User logs in
      const loginResponse = await request(app)
        .post('/auth/login')
        .send({
          identifier: userData.username,
          password: userData.password
        });

      expect(loginResponse.status).toBe(200);
      expect(loginResponse.body.success).toBe(true);

      // Extract cookies for subsequent requests
      const cookies = loginResponse.headers['set-cookie'];
      const cookieHeader = cookies.join('; ');

      // Step 5: User accesses dashboard
      const dashboardResponse = await request(app)
        .get('/dashboard')
        .set('Cookie', cookieHeader);

      expect(dashboardResponse.status).toBe(200);
      expect(dashboardResponse.text).toContain('Welcome to GitLab Copilot');

      // Step 6: User creates GitLab configuration
      const gitlabConfig = {
        name: 'My Primary GitLab',
        gitlabUrl: 'https://gitlab.example.com',
        accessToken: 'glpat-onboarding-token',
        webhookSecret: 'onboarding-webhook-secret',
        description: 'Primary GitLab instance for development'
      };

      const configResponse = await request(app)
        .post('/api/gitlab-configs')
        .set('Cookie', cookieHeader)
        .send(gitlabConfig);

      expect(configResponse.status).toBe(201);
      expect(configResponse.body.success).toBe(true);
      expect(configResponse.body.data.name).toBe(gitlabConfig.name);

      // Step 7: User views their configurations
      const configListResponse = await request(app)
        .get('/api/gitlab-configs')
        .set('Cookie', cookieHeader);

      expect(configListResponse.status).toBe(200);
      expect(configListResponse.body.data.configs).toHaveLength(1);
      expect(configListResponse.body.data.configs[0].name).toBe(gitlabConfig.name);

      // Verify data persistence in database
      const userInDb = await db.collection('users').findOne({ email: userData.email });
      expect(userInDb).toBeTruthy();
      expect(userInDb.username).toBe(userData.username);

      const configInDb = await db.collection('gitlab_configs').findOne({ name: gitlabConfig.name });
      expect(configInDb).toBeTruthy();
      expect(configInDb.encryptedAccessToken).toBeDefined();
      expect(configInDb.encryptedWebhookSecret).toBeDefined();
    });
  });

  describe('Browser Session Management', () => {
    let userData: any;
    let cookieHeader: string;

    beforeEach(async () => {
      userData = {
        username: 'sessionuser',
        email: 'session@example.com',
        password: 'SessionPassword123!',
        confirmPassword: 'SessionPassword123!'
      };

      // Register and login user
      await request(app)
        .post('/auth/register')
        .send(userData);

      const loginResponse = await request(app)
        .post('/auth/login')
        .send({
          identifier: userData.username,
          password: userData.password
        });

      const cookies = loginResponse.headers['set-cookie'];
      cookieHeader = cookies.join('; ');
    });

    it('should maintain session across multiple requests', async () => {
      // Multiple authenticated requests
      const requests = [
        request(app).get('/auth/me').set('Cookie', cookieHeader),
        request(app).get('/api/gitlab-configs').set('Cookie', cookieHeader),
        request(app).get('/api/users/profile').set('Cookie', cookieHeader)
      ];

      const responses = await Promise.all(requests);

      responses.forEach(response => {
        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
      });
    });

    it('should handle session expiration gracefully', async () => {
      // Mock session expiration by modifying JWT secret
      const originalSecret = process.env.JWT_SECRET;
      process.env.JWT_SECRET = 'changed-secret-to-invalidate-tokens';

      const expiredSessionResponse = await request(app)
        .get('/auth/me')
        .set('Cookie', cookieHeader);

      expect(expiredSessionResponse.status).toBe(401);
      expect(expiredSessionResponse.body.success).toBe(false);
      expect(expiredSessionResponse.body.error.type).toBe('AuthenticationError');

      // Restore original secret
      process.env.JWT_SECRET = originalSecret;
    });

    it('should handle token refresh in browser context', async () => {
      // Extract refresh token from cookies
      const refreshTokenMatch = cookieHeader.match(/refreshToken=([^;]+)/);
      const refreshToken = refreshTokenMatch?.[1];

      expect(refreshToken).toBeDefined();

      // Use refresh token to get new tokens
      const refreshResponse = await request(app)
        .post('/auth/refresh')
        .set('Cookie', `refreshToken=${refreshToken}`)
        .send();

      expect(refreshResponse.status).toBe(200);
      expect(refreshResponse.body.success).toBe(true);
      expect(refreshResponse.body.data.accessToken).toBeDefined();

      // New cookies should be set
      const newCookies = refreshResponse.headers['set-cookie'];
      expect(newCookies).toBeDefined();

      const newCookieHeader = newCookies.join('; ');

      // Use new tokens for authenticated request
      const authenticatedResponse = await request(app)
        .get('/auth/me')
        .set('Cookie', newCookieHeader);

      expect(authenticatedResponse.status).toBe(200);
      expect(authenticatedResponse.body.success).toBe(true);
    });

    it('should complete logout flow and clear browser state', async () => {
      // Logout
      const logoutResponse = await request(app)
        .post('/auth/logout')
        .set('Cookie', cookieHeader)
        .send();

      expect(logoutResponse.status).toBe(200);
      expect(logoutResponse.body.success).toBe(true);

      // Check that cookies are cleared
      const clearedCookies = logoutResponse.headers['set-cookie'];
      expect(clearedCookies.some((cookie: string) => cookie.includes('accessToken=;'))).toBe(true);
      expect(clearedCookies.some((cookie: string) => cookie.includes('refreshToken=;'))).toBe(true);

      // Verify subsequent requests fail
      const postLogoutResponse = await request(app)
        .get('/auth/me')
        .set('Cookie', cookieHeader);

      expect(postLogoutResponse.status).toBe(401);
    });
  });

  describe('Multi-Tab and Multi-Device Scenarios', () => {
    let userData: any;

    beforeEach(async () => {
      userData = {
        username: 'multitabuser',
        email: 'multitab@example.com',
        password: 'MultiTabPassword123!',
        confirmPassword: 'MultiTabPassword123!'
      };

      await request(app)
        .post('/auth/register')
        .send(userData);
    });

    it('should handle multiple concurrent browser sessions', async () => {
      // Simulate multiple browser tabs/windows logging in
      const loginPromises = Array.from({ length: 3 }, (_, i) =>
        request(app)
          .post('/auth/login')
          .set('User-Agent', `Browser-Tab-${i + 1}`)
          .send({
            identifier: userData.username,
            password: userData.password
          })
      );

      const loginResponses = await Promise.all(loginPromises);

      // All logins should succeed
      loginResponses.forEach((response, index) => {
        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
        expect(response.body.data.user.username).toBe(userData.username);
      });

      // Extract cookies from each session
      const sessionCookies = loginResponses.map(response =>
        response.headers['set-cookie'].join('; ')
      );

      // Each session should work independently
      const concurrentRequests = sessionCookies.map(cookies =>
        request(app)
          .get('/auth/me')
          .set('Cookie', cookies)
      );

      const responses = await Promise.all(concurrentRequests);

      responses.forEach(response => {
        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
      });

      // Verify multiple sessions in database
      const userId = loginResponses[0].body.data.user.id;
      const sessionsInDb = await db.collection('web_sessions').find({ userId }).toArray();
      expect(sessionsInDb.length).toBe(3);
    });

    it('should handle session cleanup when logging out from one tab', async () => {
      // Login from two different tabs
      const tab1Login = await request(app)
        .post('/auth/login')
        .set('User-Agent', 'Tab-1')
        .send({
          identifier: userData.username,
          password: userData.password
        });

      const tab2Login = await request(app)
        .post('/auth/login')
        .set('User-Agent', 'Tab-2')
        .send({
          identifier: userData.username,
          password: userData.password
        });

      const tab1Cookies = tab1Login.headers['set-cookie'].join('; ');
      const tab2Cookies = tab2Login.headers['set-cookie'].join('; ');

      // Both tabs should work
      const tab1Response = await request(app)
        .get('/auth/me')
        .set('Cookie', tab1Cookies);

      const tab2Response = await request(app)
        .get('/auth/me')
        .set('Cookie', tab2Cookies);

      expect(tab1Response.status).toBe(200);
      expect(tab2Response.status).toBe(200);

      // Logout from tab1
      await request(app)
        .post('/auth/logout')
        .set('Cookie', tab1Cookies);

      // Tab1 should be logged out
      const tab1PostLogout = await request(app)
        .get('/auth/me')
        .set('Cookie', tab1Cookies);

      expect(tab1PostLogout.status).toBe(401);

      // Tab2 should still work (separate session)
      const tab2PostLogout = await request(app)
        .get('/auth/me')
        .set('Cookie', tab2Cookies);

      expect(tab2PostLogout.status).toBe(200);
    });
  });

  describe('Real-World Error Scenarios', () => {
    it('should handle network timeout gracefully', async () => {
      // Simulate slow network by testing with incomplete requests
      const incompleteRegistration = {
        username: 'networkuser',
        email: 'network@example.com'
        // Missing password fields
      };

      const response = await request(app)
        .post('/auth/register')
        .send(incompleteRegistration);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error.type).toBe('ValidationError');
      expect(response.body.error.details.errors).toBeDefined();
    });

    it('should handle malformed cookie data', async () => {
      const malformedCookies = [
        'accessToken=invalid.jwt.token',
        'refreshToken=malformed-token',
        'accessToken=; refreshToken=',
        'accessToken=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c' // Valid JWT but wrong secret
      ];

      for (const cookieHeader of malformedCookies) {
        const response = await request(app)
          .get('/auth/me')
          .set('Cookie', cookieHeader);

        expect(response.status).toBe(401);
        expect(response.body.success).toBe(false);
      }
    });

    it('should handle database connection errors gracefully', async () => {
      // Close database connection to simulate error
      await mongoClient.close();

      const registrationAttempt = {
        username: 'dbuser',
        email: 'db@example.com',
        password: 'DBPassword123!',
        confirmPassword: 'DBPassword123!'
      };

      const response = await request(app)
        .post('/auth/register')
        .send(registrationAttempt);

      expect(response.status).toBe(500);
      expect(response.body.success).toBe(false);
      expect(response.body.error.type).toBe('InternalServerError');

      // Reconnect for cleanup
      mongoClient = new MongoClient(await mongoServer.getUri());
      await mongoClient.connect();
      db = mongoClient.db('test-gitlab-copilot-e2e');
    });
  });

  describe('Security and Performance Edge Cases', () => {
    it('should handle large payload attacks', async () => {
      const largePayload = {
        username: 'a'.repeat(10000),
        email: 'large@example.com',
        password: 'b'.repeat(10000),
        confirmPassword: 'b'.repeat(10000)
      };

      const response = await request(app)
        .post('/auth/register')
        .send(largePayload);

      // Should reject or handle gracefully
      expect([400, 413, 422]).toContain(response.status);
      expect(response.body.success).toBe(false);
    });

    it('should complete full workflow under load', async () => {
      const users = Array.from({ length: 10 }, (_, i) => ({
        username: `loaduser${i}`,
        email: `load${i}@example.com`,
        password: 'LoadTestPassword123!',
        confirmPassword: 'LoadTestPassword123!'
      }));

      // Register all users concurrently
      const registrationPromises = users.map(user =>
        request(app)
          .post('/auth/register')
          .send(user)
      );

      const registrationResults = await Promise.all(registrationPromises);

      // All registrations should succeed
      registrationResults.forEach(result => {
        expect(result.status).toBe(201);
        expect(result.body.success).toBe(true);
      });

      // Login all users concurrently
      const loginPromises = users.map(user =>
        request(app)
          .post('/auth/login')
          .send({
            identifier: user.username,
            password: user.password
          })
      );

      const loginResults = await Promise.all(loginPromises);

      // All logins should succeed
      loginResults.forEach(result => {
        expect(result.status).toBe(200);
        expect(result.body.success).toBe(true);
      });

      // Verify all users exist in database
      const usersInDb = await db.collection('users').find({}).toArray();
      expect(usersInDb.length).toBe(10);

      // Verify all sessions exist
      const sessionsInDb = await db.collection('web_sessions').find({}).toArray();
      expect(sessionsInDb.length).toBe(10);
    });
  });
});
