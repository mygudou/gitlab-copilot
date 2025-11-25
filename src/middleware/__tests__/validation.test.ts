import request from 'supertest';
import express from 'express';
import {
  validateRegistration,
  validateLogin,
  validateGitLabConfig,
  validatePasswordChange,
  validateJsonBody,
  validateContentType
} from '../validation';

jest.mock('../../utils/logger');

describe('Validation Middleware', () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.requestId = 'test-request-id';
      next();
    });
    jest.clearAllMocks();
  });

  describe('validateContentType', () => {
    it('should pass for GET requests', async () => {
      app.use(validateContentType);
      app.get('/test', (req, res) => {
        res.json({ success: true });
      });

      const response = await request(app).get('/test');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should pass for POST requests with correct Content-Type', async () => {
      app.use(validateContentType);
      app.post('/test', (req, res) => {
        res.json({ success: true });
      });

      const response = await request(app)
        .post('/test')
        .set('Content-Type', 'application/json')
        .send({ data: 'test' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should reject POST requests with incorrect Content-Type', async () => {
      app.use(validateContentType);
      app.post('/test', (req, res) => {
        res.json({ success: true });
      });

      const response = await request(app)
        .post('/test')
        .set('Content-Type', 'text/plain')
        .send('test data');

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error.type).toBe('ValidationError');
      expect(response.body.error.code).toBe('INVALID_CONTENT_TYPE');
    });
  });

  describe('validateJsonBody', () => {
    it('should pass for GET requests', async () => {
      app.use(validateJsonBody);
      app.get('/test', (req, res) => {
        res.json({ success: true });
      });

      const response = await request(app).get('/test');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should pass for POST requests with valid JSON body', async () => {
      app.use(validateJsonBody);
      app.post('/test', (req, res) => {
        res.json({ success: true });
      });

      const response = await request(app)
        .post('/test')
        .send({ data: 'test' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should reject POST requests without body', async () => {
      app.use((req, res, next) => {
        req.body = null;
        next();
      });
      app.use(validateJsonBody);
      app.post('/test', (req, res) => {
        res.json({ success: true });
      });

      const response = await request(app).post('/test');

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error.type).toBe('ValidationError');
      expect(response.body.error.code).toBe('INVALID_JSON');
    });
  });

  describe('validateRegistration', () => {
    it('should pass with valid registration data', async () => {
      app.use(validateRegistration);
      app.post('/register', (req, res) => {
        res.json({ success: true, body: req.body });
      });

      const validData = {
        username: 'testuser',
        email: 'test@example.com',
        password: 'StrongPassword123!',
        confirmPassword: 'StrongPassword123!'
      };

      const response = await request(app)
        .post('/register')
        .send(validData);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.body.username).toBe('testuser');
      expect(response.body.body.email).toBe('test@example.com');
    });

    it('should sanitize input data', async () => {
      app.use(validateRegistration);
      app.post('/register', (req, res) => {
        res.json({ success: true, body: req.body });
      });

      const dataWithSpaces = {
        username: '  testuser  ',
        email: '  test@example.com  ',
        password: 'StrongPassword123!',
        confirmPassword: 'StrongPassword123!'
      };

      const response = await request(app)
        .post('/register')
        .send(dataWithSpaces);

      expect(response.status).toBe(200);
      expect(response.body.body.username).toBe('testuser');
      expect(response.body.body.email).toBe('test@example.com');
    });

    it('should reject invalid username', async () => {
      app.use(validateRegistration);
      app.post('/register', (req, res) => {
        res.json({ success: true });
      });

      const invalidData = {
        username: 'ab', // Too short
        email: 'test@example.com',
        password: 'StrongPassword123!',
        confirmPassword: 'StrongPassword123!'
      };

      const response = await request(app)
        .post('/register')
        .send(invalidData);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error.details.errors).toContainEqual({
        field: 'username',
        message: 'Username must be at least 3 characters long'
      });
    });

    it('should reject invalid email', async () => {
      app.use(validateRegistration);
      app.post('/register', (req, res) => {
        res.json({ success: true });
      });

      const invalidData = {
        username: 'testuser',
        email: 'invalid-email',
        password: 'StrongPassword123!',
        confirmPassword: 'StrongPassword123!'
      };

      const response = await request(app)
        .post('/register')
        .send(invalidData);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error.details.errors).toContainEqual({
        field: 'email',
        message: 'Invalid email format'
      });
    });

    it('should reject weak password', async () => {
      app.use(validateRegistration);
      app.post('/register', (req, res) => {
        res.json({ success: true });
      });

      const invalidData = {
        username: 'testuser',
        email: 'test@example.com',
        password: 'weak',
        confirmPassword: 'weak'
      };

      const response = await request(app)
        .post('/register')
        .send(invalidData);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error.details.errors.length).toBeGreaterThan(0);
      expect(response.body.error.details.errors.some((e: any) => e.field === 'password')).toBe(true);
    });

    it('should reject mismatched passwords', async () => {
      app.use(validateRegistration);
      app.post('/register', (req, res) => {
        res.json({ success: true });
      });

      const invalidData = {
        username: 'testuser',
        email: 'test@example.com',
        password: 'StrongPassword123!',
        confirmPassword: 'DifferentPassword123!'
      };

      const response = await request(app)
        .post('/register')
        .send(invalidData);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error.details.errors).toContainEqual({
        field: 'confirmPassword',
        message: 'Passwords do not match'
      });
    });
  });

  describe('validateLogin', () => {
    it('should pass with valid login data', async () => {
      app.use(validateLogin);
      app.post('/login', (req, res) => {
        res.json({ success: true, body: req.body });
      });

      const validData = {
        identifier: 'testuser',
        password: 'password'
      };

      const response = await request(app)
        .post('/login')
        .send(validData);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.body.identifier).toBe('testuser');
    });

    it('should sanitize identifier', async () => {
      app.use(validateLogin);
      app.post('/login', (req, res) => {
        res.json({ success: true, body: req.body });
      });

      const dataWithSpaces = {
        identifier: '  testuser  ',
        password: 'password'
      };

      const response = await request(app)
        .post('/login')
        .send(dataWithSpaces);

      expect(response.status).toBe(200);
      expect(response.body.body.identifier).toBe('testuser');
    });

    it('should reject missing identifier', async () => {
      app.use(validateLogin);
      app.post('/login', (req, res) => {
        res.json({ success: true });
      });

      const invalidData = {
        password: 'password'
      };

      const response = await request(app)
        .post('/login')
        .send(invalidData);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error.details.errors).toContainEqual({
        field: 'identifier',
        message: 'Username or email is required'
      });
    });

    it('should reject missing password', async () => {
      app.use(validateLogin);
      app.post('/login', (req, res) => {
        res.json({ success: true });
      });

      const invalidData = {
        identifier: 'testuser'
      };

      const response = await request(app)
        .post('/login')
        .send(invalidData);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error.details.errors).toContainEqual({
        field: 'password',
        message: 'Password is required'
      });
    });
  });

  describe('validateGitLabConfig', () => {
    it('should pass with valid GitLab config data', async () => {
      app.use(validateGitLabConfig);
      app.post('/config', (req, res) => {
        res.json({ success: true, body: req.body });
      });

      const validData = {
        name: 'My GitLab',
        gitlabUrl: 'https://gitlab.example.com',
        accessToken: 'glpat-xxxxxxxxxxxxxxxxxxxx',
        webhookSecret: 'secret123456',
        description: 'My GitLab instance'
      };

      const response = await request(app)
        .post('/config')
        .send(validData);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.body.name).toBe('My GitLab');
      expect(response.body.body.gitlabUrl).toBe('https://gitlab.example.com');
    });

    it('should sanitize input data', async () => {
      app.use(validateGitLabConfig);
      app.post('/config', (req, res) => {
        res.json({ success: true, body: req.body });
      });

      const dataWithSpaces = {
        name: '  My GitLab  ',
        gitlabUrl: '  https://gitlab.example.com  ',
        accessToken: '  glpat-xxxxxxxxxxxxxxxxxxxx  ',
        webhookSecret: '  secret123456  ',
        description: '  My GitLab instance  '
      };

      const response = await request(app)
        .post('/config')
        .send(dataWithSpaces);

      expect(response.status).toBe(200);
      expect(response.body.body.name).toBe('My GitLab');
      expect(response.body.body.gitlabUrl).toBe('https://gitlab.example.com');
      expect(response.body.body.accessToken).toBe('glpat-xxxxxxxxxxxxxxxxxxxx');
    });

    it('should reject missing name', async () => {
      app.use(validateGitLabConfig);
      app.post('/config', (req, res) => {
        res.json({ success: true });
      });

      const invalidData = {
        gitlabUrl: 'https://gitlab.example.com',
        accessToken: 'glpat-xxxxxxxxxxxxxxxxxxxx',
        webhookSecret: 'secret123456'
      };

      const response = await request(app)
        .post('/config')
        .send(invalidData);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error.details.errors).toContainEqual({
        field: 'name',
        message: 'Configuration name is required'
      });
    });

    it('should reject invalid GitLab URL', async () => {
      app.use(validateGitLabConfig);
      app.post('/config', (req, res) => {
        res.json({ success: true });
      });

      const invalidData = {
        name: 'My GitLab',
        gitlabUrl: 'invalid-url',
        accessToken: 'glpat-xxxxxxxxxxxxxxxxxxxx',
        webhookSecret: 'secret123456'
      };

      const response = await request(app)
        .post('/config')
        .send(invalidData);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error.details.errors).toContainEqual({
        field: 'gitlabUrl',
        message: 'Invalid URL format'
      });
    });

    it('should reject short access token', async () => {
      app.use(validateGitLabConfig);
      app.post('/config', (req, res) => {
        res.json({ success: true });
      });

      const invalidData = {
        name: 'My GitLab',
        gitlabUrl: 'https://gitlab.example.com',
        accessToken: 'short',
        webhookSecret: 'secret123456'
      };

      const response = await request(app)
        .post('/config')
        .send(invalidData);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error.details.errors).toContainEqual({
        field: 'accessToken',
        message: 'Access token is too short'
      });
    });

    it('should reject short webhook secret', async () => {
      app.use(validateGitLabConfig);
      app.post('/config', (req, res) => {
        res.json({ success: true });
      });

      const invalidData = {
        name: 'My GitLab',
        gitlabUrl: 'https://gitlab.example.com',
        accessToken: 'glpat-xxxxxxxxxxxxxxxxxxxx',
        webhookSecret: 'short'
      };

      const response = await request(app)
        .post('/config')
        .send(invalidData);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error.details.errors).toContainEqual({
        field: 'webhookSecret',
        message: 'Webhook secret must be at least 8 characters long'
      });
    });
  });

  describe('validatePasswordChange', () => {
    it('should pass with valid password change data', async () => {
      app.use(validatePasswordChange);
      app.post('/change-password', (req, res) => {
        res.json({ success: true });
      });

      const validData = {
        currentPassword: 'OldPassword123!',
        newPassword: 'NewPassword123!',
        confirmNewPassword: 'NewPassword123!'
      };

      const response = await request(app)
        .post('/change-password')
        .send(validData);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should reject missing current password', async () => {
      app.use(validatePasswordChange);
      app.post('/change-password', (req, res) => {
        res.json({ success: true });
      });

      const invalidData = {
        newPassword: 'NewPassword123!',
        confirmNewPassword: 'NewPassword123!'
      };

      const response = await request(app)
        .post('/change-password')
        .send(invalidData);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error.details.errors).toContainEqual({
        field: 'currentPassword',
        message: 'Current password is required'
      });
    });

    it('should reject weak new password', async () => {
      app.use(validatePasswordChange);
      app.post('/change-password', (req, res) => {
        res.json({ success: true });
      });

      const invalidData = {
        currentPassword: 'OldPassword123!',
        newPassword: 'weak',
        confirmNewPassword: 'weak'
      };

      const response = await request(app)
        .post('/change-password')
        .send(invalidData);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error.details.errors.some((e: any) => e.field === 'newPassword')).toBe(true);
    });

    it('should reject mismatched new passwords', async () => {
      app.use(validatePasswordChange);
      app.post('/change-password', (req, res) => {
        res.json({ success: true });
      });

      const invalidData = {
        currentPassword: 'OldPassword123!',
        newPassword: 'NewPassword123!',
        confirmNewPassword: 'DifferentPassword123!'
      };

      const response = await request(app)
        .post('/change-password')
        .send(invalidData);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error.details.errors).toContainEqual({
        field: 'confirmNewPassword',
        message: 'New passwords do not match'
      });
    });

    it('should reject same current and new password', async () => {
      app.use(validatePasswordChange);
      app.post('/change-password', (req, res) => {
        res.json({ success: true });
      });

      const invalidData = {
        currentPassword: 'SamePassword123!',
        newPassword: 'SamePassword123!',
        confirmNewPassword: 'SamePassword123!'
      };

      const response = await request(app)
        .post('/change-password')
        .send(invalidData);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error.details.errors).toContainEqual({
        field: 'newPassword',
        message: 'New password must be different from current password'
      });
    });
  });
});