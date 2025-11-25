// Jest setup file
import { config } from 'dotenv';

// Load environment variables for tests
config({ path: '.env.test' });

// Set required environment variables for config validation
process.env.GITLAB_TOKEN = process.env.GITLAB_TOKEN || 'test-token';
process.env.WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'test-secret';

// Set test timeout
jest.setTimeout(30000);

// Mock console to reduce noise in tests
global.console = {
  ...console,
  log: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};