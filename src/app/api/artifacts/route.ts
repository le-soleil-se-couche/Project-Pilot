import { NextRequest, NextResponse } from 'next/server';
import { modifyJsonFile, readArtifacts } from '@/lib/file-store';
import { isValidProjectKey } from '@/lib/security';
import type {
  Artifact,
  ArtifactGeneData,
  ArtifactKind,
  ArtifactProvenance,
  ArtifactStatus,
  ProjectArtifacts,
} from '@/types';
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const values = value.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean);
  return values.length === value.length ? values : null;
}

function parseProvenance(value: unknown): ArtifactProvenance | null {
  if (!isPlainObject(value)) return null;

  const sourceType = value.sourceType;
  const sourceId = value.sourceId;
  const createdBy = value.createdBy;
  const derivedFromArtifactId = value.derivedFromArtifactId;

  const validSourceType = sourceType === 'inbox'
    || sourceType === 'chat'
    || sourceType === 'manual'
    || sourceType === 'flow'
    || sourceType === 'artifact';

  if (!validSourceType) return null;
  if (typeof sourceId !== 'string' || !sourceId.trim()) return null;
  if (createdBy !== 'user' && createdBy !== 'ai') return null;
  if (derivedFromArtifactId !== undefined && typeof derivedFromArtifactId !== 'string') return null;

  return {
    sourceType,
    sourceId: sourceId.trim(),
    createdBy,
    ...(typeof derivedFromArtifactId === 'string' && derivedFromArtifactId.trim()
      ? { derivedFromArtifactId: derivedFromArtifactId.trim() }
      : {}),
  };
}

function parseGene(value: unknown): ArtifactGeneData | null {
  if (!isPlainObject(value)) return null;

  const category = value.category;
  if (category !== 'repair' && category !== 'optimize' && category !== 'pattern') {
    return null;
  }

  const matchRules = value.matchRules;
  if (!isPlainObject(matchRules)) return null;

  const contextKeywords = parseStringArray(matchRules.contextKeywords);
  const taskPatterns = parseStringArray(matchRules.taskPatterns);
  if (!contextKeywords || !taskPatterns) return null;

  const strategy = value.strategy;
  if (typeof strategy !== 'string' || !strategy.trim()) return null;

  const usageCount = value.usageCount;
  if (typeof usageCount !== 'number' || !Number.isFinite(usageCount) || usageCount < 0) return null;

  return {
    category,
    matchRules: {
      contextKeywords,
      taskPatterns,
    },
    strategy: strategy.trim(),
    usageCount,
  };
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

    const body = await request.json().catch(() => ({}));
    const kind = body.kind as unknown;
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const content = typeof body.content === 'string' ? body.content.trim() : '';
    const status = body.status as unknown;
    const parsedProvenance = body.provenance === undefined ? null : parseProvenance(body.provenance);
    const parsedGene = body.gene === undefined ? undefined : parseGene(body.gene);

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
    if (body.provenance !== undefined && !parsedProvenance) {
      return NextResponse.json({ error: 'invalid provenance' }, { status: 400 });
    }
    if (kind === 'gene' && !parsedGene) {
      return NextResponse.json({ error: 'gene payload is required when kind is gene' }, { status: 400 });
    }
    if (kind !== 'gene' && body.gene !== undefined) {
      return NextResponse.json({ error: 'gene payload is only allowed when kind is gene' }, { status: 400 });
    }

    const now = new Date().toISOString();
    const genePayload: ArtifactGeneData | undefined = kind === 'gene' ? (parsedGene as ArtifactGeneData) : undefined;
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
      provenance: parsedProvenance ?? {
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
      gene: genePayload,
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

    const body = await request.json().catch(() => ({}));
    const artifactId = typeof body.id === 'string' ? body.id : '';
    if (!artifactId) {
      return NextResponse.json({ error: 'id is required' }, { status: 400 });
    }
    const requestedKind = isArtifactKind(body.kind) ? body.kind : undefined;
    const parsedProvenance = body.provenance === undefined ? undefined : parseProvenance(body.provenance);
    const parsedGene = body.gene === undefined ? undefined : parseGene(body.gene);

    if (body.provenance !== undefined && !parsedProvenance) {
      return NextResponse.json({ error: 'invalid provenance' }, { status: 400 });
    }
    if (body.gene !== undefined && !parsedGene) {
      return NextResponse.json({ error: 'invalid gene payload' }, { status: 400 });
    }

    const current = await readArtifacts(projectKey);
    const existing = current.items.find(item => item.id === artifactId);
    if (!existing) {
      return NextResponse.json({ error: 'artifact not found' }, { status: 404 });
    }

    const nextKind = requestedKind ?? existing.kind;
    if (body.gene !== undefined && nextKind !== 'gene') {
      return NextResponse.json({ error: 'gene payload is only allowed when resulting kind is gene' }, { status: 400 });
    }

    let nextGene = nextKind === 'gene' ? existing.gene : undefined;
    if (nextKind === 'gene' && parsedGene) {
      nextGene = parsedGene;
    }
    if (nextKind === 'gene' && !nextGene) {
      return NextResponse.json({ error: 'gene payload is required when resulting kind is gene' }, { status: 400 });
    }

    let updatedArtifact: Artifact | null = null;
    const updated = await modifyJsonFile<ProjectArtifacts>(
      getArtifactsPath(projectKey),
      DEFAULT_ARTIFACTS,
      (snapshot) => ({
        items: (snapshot.items ?? []).map(item => {
          if (item.id !== artifactId) return item;

          updatedArtifact = {
            ...item,
            ...(requestedKind ? { kind: requestedKind } : {}),
            ...(typeof body.title === 'string' ? { title: body.title.trim() } : {}),
            ...(typeof body.content === 'string' ? { content: body.content } : {}),
            ...(isArtifactStatus(body.status) ? { status: body.status } : {}),
            ...(parsedProvenance ? { provenance: parsedProvenance } : {}),
            ...(typeof body.sectionId === 'string' || body.sectionId === null ? { sectionId: body.sectionId ?? undefined } : {}),
            ...(typeof body.taskId === 'string' || body.taskId === null ? { taskId: body.taskId ?? undefined } : {}),
            ...(typeof body.dedupeKey === 'string' || body.dedupeKey === null ? { dedupeKey: body.dedupeKey ?? undefined } : {}),
            ...(typeof body.sourceSnapshot === 'string' || body.sourceSnapshot === null ? { sourceSnapshot: body.sourceSnapshot ?? undefined } : {}),
            ...(typeof body.inferenceVersion === 'string' || body.inferenceVersion === null ? { inferenceVersion: body.inferenceVersion ?? undefined } : {}),
            ...(typeof body.sourceHash === 'string' || body.sourceHash === null ? { sourceHash: body.sourceHash ?? undefined } : {}),
            gene: nextKind === 'gene' ? nextGene : undefined,
            updatedAt: new Date().toISOString(),
          };

          return updatedArtifact;
        }),
      }),
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
