import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import {
  RegisterRequest,
  LoginRequest,
  RegisterResponse,
  LoginResponse,
  TokenResponse,
  ValidationResult,
  AuthUser,
  AuthenticationError,
  ValidationError,
  WebSessionData
} from '../types/auth';
import {
  findUserByEmail,
  findUserByUsername,
  findUserByEmailOrUsername,
  upsertUser,
  generateUserToken,
  UserDocument
} from './storage/userRepository';
import {
  createSession,
  validateSession,
  refreshSession,
  destroySession,
  destroyAllUserSessions
} from './storage/webSessionRepository';
import { config } from '../utils/config';
import logger from '../utils/logger';

// Configuration constants
const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '12');
const rawJwtSecret = (process.env.JWT_SECRET || config.encryption.key || '').trim();

if (!rawJwtSecret) {
  throw new Error('JWT secret is not configured. Set JWT_SECRET or ENCRYPTION_KEY to enable authentication.');
}

const JWT_SECRET = rawJwtSecret;
const JWT_ACCESS_EXPIRES_IN = process.env.JWT_ACCESS_EXPIRES_IN || '15m';
const JWT_REFRESH_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN || '7d';
const MAX_LOGIN_ATTEMPTS = parseInt(process.env.MAX_LOGIN_ATTEMPTS || '5');
const LOCKOUT_DURATION = parseInt(process.env.LOCKOUT_DURATION || '15') * 60 * 1000; // 15 minutes in ms

interface JWTPayload {
  userId: string;
  userToken: string;
  username: string;
  email: string;
  sessionId: string;
  type: 'access' | 'refresh';
}

function parseTimeToSeconds(timeStr: string): number {
  const match = timeStr.match(/^(\d+)([smhd])$/);
  if (!match) {
    throw new Error(`Invalid time format: ${timeStr}`);
  }

  const [, value, unit] = match;
  const num = parseInt(value);

  switch (unit) {
    case 's': return num;
    case 'm': return num * 60;
    case 'h': return num * 3600;
    case 'd': return num * 86400;
    default: throw new Error(`Unknown time unit: ${unit}`);
  }
}

function generateTokens(user: AuthUser, sessionId: string): TokenResponse {
  const accessTokenPayload: JWTPayload = {
    userId: user.id,
    userToken: (user as any).userToken, // We'll add this to AuthUser interface
    username: user.username,
    email: user.email,
    sessionId,
    type: 'access'
  };

  const refreshTokenPayload: JWTPayload = {
    ...accessTokenPayload,
    type: 'refresh'
  };

  const secret = JWT_SECRET;

  // @ts-expect-error - JWT types issue, but functionally correct
  const accessToken = jwt.sign(accessTokenPayload, secret, {
    expiresIn: JWT_ACCESS_EXPIRES_IN,
    issuer: 'gitlab-copilot',
    audience: 'gitlab-copilot-web'
  }) as string;

  // @ts-expect-error - JWT types issue, but functionally correct
  const refreshToken = jwt.sign(refreshTokenPayload, secret, {
    expiresIn: JWT_REFRESH_EXPIRES_IN,
    issuer: 'gitlab-copilot',
    audience: 'gitlab-copilot-web'
  }) as string;

  const accessExpiresIn = parseTimeToSeconds(JWT_ACCESS_EXPIRES_IN);
  const refreshExpiresIn = parseTimeToSeconds(JWT_REFRESH_EXPIRES_IN);

  return {
    accessToken,
    refreshToken,
    expiresIn: accessExpiresIn,
    refreshExpiresIn
  };
}

function mapUserDocumentToAuthUser(doc: UserDocument): AuthUser {
  return {
    id: doc._id?.toString() || doc.userToken,
    username: doc.username || '',
    email: doc.email || '',
    displayName: doc.displayName,
    isEmailVerified: doc.isEmailVerified || false,
    createdAt: doc.createdAt || new Date()
  };
}

export function validatePassword(password: string): ValidationResult {
  const errors: string[] = [];

  if (password.length < 8) {
    errors.push('Password must be at least 8 characters long');
  }

  if (!/[a-z]/.test(password)) {
    errors.push('Password must contain at least one lowercase letter');
  }

  if (!/[A-Z]/.test(password)) {
    errors.push('Password must contain at least one uppercase letter');
  }

  if (!/[0-9]/.test(password)) {
    errors.push('Password must contain at least one number');
  }

  if (!/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/.test(password)) {
    errors.push('Password must contain at least one special character');
  }

  return {
    isValid: errors.length === 0,
    errors
  };
}

