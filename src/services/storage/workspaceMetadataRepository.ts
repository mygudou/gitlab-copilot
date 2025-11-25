import type { Collection } from 'mongodb';
import { getMongoDb } from './mongoClient';
import { config } from '../../utils/config';
import logger from '../../utils/logger';

export interface WorkspaceMetadataRecord {
  workspaceId: string;
  projectId?: number;
  projectName?: string;
  baseBranch?: string;
  checkoutBranch?: string;
  branch?: string;
  path?: string;
  createdAt: Date;
  lastUsed: Date;
  updatedAt: Date;
}

type WorkspaceMetadataUpsert = {
  workspaceId: string;
  projectId?: number;
  projectName?: string;
  baseBranch?: string;
  checkoutBranch?: string;
  branch?: string;
  path?: string;
  lastUsed?: Date;
  createdAt?: Date;
};

const COLLECTION_NAME = 'workspaces';

async function getWorkspacesCollection(): Promise<Collection<WorkspaceMetadataRecord>> {
  const db = await getMongoDb();
  return db.collection<WorkspaceMetadataRecord>(COLLECTION_NAME);
}

export async function upsertWorkspaceMetadata(metadata: WorkspaceMetadataUpsert): Promise<void> {
  if (!config.platform.hasMongoCredentials) {
    return;
  }

  try {
    const collection = await getWorkspacesCollection();
    const now = new Date();
    const lastUsed = metadata.lastUsed ?? now;
    const createdAt = metadata.createdAt ?? now;

    await collection.updateOne(
      { workspaceId: metadata.workspaceId },
      {
        $set: {
          projectId: metadata.projectId,
          projectName: metadata.projectName,
          baseBranch: metadata.baseBranch,
          checkoutBranch: metadata.checkoutBranch,
          branch: metadata.branch,
          path: metadata.path,
          lastUsed,
          updatedAt: now,
        },
        $setOnInsert: {
          createdAt,
        },
      },
      { upsert: true }
    );
  } catch (error) {
    logger.warn('Failed to upsert workspace metadata', {
      workspaceId: metadata.workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function getWorkspaceMetadata(workspaceId: string): Promise<WorkspaceMetadataRecord | null> {
  if (!config.platform.hasMongoCredentials) {
    return null;
  }

  try {
    const collection = await getWorkspacesCollection();
    return await collection.findOne({ workspaceId });
  } catch (error) {
    logger.warn('Failed to fetch workspace metadata', {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function removeWorkspaceMetadata(workspaceId: string): Promise<void> {
  if (!config.platform.hasMongoCredentials) {
    return;
  }

  try {
    const collection = await getWorkspacesCollection();
    await collection.deleteOne({ workspaceId });
  } catch (error) {
    logger.warn('Failed to remove workspace metadata', {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function findWorkspacesUnusedSince(cutoff: Date): Promise<WorkspaceMetadataRecord[]> {
  if (!config.platform.hasMongoCredentials) {
    return [];
  }

  try {
    const collection = await getWorkspacesCollection();
    const cursor = collection.find({
      lastUsed: { $lt: cutoff },
    });
    return await cursor.toArray();
  } catch (error) {
    logger.warn('Failed to query stale workspaces', {
      cutoff,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}
