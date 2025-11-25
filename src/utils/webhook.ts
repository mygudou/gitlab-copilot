import crypto from 'crypto';
import { config } from './config';
import logger from './logger';
import type { ExecutionScenario } from '../types/aiExecution';
import type { SpecKitStage } from '../types/session';

export interface SignatureHeaders {
  token?: string;
  webhookSignature?: string;
}

function toBufferFromSignature(signature: string): Buffer | null {
  const normalized = signature.trim();
  const withoutPrefix = normalized.startsWith('sha256=')
    ? normalized.slice('sha256='.length)
    : normalized;

  if (/^[0-9a-f]{64}$/i.test(withoutPrefix)) {
    return Buffer.from(withoutPrefix, 'hex');
  }

  try {
    const buffer = Buffer.from(withoutPrefix, 'base64');
    return buffer.length > 0 ? buffer : null;
  } catch {
    return null;
  }
}

function buildExpectedHmac(body: string, secret: string): { hex: string; buffer: Buffer } {
  const hmac = crypto.createHmac('sha256', secret).update(body, 'utf8');
  const hex = hmac.digest('hex');
  return {
    hex,
    buffer: Buffer.from(hex, 'hex'),
  };
}

export function verifyGitLabSignature(
  body: string,
  signatures: SignatureHeaders,
  secretOverride?: string
): boolean {
  const token = signatures.token?.trim();
  const webhookSignature = signatures.webhookSignature?.trim();

  if (!token && !webhookSignature) {
    logger.warn('No signature provided in webhook request');
    return false;
  }

  const secret = secretOverride ?? config.webhook.secret;

  if (!secret) {
    logger.warn('No webhook secret available for verification');
    return false;
  }

  if (token) {
    if (token === secret) {
      logger.debug('Webhook verified using direct secret token');
      return true;
    }

    logger.debug('Webhook token did not match configured secret', {
      providedLength: token.length,
    });
  }

  if (webhookSignature) {
    const expected = buildExpectedHmac(body, secret);
    const providedBuffer = toBufferFromSignature(webhookSignature);

    if (!providedBuffer) {
      logger.warn('Webhook signature format not recognized', {
        receivedLength: webhookSignature.length,
        preview: webhookSignature.substring(0, 10) + '...',
      });
      return false;
    }

    if (expected.buffer.length !== providedBuffer.length) {
      logger.warn('Webhook signature length mismatch', {
        expected: expected.buffer.length,
        provided: providedBuffer.length,
      });
      return false;
    }

    try {
      if (crypto.timingSafeEqual(expected.buffer, providedBuffer)) {
        logger.debug('Webhook verified using SHA256 signature');
        return true;
      }
    } catch (error) {
      logger.error('Error comparing webhook signatures', error);
      return false;
    }

    logger.warn('Invalid webhook SHA256 signature');
    return false;
  }

  logger.warn('Invalid webhook authentication - not a direct token or valid signature', {
    hasToken: Boolean(token),
    hasWebhookSignature: Boolean(webhookSignature),
  });
  return false;
}

const SUPPORTED_AI_HANDLES = ['claude', 'codex', 'ai'] as const;

type SupportedAiHandle = (typeof SUPPORTED_AI_HANDLES)[number];

function resolveProvider(handle: SupportedAiHandle): 'claude' | 'codex' {
  switch (handle) {
    case 'codex':
      return 'codex';
    case 'claude':
    case 'ai':
    default:
      return 'claude';
  }
}

type InstructionTrigger =
  | { type: 'mention'; handle: SupportedAiHandle }
  | { type: 'slash-spec' };

export interface ExtractedAiInstruction {
  command: string;
  provider: 'claude' | 'codex';
  fullContext: string; // Complete text including content before and after trigger
  scenario?: ExecutionScenario;
  trigger: InstructionTrigger;
  specKitCommand?: SpecKitStage;
}

export function extractAiInstructions(text: string): ExtractedAiInstruction | null {
  if (!text) return null;

  const slashMatch = text.match(/(?<!\S)\/(spec|plan|tasks)\b([\s\S]*)/i);
  if (slashMatch) {
    const commandKey = slashMatch[1]?.toLowerCase() as 'spec' | 'plan' | 'tasks';
    let normalizedContent = slashMatch[2]?.trim() ?? '';
    normalizedContent = normalizedContent.replace(/\s+$/, '');

    const commandMap: Record<'spec' | 'plan' | 'tasks', string> = {
      spec: '/speckit.specify',
      plan: '/speckit.plan',
      tasks: '/speckit.tasks',
    };

    const baseCommand = commandMap[commandKey];
    let command: string;
    if (normalizedContent) {
      const lowerNormalized = normalizedContent.toLowerCase();
      command = lowerNormalized.startsWith('/speckit.')
        ? normalizedContent
        : `${baseCommand} ${normalizedContent}`;
    } else {
      command = baseCommand;
    }

    return {
      command,
      provider: 'claude',
      fullContext: text,
      scenario: 'spec-doc',
      trigger: { type: 'slash-spec' },
      specKitCommand: commandKey,
    };
  }

  const lowerText = text.toLowerCase();

  // Check if any AI handle is present in the text
  let foundHandle: SupportedAiHandle | null = null;
  for (const handle of SUPPORTED_AI_HANDLES) {
    if (lowerText.includes(`@${handle}`)) {
      foundHandle = handle as SupportedAiHandle;
      break;
    }
  }

  if (!foundHandle) {
    return null;
  }

  // Extract command after the AI handle if present, otherwise use default
  const handlesPattern = SUPPORTED_AI_HANDLES.join('|');
  const instructionPattern = new RegExp(`@(${handlesPattern})\\s*([\\s\\S]*?)(?=@\\w+|$)`, 'i');
  const match = text.match(instructionPattern);

  let command = '';
  if (match && match[2]) {
    command = match[2].trim();
  }

  const provider = resolveProvider(foundHandle);
  // If no specific command is provided, use a sensible default
  if (!command) {
    command = 'Please perform a code review';
  }

  return {
    command,
    provider,
    fullContext: text, // Include the full text as context
    trigger: { type: 'mention', handle: foundHandle },
  };
}
