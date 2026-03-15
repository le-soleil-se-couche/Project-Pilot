import { NextRequest, NextResponse } from 'next/server';
import { modifyJsonFile, readArtifacts } from '@/lib/file-store';
import { isValidProjectKey } from '@/lib/security';
import type { Artifact, ArtifactKind, ArtifactStatus, ProjectArtifacts } from '@/types';
import { getArtifactsPath } from '@/lib/file-store';

const DEFAULT_ARTIFACTS: ProjectArtifacts = { items: [] };

function getProjectKey(request: NextRequest): string | null {
  const key = request.nextUrl.searchParams.get('project');
  if (!key || !isValidProjectKey(key)) return null;
  return key;
}

function generateArtifactId(): string {
  return `artifact-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function isArtifactKind(value: unknown): value is ArtifactKind {
  return value === 'idea' || value === 'decision' || value === 'hypothesis' || value === 'gene';
}

function isArtifactStatus(value: unknown): value is ArtifactStatus {
  return value === 'draft' || value === 'confirmed' || value === 'planned' || value === 'running' || value === 'done' || value === 'failed' || value === 'abandoned';
}

export async function GET(request: NextRequest) {
  try {
    const projectKey = getProjectKey(request);
    if (!projectKey) {
      return NextResponse.json({ error: 'valid project query parameter is required' }, { status: 400 });
    }

    const result = await readArtifacts(projectKey);

    return NextResponse.json(result);
  } catch (error) {
    console.error('[artifacts GET]', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const projectKey = getProjectKey(request);
    if (!projectKey) {
      return NextResponse.json({ error: 'valid project query parameter is required' }, { status: 400 });
    }

    const body = await request.json();
    const kind = body.kind as unknown;
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const content = typeof body.content === 'string' ? body.content.trim() : '';
    const status = body.status as unknown;

    if (!isArtifactKind(kind)) {
      return NextResponse.json({ error: 'invalid kind' }, { status: 400 });
    }
    if (!title) {
      return NextResponse.json({ error: 'title is required' }, { status: 400 });
    }
    if (!content) {
      return NextResponse.json({ error: 'content is required' }, { status: 400 });
    }
    if (status !== undefined && !isArtifactStatus(status)) {
      return NextResponse.json({ error: 'invalid status' }, { status: 400 });
    }

    const now = new Date().toISOString();
    const artifact: Artifact = {
      id: generateArtifactId(),
      kind,
      title,
      content,
      status: isArtifactStatus(status) ? status : 'draft',
      schemaVersion: typeof body.schemaVersion === 'number' ? body.schemaVersion : 1,
      projectKey,
      createdAt: now,
      updatedAt: now,
      provenance: body.provenance ?? {
        sourceType: 'manual',
        sourceId: 'manual',
        createdBy: 'user',
      },
      sourceInboxId: typeof body.sourceInboxId === 'string' ? body.sourceInboxId : undefined,
      sourceSnapshot: typeof body.sourceSnapshot === 'string' ? body.sourceSnapshot : undefined,
      inferenceVersion: typeof body.inferenceVersion === 'string' ? body.inferenceVersion : undefined,
      sourceHash: typeof body.sourceHash === 'string' ? body.sourceHash : undefined,
      dedupeKey: typeof body.dedupeKey === 'string' ? body.dedupeKey : undefined,
      sectionId: typeof body.sectionId === 'string' ? body.sectionId : undefined,
      taskId: typeof body.taskId === 'string' ? body.taskId : undefined,
      gene: kind === 'gene' ? body.gene : undefined,
    };

    await modifyJsonFile<ProjectArtifacts>(
      getArtifactsPath(projectKey),
      DEFAULT_ARTIFACTS,
      (current) => ({ items: [artifact, ...(current.items ?? [])] }),
    );

    return NextResponse.json({ artifact }, { status: 201 });
  } catch (error) {
    console.error('[artifacts POST]', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const projectKey = getProjectKey(request);
    if (!projectKey) {
      return NextResponse.json({ error: 'valid project query parameter is required' }, { status: 400 });
    }

    const body = await request.json();
    const artifactId = typeof body.id === 'string' ? body.id : '';
    if (!artifactId) {
      return NextResponse.json({ error: 'id is required' }, { status: 400 });
    }

    let updatedArtifact: Artifact | null = null;

    const updated = await modifyJsonFile<ProjectArtifacts>(
      getArtifactsPath(projectKey),
      DEFAULT_ARTIFACTS,
      (current) => {
        const items = current.items ?? [];
        const idx = items.findIndex(item => item.id === artifactId);
        if (idx === -1) return current;

        const existing = items[idx];
        const next: Artifact = {
          ...existing,
          ...(isArtifactKind(body.kind) ? { kind: body.kind } : {}),
          ...(typeof body.title === 'string' ? { title: body.title.trim() } : {}),
          ...(typeof body.content === 'string' ? { content: body.content } : {}),
          ...(isArtifactStatus(body.status) ? { status: body.status } : {}),
          ...(typeof body.sectionId === 'string' || body.sectionId === null ? { sectionId: body.sectionId ?? undefined } : {}),
          ...(typeof body.taskId === 'string' || body.taskId === null ? { taskId: body.taskId ?? undefined } : {}),
          ...(typeof body.dedupeKey === 'string' || body.dedupeKey === null ? { dedupeKey: body.dedupeKey ?? undefined } : {}),
          ...(typeof body.sourceSnapshot === 'string' || body.sourceSnapshot === null ? { sourceSnapshot: body.sourceSnapshot ?? undefined } : {}),
          ...(typeof body.inferenceVersion === 'string' || body.inferenceVersion === null ? { inferenceVersion: body.inferenceVersion ?? undefined } : {}),
          ...(typeof body.sourceHash === 'string' || body.sourceHash === null ? { sourceHash: body.sourceHash ?? undefined } : {}),
          ...(body.gene !== undefined ? { gene: body.gene } : {}),
          updatedAt: new Date().toISOString(),
        };

        updatedArtifact = next;
        const cloned = [...items];
        cloned[idx] = next;
        return { items: cloned };
      },
    );

    if (!updatedArtifact) {
      return NextResponse.json({ error: 'artifact not found' }, { status: 404 });
    }

    return NextResponse.json({ artifact: updatedArtifact, total: updated.items.length });
  } catch (error) {
    console.error('[artifacts PATCH]', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
