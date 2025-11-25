/**
 * Reusable UI Components for GitLab Copilot
 */

/**
 * Escape user provided content before injecting into HTML
 */
function escapeHtml(value) {
  if (value === null || value === undefined) {
    return '';
  }

  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Header component with navigation
 */
function createHeader(currentPage = '') {
  const isAuthenticated = api.isAuthenticated();
  const basePath = window.location.pathname.includes('/auth') ? '/auth' : '';

  return `
    <header class="header">
      <div class="container">
        <div class="header-content">
          <a href="${basePath}/" class="logo">
            GitLab Copilot
          </a>

          <!-- Desktop Navigation -->
          <nav class="nav">
            ${isAuthenticated ? `
              <a href="${basePath}/dashboard" class="nav-link ${currentPage === 'dashboard' ? 'active' : ''}">
                Dashboard
              </a>
              <a href="${basePath}/config" class="nav-link ${currentPage === 'config' ? 'active' : ''}">
                Configuration
              </a>
              <a href="${basePath}/stats" class="nav-link ${currentPage === 'stats' ? 'active' : ''}">
                Statistics
              </a>
              <a href="${basePath}/docs" class="nav-link ${currentPage === 'docs' ? 'active' : ''}">
                Documentation
              </a>
              <button onclick="handleLogout()" class="nav-link" style="background: none; border: none; cursor: pointer;">
                Logout
              </button>
            ` : `
              <a href="${basePath}/login" class="nav-link ${currentPage === 'login' ? 'active' : ''}">
                Login
              </a>
              <a href="${basePath}/register" class="nav-link ${currentPage === 'register' ? 'active' : ''}">
                Register
              </a>
            `}
          </nav>

          <!-- Mobile Navigation Toggle -->
          <button class="mobile-nav-toggle" onclick="toggleMobileNav()">
            ☰
          </button>
        </div>

        <!-- Mobile Navigation -->
        <nav class="mobile-nav" id="mobileNav">
          <div class="nav">
            ${isAuthenticated ? `
              <a href="${basePath}/dashboard" class="nav-link ${currentPage === 'dashboard' ? 'active' : ''}">
                Dashboard
              </a>
              <a href="${basePath}/config" class="nav-link ${currentPage === 'config' ? 'active' : ''}">
                Configuration
              </a>
              <a href="${basePath}/stats" class="nav-link ${currentPage === 'stats' ? 'active' : ''}">
                Statistics
              </a>
              <a href="${basePath}/docs" class="nav-link ${currentPage === 'docs' ? 'active' : ''}">
                Documentation
              </a>
              <button onclick="handleLogout()" class="nav-link" style="background: none; border: none; cursor: pointer; width: 100%;">
                Logout
              </button>
            ` : `
              <a href="${basePath}/login" class="nav-link ${currentPage === 'login' ? 'active' : ''}">
                Login
              </a>
              <a href="${basePath}/register" class="nav-link ${currentPage === 'register' ? 'active' : ''}">
                Register
              </a>
            `}
          </div>
        </nav>
      </div>
    </header>
  `;
}

/**
 * Page wrapper component
 */
function createPageWrapper(title, subtitle, content, currentPage = '', options = {}) {
  const {
    layout = 'default',
    hidePageHeader = false,
    mainClass = '',
    containerClass = ''
  } = options;

  const mainClasses = ['main'];
  if (layout === 'landing') {
    mainClasses.push('main-landing');
  }
  if (mainClass) {
    mainClasses.push(mainClass);
  }

  const containerClasses = ['container'];
  if (containerClass) {
    containerClasses.push(containerClass);
  }

  const isLanding = layout === 'landing';
  const headerClass = `page-header${isLanding ? '' : ' page-header--app'}`;
  const pageHeader = hidePageHeader
    ? ''
    : `
        <div class="${headerClass}">
          <h1 class="page-title">${title}</h1>
          ${subtitle ? `<p class="page-subtitle">${subtitle}</p>` : ''}
        </div>
      `;

  const pageContent = isLanding
    ? `${pageHeader}${content}`
    : `
        <div class="page-shell">
          ${pageHeader}
          <div class="page-body">
            ${content}
          </div>
        </div>
      `;

  return `
    ${createHeader(currentPage)}
    <main class="${mainClasses.join(' ')}">
      <div class="${containerClasses.join(' ')}">
        ${pageContent}
      </div>
    </main>
  `;
}

/**
 * Card component
 */
function createCard(title, content, subtitle = null, footer = null) {
  return `
    <div class="card">
      ${title ? `
        <div class="card-header">
          <h3 class="card-title">${title}</h3>
          ${subtitle ? `<p class="card-subtitle">${subtitle}</p>` : ''}
        </div>
      ` : ''}
      <div class="card-body">
        ${content}
      </div>
      ${footer ? `
        <div class="card-footer">
          ${footer}
        </div>
      ` : ''}
    </div>
  `;
}

/**
 * Form group component
 */
function createFormGroup(label, input, required = false, help = null, error = null) {
  return `
    <div class="form-group">
      <label class="form-label ${required ? 'required' : ''}">${label}</label>
      ${input}
      ${help ? `<div class="form-help">${help}</div>` : ''}
      ${error ? `<div class="form-error">${error}</div>` : ''}
    </div>
  `;
}

/**
 * Input component
 */
function createInput(name, type = 'text', placeholder = '', value = '', required = false, attributes = '') {
  return `
    <input
      type="${type}"
      name="${name}"
      id="${name}"
      class="form-input"
      placeholder="${placeholder}"
      value="${value}"
      ${required ? 'required' : ''}
      ${attributes}
    />
  `;
}

/**
 * Button component
 */
function createButton(text, type = 'button', variant = 'primary', size = '', disabled = false, attributes = '') {
  const classes = `btn btn-${variant} ${size ? `btn-${size}` : ''}`;
  return `
    <button
      type="${type}"
      class="${classes}"
      ${disabled ? 'disabled' : ''}
      ${attributes}
    >
      ${text}
    </button>
  `;
}

/**
 * Alert component
 */
function createAlert(message, type = 'info', dismissible = true) {
  const icon = {
    success: '✅',
    error: '❌',
    warning: '⚠️',
    info: 'ℹ️'
  }[type] || 'ℹ️';

  return `
    <div class="alert alert-${type}">
      <span class="alert-icon">${icon}</span>
      <div>
        ${message}
      </div>
      ${dismissible ? `
        <button type="button" class="alert-close" onclick="this.parentElement.remove()">
          ×
        </button>
      ` : ''}
    </div>
  `;
}

/**
 * Loading component
 */
function createSpinner(text = 'Loading...') {
  return `
    <div class="spinner-block">
      <span class="spinner"></span>
      <span class="spinner-block__text">${text}</span>
    </div>
  `;
}

/**
 * Empty state component
 */
function createEmptyState(title, description, actionButton = null) {
  return `
    <div class="empty-state">
      <div class="empty-state__icon">📋</div>
      <h3 class="empty-state__title">${title}</h3>
      <p class="empty-state__description">${description}</p>
      ${actionButton ? `<div class="empty-state__actions">${actionButton}</div>` : ''}
    </div>
  `;
}

/**
 * Table component
 */
function createTable(headers, rows, emptyMessage = 'No data available') {
  if (!rows || rows.length === 0) {
    return createEmptyState('No Data', emptyMessage);
  }

  const headerRow = headers.map(header => `<th>${header}</th>`).join('');
  const bodyRows = rows.map(row =>
    `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`
  ).join('');

  return `
    <div style="overflow-x: auto;">
      <table style="width: 100%; border-collapse: collapse; background: white; border-radius: var(--radius-lg); overflow: hidden; box-shadow: var(--shadow-sm);">
        <thead style="background: var(--gray-50); border-bottom: 1px solid var(--gray-200);">
          <tr>${headerRow}</tr>
        </thead>
        <tbody>
          ${bodyRows}
        </tbody>
      </table>
    </div>
    <style>
      table th, table td {
        padding: 1rem;
        text-align: left;
        border-bottom: 1px solid var(--gray-200);
      }
      table th {
        font-weight: 600;
        color: var(--gray-700);
      }
      table tbody tr:hover {
        background-color: var(--gray-50);
      }
      table tbody tr:last-child td {
        border-bottom: none;
      }
    </style>
  `;
}

/**
 * Modal component
 */
function createModal(id, title, content, footer = null) {
  return `
    <div id="${id}" class="modal" aria-hidden="true">
      <div class="modal__content">
        <div class="modal__header">
          <h3 class="modal__title">${title}</h3>
          <button type="button" class="modal__close" onclick="closeModal('${id}')">×</button>
        </div>
        <div class="modal__body">
          ${content}
        </div>
        ${footer ? `
          <div class="modal__footer">
            ${footer}
          </div>
        ` : ''}
      </div>
    </div>
  `;
}

/**
 * Configuration card component for GitLab configs
 */
function createConfigCard(config) {
  const maskedToken = config.maskedAccessToken || (config.hasAccessToken ? '***' : 'Not set');
  const title = `${escapeHtml(config.name || 'Unnamed')}${config.isDefault ? ' (Default)' : ''}`;
  const gitlabUrl = config.gitlabUrl ? escapeHtml(config.gitlabUrl) : 'Not set';
  const maskedTokenDisplay = escapeHtml(maskedToken);
  const descriptionHtml = config.description ? `
        <div style="margin-bottom: 1rem;">
          <strong>Description:</strong> ${escapeHtml(config.description)}
        </div>
      ` : '';

  return createCard(
    title,
    `
      <div style="margin-bottom: 1rem;">
        <strong>GitLab URL:</strong> ${gitlabUrl}
      </div>
      <div style="margin-bottom: 1rem;">
        <strong>Access Token:</strong> ${maskedTokenDisplay}
      </div>
      ${descriptionHtml}
      <div style="margin-bottom: 1rem;">
        <strong>Status:</strong>
        <span style="color: ${config.isActive ? 'var(--success-color)' : 'var(--error-color)'}">
          ${config.isActive ? 'Active' : 'Inactive'}
        </span>
      </div>
      ${config.lastTested ? `
        <div style="margin-bottom: 1rem;">
          <strong>Last Tested:</strong> ${UI.formatTimeAgo(config.lastTested)}
        </div>
      ` : ''}
    `,
    null,
    `
      <div style="display: flex; gap: 0.5rem; flex-wrap: wrap;">
        ${!config.isDefault ? `
          <button onclick="setDefaultConfig('${config.id}')" class="btn btn-sm btn-secondary">
            Set as Default
          </button>
        ` : ''}
        <button onclick="testConfig('${config.id}')" class="btn btn-sm btn-secondary">
          Test Connection
        </button>
        <button onclick="editConfig('${config.id}')" class="btn btn-sm btn-secondary">
          Edit
        </button>
        <button onclick="deleteConfig('${config.id}', '${config.name}')" class="btn btn-sm btn-danger">
          Delete
        </button>
      </div>
    `
  );
}

/**
 * Global utility functions
 */
window.toggleMobileNav = function() {
  const mobileNav = document.getElementById('mobileNav');
  if (mobileNav) {
    mobileNav.classList.toggle('active');
  }
};

window.closeModal = function(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.classList.remove('modal--open');
    modal.setAttribute('aria-hidden', 'true');
  }
};

