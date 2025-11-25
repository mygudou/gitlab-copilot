/**
 * GitLab Copilot API Client
 * Handles all API communication with the backend
 */
class GitLabCopilotAPI {
  constructor(baseUrl = '') {
    this.baseUrl = baseUrl;
    this.storage = this.initializeStorage();
    this.token = null;
    this.refreshToken = null;

    // Load tokens from localStorage if available
    this.loadTokens();
  }

  /**
   * Initialize a resilient storage layer that falls back to in-memory storage when
   * browser localStorage is unavailable (e.g. server-side rendering, privacy mode).
   */
  initializeStorage() {
    if (typeof window === 'undefined') {
      return this.createMemoryStorage();
    }

    try {
      const storage = window.localStorage;
      const testKey = '__gitlab_copilot_storage_test__';
      storage.setItem(testKey, testKey);
      storage.removeItem(testKey);
      return storage;
    } catch (error) {
      console.warn('localStorage unavailable, using in-memory storage instead:', error);
      return this.createMemoryStorage();
    }
  }

  /**
   * Create a minimal localStorage-compatible in-memory store.
   */
  createMemoryStorage() {
    const store = new Map();

    return {
      getItem(key) {
        return store.has(key) ? store.get(key) : null;
      },
      setItem(key, value) {
        store.set(key, String(value));
      },
      removeItem(key) {
        store.delete(key);
      },
      clear() {
        store.clear();
      }
    };
  }

  /**
   * Expose storage for other modules (e.g. Navigation helpers).
   */
  getStorage() {
    return this.storage;
  }

  /**
   * Load tokens from localStorage
   */
  loadTokens() {
    try {
      this.token = this.storage.getItem('accessToken');
      this.refreshToken = this.storage.getItem('refreshToken');
    } catch (error) {
      console.warn('Failed to load tokens from storage:', error);
      this.storage = this.createMemoryStorage();
      this.token = null;
      this.refreshToken = null;
    }
  }

  /**
   * Save tokens to localStorage
   */
  saveTokens(accessToken, refreshToken) {
    this.token = accessToken;
    this.refreshToken = refreshToken;

    try {
      if (accessToken) {
        this.storage.setItem('accessToken', accessToken);
      } else {
        this.storage.removeItem('accessToken');
      }

      if (refreshToken) {
        this.storage.setItem('refreshToken', refreshToken);
      } else {
        this.storage.removeItem('refreshToken');
      }
    } catch (error) {
      console.warn('Failed to persist tokens to storage:', error);
      this.storage = this.createMemoryStorage();
      if (accessToken) {
        this.storage.setItem('accessToken', accessToken);
      }
      if (refreshToken) {
        this.storage.setItem('refreshToken', refreshToken);
      }
    }
  }

  /**
   * Clear tokens
   */
  clearTokens() {
    this.token = null;
    this.refreshToken = null;
    try {
      this.storage.removeItem('accessToken');
      this.storage.removeItem('refreshToken');
    } catch (error) {
      console.warn('Failed to clear tokens from storage:', error);
      this.storage = this.createMemoryStorage();
    }
  }

  /**
   * Get auth headers
   */
  getAuthHeaders() {
    const headers = {
      'Content-Type': 'application/json'
    };

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    return headers;
  }

  buildQueryString(params = {}) {
    const searchParams = new URLSearchParams();

    Object.entries(params).forEach(([key, value]) => {
      if (value === undefined || value === null || value === '') {
        return;
      }
      searchParams.append(key, value);
    });

    const queryString = searchParams.toString();
    return queryString ? `?${queryString}` : '';
  }

