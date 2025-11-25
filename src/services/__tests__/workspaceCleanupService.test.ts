import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { WorkspaceCleanupService } from '../workspaceCleanupService';
import { getWorkspaceMetadata, removeWorkspaceMetadata } from '../storage/workspaceMetadataRepository';

jest.mock('../storage/workspaceMetadataRepository');

const mockedGetWorkspaceMetadata = getWorkspaceMetadata as jest.MockedFunction<typeof getWorkspaceMetadata>;
const mockedRemoveWorkspaceMetadata = removeWorkspaceMetadata as jest.MockedFunction<typeof removeWorkspaceMetadata>;

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

describe('WorkspaceCleanupService', () => {
  it('removes workspaces older than max idle time', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-cleanup-'));
    const oldWorkspace = path.join(tempDir, 'old-workspace');
    const recentWorkspace = path.join(tempDir, 'recent-workspace');

    try {
      await fs.mkdir(oldWorkspace, { recursive: true });
      await fs.mkdir(recentWorkspace, { recursive: true });

      const now = Date.now();
      mockedGetWorkspaceMetadata.mockImplementation(async workspaceId => {
        if (workspaceId === 'old-workspace') {
          const date = new Date(now - 60_000);
          return {
            workspaceId,
            projectId: 1,
            projectName: 'demo',
            baseBranch: 'main',
            checkoutBranch: 'main',
            branch: 'main',
            path: oldWorkspace,
            createdAt: date,
            lastUsed: date,
            updatedAt: date,
          };
        }

        if (workspaceId === 'recent-workspace') {
          const date = new Date(now);
          return {
            workspaceId,
            projectId: 1,
            projectName: 'demo',
            baseBranch: 'main',
            checkoutBranch: 'main',
            branch: 'main',
            path: recentWorkspace,
            createdAt: date,
            lastUsed: date,
            updatedAt: date,
          };
        }

        return null;
      });

      const cleanupService = new WorkspaceCleanupService(tempDir, {
        maxIdleTime: 1_000, // 1 second
        cleanupInterval: 60_000,
      });

      const stats = await cleanupService.runManualCleanup();

      expect(stats.removed).toBe(1);
      expect(stats.errors).toBe(0);
      expect(await pathExists(oldWorkspace)).toBe(false);
      expect(await pathExists(recentWorkspace)).toBe(true);
      expect(mockedRemoveWorkspaceMetadata).toHaveBeenCalledWith('old-workspace');
    } finally {
      mockedGetWorkspaceMetadata.mockReset();
      mockedRemoveWorkspaceMetadata.mockReset();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
