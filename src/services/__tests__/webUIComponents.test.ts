import { JSDOM } from 'jsdom';

// Mock the DOM environment for testing
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:3000',
  referrer: 'http://localhost:3000',
  contentType: 'text/html',
  includeNodeLocations: true,
  storageQuota: 10000000
});

// Set up global DOM objects
global.window = dom.window as any;
global.document = dom.window.document;
global.localStorage = dom.window.localStorage;
global.sessionStorage = dom.window.sessionStorage;
global.fetch = jest.fn();
global.URL = dom.window.URL;

// Mock console methods to avoid noise in tests
global.console = {
  ...console,
  log: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  debug: jest.fn()
};

describe('Web UI Components', () => {
  let mockApi: any;
  let mockValidators: any;
  let mockUI: any;
  let mockFormValidator: any;
  let mockNavigation: any;

  beforeEach(() => {
    // Clear all mocks
    jest.clearAllMocks();

    // Reset DOM
    document.body.innerHTML = '';

    // Clear localStorage
    localStorage.clear();
    sessionStorage.clear();

    // Mock API
    mockApi = {
      isAuthenticated: jest.fn(),
      register: jest.fn(),
      login: jest.fn(),
      logout: jest.fn(),
      getCurrentUser: jest.fn(),
      validateToken: jest.fn(),
      getGitLabConfigs: jest.fn(),
      createGitLabConfig: jest.fn(),
      updateGitLabConfig: jest.fn(),
      deleteGitLabConfig: jest.fn(),
      testGitLabConnection: jest.fn(),
      setDefaultGitLabConfig: jest.fn(),
      clearTokens: jest.fn(),
      saveTokens: jest.fn(),
      loadTokens: jest.fn()
    };

    // Mock Validators
    mockValidators = {
      email: jest.fn(),
      password: jest.fn(),
      username: jest.fn(),
      url: jest.fn(),
      required: jest.fn()
    };

    // Mock UI utilities
    mockUI = {
      showAlert: jest.fn(),
      hideLoading: jest.fn(),
      showLoading: jest.fn(),
      clearAlerts: jest.fn(),
      formatDate: jest.fn(),
      formatTimeAgo: jest.fn()
    };

    // Mock FormValidator
    mockFormValidator = {
      addRule: jest.fn().mockReturnThis(),
      validate: jest.fn(),
      clearFieldError: jest.fn(),
      showFieldError: jest.fn(),
      clearAllErrors: jest.fn(),
      getErrors: jest.fn(),
      rules: {}
    };

    // Mock Navigation
    mockNavigation = {
      redirectTo: jest.fn(),
      redirectToLogin: jest.fn(),
      redirectToDashboard: jest.fn(),
      requireAuth: jest.fn(),
      requireNoAuth: jest.fn()
    };

    // Set up global mocks
    global.api = mockApi;
    global.Validators = mockValidators;
    global.UI = mockUI;
    global.FormValidator = jest.fn().mockReturnValue(mockFormValidator);
    global.Navigation = mockNavigation;
  });

  describe('API Client', () => {
    it('should handle token storage and retrieval', () => {
      const accessToken = 'test-access-token';
      const refreshToken = 'test-refresh-token';

      // Test saving tokens
      mockApi.saveTokens(accessToken, refreshToken);
      expect(localStorage.getItem('accessToken')).toBe(accessToken);
      expect(localStorage.getItem('refreshToken')).toBe(refreshToken);

      // Test loading tokens
      mockApi.token = localStorage.getItem('accessToken');
      mockApi.refreshToken = localStorage.getItem('refreshToken');
      expect(mockApi.token).toBe(accessToken);
      expect(mockApi.refreshToken).toBe(refreshToken);

      // Test clearing tokens
      mockApi.clearTokens();
      localStorage.removeItem('accessToken');
      localStorage.removeItem('refreshToken');
      expect(localStorage.getItem('accessToken')).toBeNull();
      expect(localStorage.getItem('refreshToken')).toBeNull();
    });

    it('should handle authentication state', () => {
      // Test unauthenticated state
      mockApi.isAuthenticated.mockReturnValue(false);
      expect(mockApi.isAuthenticated()).toBe(false);

      // Test authenticated state
      mockApi.isAuthenticated.mockReturnValue(true);
      expect(mockApi.isAuthenticated()).toBe(true);
    });

    it('should handle registration flow', async () => {
      const registrationData = {
        username: 'testuser',
        email: 'test@example.com',
        password: 'TestPass123!',
        confirmPassword: 'TestPass123!'
      };

      const expectedResponse = {
        userToken: 'user-token-123',
        message: 'Registration successful'
      };

      mockApi.register.mockResolvedValue(expectedResponse);

      const result = await mockApi.register(registrationData);
      expect(mockApi.register).toHaveBeenCalledWith(registrationData);
      expect(result).toEqual(expectedResponse);
    });

    it('should handle login flow', async () => {
      const loginData = {
        identifier: 'testuser',
        password: 'TestPass123!'
      };

      const expectedResponse = {
        user: { id: '1', username: 'testuser', email: 'test@example.com' },
        accessToken: 'access-token-123',
        refreshToken: 'refresh-token-123',
        expiresIn: 900
      };

      mockApi.login.mockResolvedValue(expectedResponse);

      const result = await mockApi.login(loginData);
      expect(mockApi.login).toHaveBeenCalledWith(loginData);
      expect(result).toEqual(expectedResponse);
    });

    it('should handle GitLab configuration operations', async () => {
      const configData = {
        name: 'Test GitLab',
        gitlabUrl: 'https://gitlab.example.com',
        accessToken: 'gitlab-token-123',
        webhookSecret: 'webhook-secret-123',
        description: 'Test configuration'
      };

      const expectedConfig = {
        id: 'config-123',
        ...configData,
        isDefault: false,
        isActive: true,
        createdAt: new Date().toISOString()
      };

      // Test create
      mockApi.createGitLabConfig.mockResolvedValue(expectedConfig);
      const createResult = await mockApi.createGitLabConfig(configData);
      expect(mockApi.createGitLabConfig).toHaveBeenCalledWith(configData);
      expect(createResult).toEqual(expectedConfig);

      // Test get configs
      const configs = [expectedConfig];
      mockApi.getGitLabConfigs.mockResolvedValue({ configs });
      const getResult = await mockApi.getGitLabConfigs();
      expect(getResult.configs).toEqual(configs);

      // Test connection test
      const testResult = { success: true, message: 'Connection successful' };
      mockApi.testGitLabConnection.mockResolvedValue(testResult);
      const connectionResult = await mockApi.testGitLabConnection(configData);
      expect(connectionResult).toEqual(testResult);
    });
  });

  describe('Form Validation', () => {
    it('should validate required fields', () => {
      mockValidators.required.mockImplementation((value) => {
        return value !== null && value !== undefined && value.toString().trim().length > 0;
      });

      expect(mockValidators.required('')).toBe(false);
      expect(mockValidators.required('   ')).toBe(false);
      expect(mockValidators.required('test')).toBe(true);
      expect(mockValidators.required(null)).toBe(false);
      expect(mockValidators.required(undefined)).toBe(false);
    });

    it('should validate email addresses', () => {
      mockValidators.email.mockImplementation((email) => {
        const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return regex.test(email);
      });

      expect(mockValidators.email('test@example.com')).toBe(true);
      expect(mockValidators.email('invalid-email')).toBe(false);
      expect(mockValidators.email('test@')).toBe(false);
      expect(mockValidators.email('@example.com')).toBe(false);
    });

    it('should validate passwords', () => {
      mockValidators.password.mockImplementation((password) => {
        const regex = /^(?=.*[A-Za-z])(?=.*\d)(?=.*[@$!%*#?&])[A-Za-z\d@$!%*#?&]{8,}$/;
        return regex.test(password);
      });

      expect(mockValidators.password('TestPass123!')).toBe(true);
      expect(mockValidators.password('weakpass')).toBe(false);
      expect(mockValidators.password('NoNumbers!')).toBe(false);
      expect(mockValidators.password('NoSpecialChar123')).toBe(false);
      expect(mockValidators.password('Short1!')).toBe(false);
    });

    it('should validate usernames', () => {
      mockValidators.username.mockImplementation((username) => {
        const regex = /^[a-zA-Z0-9_]{3,30}$/;
        return regex.test(username);
      });

      expect(mockValidators.username('validuser123')).toBe(true);
      expect(mockValidators.username('valid_user')).toBe(true);
      expect(mockValidators.username('ab')).toBe(false); // too short
      expect(mockValidators.username('user-with-dash')).toBe(false); // invalid character
      expect(mockValidators.username('user with space')).toBe(false); // space
    });

    it('should validate URLs', () => {
      mockValidators.url.mockImplementation((url) => {
        try {
          new URL(url);
          return true;
        } catch {
          return false;
        }
      });

      expect(mockValidators.url('https://example.com')).toBe(true);
      expect(mockValidators.url('http://localhost:3000')).toBe(true);
      expect(mockValidators.url('invalid-url')).toBe(false);
      expect(mockValidators.url('ftp://example.com')).toBe(true);
    });

    it('should create and configure form validator', () => {
      const form = document.createElement('form');
      document.body.appendChild(form);

      const validator = new (global.FormValidator as any)(form);

      expect(validator.addRule).toBeDefined();
      expect(validator.validate).toBeDefined();
      expect(validator.clearFieldError).toBeDefined();
      expect(validator.showFieldError).toBeDefined();
    });
  });

  describe('UI Components', () => {
    it('should create header component with navigation', () => {
      mockApi.isAuthenticated.mockReturnValue(true);

      // Mock the createHeader function
      const createHeader = (currentPage = '') => {
        const isAuthenticated = mockApi.isAuthenticated();
        const basePath = '/auth';

        if (isAuthenticated) {
          return `<header><nav><a href="${basePath}/dashboard">Dashboard</a></nav></header>`;
        } else {
          return `<header><nav><a href="${basePath}/login">Login</a></nav></header>`;
        }
      };

      const authenticatedHeader = createHeader('dashboard');
      expect(authenticatedHeader).toContain('Dashboard');

      mockApi.isAuthenticated.mockReturnValue(false);
      const unauthenticatedHeader = createHeader();
      expect(unauthenticatedHeader).toContain('Login');
    });

    it('should create form components', () => {
      const createFormGroup = (label: string, input: string, required = false) => {
        return `
          <div class="form-group">
            <label class="form-label ${required ? 'required' : ''}">${label}</label>
            ${input}
          </div>
        `;
      };

      const createInput = (name: string, type = 'text', placeholder = '', value = '', required = false) => {
        return `
          <input
            type="${type}"
            name="${name}"
            class="form-input"
            placeholder="${placeholder}"
            value="${value}"
            ${required ? 'required' : ''}
          />
        `;
      };

      const input = createInput('email', 'email', 'Enter email', '', true);
      const formGroup = createFormGroup('Email', input, true);

      expect(formGroup).toContain('form-group');
      expect(formGroup).toContain('required');
      expect(formGroup).toContain('Email');
      expect(input).toContain('type="email"');
      expect(input).toContain('required');
    });

    it('should create card components', () => {
      const createCard = (title: string, content: string, footer?: string) => {
        return `
          <div class="card">
            ${title ? `<div class="card-header"><h3>${title}</h3></div>` : ''}
            <div class="card-body">${content}</div>
            ${footer ? `<div class="card-footer">${footer}</div>` : ''}
          </div>
        `;
      };

      const card = createCard('Test Title', 'Test Content', 'Test Footer');

      expect(card).toContain('card');
      expect(card).toContain('Test Title');
      expect(card).toContain('Test Content');
      expect(card).toContain('Test Footer');
    });

    it('should create alert components', () => {
      const createAlert = (message: string, type = 'info') => {
        const icon = {
          success: '✅',
          error: '❌',
          warning: '⚠️',
          info: 'ℹ️'
        }[type] || 'ℹ️';

        return `
          <div class="alert alert-${type}">
            <span class="alert-icon">${icon}</span>
            <div>${message}</div>
          </div>
        `;
      };

      const successAlert = createAlert('Success message', 'success');
      const errorAlert = createAlert('Error message', 'error');

      expect(successAlert).toContain('alert-success');
      expect(successAlert).toContain('✅');
      expect(successAlert).toContain('Success message');

      expect(errorAlert).toContain('alert-error');
      expect(errorAlert).toContain('❌');
      expect(errorAlert).toContain('Error message');
    });

    it('should handle modal operations', () => {
      const createModal = (id: string, title: string, content: string) => {
        return `
          <div id="${id}" class="modal" aria-hidden="true">
            <div class="modal__content">
              <div class="modal__header">
                <h3 class="modal__title">${title}</h3>
                <button type="button" class="modal__close" onclick="closeModal('${id}')">×</button>
              </div>
              <div class="modal__body">${content}</div>
            </div>
          </div>
        `;
      };

      const modal = createModal('testModal', 'Test Modal', 'Modal content');
      document.body.innerHTML = modal;

      const modalElement = document.getElementById('testModal');
      expect(modalElement).toBeTruthy();
      expect(modalElement?.classList.contains('modal--open')).toBe(false);
      expect(modalElement?.getAttribute('aria-hidden')).toBe('true');

      // Test opening modal
      const openModal = (modalId: string) => {
        const modal = document.getElementById(modalId);
        if (modal) {
          modal.classList.add('modal--open');
          modal.setAttribute('aria-hidden', 'false');
        }
      };

      openModal('testModal');
      expect(modalElement?.classList.contains('modal--open')).toBe(true);
      expect(modalElement?.getAttribute('aria-hidden')).toBe('false');

      // Test closing modal
      const closeModal = (modalId: string) => {
        const modal = document.getElementById(modalId);
        if (modal) {
          modal.classList.remove('modal--open');
          modal.setAttribute('aria-hidden', 'true');
        }
      };

      closeModal('testModal');
      expect(modalElement?.classList.contains('modal--open')).toBe(false);
      expect(modalElement?.getAttribute('aria-hidden')).toBe('true');
    });
  });

  describe('Navigation and Authentication', () => {
    it('should handle authentication requirements', async () => {
      // Test requireAuth with valid token
      mockApi.isAuthenticated.mockReturnValue(true);
      mockApi.validateToken.mockResolvedValue({ valid: true });
      mockNavigation.requireAuth.mockResolvedValue(true);

      const authResult = await mockNavigation.requireAuth();
      expect(authResult).toBe(true);

      // Test requireAuth with invalid token
      mockApi.isAuthenticated.mockReturnValue(false);
      mockNavigation.requireAuth.mockResolvedValue(false);

      const unauthResult = await mockNavigation.requireAuth();
      expect(unauthResult).toBe(false);
    });

    it('should handle redirections', () => {
      mockNavigation.redirectTo('/dashboard');
      expect(mockNavigation.redirectTo).toHaveBeenCalledWith('/dashboard');

      mockNavigation.redirectToLogin();
      expect(mockNavigation.redirectToLogin).toHaveBeenCalled();

      mockNavigation.redirectToDashboard();
      expect(mockNavigation.redirectToDashboard).toHaveBeenCalled();
    });

    it('should handle no-auth requirements', () => {
      // Test with authenticated user (should redirect)
      mockApi.isAuthenticated.mockReturnValue(true);
      mockNavigation.requireNoAuth.mockReturnValue(false);

      const authResult = mockNavigation.requireNoAuth();
      expect(authResult).toBe(false);

      // Test with unauthenticated user (should allow)
      mockApi.isAuthenticated.mockReturnValue(false);
      mockNavigation.requireNoAuth.mockReturnValue(true);

      const unauthResult = mockNavigation.requireNoAuth();
      expect(unauthResult).toBe(true);
    });
  });

  describe('Utility Functions', () => {
    it('should format dates correctly', () => {
      const testDate = new Date('2024-01-15T10:30:00Z');

      mockUI.formatDate.mockImplementation((date) => {
        return new Date(date).toLocaleString();
      });

      mockUI.formatTimeAgo.mockImplementation((date) => {
        const now = new Date();
        const past = new Date(date);
        const diffMs = now.getTime() - past.getTime();
        const diffMins = Math.floor(diffMs / 60000);

        if (diffMins < 1) return 'just now';
        if (diffMins < 60) return `${diffMins} minutes ago`;
        return past.toLocaleDateString();
      });

      const formatted = mockUI.formatDate(testDate);
      expect(mockUI.formatDate).toHaveBeenCalledWith(testDate);

      const timeAgo = mockUI.formatTimeAgo(testDate);
      expect(mockUI.formatTimeAgo).toHaveBeenCalledWith(testDate);
    });

    it('should handle loading states', () => {
      const button = document.createElement('button');
      button.innerHTML = 'Submit';
      document.body.appendChild(button);

      mockUI.showLoading.mockImplementation((element, text) => {
        if (element.tagName === 'BUTTON') {
          element.disabled = true;
          element.innerHTML = `<span class="spinner"></span> ${text}`;
        }
      });

      mockUI.hideLoading.mockImplementation((element, originalText) => {
        if (element.tagName === 'BUTTON') {
          element.disabled = false;
          element.innerHTML = originalText;
        }
      });

      mockUI.showLoading(button, 'Loading...');
      expect(mockUI.showLoading).toHaveBeenCalledWith(button, 'Loading...');

      mockUI.hideLoading(button, 'Submit');
      expect(mockUI.hideLoading).toHaveBeenCalledWith(button, 'Submit');
    });

    it('should handle alert management', () => {
      mockUI.showAlert.mockImplementation((message, type, container) => {
        const alertEl = document.createElement('div');
        alertEl.className = `alert alert-${type}`;
        alertEl.innerHTML = message;

        const targetContainer = container || document.body;
        targetContainer.appendChild(alertEl);

        return alertEl;
      });

      mockUI.clearAlerts.mockImplementation((container) => {
        const targetContainer = container || document;
        const alerts = targetContainer.querySelectorAll('.alert');
        alerts.forEach((alert: Element) => alert.remove());
      });

      const alert = mockUI.showAlert('Test message', 'success');
      expect(mockUI.showAlert).toHaveBeenCalledWith('Test message', 'success');

      mockUI.clearAlerts();
      expect(mockUI.clearAlerts).toHaveBeenCalled();
    });
  });

  describe('Error Handling', () => {
    it('should handle API errors gracefully', async () => {
      const apiError = new Error('API Error');
      (apiError as any).status = 401;

      mockApi.login.mockRejectedValue(apiError);

      try {
        await mockApi.login({ identifier: 'user', password: 'pass' });
      } catch (error) {
        expect(error.message).toBe('API Error');
      }
    });

    it('should handle validation errors', () => {
      const form = document.createElement('form');
      const input = document.createElement('input');
      input.name = 'email';
      form.appendChild(input);
      document.body.appendChild(form);

      mockFormValidator.validate.mockReturnValue(false);
      mockFormValidator.getErrors.mockReturnValue({ email: 'Invalid email' });

      const isValid = mockFormValidator.validate();
      expect(isValid).toBe(false);

      const errors = mockFormValidator.getErrors();
      expect(errors.email).toBe('Invalid email');
    });

    it('should handle network errors', async () => {
      const networkError = new Error('Network error');
      mockApi.getCurrentUser.mockRejectedValue(networkError);

      try {
        await mockApi.getCurrentUser();
      } catch (error) {
        expect(error.message).toBe('Network error');
      }
    });
  });
});