  /**
   * Make HTTP request with automatic retry on auth failure
   */
  async request(endpoint, options = {}) {
    const url = `${this.baseUrl}${endpoint}`;
    const config = {
      ...options,
      headers: {
        ...this.getAuthHeaders(),
        ...options.headers
      }
    };

    try {
      let response = await fetch(url, config);

      // If unauthorized and we have a refresh token, try to refresh
      if (response.status === 401 && this.refreshToken && !endpoint.includes('/auth/refresh')) {
        const refreshed = await this.refreshAccessToken();
        if (refreshed) {
          // Retry the original request with new token
          config.headers = {
            ...this.getAuthHeaders(),
            ...options.headers
          };
          response = await fetch(url, config);
        }
      }

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: { message: 'Request failed' } }));
        throw new APIError(errorData.error?.message || 'Request failed', response.status, errorData);
      }

      return await response.json();
    } catch (error) {
      if (error instanceof APIError) {
        throw error;
      }
      throw new APIError('Network error', 0, { message: error.message });
    }
  }

  /**
   * Refresh access token
   */
  async refreshAccessToken() {
    if (!this.refreshToken) {
      return false;
    }

    try {
      const response = await fetch(`${this.baseUrl}/api/auth/refresh`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ refreshToken: this.refreshToken })
      });

      if (response.ok) {
        const data = await response.json();
        this.saveTokens(data.data.accessToken, data.data.refreshToken);
        return true;
      } else {
        this.clearTokens();
        return false;
      }
    } catch (error) {
      this.clearTokens();
      return false;
    }
  }

  /**
   * Check if user is authenticated
   */
  isAuthenticated() {
    return !!this.token;
  }

  // Auth API methods
  async register(userData) {
    const response = await this.request('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(userData)
    });
    return response.data;
  }

  async login(credentials) {
    const response = await this.request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(credentials)
    });

    // Save tokens from response
    this.saveTokens(response.data.accessToken, response.data.refreshToken);

    return response.data;
  }

  async logout() {
    if (this.isAuthenticated()) {
      try {
        await this.request('/api/auth/logout', {
          method: 'POST'
        });
      } catch (error) {
        // Continue with logout even if API call fails
        console.warn('Logout API call failed:', error);
      }
    }

    this.clearTokens();
    return { success: true };
  }

  async getCurrentUser() {
    const response = await this.request('/api/auth/me');
    return response.data;
  }

  async validateToken() {
    try {
      const response = await this.request('/api/auth/validate', {
        method: 'POST'
      });
      return response.data;
    } catch (error) {
      return { valid: false };
    }
  }

  // User API methods
  async getUserProfile() {
    const response = await this.request('/api/users/me');
    return response.data;
  }

  async updateUserProfile(updates) {
    const response = await this.request('/api/users/me', {
      method: 'PUT',
      body: JSON.stringify(updates)
    });
    return response.data;
  }

  async changePassword(passwordData) {
    const response = await this.request('/api/users/me/change-password', {
      method: 'POST',
      body: JSON.stringify(passwordData)
    });
    return response.data;
  }

  async getUserSessions() {
    const response = await this.request('/api/users/me/sessions');
    return response.data;
  }

  async terminateSession(sessionId) {
    const response = await this.request(`/api/users/me/sessions/${sessionId}`, {
      method: 'DELETE'
    });
    return response.data;
  }

  async terminateAllSessions() {
    const response = await this.request('/api/users/me/sessions', {
      method: 'DELETE'
    });
    return response.data;
  }

  // GitLab Config API methods
  async getGitLabConfigs() {
    const response = await this.request('/api/gitlab-configs');
    return response.data;
  }

  async createGitLabConfig(configData) {
    const response = await this.request('/api/gitlab-configs', {
      method: 'POST',
      body: JSON.stringify(configData)
    });
    return response.data;
  }

  async getGitLabConfig(configId) {
    const response = await this.request(`/api/gitlab-configs/${configId}`);
    return response.data;
  }

  async updateGitLabConfig(configId, updates) {
    const response = await this.request(`/api/gitlab-configs/${configId}`, {
      method: 'PUT',
      body: JSON.stringify(updates)
    });
    return response.data;
  }

  async deleteGitLabConfig(configId) {
    const response = await this.request(`/api/gitlab-configs/${configId}`, {
      method: 'DELETE'
    });
    return response.data;
  }

  async setDefaultGitLabConfig(configId) {
    const response = await this.request(`/api/gitlab-configs/${configId}/set-default`, {
      method: 'POST'
    });
    return response.data;
  }

  async getDefaultGitLabConfig() {
    const response = await this.request('/api/gitlab-configs/default');
    return response.data;
  }

  async testGitLabConnection(configData) {
    const response = await this.request('/api/gitlab-configs/test-connection', {
      method: 'POST',
      body: JSON.stringify(configData)
    });
    return response.data;
  }

  // Usage Statistics API methods
  async getUserUsageStats(params = {}) {
    const queryString = this.buildQueryString(params);
    const url = `/api/usage-stats${queryString}`;
    const response = await this.request(url);
    return response.data;
  }

  async getUsageSummary() {
    const response = await this.request('/api/usage-stats/summary');
    return response.data;
  }

  async getContextStats(context, days = 30) {
    const response = await this.request(`/api/usage-stats/context/${context}?days=${days}`);
    return response.data;
  }

  async getComprehensiveUserStats(params = {}) {
    const queryString = this.buildQueryString(params);
    const url = `/api/usage-stats/comprehensive${queryString}`;
    const response = await this.request(url);
    return response.data;
  }

  async getComprehensiveConfigStats(configId, params = {}) {
    if (!configId) {
      throw new Error('Configuration ID is required');
    }

    const queryString = this.buildQueryString(params);
    const url = `/api/usage-stats/by-config/${encodeURIComponent(configId)}/comprehensive${queryString}`;
    const response = await this.request(url);
    return response.data;
  }
}