export async function validateEmail(email: string): Promise<ValidationResult> {
  const errors: string[] = [];

  // Basic email format validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    errors.push('Invalid email format');
  }

  // Check if email is already taken
  const existingUser = await findUserByEmail(email);
  if (existingUser) {
    errors.push('Email is already registered');
  }

  return {
    isValid: errors.length === 0,
    errors
  };
}

export async function validateUsername(username: string): Promise<ValidationResult> {
  const errors: string[] = [];

  if (username.length < 3) {
    errors.push('Username must be at least 3 characters long');
  }

  if (username.length > 30) {
    errors.push('Username must be no more than 30 characters long');
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
    errors.push('Username can only contain letters, numbers, underscores, and hyphens');
  }

  // Check if username is already taken
  const existingUser = await findUserByUsername(username);
  if (existingUser) {
    errors.push('Username is already taken');
  }

  return {
    isValid: errors.length === 0,
    errors
  };
}

export async function register(userData: RegisterRequest): Promise<RegisterResponse> {
  try {
    // Validate input
    if (userData.password !== userData.confirmPassword) {
      throw new ValidationError('Passwords do not match', 'confirmPassword');
    }

    const passwordValidation = validatePassword(userData.password);
    if (!passwordValidation.isValid) {
      throw new ValidationError(passwordValidation.errors.join(', '), 'password');
    }

    const emailValidation = await validateEmail(userData.email);
    if (!emailValidation.isValid) {
      throw new ValidationError(emailValidation.errors.join(', '), 'email');
    }

    const usernameValidation = await validateUsername(userData.username);
    if (!usernameValidation.isValid) {
      throw new ValidationError(usernameValidation.errors.join(', '), 'username');
    }

    // Hash password
    const passwordHash = await bcrypt.hash(userData.password, BCRYPT_ROUNDS);

    // Create user (using existing upsert function but with new fields)
    const userToken = generateUserToken();
    const result = await upsertUser({
      userToken,
      username: userData.username,
      email: userData.email,
      passwordHash,
      displayName: userData.username, // Use username as initial display name
      isEmailVerified: false,
      pat: '', // Empty PAT for web users
      webhookSecret: crypto.randomBytes(32).toString('hex') // Generate random webhook secret
    });

    logger.info('User registered successfully', {
      userToken: result.userToken,
      username: userData.username,
      email: userData.email
    });

    return {
      success: true,
      userToken: result.userToken,
      message: 'Registration successful. Please verify your email address.'
    };
  } catch (error) {
    logger.error('Registration failed', {
      username: userData.username,
      email: userData.email,
      error: error instanceof Error ? error.message : String(error)
    });

    if (error instanceof ValidationError || error instanceof AuthenticationError) {
      throw error;
    }

    throw new AuthenticationError('Registration failed due to server error', 'REGISTRATION_ERROR');
  }
}

async function checkAccountLockout(user: UserDocument): Promise<void> {
  if (user.lockUntil && user.lockUntil > new Date()) {
    const remainingTime = Math.ceil((user.lockUntil.getTime() - Date.now()) / 1000 / 60);
    throw new AuthenticationError(
      `Account is locked. Please try again in ${remainingTime} minutes.`,
      'ACCOUNT_LOCKED'
    );
  }
}

async function handleLoginAttempt(user: UserDocument, success: boolean): Promise<void> {
  const loginAttempts = (user.loginAttempts || 0) + (success ? 0 : 1);
  const updates: any = {
    loginAttempts: success ? 0 : loginAttempts,
    lastLogin: success ? new Date() : user.lastLogin
  };

  // Lock account if too many failed attempts
  if (!success && loginAttempts >= MAX_LOGIN_ATTEMPTS) {
    updates.lockUntil = new Date(Date.now() + LOCKOUT_DURATION);
    logger.warn('Account locked due to too many failed login attempts', {
      userToken: user.userToken,
      username: user.username,
      email: user.email,
      attempts: loginAttempts
    });
  }

  // Update user document
  await upsertUser({
    userToken: user.userToken,
    username: user.username,
    email: user.email,
    passwordHash: user.passwordHash,
    displayName: user.displayName,
    gitlabHost: user.gitlabHost,
    isEmailVerified: user.isEmailVerified,
    pat: '', // Keep empty for web users
    webhookSecret: '' // Keep existing
  });
}

