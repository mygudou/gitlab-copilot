import type { ObjectId } from 'mongodb';

// Authentication interfaces
export interface RegisterRequest {
  username: string;
  email: string;
  password: string;
  confirmPassword: string;
}

export interface LoginRequest {
  identifier: string; // username or email
  password: string;
}

export interface RegisterResponse {
  success: boolean;
  userToken: string;
  message: string;
}

export interface LoginResponse {
  success: boolean;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: {
    id: string;
    username: string;
    email: string;
    displayName?: string;
  };
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number; // Access token expiration in seconds
  refreshExpiresIn: number; // Refresh token expiration in seconds
}

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
}

// GitLab Configuration interfaces
export interface GitLabConfigInput {
  name: string;
  gitlabUrl: string;
  accessToken: string;
  webhookSecret: string;
  description?: string;
}

export interface GitLabConfig {
  id: string;
  userId: string;
  userToken: string; // for backward compatibility
  configToken: string; // 配置专属的token，用于webhook URL路由
  name: string;
  gitlabUrl: string;
  encryptedAccessToken: string;
  encryptedWebhookSecret: string;
  description?: string;
  isDefault: boolean;
  isActive: boolean;
  lastTested?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface GitLabConfigDocument {
  _id?: ObjectId;
  userId: string;
  userToken: string; // for backward compatibility
  configToken: string; // 配置专属的token，用于webhook URL路由
  name: string;
  gitlabUrl: string;
  encryptedAccessToken: string;
  encryptedWebhookSecret: string;
  description?: string;
  isDefault: boolean;
  isActive: boolean;
  lastTested?: Date;
  testResult?: {
    success: boolean;
    message: string;
    testedAt: Date;
  };
  createdAt: Date;
  updatedAt: Date;
}

export interface ConnectionTestResult {
  success: boolean;
  message: string;
  details?: any;
}

// Web Session interfaces
export interface WebSessionData {
  userAgent: string;
  ipAddress: string;
}

export interface WebSession {
  sessionId: string;
  userId: string;
  accessToken: string;
  refreshToken: string;
  userAgent: string;
  ipAddress: string;
  expiresAt: Date;
  lastActivity: Date;
  createdAt: Date;
}

export interface WebSessionDocument {
  _id?: ObjectId;
  sessionId: string;
  userId: string;
  accessTokenHash: string; // store hash, not raw token
  refreshTokenHash: string;
  userAgent: string;
  ipAddress: string;
  expiresAt: Date;
  lastActivity: Date;
  isActive: boolean;
  createdAt: Date;
}

// User interfaces for authentication context
export interface AuthUser {
  id: string;
  username: string;
  email: string;
  displayName?: string;
  isEmailVerified: boolean;
  createdAt: Date;
}

export interface CreateUserData {
  username: string;
  email: string;
  passwordHash: string;
  displayName?: string;
  isEmailVerified?: boolean;
}

// Error types
export class AuthenticationError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

export class ValidationError extends Error {
  constructor(message: string, public field: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class ConfigurationError extends Error {
  constructor(message: string, public details?: any) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

// API Error response format
export interface ErrorResponse {
  success: false;
  error: {
    type: string;
    message: string;
    code?: string;
    field?: string;
    details?: any;
  };
  timestamp: string;
  requestId: string;
}