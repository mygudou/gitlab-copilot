import { Gitlab } from '@gitbeaker/node';
import logger from '../utils/logger';
import { resolveGitLabAuth } from '../utils/gitlabAuth';

export class GitLabService {
  private clientCache = new Map<string, InstanceType<typeof Gitlab>>();

  private getGitlabClient(): InstanceType<typeof Gitlab> {
    const auth = resolveGitLabAuth();
    const cacheKey = `${auth.baseUrl}|${auth.token}`;
    const cached = this.clientCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const client = new Gitlab({
      host: auth.baseUrl,
      token: auth.token,
    });

    this.clientCache.set(cacheKey, client);
    return client;
  }

  public async createIssueComment(projectId: number, issueIid: number, body: string): Promise<any> {
    try {
      const comment = await this.getGitlabClient().IssueNotes.create(projectId, issueIid, body);

      logger.info('Created comment on issue', {
        projectId,
        issueIid,
        bodyLength: body.length,
        commentId: comment?.id,
      });

      return comment;
    } catch (error) {
      logger.error('Failed to create issue comment:', error);
      throw new Error(
        `Failed to create issue comment: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  public async addIssueComment(projectId: number, issueIid: number, body: string): Promise<void> {
    await this.createIssueComment(projectId, issueIid, body);
  }

  public async createMergeRequestComment(
    projectId: number,
    mergeRequestIid: number,
    body: string
  ): Promise<any> {
    try {
      const comment = await this.getGitlabClient().MergeRequestNotes.create(projectId, mergeRequestIid, body);

      logger.info('Created comment on merge request', {
        projectId,
        mergeRequestIid,
        bodyLength: body.length,
        commentId: comment?.id,
      });

      return comment;
    } catch (error) {
      logger.error('Failed to create merge request comment:', error);
      throw new Error(
        `Failed to create merge request comment: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  public async addMergeRequestComment(
    projectId: number,
    mergeRequestIid: number,
    body: string
  ): Promise<void> {
    await this.createMergeRequestComment(projectId, mergeRequestIid, body);
  }

  public async getProject(projectId: number): Promise<any> {
    try {
      const project = await this.getGitlabClient().Projects.show(projectId);
      return project;
    } catch (error) {
      logger.error('Failed to get project:', error);
      throw new Error(
        `Failed to get project: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  public async getBranches(projectId: number): Promise<any[]> {
    try {
      const branches = await this.getGitlabClient().Branches.all(projectId);
      return branches;
    } catch (error) {
      logger.error('Failed to get branches:', error);
      throw new Error(
        `Failed to get branches: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  public async createBranch(projectId: number, branchName: string, ref: string): Promise<any> {
    try {
      const branch = await this.getGitlabClient().Branches.create(projectId, branchName, ref);

      logger.info('Created branch', {
        projectId,
        branchName,
        ref,
      });

      return branch;
    } catch (error) {
      logger.error('Failed to create branch:', error);
      throw new Error(
        `Failed to create branch: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  public async updateMergeRequestDescription(
    projectId: number,
    mergeRequestIid: number,
    description: string
  ): Promise<void> {
    try {
      await this.getGitlabClient().MergeRequests.edit(projectId, mergeRequestIid, {
        description,
      });

      logger.info('Updated merge request description', {
        projectId,
        mergeRequestIid,
      });
    } catch (error) {
      logger.error('Failed to update merge request description:', error);
      throw new Error(
        `Failed to update merge request description: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  public async updateMergeRequestTitle(
    projectId: number,
    mergeRequestIid: number,
    title: string
  ): Promise<void> {
    try {
      await this.getGitlabClient().MergeRequests.edit(projectId, mergeRequestIid, {
        title,
      });

      logger.info('Updated merge request title', {
        projectId,
        mergeRequestIid,
        titleLength: title?.length ?? 0,
      });
    } catch (error) {
      logger.error('Failed to update merge request title:', error);
      throw new Error(
        `Failed to update merge request title: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  public async updateIssueDescription(
    projectId: number,
    issueIid: number,
    description: string
  ): Promise<void> {
    try {
      await this.getGitlabClient().Issues.edit(projectId, issueIid, {
        description,
      });

      logger.info('Updated issue description', {
        projectId,
        issueIid,
      });
    } catch (error) {
      logger.error('Failed to update issue description:', error);
      throw new Error(
        `Failed to update issue description: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  public async getIssue(projectId: number, issueIid: number): Promise<any> {
    try {
      const issue = await this.getGitlabClient().Issues.show(projectId, issueIid);
      return issue;
    } catch (error) {
      logger.error('Failed to get issue:', error);
      throw new Error(
        `Failed to get issue: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  public async getMergeRequest(projectId: number, mergeRequestIid: number): Promise<any> {
    try {
      const mergeRequest = await this.getGitlabClient().MergeRequests.show(projectId, mergeRequestIid);
      return mergeRequest;
    } catch (error) {
      logger.error('Failed to get merge request:', error);
      throw new Error(
        `Failed to get merge request: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  public async createMergeRequest(
    projectId: number,
    options: {
      sourceBranch: string;
      targetBranch: string;
      title: string;
      description?: string;
    }
  ): Promise<any> {
    try {
      const mergeRequest = await this.getGitlabClient().MergeRequests.create(
        projectId,
        options.sourceBranch,
        options.targetBranch,
        options.title,
        {
          ...(options.description && { description: options.description }),
        }
      );

      logger.info('Created merge request', {
        projectId,
        sourceBranch: options.sourceBranch,
        targetBranch: options.targetBranch,
        title: options.title,
      });

      return mergeRequest;
    } catch (error) {
      logger.error('Failed to create merge request:', error);
      throw new Error(
        `Failed to create merge request: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  public async getIssueDiscussions(projectId: number, issueIid: number): Promise<any[]> {
    try {
      const discussions = await this.getGitlabClient().IssueDiscussions.all(projectId, issueIid);
      return discussions;
    } catch (error) {
      logger.error('Failed to get issue discussions:', error);
      throw new Error(
        `Failed to get issue discussions: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  public async getMergeRequestDiscussions(
    projectId: number,
    mergeRequestIid: number
  ): Promise<any[]> {
    try {
      const discussions = await this.getGitlabClient().MergeRequestDiscussions.all(projectId, mergeRequestIid);
      return discussions;
    } catch (error) {
      logger.error('Failed to get merge request discussions:', error);
      throw new Error(
        `Failed to get merge request discussions: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  public async findNoteInDiscussions(
    discussions: any[],
    noteId: number
  ): Promise<{ discussion: any; note: any; threadContext: string; discussionId: string } | null> {
    try {
      for (const discussion of discussions) {
        if (discussion.notes && Array.isArray(discussion.notes)) {
          for (const note of discussion.notes) {
            if (note.id === noteId) {
              // Found the note, now build thread context
              const threadContext = this.buildThreadContext(discussion.notes, noteId);
              return {
                discussion,
                note,
                threadContext,
                discussionId: discussion.id,
              };
            }
          }
        }
      }
      return null;
    } catch (error) {
      logger.error('Failed to find note in discussions:', error);
      return null;
    }
  }

  private extractDiscussionNote(discussion: any): any {
    if (!discussion) {
      return null;
    }

    if (discussion.notes && Array.isArray(discussion.notes) && discussion.notes.length > 0) {
      return discussion.notes[discussion.notes.length - 1];
    }

    return discussion;
  }

  private buildThreadContext(notes: any[], currentNoteId: number): string {
    if (!notes || notes.length <= 1) {
      return '';
    }

    // Sort notes by creation time
    const sortedNotes = notes.sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );

    let context = '**Thread Context:**\n\n';
    let hasNotes = false;

    for (const note of sortedNotes) {
      if (note.id === currentNoteId) {
        // Don't include the current note in context, just notes before it
        break;
      }

      const author = note.author?.name || note.author?.username || 'Unknown';
      const timestamp = new Date(note.created_at).toLocaleString();

      context += `**${author}** (${timestamp}):\n`;
      context += `${note.body}\n\n`;
      hasNotes = true;
    }

    return hasNotes ? context.trim() : '';
  }

  public async updateIssueComment(
    projectId: number,
    issueIid: number,
    noteId: number,
    body: string
  ): Promise<any> {
    try {
      const updatedComment = await this.getGitlabClient().IssueNotes.edit(projectId, issueIid, noteId, body);

      logger.info('Updated issue comment', {
        projectId,
        issueIid,
        noteId,
        bodyLength: body.length,
      });

      return updatedComment;
    } catch (error) {
      logger.error('Failed to update issue comment:', error);
      throw new Error(
        `Failed to update issue comment: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  public async updateMergeRequestComment(
    projectId: number,
    mergeRequestIid: number,
    noteId: number,
    body: string
  ): Promise<any> {
    try {
      const updatedComment = await this.getGitlabClient().MergeRequestNotes.edit(
        projectId,
        mergeRequestIid,
        noteId,
        body
      );

      logger.info('Updated merge request comment', {
        projectId,
        mergeRequestIid,
        noteId,
        bodyLength: body.length,
      });

      return updatedComment;
    } catch (error) {
      logger.error('Failed to update merge request comment:', error);
      throw new Error(
        `Failed to update merge request comment: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private buildAuthHeaders(): Record<string, string> {
    const auth = resolveGitLabAuth();
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${auth.token}`,
      'Private-Token': auth.token,
    };
  }

  private buildApiBaseUrl(): string {
    const auth = resolveGitLabAuth();
    return auth.baseUrl.replace(/\/$/, '');
  }

  public async replyToIssueDiscussion(
    projectId: number,
    issueIid: number,
    discussionId: string,
    body: string
  ): Promise<any> {
    try {
      const url = `${this.buildApiBaseUrl()}/api/v4/projects/${encodeURIComponent(
        projectId
      )}/issues/${encodeURIComponent(issueIid)}/discussions/${encodeURIComponent(discussionId)}/notes`;

      const response = await fetch(url, {
        method: 'POST',
        headers: this.buildAuthHeaders(),
        body: JSON.stringify({ body }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Failed to reply to issue discussion: ${response.status} ${response.statusText} - ${errorText}`
        );
      }

      const reply = (await response.json()) as any;

      logger.info('Added reply to issue discussion', {
        projectId,
        issueIid,
        discussionId,
        noteId: reply?.id,
      });

      return reply;
    } catch (error) {
      logger.error('Failed to reply to issue discussion via REST API', error);
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  public async replyToMergeRequestDiscussion(
    projectId: number,
    mergeRequestIid: number,
    discussionId: string,
    body: string
  ): Promise<any> {
    try {
      const url = `${this.buildApiBaseUrl()}/api/v4/projects/${encodeURIComponent(
        projectId
      )}/merge_requests/${encodeURIComponent(
        mergeRequestIid
      )}/discussions/${encodeURIComponent(discussionId)}/notes`;

      const response = await fetch(url, {
        method: 'POST',
        headers: this.buildAuthHeaders(),
        body: JSON.stringify({ body }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Failed to reply to merge request discussion: ${response.status} ${response.statusText} - ${errorText}`
        );
      }

      const reply = (await response.json()) as any;

      logger.info('Added reply to merge request discussion', {
        projectId,
        mergeRequestIid,
        discussionId,
        noteId: reply?.id,
      });

      return reply;
    } catch (error) {
      logger.error('Failed to reply to merge request discussion via REST API', error);
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  public async updateIssueDiscussionNote(
    projectId: number,
    issueIid: number,
    discussionId: string,
    noteId: number,
    body: string
  ): Promise<any> {
    try {
      const discussion = await this.getGitlabClient().IssueDiscussions.editNote(
        projectId,
        issueIid,
        discussionId,
        noteId,
        { body }
      );

      const updatedNote = this.extractDiscussionNote(discussion);

      logger.info('Updated issue discussion note', {
        projectId,
        issueIid,
        discussionId,
        noteId: updatedNote?.id ?? noteId,
      });

      return updatedNote;
    } catch (error) {
      logger.error('Failed to update issue discussion note:', error);
      throw new Error(
        `Failed to update issue discussion note: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  public async updateMergeRequestDiscussionNote(
    projectId: number,
    mergeRequestIid: number,
    discussionId: string,
    noteId: number,
    body: string
  ): Promise<any> {
    try {
      const discussion = await this.getGitlabClient().MergeRequestDiscussions.editNote(
        projectId,
        mergeRequestIid,
        discussionId,
        noteId,
        { body }
      );

      const updatedNote = this.extractDiscussionNote(discussion);

      logger.info('Updated merge request discussion note', {
        projectId,
        mergeRequestIid,
        discussionId,
        noteId: updatedNote?.id ?? noteId,
      });

      return updatedNote;
    } catch (error) {
      logger.error('Failed to update merge request discussion note:', error);
      throw new Error(
        `Failed to update merge request discussion note: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  public async resolveMergeRequestDiscussion(
    projectId: number,
    mergeRequestIid: number,
    discussionId: string
  ): Promise<void> {
    try {
      await this.getGitlabClient().MergeRequestDiscussions.resolve(
        projectId,
        mergeRequestIid,
        discussionId,
        true
      );

      logger.info('Resolved merge request discussion', {
        projectId,
        mergeRequestIid,
        discussionId,
      });
    } catch (error) {
      logger.error('Failed to resolve merge request discussion:', error);
      throw new Error(
        `Failed to resolve merge request discussion: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  public async getMergeRequestDiffs(projectId: number, mergeRequestIid: number): Promise<any[]> {
    try {
      // Use the raw API to get merge request changes since the method might not exist in this version

      // Get the diff by calling the GitLab API directly
      const auth = resolveGitLabAuth();
      logger.info('Fetching merge request diffs', {
        projectId,
        mergeRequestIid,
        baseUrl: auth.baseUrl,
        isTenantToken: auth.isTenantToken,
        tenantUserToken: auth.tenant?.userToken,
      });
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${auth.token}`,
        'Private-Token': auth.token,
      };

      const response = await fetch(
        `${auth.baseUrl}/api/v4/projects/${projectId}/merge_requests/${mergeRequestIid}/changes`,
        {
          headers,
        }
      );

      if (!response.ok) {
        throw new Error(`Failed to fetch MR changes: ${response.status} ${response.statusText}`);
      }

      const changes: any = await response.json();
      const diffs = changes.changes || [];

      logger.info('Retrieved merge request diffs', {
        projectId,
        mergeRequestIid,
        diffsCount: diffs.length,
        filePaths: diffs.map((diff: any) => ({
          oldPath: diff.old_path,
          newPath: diff.new_path,
          isNew: diff.new_file,
          isDeleted: diff.deleted_file,
          isRenamed: diff.renamed_file
        }))
      });

      // Special debug for dao.go file (specific path)
      return diffs;
    } catch (error) {
      logger.error('Failed to get merge request diffs:', error);
      throw new Error(
        `Failed to get merge request diffs: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  public async createInlineComment(
    projectId: number,
    mergeRequestIid: number,
    body: string,
    position: {
      base_sha: string;
      head_sha: string;
      start_sha: string;
      old_path: string;
      new_path: string;
      position_type: 'text';
      old_line?: number;
      new_line?: number;
    }
  ): Promise<any> {
    try {
      const discussion = await this.getGitlabClient().MergeRequestDiscussions.create(
        projectId,
        mergeRequestIid,
        body,
        {
          position,
        }
      );

      logger.info('Created inline comment on merge request', {
        projectId,
        mergeRequestIid,
        bodyLength: body.length,
        filePath: position.new_path,
        line: position.new_line || position.old_line,
        discussionId: discussion?.id,
      });

      return discussion;
    } catch (error) {
      logger.error('Failed to create inline comment:', error);
      throw new Error(
        `Failed to create inline comment: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  public async testConnection(): Promise<boolean> {
    try {
      await this.getGitlabClient().Users.current();
      logger.info('GitLab API connection test successful');
      return true;
    } catch (error) {
      logger.error('GitLab API connection test failed:', error);
      return false;
    }
  }
}
