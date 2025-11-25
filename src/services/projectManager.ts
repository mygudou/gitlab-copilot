import { simpleGit } from 'simple-git';
import path from 'path';
import fs from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../utils/config';
import logger from '../utils/logger';
import { GitLabProject } from '../types/gitlab';
import { resolveGitLabAuth } from '../utils/gitlabAuth';
import { upsertWorkspaceMetadata } from './storage/workspaceMetadataRepository';

export class ProjectManager {
  private workDir: string;

  constructor() {
    this.workDir = config.workDir;
  }

  public async prepareProject(
    project: GitLabProject,
    branch: string,
    options?: {
      workspaceId?: string;
      checkoutBranch?: string;
      baseBranch?: string;
    }
  ): Promise<string> {
    const workspaceId = options?.workspaceId;
    const checkoutBranch = options?.checkoutBranch ?? branch;
    const baseBranch = options?.baseBranch ?? branch;

    const projectPath = workspaceId
      ? path.join(this.workDir, this.sanitizeWorkspaceId(workspaceId))
      : path.join(this.workDir, uuidv4());

    try {
      await this.ensureWorkDirExists();
      const exists = await this.pathExists(projectPath);

      if (exists) {
        await this.refreshExistingWorkspace(projectPath, baseBranch, checkoutBranch);

        logger.info('Reused existing workspace', {
          projectId: project.id,
          projectName: project.name,
          checkoutBranch,
          baseBranch,
          path: projectPath,
        });

        await this.trackWorkspaceUsage('reuse', projectPath, {
          workspaceId,
          project,
          baseBranch,
          checkoutBranch,
          branch: checkoutBranch,
        });

        return projectPath;
      }

      await fs.mkdir(path.dirname(projectPath), { recursive: true });
      await this.cloneProject(project, projectPath, baseBranch);

      if (checkoutBranch !== baseBranch) {
        const git = simpleGit(projectPath);
        try {
          await git.checkout(['-b', checkoutBranch]);
        } catch (error) {
          logger.warn('Failed to create checkout branch after clone', {
            checkoutBranch,
            baseBranch,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      logger.info('Project prepared successfully', {
        projectId: project.id,
        projectName: project.name,
        branch: checkoutBranch,
        path: projectPath,
      });

      await this.trackWorkspaceUsage('create', projectPath, {
        workspaceId,
        project,
        baseBranch,
        checkoutBranch,
        branch: checkoutBranch,
      });

      return projectPath;
    } catch (error) {
      logger.error('Failed to prepare project:', error);
      await this.cleanup(projectPath);
      throw error;
    }
  }

  private sanitizeWorkspaceId(workspaceId: string): string {
    return workspaceId.replace(/[^a-zA-Z0-9-_/.]/g, '_');
  }

  private async trackWorkspaceUsage(
    action: 'create' | 'reuse',
    projectPath: string,
    details: {
      workspaceId?: string;
      project: GitLabProject;
      baseBranch: string;
      checkoutBranch: string;
      branch: string;
    }
  ): Promise<void> {
    const workspaceId = details.workspaceId
      ? this.sanitizeWorkspaceId(details.workspaceId)
      : path.basename(projectPath);

    logger.info('Workspace usage event', {
      action,
      workspaceId,
      projectId: details.project.id,
      projectName: details.project.name,
      baseBranch: details.baseBranch,
      checkoutBranch: details.checkoutBranch,
      branch: details.branch,
      path: projectPath,
    });

    await upsertWorkspaceMetadata({
      workspaceId,
      projectId: details.project.id,
      projectName: details.project.name,
      baseBranch: details.baseBranch,
      checkoutBranch: details.checkoutBranch,
      branch: details.branch,
      path: projectPath,
      lastUsed: new Date(),
    });
  }

  private async ensureWorkDirExists(): Promise<void> {
    try {
      await fs.access(this.workDir);
    } catch {
      await fs.mkdir(this.workDir, { recursive: true });
      logger.info(`Created work directory: ${this.workDir}`);
    }
  }

  private async pathExists(dirPath: string): Promise<boolean> {
    try {
      await fs.access(dirPath);
      return true;
    } catch {
      return false;
    }
  }

  private async cloneProject(
    project: GitLabProject,
    projectPath: string,
    branch: string
  ): Promise<void> {
    const git = simpleGit();

    logger.debug('Project details for cloning', {
      projectId: project.id,
      projectName: project.name,
      httpUrl: project.http_url_to_repo,
      webUrl: project.web_url,
      defaultBranch: project.default_branch,
      requestedBranch: branch,
    });

    // Use HTTP URL with token for authentication
    // GitLab webhook uses 'http_url' or 'git_http_url' instead of 'http_url_to_repo'
    const httpUrl =
      project.http_url_to_repo || (project as any).http_url || (project as any).git_http_url;
    const cloneUrl = this.getAuthenticatedUrl(httpUrl);

    logger.info('Cloning project', {
      projectId: project.id,
      branch,
      url: project.http_url_to_repo,
    });

    try {
      await git.clone(cloneUrl, projectPath, ['--depth', '1', '--branch', branch]);
    } catch (error) {
      // If specific branch doesn't exist, clone default and checkout
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('Remote branch') && errorMessage.includes('not found')) {
        logger.warn(`Branch ${branch} not found, cloning default branch and checking out`);

        await git.clone(cloneUrl, projectPath, ['--depth', '1']);
        const projectGit = simpleGit(projectPath);

        try {
          await projectGit.checkout(branch);
        } catch (checkoutError) {
          logger.warn(`Failed to checkout branch ${branch}, using default branch`);
        }
      } else {
        throw error;
      }
    }

    // Configure git user for commits
    const projectGit = simpleGit(projectPath);
    await projectGit.addConfig('user.name', 'AI Webhook Bot');
    await projectGit.addConfig('user.email', 'claude-webhook@example.com');
  }

  private async refreshExistingWorkspace(
    projectPath: string,
    baseBranch: string,
    checkoutBranch: string
  ): Promise<void> {
    const git = simpleGit(projectPath);

    try {
      await git.fetch();
    } catch (error) {
      logger.warn('Failed to fetch repository updates', {
        path: projectPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      const status = await git.status();
      if (status.files.length > 0) {
        logger.warn('Workspace has uncommitted changes before refresh', {
          path: projectPath,
          files: status.files.slice(0, 20),
          totalChanges: status.files.length,
        });
      }
    } catch (statusError) {
      logger.debug('Failed to read workspace status before refresh', {
        path: projectPath,
        error: statusError instanceof Error ? statusError.message : String(statusError),
      });
    }

    // 如果 checkoutBranch 和 baseBranch 相同,直接 checkout 到该分支
    if (checkoutBranch === baseBranch) {
      try {
        await git.checkout(checkoutBranch);
        await git.pull('origin', checkoutBranch);
        logger.info('Successfully refreshed branch', {
          branch: checkoutBranch,
          path: projectPath,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error('Failed to checkout and update branch during workspace refresh', {
          path: projectPath,
          branch: checkoutBranch,
          error: errorMessage,
        });
        // 分支不存在或无法 checkout,尝试从远端创建
        try {
          await git.checkout(['-B', checkoutBranch, `origin/${checkoutBranch}`]);
          logger.info('Created branch from remote', {
            branch: checkoutBranch,
            path: projectPath,
          });
        } catch (createError) {
          logger.error('Failed to create branch from remote', {
            branch: checkoutBranch,
            error: createError instanceof Error ? createError.message : String(createError),
          });
          throw new Error(`Unable to checkout or create branch ${checkoutBranch}: ${errorMessage}`);
        }
      }
      return;
    }

    // checkoutBranch 和 baseBranch 不同,先更新 base,再切换到 checkout
    try {
      await git.checkout(baseBranch);
      await git.pull('origin', baseBranch);
    } catch (error) {
      logger.warn('Failed to update base branch during workspace refresh', {
        path: projectPath,
        baseBranch,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      await git.checkout(checkoutBranch);
    } catch (checkoutError) {
      const errorMessage = checkoutError instanceof Error ? checkoutError.message : String(checkoutError);
      logger.warn('Failed to checkout feature branch, creating from base', {
        checkoutBranch,
        baseBranch,
        error: errorMessage,
      });

      try {
        await git.checkout(['-B', checkoutBranch, `origin/${checkoutBranch}`]);
      } catch {
        await git.checkout(['-b', checkoutBranch]);
      }
    }

    try {
      await git.pull('origin', checkoutBranch);
    } catch (pullError) {
      logger.warn('Failed to pull latest changes for feature branch', {
        checkoutBranch,
        error: pullError instanceof Error ? pullError.message : String(pullError),
      });
    }
  }

  private getAuthenticatedUrl(httpUrl: string): string {
    if (!httpUrl) {
      logger.error('HTTP URL is undefined or empty', { httpUrl });
      throw new Error('HTTP URL for repository is not available');
    }

    const auth = resolveGitLabAuth();
    const url = new URL(httpUrl);
    url.username = 'oauth2';
    url.password = auth.token;
    return url.toString();
  }

  public async switchToAndPushBranch(
    projectPath: string,
    branchName: string,
    commitMessage: string
  ): Promise<void> {
    const git = simpleGit(projectPath);

    try {
      // Switch to the new branch
      await git.checkout(['-b', branchName]);

      // Add all changes
      await git.add('.');

      // Check if there are changes to commit
      const status = await git.status();
      if (status.files.length === 0) {
        logger.info('No changes to commit');
        return;
      }

      // Commit changes
      await git.commit(commitMessage);

      // Push to remote with upstream tracking
      await git.push(['-u', 'origin', branchName]);

      logger.info('Changes committed and pushed to new branch', {
        branch: branchName,
        filesChanged: status.files.length,
      });
    } catch (error) {
      logger.error('Error switching to branch and pushing changes:', error);
      throw error;
    }
  }

  public async hasChanges(projectPath: string): Promise<boolean> {
    const git = simpleGit(projectPath);

    try {
      const status = await git.status();
      return status.files.length > 0;
    } catch (error) {
      logger.error('Error checking git status:', error);
      return false;
    }
  }

  public async commitAndPush(
    projectPath: string,
    commitMessage: string,
    branch: string
  ): Promise<void> {
    const git = simpleGit(projectPath);

    try {
      // Add all changes
      await git.add('.');

      // Check if there are changes to commit
      const status = await git.status();
      if (status.files.length === 0) {
        logger.info('No changes to commit');
        return;
      }

      // Commit changes
      await git.commit(commitMessage);

      // Push to remote
      await git.push('origin', branch);

      logger.info('Changes committed and pushed successfully', {
        branch,
        filesChanged: status.files.length,
      });
    } catch (error) {
      logger.error('Error committing and pushing changes:', error);
      throw error;
    }
  }

  private isNonFastForwardError(errorMessage: string): boolean {
    if (!errorMessage) {
      return false;
    }
    const normalized = errorMessage.toLowerCase();
    return (
      normalized.includes('non-fast-forward') ||
      normalized.includes('fetch first') ||
      normalized.includes('fetch the latest changes') ||
      normalized.includes('failed to push some refs') ||
      normalized.includes('tip of your current branch')
    );
  }

  public async commitAndPushChanges(
    projectPath: string,
    commitMessage: string
  ): Promise<{
    success: boolean;
    rebased: boolean;
    conflicts?: string[];
    error?: string;
  }> {
    const git = simpleGit(projectPath);

    try {
      // Add all changes
      await git.add('.');

      // Check if there are changes to commit
      const initialStatus = await git.status();
      if (initialStatus.files.length === 0) {
        logger.info('No changes to commit and push');
        return {
          success: true,
          rebased: false,
        };
      }

      // Commit changes
      await git.commit(commitMessage);

      const branchStatus = await git.status();
      const currentBranch = branchStatus.current;

      // Push to current branch
      try {
        await git.push();

        logger.info('Changes committed and pushed successfully', {
          filesChanged: initialStatus.files.length,
        });

        return {
          success: true,
          rebased: false,
        };
      } catch (pushError) {
        const pushMessage = pushError instanceof Error ? pushError.message : String(pushError);

        if (!this.isNonFastForwardError(pushMessage)) {
          logger.error('Failed to push changes after commit:', pushError);
          return {
            success: false,
            rebased: false,
            error: pushMessage,
          };
        }

        logger.warn('Push rejected, attempting git pull --rebase to synchronize', {
          branch: currentBranch,
          message: pushMessage,
        });

        try {
          if (currentBranch) {
            await git.pull('origin', currentBranch, { '--rebase': 'true' });
          } else {
            await git.pull(undefined, undefined, { '--rebase': 'true' });
          }
        } catch (rebaseError) {
          const rebaseStatus = await git.status();
          if (rebaseStatus.conflicted.length > 0) {
            logger.warn('Rebase resulted in conflicts', {
              conflicts: rebaseStatus.conflicted,
            });
            return {
              success: false,
              rebased: true,
              conflicts: rebaseStatus.conflicted,
            };
          }

          const rebaseMessage = rebaseError instanceof Error ? rebaseError.message : String(rebaseError);
          logger.error('git pull --rebase failed without conflict details', {
            error: rebaseMessage,
          });
          return {
            success: false,
            rebased: true,
            error: rebaseMessage,
          };
        }

        // Attempt to push again after successful rebase
        try {
          await git.push();
          logger.info('Changes pushed successfully after rebase', {
            filesChanged: initialStatus.files.length,
          });
          return {
            success: true,
            rebased: true,
          };
        } catch (pushAfterRebaseError) {
          const rebaseStatus = await git.status();
          if (rebaseStatus.conflicted.length > 0) {
            logger.warn('Push after rebase failed due to remaining conflicts', {
              conflicts: rebaseStatus.conflicted,
            });
            return {
              success: false,
              rebased: true,
              conflicts: rebaseStatus.conflicted,
            };
          }

          const finalMessage =
            pushAfterRebaseError instanceof Error
              ? pushAfterRebaseError.message
              : String(pushAfterRebaseError);
          logger.error('Push after successful rebase still failed', {
            message: finalMessage,
          });

          return {
            success: false,
            rebased: true,
            error: finalMessage,
          };
        }
      }
    } catch (error) {
      logger.error('Error committing and pushing changes:', error);
      return {
        success: false,
        rebased: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  public async cleanup(projectPath: string): Promise<void> {
    try {
      await fs.rm(projectPath, { recursive: true, force: true });
      logger.debug(`Cleaned up project directory: ${projectPath}`);
    } catch (error) {
      logger.warn(`Failed to cleanup directory ${projectPath}:`, error);
    }
  }

  private async isRebaseInProgress(projectPath: string): Promise<boolean> {
    const gitDir = path.join(projectPath, '.git');
    const markers = ['rebase-apply', 'rebase-merge'];

    for (const marker of markers) {
      try {
        await fs.access(path.join(gitDir, marker));
        return true;
      } catch {
        // ignore
      }
    }

    return false;
  }

  public async pushAfterConflictResolution(
    projectPath: string
  ): Promise<{ success: boolean; conflicts?: string[]; error?: string }> {
    const git = simpleGit(projectPath);

    try {
      let status = await git.status();

      if (status.conflicted.length > 0) {
        return {
          success: false,
          conflicts: status.conflicted,
        };
      }

      if (await this.isRebaseInProgress(projectPath)) {
        try {
          await git.raw(['rebase', '--continue']);
        } catch (continueError) {
          const continueMessage =
            continueError instanceof Error ? continueError.message : String(continueError);
          logger.error('Failed to continue rebase during conflict resolution:', continueMessage);
          status = await git.status();
          return {
            success: false,
            conflicts: status.conflicted.length > 0 ? status.conflicted : undefined,
            error: continueMessage,
          };
        }
      }

      status = await git.status();
      if (status.conflicted.length > 0) {
        return {
          success: false,
          conflicts: status.conflicted,
        };
      }

      if (status.files.length > 0) {
        const unstagedFiles = status.files.map(file => file.path);
        logger.warn('Workspace still has uncommitted changes after conflict resolution', {
          files: unstagedFiles,
        });
        return {
          success: false,
          error: 'Workspace still has uncommitted changes after conflict resolution',
        };
      }

      await git.push();
      logger.info('Successfully pushed changes after resolving conflicts');
      return { success: true };
    } catch (error) {
      logger.error('Failed to push changes after resolving conflicts:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  public async getChangedFiles(
    projectPath: string
  ): Promise<Array<{ path: string; type: string }>> {
    const git = simpleGit(projectPath);

    try {
      const status = await git.status();

      return status.files.map(file => ({
        path: file.path,
        type:
          file.working_dir === '?' ? 'created' : file.working_dir === 'D' ? 'deleted' : 'modified',
      }));
    } catch (error) {
      logger.error('Error getting changed files:', error);
      return [];
    }
  }
}
