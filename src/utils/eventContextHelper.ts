import { GitLabWebhookEvent } from '../types/gitlab';
import { EventContext } from '../services/storage/eventRepository';

export function determineEventContext(event: GitLabWebhookEvent): {
  context: EventContext;
  contextId?: number;
  contextTitle?: string;
} {
  switch (event.object_kind) {
    case 'issue':
      if (event.object_attributes?.action === 'open' ||
          event.object_attributes?.action === 'reopen' ||
          event.object_attributes?.action === 'update') {
        return {
          context: 'issue',
          contextId: event.issue?.iid,
          contextTitle: event.issue?.title
        };
      }
      break;

    case 'merge_request':
      if (event.object_attributes?.action === 'open' ||
          event.object_attributes?.action === 'reopen' ||
          event.object_attributes?.action === 'update') {
        return {
          context: 'merge_request',
          contextId: event.merge_request?.iid,
          contextTitle: event.merge_request?.title
        };
      }
      break;

    case 'note': {
      const noteableType = event.object_attributes?.noteable_type;
      if (noteableType === 'Issue') {
        return {
          context: 'issue_comment',
          contextId: event.issue?.iid,
          contextTitle: event.issue?.title
        };
      } else if (noteableType === 'MergeRequest') {
        return {
          context: 'merge_request_comment',
          contextId: event.merge_request?.iid,
          contextTitle: event.merge_request?.title
        };
      }
      break;
    }
  }

  // Default fallback - try to infer from available data
  if (event.merge_request) {
    return {
      context: 'merge_request',
      contextId: event.merge_request.iid,
      contextTitle: event.merge_request.title
    };
  } else if (event.issue) {
    return {
      context: 'issue',
      contextId: event.issue.iid,
      contextTitle: event.issue.title
    };
  }

  // Final fallback
  return {
    context: 'issue' // Default to issue if we can't determine
  };
}

export function extractInstructionText(content: string): string {
  const lines = content.split('\n');
  const instructionRegex = /@(claude|codex)\b/i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (instructionRegex.test(line)) {
      const snippet: string[] = [];

      if (i > 0 && lines[i - 1].trim()) {
        snippet.push(lines[i - 1]);
      }

      snippet.push(line);

      if (i < lines.length - 1 && lines[i + 1].trim()) {
        snippet.push(lines[i + 1]);
      }

      return snippet.join('\n').substring(0, 500);
    }
  }

  return '';
}

/**
 * 从内容中提取 AI provider（@claude 或 @codex）
 */
export function detectAiProvider(content: string): 'claude' | 'codex' | null {
  const instructionRegex = /@(claude|codex)\b/i;
  const match = content.match(instructionRegex);

  if (!match) {
    return null;
  }

  const provider = match[1].toLowerCase();
  return provider === 'codex' ? 'codex' : 'claude';
}
