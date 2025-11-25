import * as fs from 'fs';
import * as path from 'path';
import logger from '../utils/logger';
import { AiExecutionContext, ExecutionScenario } from '../types/aiExecution';
import { PromptPayload, ProviderId } from './providers/providerAdapter';

const PROMPT_DIRECTORY = path.join(process.cwd(), 'prompt');

const SCENARIO_PROMPT_FILES: Record<ExecutionScenario, string> = {
  'issue-session': 'issue-session.md',
  'mr-fix': 'mr-fix.md',
  'code-review': 'code-review.md',
  'spec-doc': 'spec-doc.md',
};

const DEFAULT_SYSTEM_PROMPTS: Record<ExecutionScenario, string> = {
  'issue-session': `You are working in an automated webhook environment for GitLab issues.
You can inspect the repository, create or edit files, and describe your changes clearly.
Keep conversation going across turns, remember previous context, and provide actionable updates each time you reply.`,
  'mr-fix': `You are working in an automated webhook environment responding to merge request feedback.
Make the requested code changes directly without asking for confirmation.
Use git commands when needed and summarize the modifications once complete.`,
  'code-review': `You are performing an automated code review for a GitLab merge request.
Review only the provided diff context, call out issues with clear explanations, and suggest actionable improvements.
Focus on correctness, security, and maintainability.`,
  'spec-doc': `You are in documentation mode responding to a GitLab issue using Spec Kit.
Focus on capturing product requirements, success criteria, and constraints clearly.
Use the /speckit.specify command (and related Spec Kit tools if necessary) to produce high-quality documentation.
Avoid modifying application source code unless explicitly instructed.`,
};

const ANALYSIS_KEYWORDS = [
  'introduce',
  'explain',
  'analyze',
  'understand',
  'review',
  'describe',
  'show',
  'list',
  'find',
  'search',
  'what',
  'how',
  'overview',
  'structure',
  '介绍',
  '解释',
  '分析',
  '理解',
  '审查',
  '描述',
  '显示',
  '列出',
  '查找',
  '搜索',
  '概述',
  '结构',
] as const;

export class PromptBuilder {
  constructor(private readonly promptDirectory = PROMPT_DIRECTORY) {}

  public buildPrompt(
    provider: ProviderId,
    command: string,
    context: AiExecutionContext
  ): PromptPayload {
    const scenario = this.resolveScenario(context);

    if (scenario === 'spec-doc') {
      const trimmedCommand = command.trim();
      logger.debug('Built prompt for spec-doc scenario', {
        provider,
        commandLength: trimmedCommand.length,
      });

      return {
        prompt: trimmedCommand,
        systemPrompt: null,
      };
    }

    const scenarioPrompt = this.getScenarioPrompt(context);
    const segments: string[] = [];

    if (scenarioPrompt && provider === 'codex') {
      segments.push(`### 系统指令\n${scenarioPrompt.trim()}`);
    }

    if (provider === 'codex') {
      segments.push('**Language:** 请始终使用中文回复，包括总结与提示。');
    }

    if (context.context && context.context.trim()) {
      segments.push(`**Context:** ${context.context}`);
    }

    const needsExploration = ANALYSIS_KEYWORDS.some(keyword =>
      command.toLowerCase().includes(keyword)
    );

    const isMRContext = context.context && context.context.includes('MR #');
    if (isMRContext) {
      segments.push(
        `**MR Analysis:** This is a merge request context. You can use git commands to examine the changes if needed. Use 'git log', 'git diff', and 'git show' to understand what files have been modified.`
      );
    }

    segments.push(`**Request:** ${command}`);

    const prompt = segments.join('\n\n');

    logger.debug('Built prompt with context', {
      provider,
      hasContext: !!context.context,
      contextLength: context.context?.length || 0,
      commandLength: command.length,
      needsExploration,
      fullPromptLength: prompt.length,
    });

    return {
      prompt,
      systemPrompt: provider === 'claude' ? scenarioPrompt : null,
    };
  }

  private resolveScenario(context: AiExecutionContext): ExecutionScenario {
    if (context.scenario) {
      return context.scenario;
    }

    if (context.isIssueScenario) {
      return 'issue-session';
    }

    return 'mr-fix';
  }

  private getScenarioPrompt(context: AiExecutionContext): string | null {
    const scenario = this.resolveScenario(context);
    const filePrompt = this.loadSystemPromptFromFile(scenario);
    return filePrompt ?? DEFAULT_SYSTEM_PROMPTS[scenario];
  }

  private loadSystemPromptFromFile(scenario: ExecutionScenario): string | null {
    const fileName = SCENARIO_PROMPT_FILES[scenario];
    const filePath = path.join(this.promptDirectory, fileName);

    try {
      if (fs.existsSync(filePath)) {
        const contents = fs.readFileSync(filePath, 'utf-8').trim();
        if (contents) {
          logger.debug('Loaded scenario system prompt', {
            scenario,
            filePath,
            length: contents.length,
          });
          return contents;
        }

        logger.warn('Scenario system prompt file is empty', { scenario, filePath });
      }
    } catch (error) {
      logger.warn('Failed to load scenario system prompt', {
        scenario,
        filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return null;
  }
}
