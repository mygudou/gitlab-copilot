import { Request, Response, NextFunction } from 'express';
import { sendErrorResponse } from './auth';
import logger from '../utils/logger';

/**
 * Input validation schemas and functions
 */

// Email validation regex
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Username validation regex (alphanumeric, underscore, hyphen)
const USERNAME_REGEX = /^[a-zA-Z0-9_-]+$/;

// Password strength validation
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_REQUIREMENTS = {
  lowercase: /[a-z]/,
  uppercase: /[A-Z]/,
  number: /[0-9]/,
  special: /[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/
};

// GitLab URL validation
const GITLAB_URL_REGEX = /^https?:\/\/[^\s/$.?#].[^\s]*$/;


/**
 * Local validation error type
 */
interface LocalValidationError {
  field: string;
  message: string;
}

/**
 * Sanitize string input
 */
function sanitizeString(input: string | undefined): string {
  if (!input || typeof input !== 'string') {
    return '';
  }
  return input.trim();
}

/**
 * Validate email format
 */
function validateEmail(email: string): { isValid: boolean; message?: string } {
  if (!email) {
    return { isValid: false, message: 'Email is required' };
  }

  if (!EMAIL_REGEX.test(email)) {
    return { isValid: false, message: 'Invalid email format' };
  }

  if (email.length > 320) {
    return { isValid: false, message: 'Email is too long' };
  }

  return { isValid: true };
}

/**
 * Validate username
 */
function validateUsername(username: string): { isValid: boolean; message?: string } {
  if (!username) {
    return { isValid: false, message: 'Username is required' };
  }

  if (username.length < 3) {
    return { isValid: false, message: 'Username must be at least 3 characters long' };
  }

  if (username.length > 30) {
    return { isValid: false, message: 'Username must be no more than 30 characters long' };
  }

  if (!USERNAME_REGEX.test(username)) {
    return { isValid: false, message: 'Username can only contain letters, numbers, underscores, and hyphens' };
  }

  return { isValid: true };
}

/**
 * Validate password strength
 */
function validatePassword(password: string): { isValid: boolean; message?: string } {
  if (!password) {
    return { isValid: false, message: 'Password is required' };
  }

  if (password.length < PASSWORD_MIN_LENGTH) {
    return { isValid: false, message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters long` };
  }

  if (!PASSWORD_REQUIREMENTS.lowercase.test(password)) {
    return { isValid: false, message: 'Password must contain at least one lowercase letter' };
  }

  if (!PASSWORD_REQUIREMENTS.uppercase.test(password)) {
    return { isValid: false, message: 'Password must contain at least one uppercase letter' };
  }

  if (!PASSWORD_REQUIREMENTS.number.test(password)) {
    return { isValid: false, message: 'Password must contain at least one number' };
  }

  if (!PASSWORD_REQUIREMENTS.special.test(password)) {
    return { isValid: false, message: 'Password must contain at least one special character' };
  }

  return { isValid: true };
}

/**
 * Validate GitLab URL
 */
function validateGitLabUrl(url: string): { isValid: boolean; message?: string } {
  if (!url) {
    return { isValid: false, message: 'GitLab URL is required' };
  }

  // Normalize URL
  let normalizedUrl = url.trim();
  if (!normalizedUrl.startsWith('http://') && !normalizedUrl.startsWith('https://')) {
    normalizedUrl = `https://${normalizedUrl}`;
  }

  if (!GITLAB_URL_REGEX.test(normalizedUrl)) {
    return { isValid: false, message: 'Invalid GitLab URL format' };
  }

  try {
    new URL(normalizedUrl);
    return { isValid: true };
  } catch {
    return { isValid: false, message: 'Invalid URL format' };
  }
}

/**
 * Validate GitLab access token
 */
function validateAccessToken(token: string): { isValid: boolean; message?: string } {
  if (!token) {
    return { isValid: false, message: 'Access token is required' };
  }

  if (token.length < 10) {
    return { isValid: false, message: 'Access token is too short' };
  }

  if (token.length > 255) {
    return { isValid: false, message: 'Access token is too long' };
  }

  // Basic format validation for GitLab tokens
  if (!/^[a-zA-Z0-9_-]+$/.test(token)) {
    return { isValid: false, message: 'Access token contains invalid characters' };
  }

  return { isValid: true };
}

/**
 * Registration validation middleware
 */
export function validateRegistration(req: Request, res: Response, next: NextFunction): void {
  const requestId = req.requestId || 'unknown';
  const { username, email, password, confirmPassword } = req.body;

  const errors: LocalValidationError[] = [];

  // Sanitize inputs
  const sanitizedUsername = sanitizeString(username);
  const sanitizedEmail = sanitizeString(email);

  // Validate username
  const usernameValidation = validateUsername(sanitizedUsername);
  if (!usernameValidation.isValid) {
    errors.push({ field: 'username', message: usernameValidation.message! });
  }

  // Validate email
  const emailValidation = validateEmail(sanitizedEmail);
  if (!emailValidation.isValid) {
    errors.push({ field: 'email', message: emailValidation.message! });
  }

  // Validate password
  const passwordValidation = validatePassword(password);
  if (!passwordValidation.isValid) {
    errors.push({ field: 'password', message: passwordValidation.message! });
  }

  // Validate password confirmation
  if (password !== confirmPassword) {
    errors.push({ field: 'confirmPassword', message: 'Passwords do not match' });
  }

  if (errors.length > 0) {
    logger.warn('Registration validation failed', {
      requestId,
      username: sanitizedUsername,
      email: sanitizedEmail,
      errors: errors.map(e => `${e.field}: ${e.message}`)
    });

    sendErrorResponse(res, {
      type: 'ValidationError',
      message: 'Validation failed',
      code: 'VALIDATION_FAILED',
      details: { errors }
    }, 400, requestId);
    return;
  }

  // Update request body with sanitized values
  req.body.username = sanitizedUsername;
  req.body.email = sanitizedEmail;

  next();
}

/**
 * Login validation middleware
 */
export function validateLogin(req: Request, res: Response, next: NextFunction): void {
  const requestId = req.requestId || 'unknown';
  const { identifier, password } = req.body;

  const errors: LocalValidationError[] = [];

  // Sanitize identifier
  const sanitizedIdentifier = sanitizeString(identifier);

  if (!sanitizedIdentifier) {
    errors.push({ field: 'identifier', message: 'Username or email is required' });
  }

  if (!password) {
    errors.push({ field: 'password', message: 'Password is required' });
  }

  if (errors.length > 0) {
    logger.warn('Login validation failed', {
      requestId,
      identifier: sanitizedIdentifier,
      errors: errors.map(e => `${e.field}: ${e.message}`)
    });

    sendErrorResponse(res, {
      type: 'ValidationError',
      message: 'Validation failed',
      code: 'VALIDATION_FAILED',
      details: { errors }
    }, 400, requestId);
    return;
  }

  // Update request body with sanitized values
  req.body.identifier = sanitizedIdentifier;

  next();
}

/**
 * GitLab configuration validation middleware
 */
export function validateGitLabConfig(req: Request, res: Response, next: NextFunction): void {
  const requestId = req.requestId || 'unknown';
  const { name, gitlabUrl, accessToken, webhookSecret, description } = req.body;

  const errors: LocalValidationError[] = [];

  // Validate name (optional - will use default if not provided)
  const sanitizedName = sanitizeString(name);
  if (sanitizedName && sanitizedName.length > 100) {
    errors.push({ field: 'name', message: 'Configuration name is too long' });
  }

  // Validate GitLab URL
  const sanitizedUrl = sanitizeString(gitlabUrl);
  const urlValidation = validateGitLabUrl(sanitizedUrl);
  if (!urlValidation.isValid) {
    errors.push({ field: 'gitlabUrl', message: urlValidation.message! });
  }

  // Validate access token
  const sanitizedToken = sanitizeString(accessToken);
  const tokenValidation = validateAccessToken(sanitizedToken);
  if (!tokenValidation.isValid) {
    errors.push({ field: 'accessToken', message: tokenValidation.message! });
  }

  // Validate webhook secret (optional - will be auto-generated if not provided)
  const sanitizedSecret = sanitizeString(webhookSecret);
  if (sanitizedSecret && sanitizedSecret.length < 8) {
    errors.push({ field: 'webhookSecret', message: 'Webhook secret must be at least 8 characters long' });
  }

  // Validate description (optional)
  const sanitizedDescription = sanitizeString(description);
  if (sanitizedDescription && sanitizedDescription.length > 500) {
    errors.push({ field: 'description', message: 'Description is too long' });
  }

  if (errors.length > 0) {
    logger.warn('GitLab configuration validation failed', {
      requestId,
      name: sanitizedName,
      gitlabUrl: sanitizedUrl,
      errors: errors.map(e => `${e.field}: ${e.message}`)
    });

    sendErrorResponse(res, {
      type: 'ValidationError',
      message: 'Validation failed',
      code: 'VALIDATION_FAILED',
      details: { errors }
    }, 400, requestId);
    return;
  }

  // Update request body with sanitized values
  req.body.name = sanitizedName;
  req.body.gitlabUrl = sanitizedUrl;
  req.body.accessToken = sanitizedToken;
  req.body.webhookSecret = sanitizedSecret;
  req.body.description = sanitizedDescription;

  next();
}

/**
 * Password change validation middleware
 */
export function validatePasswordChange(req: Request, res: Response, next: NextFunction): void {
  const requestId = req.requestId || 'unknown';
  const { currentPassword, newPassword, confirmNewPassword } = req.body;

  const errors: LocalValidationError[] = [];

  if (!currentPassword) {
    errors.push({ field: 'currentPassword', message: 'Current password is required' });
  }

  // Validate new password
  const passwordValidation = validatePassword(newPassword);
  if (!passwordValidation.isValid) {
    errors.push({ field: 'newPassword', message: passwordValidation.message! });
  }

  // Validate new password confirmation
  if (newPassword !== confirmNewPassword) {
    errors.push({ field: 'confirmNewPassword', message: 'New passwords do not match' });
  }

  // Check that new password is different from current
  if (currentPassword === newPassword) {
    errors.push({ field: 'newPassword', message: 'New password must be different from current password' });
  }

  if (errors.length > 0) {
    logger.warn('Password change validation failed', {
      requestId,
      userId: req.user?.userId,
      errors: errors.map(e => `${e.field}: ${e.message}`)
    });

    sendErrorResponse(res, {
      type: 'ValidationError',
      message: 'Validation failed',
      code: 'VALIDATION_FAILED',
      details: { errors }
    }, 400, requestId);
    return;
  }

  next();
}

/**
 * Generic JSON body validation middleware
 */
export function validateJsonBody(req: Request, res: Response, next: NextFunction): void {
  const requestId = req.requestId || 'unknown';

  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
    if (!req.body || typeof req.body !== 'object') {
      logger.warn('Invalid JSON body', {
        requestId,
        path: req.path,
        method: req.method,
        contentType: req.get('Content-Type')
      });

      sendErrorResponse(res, {
        type: 'ValidationError',
        message: 'Invalid JSON body',
        code: 'INVALID_JSON'
      }, 400, requestId);
      return;
    }
  }

  next();
}

/**
 * Content-Type validation middleware
 */
export function validateContentType(req: Request, res: Response, next: NextFunction): void {
  const requestId = req.requestId || 'unknown';

  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
    const contentType = req.get('Content-Type');

    if (!contentType || !contentType.includes('application/json')) {
      logger.warn('Invalid Content-Type', {
        requestId,
        path: req.path,
        method: req.method,
        contentType
      });

      sendErrorResponse(res, {
        type: 'ValidationError',
        message: 'Content-Type must be application/json',
        code: 'INVALID_CONTENT_TYPE'
      }, 400, requestId);
      return;
    }
  }

  next();
}