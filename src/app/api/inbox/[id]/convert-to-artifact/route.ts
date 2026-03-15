import { NextRequest, NextResponse } from 'next/server';
import {
  getArtifactsPath,
  getInboxPath,
  modifyJsonFile,
  readArtifacts,
  readInbox,
} from '@/lib/file-store';
import { isValidProjectKey } from '@/lib/security';
import {
  ARTIFACT_INFERENCE_VERSION,
  hashString,
  inferArtifactKind,
  recommendGenes,
} from '@/lib/artifact-inference';
import type { Artifact, InboxItemStatus, ProjectArtifacts, ProjectInbox } from '@/types';

type Params = { params: Promise<{ id: string }> };

function buildArtifactId(): string {
  return `artifact-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

export async function POST(request: NextRequest, { params }: Params) {
  const { id: inboxItemId } = await params;
  const projectKey = request.nextUrl.searchParams.get('project');

  if (!projectKey || !isValidProjectKey(projectKey)) {
    return NextResponse.json({ error: 'valid project query parameter is required' }, { status: 400 });
  }

  try {
    const body = await request.json();
    const archive = body.archive === true;
    const target = body.target as { sectionId?: string; taskId?: string } | undefined;
    const idempotencyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined;

    const inbox = await readInbox(projectKey);
    const item = inbox.items.find(entry => entry.id === inboxItemId);
    if (!item) {
      return NextResponse.json({ error: 'inbox item not found' }, { status: 404 });
    }

    if (item.archivedTo?.artifactId) {
      const currentArtifacts = await readArtifacts(projectKey);
      const linked = currentArtifacts.items.find(entry => entry.id === item.archivedTo?.artifactId);
      if (linked) {
        return NextResponse.json({
          artifact: linked,
          inboxStatus: item.status,
          recommendation: undefined,
        });
      }
    }

    const sourceSnapshot = item.content.trim();
    const sourceHash = hashString(sourceSnapshot);
    const dedupeKey = idempotencyKey ?? `inbox:${inboxItemId}:${sourceHash}`;
    const inference = inferArtifactKind(sourceSnapshot);

    const now = new Date().toISOString();
    let createdOrExisting: Artifact | null = null;

    const artifacts = await modifyJsonFile<ProjectArtifacts>(
      getArtifactsPath(projectKey),
      { items: [] },
      (current) => {
        const items = current.items ?? [];
        const existing = items.find(entry =>
          entry.dedupeKey === dedupeKey
          || (entry.sourceInboxId === inboxItemId && entry.sourceHash === sourceHash),
        );

        if (existing) {
          createdOrExisting = existing;
          return current;
        }

        const artifact: Artifact = {
          id: buildArtifactId(),
          kind: inference.kind,
          title: sourceSnapshot.length > 48 ? `${sourceSnapshot.slice(0, 48)}...` : sourceSnapshot,
          content: sourceSnapshot,
          status: 'draft',
          schemaVersion: 1,
          projectKey,
          createdAt: now,
          updatedAt: now,
          provenance: {
            sourceType: 'inbox',
            sourceId: inboxItemId,
            createdBy: 'ai',
          },
          sourceInboxId: inboxItemId,
          sourceSnapshot,
          inferenceVersion: ARTIFACT_INFERENCE_VERSION,
          sourceHash,
          dedupeKey,
          sectionId: target?.sectionId,
          taskId: target?.taskId,
          gene: inference.kind === 'gene'
            ? {
                category: 'pattern',
                matchRules: {
                  contextKeywords: inference.signals,
                  taskPatterns: [],
                },
                strategy: sourceSnapshot,
                usageCount: 0,
              }
            : undefined,
        };

        createdOrExisting = artifact;
        return { items: [artifact, ...items] };
      },
    );

    if (!createdOrExisting) {
      return NextResponse.json({ error: 'failed to create artifact' }, { status: 500 });
    }

    const recommended = recommendGenes(
      sourceSnapshot,
      artifacts.items.filter(entry => entry.id !== createdOrExisting?.id),
      3,
    );

    const nextInboxStatus: InboxItemStatus = archive ? 'archived' : 'converted';

    try {
      let inboxUpdated = false;

      await modifyJsonFile<ProjectInbox>(
        getInboxPath(projectKey),
        { items: [] },
        (current) => {
          const nextItems = (current.items ?? []).map(entry => {
            if (entry.id !== inboxItemId) return entry;
            inboxUpdated = true;
            return {
              ...entry,
              status: nextInboxStatus,
              archivedTo: {
                sectionId: target?.sectionId,
                taskId: target?.taskId,
                artifactId: createdOrExisting?.id,
              },
              conversionAttemptAt: now,
              lastError: undefined,
              updatedAt: now,
            };
          });
          return { items: nextItems };
        },
      );

      if (!inboxUpdated) {
        throw new Error('inbox item disappeared while converting');
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown inbox update error';
      await modifyJsonFile<ProjectInbox>(
        getInboxPath(projectKey),
        { items: [] },
        (current) => ({
          items: (current.items ?? []).map(entry => (
            entry.id === inboxItemId
              ? {
                  ...entry,
                  status: 'conversion_failed',
                  conversionAttemptAt: now,
                  lastError: reason,
                  updatedAt: now,
                }
              : entry
          )),
        }),
      );

      return NextResponse.json(
        {
          error: 'artifact created but inbox update failed',
          artifact: createdOrExisting,
          inboxStatus: 'conversion_failed',
        },
        { status: 500 },
      );
    }

    return NextResponse.json({
      artifact: createdOrExisting,
      inboxStatus: nextInboxStatus,
      recommendation: recommended.length > 0
        ? {
            top1: recommended[0],
            top3: recommended,
          }
        : undefined,
    });
  } catch (error) {
    console.error('[convert-to-artifact POST]', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
