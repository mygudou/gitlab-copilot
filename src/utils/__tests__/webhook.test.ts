import { extractAiInstructions } from '../webhook';

describe('extractAiInstructions', () => {
  it('detects /spec and returns spec-doc scenario with speckit command', () => {
    const text = '/spec 为新用户注册流程编写规格说明';
    const result = extractAiInstructions(text);

    expect(result).not.toBeNull();
    expect(result?.provider).toBe('claude');
    expect(result?.scenario).toBe('spec-doc');
    expect(result?.command.startsWith('/speckit.specify')).toBe(true);
    expect(result?.fullContext).toBe(text);
    expect(result?.trigger.type).toBe('slash-spec');
  });

  it('preserves explicit speckit command after /spec', () => {
    const text = '/spec /speckit.specify Draft a migration strategy';
    const result = extractAiInstructions(text);

    expect(result).not.toBeNull();
    expect(result?.command).toBe('/speckit.specify Draft a migration strategy');
    expect(result?.scenario).toBe('spec-doc');
    expect(result?.specKitCommand).toBe('spec');
  });

  it('maps /plan to /speckit.plan and marks stage', () => {
    const text = '/plan 针对智能 issue 设计迭代计划';
    const result = extractAiInstructions(text);

    expect(result).not.toBeNull();
    expect(result?.command.startsWith('/speckit.plan')).toBe(true);
    expect(result?.specKitCommand).toBe('plan');
  });

  it('maps /tasks to /speckit.tasks and marks stage', () => {
    const text = '/tasks 列出本迭代的任务分解';
    const result = extractAiInstructions(text);

    expect(result).not.toBeNull();
    expect(result?.command.startsWith('/speckit.tasks')).toBe(true);
    expect(result?.specKitCommand).toBe('tasks');
  });

  it('ignores @code and falls back to default workflow', () => {
    const text = '@code Please add integration tests';
    const result = extractAiInstructions(text);

    expect(result).toBeNull();
  });
});