/**
 * Custom API Error class
 */
class APIError extends Error {
  constructor(message, status, data) {
    super(message);
    this.name = 'APIError';
    this.status = status;
    this.data = data;
  }
}

/**
 * Global API instance
 */
const api = new GitLabCopilotAPI();

/**
 * Validation utilities
 */
const Validators = {
  email: (email) => {
    const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return regex.test(email);
  },

  password: (password) => {
    // At least 8 characters, with at least one letter, one number, and one special character
    const regex = /^(?=.*[A-Za-z])(?=.*\d)(?=.*[@$!%*#?&])[A-Za-z\d@$!%*#?&]{8,}$/;
    return regex.test(password);
  },

  username: (username) => {
    // 3-30 characters, alphanumeric and underscores
    const regex = /^[a-zA-Z0-9_]{3,30}$/;
    return regex.test(username);
  },

  url: (url) => {
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
  },

  required: (value) => {
    return value !== null && value !== undefined && value.toString().trim().length > 0;
  }
};

/**
 * UI Utilities
 */
const UI = {
  showAlert: (message, type = 'info', container = null) => {
    const alertEl = document.createElement('div');
    alertEl.className = `alert alert-${type}`;

    const icon = {
      success: '✅',
      error: '❌',
      warning: '⚠️',
      info: 'ℹ️'
    }[type] || 'ℹ️';

    alertEl.innerHTML = `
      <span class="alert-icon">${icon}</span>
      <div>
        <strong>${type.charAt(0).toUpperCase() + type.slice(1)}</strong>
        <p>${message}</p>
      </div>
    `;

    const targetContainer = container || document.querySelector('.main .container') || document.body;
    targetContainer.insertBefore(alertEl, targetContainer.firstChild);

    // Auto-remove after 5 seconds
    setTimeout(() => {
      if (alertEl.parentNode) {
        alertEl.parentNode.removeChild(alertEl);
      }
    }, 5000);

    return alertEl;
  },

  showLoading: (element, text = 'Loading...') => {
    if (element.tagName === 'BUTTON') {
      element.disabled = true;
      element.innerHTML = `<span class="spinner"></span> ${text}`;
    } else {
      element.classList.add('loading');
    }
  },

  hideLoading: (element, originalText = '') => {
    if (element.tagName === 'BUTTON') {
      element.disabled = false;
      element.innerHTML = originalText;
    } else {
      element.classList.remove('loading');
    }
  },

  clearAlerts: (container = null) => {
    const targetContainer = container || document;
    const alerts = targetContainer.querySelectorAll('.alert');
    alerts.forEach(alert => alert.remove());
  },

  formatDate: (date) => {
    return new Date(date).toLocaleString();
  },

  formatTimeAgo: (date) => {
    const now = new Date();
    const past = new Date(date);
    const diffMs = now - past;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins} minute${diffMins !== 1 ? 's' : ''} ago`;
    if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
    if (diffDays < 7) return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;

    return past.toLocaleDateString();
  }
};

/**
 * Form validation helper
 */
class FormValidator {
  constructor(form) {
    this.form = form;
    this.rules = {};
    this.errors = {};
  }

  addRule(fieldName, validator, message) {
    if (!this.rules[fieldName]) {
      this.rules[fieldName] = [];
    }
    this.rules[fieldName].push({ validator, message });
    return this;
  }

  validate() {
    this.errors = {};
    let isValid = true;

    for (const [fieldName, rules] of Object.entries(this.rules)) {
      const field = this.form.elements[fieldName];
      if (!field) continue;

      const fieldElement = this.resolveFieldElement(field);
      if (!fieldElement) continue;

      const value = this.getFieldValue(field);

      for (const rule of rules) {
        if (!rule.validator(value)) {
          this.errors[fieldName] = rule.message;
          this.showFieldError(fieldElement, rule.message);
          isValid = false;
          break; // Stop at first error
        } else {
          this.clearFieldError(fieldElement);
        }
      }
    }

    return isValid;
  }

  getFieldValue(field) {
    if (!field) return '';

    if (typeof NodeList !== 'undefined' && field instanceof NodeList) {
      return this.getValueFromCollection(Array.from(field));
    }

    if (typeof HTMLCollection !== 'undefined' && field instanceof HTMLCollection) {
      return this.getValueFromCollection(Array.from(field));
    }

    if (field.type === 'checkbox') {
      return field.checked;
    }

    return field.value;
  }

  getValueFromCollection(collection) {
    if (!collection.length) {
      return '';
    }

    const first = collection[0];
    if (first.type === 'checkbox') {
      return collection.some(item => item.checked);
    }

    if (first.type === 'radio') {
      const checked = collection.find(item => item.checked);
      return checked ? checked.value : '';
    }

    return first.value;
  }

  resolveFieldElement(field) {
    if (!field) return null;

    if (typeof NodeList !== 'undefined' && field instanceof NodeList) {
      return field.length ? field[0] : null;
    }

    if (typeof HTMLCollection !== 'undefined' && field instanceof HTMLCollection) {
      return field.length ? field[0] : null;
    }

    return field;
  }

  showFieldError(field, message) {
    if (!field || !field.parentNode) return;

    field.classList.add('error');

    // Remove existing error message
    const existing = field.parentNode.querySelector('.form-error');
    if (existing) {
      existing.remove();
    }

    // Add new error message
    const errorEl = document.createElement('div');
    errorEl.className = 'form-error';
    errorEl.textContent = message;
    field.parentNode.appendChild(errorEl);
  }

  clearFieldError(field) {
    if (!field) return;

    field.classList.remove('error');

    const parent = field.parentNode;
    if (!parent) return;

    const errorEl = parent.querySelector('.form-error');
    if (errorEl) {
      errorEl.remove();
    }
  }

  clearAllErrors() {
    Object.keys(this.rules).forEach(fieldName => {
      const field = this.form.elements[fieldName];
      if (field) {
        const fieldElement = this.resolveFieldElement(field);
        if (fieldElement) {
          this.clearFieldError(fieldElement);
        }
      }
    });
  }

  getErrors() {
    return this.errors;
  }
}

/**
 * Page navigation and auth helpers
 */
const Navigation = {
  redirectTo: (path) => {
    window.location.href = path;
  },

  redirectToLogin: () => {
    const basePath = window.location.pathname.includes('/auth') ? '/auth' : '';
    Navigation.redirectTo(`${basePath}/login`);
  },

  redirectToDashboard: () => {
    const basePath = window.location.pathname.includes('/auth') ? '/auth' : '';
    Navigation.redirectTo(`${basePath}/dashboard`);
  },

  requireAuth: async () => {
    if (!api.isAuthenticated()) {
      Navigation.redirectToLogin();
      return false;
    }

    // Check if we've recently validated the token (cache for 5 minutes)
    let lastValidation = null;
    try {
      lastValidation = api.getStorage().getItem('lastTokenValidation');
    } catch (error) {
      console.warn('Failed to read last token validation timestamp:', error);
    }
    const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);

    if (lastValidation && parseInt(lastValidation) > fiveMinutesAgo) {
      // Token was recently validated, assume it's still valid
      return true;
    }

    // Validate token only if we haven't done so recently
    const validation = await api.validateToken();
    if (!validation.valid) {
      try {
        api.getStorage().removeItem('lastTokenValidation');
      } catch (error) {
        console.warn('Failed to clear last token validation timestamp:', error);
      }
      Navigation.redirectToLogin();
      return false;
    }

    // Cache the validation timestamp
    try {
      api.getStorage().setItem('lastTokenValidation', Date.now().toString());
    } catch (error) {
      console.warn('Failed to persist last token validation timestamp:', error);
    }
    return true;
  },

  requireNoAuth: async () => {
    if (!api.isAuthenticated()) {
      return true;
    }

    // If we have a token, validate it before redirecting
    try {
      const validation = await api.validateToken();
      if (validation.valid) {
        // Token is valid, redirect to dashboard
        Navigation.redirectToDashboard();
        return false;
      } else {
        // Token is invalid, clear it and stay on login page
        api.clearTokens();
        try {
          api.getStorage().removeItem('lastTokenValidation');
        } catch (error) {
          console.warn('Failed to clear last token validation timestamp:', error);
        }
        return true;
      }
    } catch (error) {
      // Validation failed, clear tokens and stay on login page
      api.clearTokens();
      try {
        api.getStorage().removeItem('lastTokenValidation');
      } catch (storageError) {
        console.warn('Failed to clear last token validation timestamp:', storageError);
      }
      return true;
    }
  }
};

// Export for use in other files
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GitLabCopilotAPI, APIError, Validators, UI, FormValidator, Navigation };
}
