#!/usr/bin/env node

import path from 'path';
import crypto from 'crypto';
import readline from 'readline';
import { once } from 'events';
import dotenv from 'dotenv';
import type { Config } from '../types/common';

// Load .env similarly to main entry point
const envPath = path.resolve(process.cwd(), '.env');
const result = dotenv.config({ path: envPath });
if (result.error) {
  const parentEnvPath = path.resolve(process.cwd(), '../.env');
  dotenv.config({ path: parentEnvPath });
}

let cachedConfig: Config | null = null;
let cachedLogger: typeof import('../utils/logger').default | null = null;
let cachedUserRepo: typeof import('../services/storage/userRepository') | null = null;
let cachedMongoModule: typeof import('../services/storage/mongoClient') | null = null;

function getConfig(): Config {
  if (!cachedConfig) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const module = require('../utils/config') as { config: Config };
    cachedConfig = module.config;
  }
  return cachedConfig;
}

function getLogger(): typeof import('../utils/logger').default {
  if (!cachedLogger) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    cachedLogger = require('../utils/logger').default;
  }
  return cachedLogger!;
}

function getUserRepository(): typeof import('../services/storage/userRepository') {
  if (!cachedUserRepo) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    cachedUserRepo = require('../services/storage/userRepository');
  }
  return cachedUserRepo!;
}

function getMongoModule(): typeof import('../services/storage/mongoClient') {
  if (!cachedMongoModule) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    cachedMongoModule = require('../services/storage/mongoClient');
  }
  return cachedMongoModule!;
}

type ArgValue = string | boolean;
type ArgMap = Record<string, ArgValue>;

type PromptOptions = {
  defaultValue?: string;
  required?: boolean;
};

interface ValidatedGitLabUser {
  id: number;
  username: string;
  name?: string;
  email?: string;
}

interface SetupInput {
  email?: string;
  displayName?: string;
  gitlabHost: string;
  pat: string;
  webhookSecret: string;
  userToken?: string;
}

const HELP_TEXT = `Usage: npm run setup-user [-- --email user@example.com --name "Display Name" --gitlab-url https://gitlab.example.com --pat token --webhook-secret secret --user-token abc]

Options:
  --email            User email (used for identification)
  --name             Display name (optional)
  --gitlab-url       GitLab instance base URL (default: value from config)
  --pat              Personal Access Token (will be validated via GitLab API)
  --webhook-secret   Secret used by GitLab webhook requests (leave empty to auto-generate)
  --user-token       Existing user token to update (optional)
  --non-interactive  Fail if required fields are missing instead of prompting
  --help             Show this help message
`;

function parseArgs(): ArgMap {
  const args = process.argv.slice(2);
  const map: ArgMap = {};

  for (let i = 0; i < args.length; i++) {
    const raw = args[i];
    if (!raw.startsWith('--')) {
      continue;
    }

    const key = raw.replace(/^--/, '');
    const next = args[i + 1];

    if (!next || next.startsWith('--')) {
      map[key] = true;
    } else {
      map[key] = next;
      i += 1;
    }
  }

  return map;
}