window.openModal = function(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.classList.add('modal--open');
    modal.setAttribute('aria-hidden', 'false');
  }
};

window.handleLogout = async function() {
  try {
    await api.logout();
    Navigation.redirectToLogin();
  } catch (error) {
    console.error('Logout error:', error);
    // Force redirect even if API call fails
    Navigation.redirectToLogin();
  }
};

// Close mobile nav when clicking outside
document.addEventListener('click', function(event) {
  const mobileNav = document.getElementById('mobileNav');
  const toggle = document.querySelector('.mobile-nav-toggle');

  if (mobileNav && mobileNav.classList.contains('active')) {
    if (!mobileNav.contains(event.target) && !toggle.contains(event.target)) {
      mobileNav.classList.remove('active');
    }
  }
});

// Close modals when clicking outside
document.addEventListener('click', function(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  if (target.classList.contains('modal') && target.classList.contains('modal--open')) {
    window.closeModal(target.id);
  }
});

// ESC key to close modals
document.addEventListener('keydown', function(event) {
  if (event.key === 'Escape') {
    document.querySelectorAll('.modal.modal--open').forEach(modal => {
      window.closeModal(modal.id);
    });
  }
});

// Export components for use in other files
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    createHeader,
    createPageWrapper,
    createCard,
    createFormGroup,
    createInput,
    createButton,
    createAlert,
    createSpinner,
    createEmptyState,
    createTable,
    createModal,
    createConfigCard
  };
}
