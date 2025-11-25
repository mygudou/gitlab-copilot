FROM node:18

# Install common CLI utilities
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    git \
    curl \
    wget \
    ca-certificates \
    vim-tiny \
    nano \
    less \
    procps \
    iproute2 \
    net-tools \
    iputils-ping \
    dnsutils \
    jq \
    unzip \
    zip \
    tar \
    build-essential \
  && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code

# Install Codex CLI globally
RUN npm install -g @openai/codex

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies (skip prepare script to avoid premature build)
RUN npm ci --ignore-scripts

# Copy source code, static assets, prompts and .env.example
COPY src/ ./src/
COPY public/ ./public/
COPY prompt/ ./prompt/
COPY .env.example ./
COPY CODE_REVIEW_GUIDELINES.md ./

# Build the application
RUN npm run build

# Remove dev dependencies after build
RUN npm prune --omit=dev

# Create work directory
RUN mkdir -p /tmp/gitlab-copilot-work

# Create non-root user
RUN groupadd --gid 1001 claude && \
    useradd --uid 1001 --gid 1001 --create-home --shell /bin/bash claude

# Change ownership of work directory
RUN chown -R claude:claude /tmp/gitlab-copilot-work /app

# Switch to non-root user
USER claude

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) }).on('error', () => process.exit(1))"

# Start the application
CMD ["npm", "start"]