function createInterface(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

async function prompt(question: string, options: PromptOptions = {}): Promise<string | undefined> {
  if (options.defaultValue && !options.required) {
    question = `${question} (${options.defaultValue}): `;
  } else {
    question = `${question}: `;
  }

  const rl = createInterface();

  rl.setPrompt(question);
  rl.prompt();

  const [answer] = (await once(rl, 'line')) as [string];
  rl.close();

  const trimmed = answer.trim();
  if (!trimmed && options.defaultValue) {
    return options.defaultValue;
  }
  if (!trimmed && options.required) {
    return prompt(question.replace(/: $/, ''), options);
  }
  return trimmed || undefined;
}

function requirePlatformMode(): void {
  const cfg = getConfig();
  if (!cfg.platform.hasMongoCredentials) {
    throw new Error('MongoDB configuration is missing. Please set MONGODB_URI, MONGODB_DB, and ENCRYPTION_KEY.');
  }
}

function sanitizeHost(raw: string): string {
  const cfg = getConfig();
  const value = raw.trim();
  if (!value) {
    return cfg.gitlab.baseUrl;
  }

  if (!/^https?:\/\//i.test(value)) {
    return `https://${value}`;
  }

  return value.replace(/\/+$/, '');
}

async function validateGitLabToken(baseUrl: string, pat: string): Promise<ValidatedGitLabUser> {
  const endpoint = new URL('/api/v4/user', baseUrl).toString();
  const response = await fetch(endpoint, {
    headers: {
      'Private-Token': pat,
      'Accept': 'application/json',
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to validate PAT (${response.status} ${response.statusText}): ${text}`);
  }

  const data = (await response.json()) as ValidatedGitLabUser;
  if (!data || typeof data.id !== 'number') {
    throw new Error('Unexpected response from GitLab user endpoint.');
  }

  return data;
}

function mask(value: string | undefined, visible = 4): string {
  if (!value) return '';
  if (value.length <= visible) return '*'.repeat(value.length);
  return `${'*'.repeat(Math.max(0, value.length - visible))}${value.slice(-visible)}`;
}

async function gatherInput(args: ArgMap): Promise<SetupInput> {
  const cfg = getConfig();
  const nonInteractive = Boolean(args['non-interactive']);
  const emailArg = typeof args.email === 'string' ? args.email : undefined;
  const tokenArg = typeof args['user-token'] === 'string' ? args['user-token'] : undefined;
  const nameArg = typeof args.name === 'string' ? args.name : undefined;
  const gitlabArg = typeof args['gitlab-url'] === 'string' ? args['gitlab-url'] : undefined;
  const patArg = typeof args.pat === 'string' ? args.pat : undefined;
  const webhookArg = typeof args['webhook-secret'] === 'string' ? args['webhook-secret'] : undefined;

  const gitlabHost = sanitizeHost(gitlabArg ?? cfg.gitlab.baseUrl);

  const autoWebhookSecret = webhookArg ?? crypto.randomBytes(24).toString('hex');

  let email = emailArg;
  if (!email && !nonInteractive) {
    email = await prompt('User email', { required: true });
  }

  let displayName = nameArg;
  if (!displayName && !nonInteractive) {
    displayName = await prompt('Display name (optional)');
  }

  let pat = patArg;
  if (!pat && !nonInteractive) {
    pat = await prompt('GitLab Personal Access Token', { required: true });
  }

  let webhookSecret = webhookArg;
  if (!webhookSecret && !nonInteractive) {
    webhookSecret = await prompt('Webhook secret (leave empty to auto-generate)', {
      defaultValue: autoWebhookSecret,
    });
  }

  if (!email || !pat || !webhookSecret) {
    throw new Error('Missing required parameters. Provide email, pat, and webhook secret.');
  }

  return {
    email,
    displayName,
    gitlabHost,
    pat,
    webhookSecret: webhookSecret || autoWebhookSecret,
    userToken: tokenArg,
  };
}

async function resolveUserToken(preferredToken: string | undefined, email: string | undefined): Promise<string | undefined> {
  const repo = getUserRepository();

  if (preferredToken) {
    const existing = await repo.findUserByToken(preferredToken);
    if (existing) {
      return existing.userToken;
    }
    return preferredToken;
  }

  if (email) {
    const existing = await repo.findUserByEmail(email);
    if (existing) {
      return existing.userToken;
    }
  }

  return undefined;
}

async function main(): Promise<void> {
  requirePlatformMode();

  const args = parseArgs();
  if (args.help) {
    console.log(HELP_TEXT);
    return;
  }

  const input = await gatherInput(args);
  const repo = getUserRepository();
  const existingToken = await resolveUserToken(input.userToken, input.email);
  const userToken = existingToken ?? repo.generateUserToken();

  const gitlabUser = await validateGitLabToken(input.gitlabHost, input.pat);

  const result = await repo.upsertUser({
    userToken,
    email: input.email,
    displayName: input.displayName ?? gitlabUser.name ?? gitlabUser.username,
    gitlabHost: input.gitlabHost,
    pat: input.pat,
    webhookSecret: input.webhookSecret,
  });

  const operationLabel = result.operation === 'created' ? 'Created new tenant user' : 'Updated tenant user';

  console.log('\n✅ %s', operationLabel);
  console.log('   GitLab user: %s (%s)', gitlabUser.name ?? gitlabUser.username, gitlabUser.username);
  console.log('   Email: %s', input.email);
  console.log('   GitLab host: %s', input.gitlabHost);
  console.log('   User token: %s', result.userToken);
  console.log('   PAT (masked): %s', mask(input.pat));
  console.log('   Webhook secret (masked): %s', mask(input.webhookSecret));

  console.log('\nConfigure your GitLab project/webhook to use:');
  console.log('   URL: <platform-domain>/webhook/%s', result.userToken);
  console.log('   Secret token: %s', input.webhookSecret);
  console.log('\nTo update this user in the future, rerun with --user-token %s', result.userToken);
}

main()
  .catch(error => {
    try {
      getLogger().error('setup-user script failed', error);
    } catch {
      // Fallback to console if logger is unavailable
    }
    console.error('\n❌ setup-user failed:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await getMongoModule().closeMongoConnection();
    } catch (closeError) {
      try {
        getLogger().warn('Failed to close Mongo connection', closeError);
      } catch {
        // ignore logging failure
      }
    }
  });