export async function login(credentials: LoginRequest, sessionData: WebSessionData): Promise<LoginResponse> {
  try {
    // Find user by email or username
    const user = await findUserByEmailOrUsername(credentials.identifier);
    if (!user || !user.passwordHash) {
      throw new AuthenticationError('Invalid credentials', 'INVALID_CREDENTIALS');
    }

    // Check account lockout
    await checkAccountLockout(user);

    // Verify password
    const isValidPassword = await bcrypt.compare(credentials.password, user.passwordHash);

    // Handle login attempt (success or failure)
    await handleLoginAttempt(user, isValidPassword);

    if (!isValidPassword) {
      throw new AuthenticationError('Invalid credentials', 'INVALID_CREDENTIALS');
    }

    // Generate session and tokens
    const authUser = mapUserDocumentToAuthUser(user);
    (authUser as any).userToken = user.userToken; // Add userToken for JWT payload

    const sessionId = crypto.randomUUID();
    const tokens = generateTokens(authUser, sessionId);

    // Create web session - use refresh token expiry for session lifetime
    await createSession(
      authUser.id,
      tokens.accessToken,
      tokens.refreshToken,
      sessionData,
      tokens.refreshExpiresIn, // Use refresh token expiry instead of access token expiry
      sessionId
    );

    logger.info('User logged in successfully', {
      userToken: user.userToken,
      username: user.username,
      email: user.email,
      sessionId
    });

    return {
      success: true,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn,
      user: {
        id: authUser.id,
        username: authUser.username,
        email: authUser.email,
        displayName: authUser.displayName
      }
    };
  } catch (error) {
    logger.error('Login failed', {
      identifier: credentials.identifier,
      error: error instanceof Error ? error.message : String(error)
    });

    if (error instanceof AuthenticationError) {
      throw error;
    }

    throw new AuthenticationError('Login failed due to server error', 'LOGIN_ERROR');
  }
}

export async function logout(sessionId: string): Promise<void> {
  try {
    await destroySession(sessionId);
    logger.info('User logged out successfully', { sessionId });
  } catch (error) {
    logger.error('Logout failed', {
      sessionId,
      error: error instanceof Error ? error.message : String(error)
    });
    throw new AuthenticationError('Logout failed', 'LOGOUT_ERROR');
  }
}

export async function refreshTokens(refreshToken: string): Promise<TokenResponse> {
  try {
    // Verify refresh token
    const payload = jwt.verify(refreshToken, JWT_SECRET, {
      issuer: 'gitlab-copilot',
      audience: 'gitlab-copilot-web'
    }) as JWTPayload;

    if (payload.type !== 'refresh') {
      throw new AuthenticationError('Invalid token type', 'INVALID_TOKEN');
    }

    // Get user to ensure they still exist and are valid
    const user = await findUserByEmailOrUsername(payload.username);
    if (!user) {
      throw new AuthenticationError('User not found', 'USER_NOT_FOUND');
    }

    // Generate new tokens
    const authUser = mapUserDocumentToAuthUser(user);
    (authUser as any).userToken = user.userToken;

    const newTokens = generateTokens(authUser, payload.sessionId);

    // Update session with new tokens - use refresh token expiry for session lifetime
    const session = await refreshSession(
      payload.sessionId,
      refreshToken,
      newTokens.accessToken,
      newTokens.refreshToken,
      newTokens.refreshExpiresIn // Use refresh token expiry instead of access token expiry
    );

    if (!session) {
      throw new AuthenticationError('Session not found or expired', 'SESSION_EXPIRED');
    }

    logger.info('Tokens refreshed successfully', {
      userToken: user.userToken,
      sessionId: payload.sessionId
    });

    return newTokens;
  } catch (error) {
    logger.error('Token refresh failed', {
      error: error instanceof Error ? error.message : String(error)
    });

    if (error instanceof jwt.JsonWebTokenError) {
      throw new AuthenticationError('Invalid or expired token', 'INVALID_TOKEN');
    }

    if (error instanceof AuthenticationError) {
      throw error;
    }

    throw new AuthenticationError('Token refresh failed', 'REFRESH_ERROR');
  }
}

export async function verifyAccessToken(token: string): Promise<JWTPayload> {
  try {
    const payload = jwt.verify(token, JWT_SECRET, {
      issuer: 'gitlab-copilot',
      audience: 'gitlab-copilot-web'
    }) as JWTPayload;

    if (payload.type !== 'access') {
      throw new AuthenticationError('Invalid token type', 'INVALID_TOKEN');
    }

    // Validate session is still active
    const session = await validateSession(payload.sessionId, token);
    if (!session) {
      throw new AuthenticationError('Session expired or invalid', 'SESSION_EXPIRED');
    }

    return payload;
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) {
      throw new AuthenticationError('Invalid or expired token', 'INVALID_TOKEN');
    }
    throw error;
  }
}

export async function logoutAllSessions(userId: string): Promise<void> {
  try {
    await destroyAllUserSessions(userId);
    logger.info('All user sessions logged out', { userId });
  } catch (error) {
    logger.error('Failed to logout all sessions', {
      userId,
      error: error instanceof Error ? error.message : String(error)
    });
    throw new AuthenticationError('Failed to logout all sessions', 'LOGOUT_ALL_ERROR');
  }
}
