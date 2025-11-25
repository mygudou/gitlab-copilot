import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, Db } from 'mongodb';
import { performance } from 'perf_hooks';
import authRouter from '../../routes/auth';
import gitlabConfigRouter from '../../routes/gitlab-config';
import { errorHandler } from '../../middleware/errorHandler';

/**
 * Performance Tests for Authentication System
 *
 * These tests verify that the authentication system meets performance
 * requirements under various load conditions and scenarios.
 */
describe('Authentication Performance Tests', () => {
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
    db = mongoClient.db('test-gitlab-copilot-perf');

    // Set environment variables for performance testing
    process.env.MONGODB_URI = mongoUri;
    process.env.JWT_SECRET = 'performance-test-secret';
    process.env.JWT_ACCESS_EXPIRES_IN = '15m';
    process.env.JWT_REFRESH_EXPIRES_IN = '7d';
    process.env.BCRYPT_ROUNDS = '4'; // Lower for performance testing
    process.env.MAX_LOGIN_ATTEMPTS = '5';
    process.env.LOCKOUT_DURATION = '15';

    // Setup Express app
    app = express();
    app.use(express.json());
    app.use(cookieParser());

    // Request ID middleware
    app.use((req, res, next) => {
      req.requestId = `perf-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      next();
    });

    app.use('/auth', authRouter);
    app.use('/api/gitlab-configs', gitlabConfigRouter);
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

  describe('Registration Performance', () => {
    it('should register users within acceptable time limits', async () => {
      const users = Array.from({ length: 50 }, (_, i) => ({
        username: `perfuser${i}`,
        email: `perf${i}@example.com`,
        password: 'PerfTestPassword123!',
        confirmPassword: 'PerfTestPassword123!'
      }));

      const startTime = performance.now();
      const maxAllowedTime = 10000; // 10 seconds for 50 registrations

      const registrationPromises = users.map(user =>
        request(app)
          .post('/auth/register')
          .send(user)
      );

      const results = await Promise.all(registrationPromises);
      const endTime = performance.now();
      const totalTime = endTime - startTime;

      // Performance assertions
      expect(totalTime).toBeLessThan(maxAllowedTime);
      expect(totalTime / users.length).toBeLessThan(200); // Average less than 200ms per registration

      // Verify all succeeded
      results.forEach(result => {
        expect(result.status).toBe(201);
        expect(result.body.success).toBe(true);
      });

      console.log(`Registration Performance: ${users.length} users in ${totalTime.toFixed(2)}ms (avg: ${(totalTime / users.length).toFixed(2)}ms per user)`);
    });

    it('should handle password hashing efficiently', async () => {
      const user = {
        username: 'hashuser',
        email: 'hash@example.com',
        password: 'ComplexPasswordForHashing123!@#',
        confirmPassword: 'ComplexPasswordForHashing123!@#'
      };

      const iterations = 10;
      const times: number[] = [];

      for (let i = 0; i < iterations; i++) {
        const startTime = performance.now();

        await request(app)
          .post('/auth/register')
          .send({
            ...user,
            username: `${user.username}${i}`,
            email: `hash${i}@example.com`
          });

        const endTime = performance.now();
        times.push(endTime - startTime);
      }

      const avgTime = times.reduce((sum, time) => sum + time, 0) / times.length;
      const maxTime = Math.max(...times);
      const minTime = Math.min(...times);

      // Password hashing should be consistent and reasonable
      expect(avgTime).toBeLessThan(500); // Average less than 500ms
      expect(maxTime).toBeLessThan(1000); // Max less than 1 second
      expect(maxTime - minTime).toBeLessThan(300); // Variation less than 300ms

      console.log(`Password Hashing Performance: avg=${avgTime.toFixed(2)}ms, min=${minTime.toFixed(2)}ms, max=${maxTime.toFixed(2)}ms`);
    });
  });

  describe('Login Performance', () => {
    let registeredUsers: Array<{username: string, email: string, password: string}> = [];

    beforeEach(async () => {
      // Pre-register users for login testing
      registeredUsers = Array.from({ length: 20 }, (_, i) => ({
        username: `loginuser${i}`,
        email: `login${i}@example.com`,
        password: 'LoginTestPassword123!'
      }));

      const registrationPromises = registeredUsers.map(user =>
        request(app)
          .post('/auth/register')
          .send({
            ...user,
            confirmPassword: user.password
          })
      );

      await Promise.all(registrationPromises);
    });

    it('should authenticate users quickly', async () => {
      const startTime = performance.now();
      const maxAllowedTime = 5000; // 5 seconds for 20 logins

      const loginPromises = registeredUsers.map(user =>
        request(app)
          .post('/auth/login')
          .send({
            identifier: user.username,
            password: user.password
          })
      );

      const results = await Promise.all(loginPromises);
      const endTime = performance.now();
      const totalTime = endTime - startTime;

      // Performance assertions
      expect(totalTime).toBeLessThan(maxAllowedTime);
      expect(totalTime / registeredUsers.length).toBeLessThan(250); // Average less than 250ms per login

      // Verify all succeeded
      results.forEach(result => {
        expect(result.status).toBe(200);
        expect(result.body.success).toBe(true);
      });

      console.log(`Login Performance: ${registeredUsers.length} logins in ${totalTime.toFixed(2)}ms (avg: ${(totalTime / registeredUsers.length).toFixed(2)}ms per login)`);
    });

    it('should handle password verification efficiently', async () => {
      const user = registeredUsers[0];
      const iterations = 20;
      const times: number[] = [];

      for (let i = 0; i < iterations; i++) {
        const startTime = performance.now();

        await request(app)
          .post('/auth/login')
          .send({
            identifier: user.username,
            password: user.password
          });

        const endTime = performance.now();
        times.push(endTime - startTime);
      }

      const avgTime = times.reduce((sum, time) => sum + time, 0) / times.length;
      const maxTime = Math.max(...times);
      const minTime = Math.min(...times);

      // Password verification should be consistent
      expect(avgTime).toBeLessThan(300); // Average less than 300ms
      expect(maxTime).toBeLessThan(500); // Max less than 500ms

      console.log(`Password Verification Performance: avg=${avgTime.toFixed(2)}ms, min=${minTime.toFixed(2)}ms, max=${maxTime.toFixed(2)}ms`);
    });

    it('should handle failed login attempts efficiently', async () => {
      const user = registeredUsers[0];
      const iterations = 15;
      const times: number[] = [];

      for (let i = 0; i < iterations; i++) {
        const startTime = performance.now();

        await request(app)
          .post('/auth/login')
          .send({
            identifier: user.username,
            password: 'wrongpassword'
          });

        const endTime = performance.now();
        times.push(endTime - startTime);
      }

      const avgTime = times.reduce((sum, time) => sum + time, 0) / times.length;

      // Failed logins should not be significantly slower (timing attack resistance)
      expect(avgTime).toBeLessThan(400); // Should be similar to successful logins

      console.log(`Failed Login Performance: avg=${avgTime.toFixed(2)}ms`);
    });
  });

  describe('Token Operations Performance', () => {
    let userCookies: string;

    beforeEach(async () => {
      const user = {
        username: 'tokenuser',
        email: 'token@example.com',
        password: 'TokenTestPassword123!',
        confirmPassword: 'TokenTestPassword123!'
      };

      await request(app)
        .post('/auth/register')
        .send(user);

      const loginResponse = await request(app)
        .post('/auth/login')
        .send({
          identifier: user.username,
          password: user.password
        });

      userCookies = loginResponse.headers['set-cookie'].join('; ');
    });

    it('should validate tokens quickly', async () => {
      const iterations = 100;
      const times: number[] = [];

      for (let i = 0; i < iterations; i++) {
        const startTime = performance.now();

        await request(app)
          .get('/auth/me')
          .set('Cookie', userCookies);

        const endTime = performance.now();
        times.push(endTime - startTime);
      }

      const avgTime = times.reduce((sum, time) => sum + time, 0) / times.length;
      const maxTime = Math.max(...times);

      // Token validation should be very fast
      expect(avgTime).toBeLessThan(50); // Average less than 50ms
      expect(maxTime).toBeLessThan(200); // Max less than 200ms

      console.log(`Token Validation Performance: ${iterations} validations, avg=${avgTime.toFixed(2)}ms, max=${maxTime.toFixed(2)}ms`);
    });

    it('should refresh tokens efficiently', async () => {
      const refreshTokenMatch = userCookies.match(/refreshToken=([^;]+)/);
      const refreshToken = refreshTokenMatch?.[1];

      const iterations = 20;
      const times: number[] = [];

      for (let i = 0; i < iterations; i++) {
        const startTime = performance.now();

        await request(app)
          .post('/auth/refresh')
          .set('Cookie', `refreshToken=${refreshToken}`)
          .send();

        const endTime = performance.now();
        times.push(endTime - startTime);
      }

      const avgTime = times.reduce((sum, time) => sum + time, 0) / times.length;
      const maxTime = Math.max(...times);

      // Token refresh should be reasonably fast
      expect(avgTime).toBeLessThan(150); // Average less than 150ms
      expect(maxTime).toBeLessThan(300); // Max less than 300ms

      console.log(`Token Refresh Performance: ${iterations} refreshes, avg=${avgTime.toFixed(2)}ms, max=${maxTime.toFixed(2)}ms`);
    });
  });

  describe('Database Operations Performance', () => {
    it('should handle user lookups efficiently', async () => {
      // Create many users
      const userCount = 100;
      const users = Array.from({ length: userCount }, (_, i) => ({
        username: `dbuser${i}`,
        email: `db${i}@example.com`,
        password: 'DBTestPassword123!',
        confirmPassword: 'DBTestPassword123!'
      }));

      // Register all users
      const registrationPromises = users.map(user =>
        request(app)
          .post('/auth/register')
          .send(user)
      );

      await Promise.all(registrationPromises);

      // Test lookup performance
      const lookupTimes: number[] = [];
      const iterations = 50;

      for (let i = 0; i < iterations; i++) {
        const randomUserIndex = Math.floor(Math.random() * userCount);
        const user = users[randomUserIndex];

        const startTime = performance.now();

        await request(app)
          .post('/auth/login')
          .send({
            identifier: user.email,
            password: user.password
          });

        const endTime = performance.now();
        lookupTimes.push(endTime - startTime);
      }

      const avgLookupTime = lookupTimes.reduce((sum, time) => sum + time, 0) / lookupTimes.length;
      const maxLookupTime = Math.max(...lookupTimes);

      // Database lookups should remain fast even with many users
      expect(avgLookupTime).toBeLessThan(300); // Average less than 300ms
      expect(maxLookupTime).toBeLessThan(500); // Max less than 500ms

      console.log(`Database Lookup Performance: ${userCount} users, ${iterations} lookups, avg=${avgLookupTime.toFixed(2)}ms, max=${maxLookupTime.toFixed(2)}ms`);
    });

    it('should handle session management efficiently', async () => {
      const user = {
        username: 'sessionperfuser',
        email: 'sessionperf@example.com',
        password: 'SessionPerfPassword123!',
        confirmPassword: 'SessionPerfPassword123!'
      };

      await request(app)
        .post('/auth/register')
        .send(user);

      // Create multiple sessions
      const sessionCount = 50;
      const sessionTimes: number[] = [];

      for (let i = 0; i < sessionCount; i++) {
        const startTime = performance.now();

        await request(app)
          .post('/auth/login')
          .set('User-Agent', `PerformanceTest-${i}`)
          .send({
            identifier: user.username,
            password: user.password
          });

        const endTime = performance.now();
        sessionTimes.push(endTime - startTime);
      }

      const avgSessionTime = sessionTimes.reduce((sum, time) => sum + time, 0) / sessionTimes.length;
      const maxSessionTime = Math.max(...sessionTimes);

      // Session creation should remain efficient
      expect(avgSessionTime).toBeLessThan(400); // Average less than 400ms
      expect(maxSessionTime).toBeLessThan(800); // Max less than 800ms

      // Verify all sessions were created
      const sessionsInDb = await db.collection('web_sessions').find({}).toArray();
      expect(sessionsInDb.length).toBe(sessionCount);

      console.log(`Session Management Performance: ${sessionCount} sessions, avg=${avgSessionTime.toFixed(2)}ms, max=${maxSessionTime.toFixed(2)}ms`);
    });
  });

  describe('Memory Usage and Resource Management', () => {
    it('should manage memory efficiently during high load', async () => {
      const initialMemory = process.memoryUsage();

      // Simulate high load
      const concurrentUsers = 100;
      const users = Array.from({ length: concurrentUsers }, (_, i) => ({
        username: `memuser${i}`,
        email: `mem${i}@example.com`,
        password: 'MemoryTestPassword123!',
        confirmPassword: 'MemoryTestPassword123!'
      }));

      // Register users
      const registrationPromises = users.map(user =>
        request(app)
          .post('/auth/register')
          .send(user)
      );

      await Promise.all(registrationPromises);

      // Login users
      const loginPromises = users.map(user =>
        request(app)
          .post('/auth/login')
          .send({
            identifier: user.username,
            password: user.password
          })
      );

      await Promise.all(loginPromises);

      // Check memory usage
      const finalMemory = process.memoryUsage();
      const memoryIncrease = finalMemory.heapUsed - initialMemory.heapUsed;
      const memoryPerUser = memoryIncrease / concurrentUsers;

      // Memory usage should be reasonable
      expect(memoryPerUser).toBeLessThan(1024 * 1024); // Less than 1MB per user
      expect(memoryIncrease).toBeLessThan(100 * 1024 * 1024); // Less than 100MB total increase

      console.log(`Memory Usage: ${concurrentUsers} users, total increase=${(memoryIncrease / 1024 / 1024).toFixed(2)}MB, per user=${(memoryPerUser / 1024).toFixed(2)}KB`);

      // Force garbage collection if available
      if (global.gc) {
        global.gc();
      }
    });

    it('should handle cleanup efficiently on logout', async () => {
      const users = Array.from({ length: 30 }, (_, i) => ({
        username: `cleanupuser${i}`,
        email: `cleanup${i}@example.com`,
        password: 'CleanupTestPassword123!',
        confirmPassword: 'CleanupTestPassword123!'
      }));

      // Register and login users
      const registrationPromises = users.map(user =>
        request(app)
          .post('/auth/register')
          .send(user)
      );

      await Promise.all(registrationPromises);

      const loginPromises = users.map(user =>
        request(app)
          .post('/auth/login')
          .send({
            identifier: user.username,
            password: user.password
          })
      );

      const loginResults = await Promise.all(loginPromises);

      // Extract cookies for logout
      const userCookies = loginResults.map(result =>
        result.headers['set-cookie'].join('; ')
      );

      // Logout all users and measure time
      const startTime = performance.now();

      const logoutPromises = userCookies.map(cookies =>
        request(app)
          .post('/auth/logout')
          .set('Cookie', cookies)
      );

      await Promise.all(logoutPromises);

      const endTime = performance.now();
      const totalLogoutTime = endTime - startTime;
      const avgLogoutTime = totalLogoutTime / users.length;

      // Cleanup should be efficient
      expect(avgLogoutTime).toBeLessThan(100); // Average less than 100ms per logout
      expect(totalLogoutTime).toBeLessThan(3000); // Total less than 3 seconds

      // Verify sessions were cleaned up
      const remainingSessions = await db.collection('web_sessions').find({ isActive: true }).toArray();
      expect(remainingSessions.length).toBe(0);

      console.log(`Cleanup Performance: ${users.length} logouts in ${totalLogoutTime.toFixed(2)}ms (avg: ${avgLogoutTime.toFixed(2)}ms per logout)`);
    });
  });

  describe('Concurrent Operations Performance', () => {
    it('should handle concurrent registrations without performance degradation', async () => {
      const batchSize = 25;
      const batchCount = 4;
      const batchTimes: number[] = [];

      for (let batch = 0; batch < batchCount; batch++) {
        const users = Array.from({ length: batchSize }, (_, i) => ({
          username: `concuser${batch}_${i}`,
          email: `conc${batch}_${i}@example.com`,
          password: 'ConcurrentTestPassword123!',
          confirmPassword: 'ConcurrentTestPassword123!'
        }));

        const startTime = performance.now();

        const registrationPromises = users.map(user =>
          request(app)
            .post('/auth/register')
            .send(user)
        );

        const results = await Promise.all(registrationPromises);

        const endTime = performance.now();
        const batchTime = endTime - startTime;
        batchTimes.push(batchTime);

        // Verify all succeeded
        results.forEach(result => {
          expect(result.status).toBe(201);
        });
      }

      // Performance should not degrade significantly across batches
      const firstBatchTime = batchTimes[0];
      const lastBatchTime = batchTimes[batchTimes.length - 1];
      const degradation = (lastBatchTime - firstBatchTime) / firstBatchTime;

      expect(degradation).toBeLessThan(0.5); // Less than 50% degradation

      console.log(`Concurrent Registration Performance: batch times=${batchTimes.map(t => t.toFixed(2)).join(', ')}ms, degradation=${(degradation * 100).toFixed(1)}%`);
    });
  });
});