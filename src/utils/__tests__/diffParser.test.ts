import { DiffParser } from '../diffParser';

describe('DiffParser', () => {
  describe('parseMergeRequestDiffs - file exclusion', () => {
    const createMockDiff = (filePath: string, hasDiff = true) => ({
      old_path: filePath,
      new_path: filePath,
      diff: hasDiff ? '@@ -1,1 +1,2 @@\n-old line\n+new line\n+another line' : null,
      new_file: false,
      deleted_file: false,
      renamed_file: false,
    });

    const mockMergeRequest = {
      diff_refs: {
        base_sha: 'base123',
        head_sha: 'head456',
        start_sha: 'start789',
      },
    };

    it('应该排除 .pb.go 文件', () => {
      const diffs = [
        createMockDiff('api/proto/service.pb.go'),
        createMockDiff('pkg/models/user.go'),
      ];

      const result = DiffParser.parseMergeRequestDiffs(diffs, mockMergeRequest);

      expect(result.files).toHaveLength(1);
      expect(result.files[0].newPath).toBe('pkg/models/user.go');
    });

    it('应该排除 swagger.json 文件', () => {
      const diffs = [
        createMockDiff('docs/swagger.json'),
        createMockDiff('api/swagger.json'),
        createMockDiff('src/handler.js'),
      ];

      const result = DiffParser.parseMergeRequestDiffs(diffs, mockMergeRequest);

      expect(result.files).toHaveLength(1);
      expect(result.files[0].newPath).toBe('src/handler.js');
    });

    it('应该排除 swagger.yaml 和 swagger.yml 文件', () => {
      const diffs = [
        createMockDiff('swagger.yaml'),
        createMockDiff('api/swagger.yml'),
        createMockDiff('SWAGGER.YAML'), // 测试大小写不敏感
        createMockDiff('src/controller.ts'),
      ];

      const result = DiffParser.parseMergeRequestDiffs(diffs, mockMergeRequest);

      expect(result.files).toHaveLength(1);
      expect(result.files[0].newPath).toBe('src/controller.ts');
    });

    it('应该排除 openapi 相关文件', () => {
      const diffs = [
        createMockDiff('openapi.json'),
        createMockDiff('openapi.yaml'),
        createMockDiff('api/openapi.yml'),
        createMockDiff('src/service.ts'),
      ];

      const result = DiffParser.parseMergeRequestDiffs(diffs, mockMergeRequest);

      expect(result.files).toHaveLength(1);
      expect(result.files[0].newPath).toBe('src/service.ts');
    });

    it('应该排除文档文件 (.md, .txt, .rst)', () => {
      const diffs = [
        createMockDiff('README.md'),
        createMockDiff('CHANGELOG.md'),
        createMockDiff('docs/guide.txt'),
        createMockDiff('api/README.rst'),
        createMockDiff('src/index.ts'),
      ];

      const result = DiffParser.parseMergeRequestDiffs(diffs, mockMergeRequest);

      expect(result.files).toHaveLength(1);
      expect(result.files[0].newPath).toBe('src/index.ts');
    });

    it('应该排除 docs 目录下的所有文件', () => {
      const diffs = [
        createMockDiff('docs/api.html'),
        createMockDiff('docs/guide/setup.txt'),
        createMockDiff('internal/docs/design.pdf'),
        createMockDiff('src/docs.ts'), // 文件名包含 docs 但不在 docs 目录
        createMockDiff('src/service.ts'),
      ];

      const result = DiffParser.parseMergeRequestDiffs(diffs, mockMergeRequest);

      expect(result.files).toHaveLength(2);
      expect(result.files[0].newPath).toBe('src/docs.ts');
      expect(result.files[1].newPath).toBe('src/service.ts');
    });

    it('应该排除 api-docs 目录下的所有文件', () => {
      const diffs = [
        createMockDiff('api-docs/index.html'),
        createMockDiff('public/api-docs/styles.css'),
        createMockDiff('src/api.ts'),
      ];

      const result = DiffParser.parseMergeRequestDiffs(diffs, mockMergeRequest);

      expect(result.files).toHaveLength(1);
      expect(result.files[0].newPath).toBe('src/api.ts');
    });

    it('应该排除 swagger-ui 相关文件', () => {
      const diffs = [
        createMockDiff('public/swagger-ui/index.html'),
        createMockDiff('swagger-ui.js'),
        createMockDiff('src/app.ts'),
      ];

      const result = DiffParser.parseMergeRequestDiffs(diffs, mockMergeRequest);

      expect(result.files).toHaveLength(1);
      expect(result.files[0].newPath).toBe('src/app.ts');
    });

    it('应该正确处理混合场景', () => {
      const diffs = [
        createMockDiff('api/proto/service.pb.go'),
        createMockDiff('swagger.json'),
        createMockDiff('docs/README.md'),
        createMockDiff('src/service.ts'),
        createMockDiff('src/handler.go'),
        createMockDiff('openapi.yaml'),
        createMockDiff('pkg/models/user.go'),
      ];

      const result = DiffParser.parseMergeRequestDiffs(diffs, mockMergeRequest);

      expect(result.files).toHaveLength(3);
      expect(result.files.map(f => f.newPath)).toEqual([
        'src/service.ts',
        'src/handler.go',
        'pkg/models/user.go',
      ]);
    });

    it('不应该排除普通的 .go 文件', () => {
      const diffs = [
        createMockDiff('pkg/service.go'),
        createMockDiff('internal/handler.go'),
        createMockDiff('cmd/main.go'),
      ];

      const result = DiffParser.parseMergeRequestDiffs(diffs, mockMergeRequest);

      expect(result.files).toHaveLength(3);
    });

    it('应该保持 diff 的其他信息不变', () => {
      const diffs = [
        createMockDiff('src/service.ts'),
      ];

      const result = DiffParser.parseMergeRequestDiffs(diffs, mockMergeRequest);

      expect(result.baseSha).toBe('base123');
      expect(result.headSha).toBe('head456');
      expect(result.startSha).toBe('start789');
    });
  });

  describe('getReviewableLines', () => {
    it('应该只返回新增的行', () => {
      const parsedDiff = {
        baseSha: 'base',
        headSha: 'head',
        startSha: 'start',
        files: [{
          oldPath: 'test.ts',
          newPath: 'test.ts',
          isNew: false,
          isDeleted: false,
          isRenamed: false,
          hasDiff: true,
          lines: [
            { type: 'add' as const, content: 'new line 1', newLineNumber: 1 },
            { type: 'remove' as const, content: 'old line', oldLineNumber: 1 },
            { type: 'context' as const, content: 'unchanged', newLineNumber: 2, oldLineNumber: 2 },
            { type: 'add' as const, content: 'new line 2', newLineNumber: 3 },
          ],
        }],
      };

      const reviewableLines = DiffParser.getReviewableLines(parsedDiff);

      expect(reviewableLines).toHaveLength(2);
      expect(reviewableLines[0].lineNumber).toBe(1);
      expect(reviewableLines[1].lineNumber).toBe(3);
    });
  });

  describe('filterLinesNeedingReview', () => {
    const createReviewableLine = (content: string, lineNumber: number) => ({
      file: {
        oldPath: 'test.ts',
        newPath: 'test.ts',
        isNew: false,
        isDeleted: false,
        isRenamed: false,
        hasDiff: true,
        lines: [],
      },
      line: {
        type: 'add' as const,
        content,
        newLineNumber: lineNumber,
      },
      lineNumber,
    });

    it('应该过滤空白行和简单赋值', () => {
      const lines = [
        createReviewableLine('', 1),
        createReviewableLine('  ', 2),
        createReviewableLine('const x = 1;', 3), // 简单赋值也会被过滤
        createReviewableLine('const result = await fetch();', 4),
      ];

      const filtered = DiffParser.filterLinesNeedingReview(lines);

      // 只有包含复杂逻辑的行会被保留
      expect(filtered).toHaveLength(1);
      expect(filtered[0].lineNumber).toBe(4);
    });

    it('应该过滤 import 语句', () => {
      const lines = [
        createReviewableLine('import { foo } from "bar";', 1),
        createReviewableLine('from bar import foo', 2),
        createReviewableLine('const result = await fetch();', 3),
      ];

      const filtered = DiffParser.filterLinesNeedingReview(lines);

      // require() 不以 require 开头，所以不会被过滤
      // 只有以 import/require/from 开头的行才会被过滤
      expect(filtered).toHaveLength(1);
      expect(filtered[0].lineNumber).toBe(3);
    });

    it('应该识别控制流逻辑', () => {
      const lines = [
        createReviewableLine('if (condition) {', 1),
        createReviewableLine('for (let i = 0; i < 10; i++) {', 2),
      ];

      const filtered = DiffParser.filterLinesNeedingReview(lines);

      expect(filtered).toHaveLength(2);
      expect(filtered[0].reviewReason).toBe('Control flow logic');
      expect(filtered[1].reviewReason).toBe('Control flow logic');
    });

    it('应该识别安全敏感代码', () => {
      const lines = [
        createReviewableLine('const password = getPassword();', 1),
        createReviewableLine('const token = jwt.sign(payload);', 2),
      ];

      const filtered = DiffParser.filterLinesNeedingReview(lines);

      expect(filtered).toHaveLength(2);
      expect(filtered[0].reviewReason).toBe('Security-sensitive code');
      expect(filtered[1].reviewReason).toBe('Security-sensitive code');
    });

    it('应该识别 API 调用', () => {
      const lines = [
        createReviewableLine('const result = await fetch(url);', 1),
        createReviewableLine('axios.get("/api/data").then(res => res);', 2),
      ];

      const filtered = DiffParser.filterLinesNeedingReview(lines);

      expect(filtered).toHaveLength(2);
      expect(filtered[0].reviewReason).toBe('API call or async operation');
    });
  });
});
