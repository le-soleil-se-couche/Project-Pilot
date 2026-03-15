import { NextRequest, NextResponse } from 'next/server';
import { getArtifactsPath, getPlanProposalsPath, modifyJsonFile, readArtifacts } from '@/lib/file-store';
import { isValidProjectKey } from '@/lib/security';
import type { Artifact, ProjectArtifacts, PlanProposal, ProjectPlanProposals } from '@/types';

type Params = { params: Promise<{ id: string }> };

const DEFAULT_ARTIFACTS: ProjectArtifacts = { items: [] };
const DEFAULT_PROPOSALS: ProjectPlanProposals = { items: [] };

function generateProposalId(): string {
  return `proposal-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function defaultAction(kind: Artifact['kind']): string {
  switch (kind) {
    case 'decision':
      return '基于该决策推进执行并完成落地';
    case 'hypothesis':
      return '围绕该假设制定验证方案并执行';
    case 'gene':
      return '应用该经验模板到当前项目并验证效果';
    default:
      return '将该灵感转化为可执行计划并落地';
  }
}

export async function POST(request: NextRequest, { params }: Params) {
  const { id: artifactId } = await params;
  const projectKey = request.nextUrl.searchParams.get('project');
  if (!projectKey || !isValidProjectKey(projectKey)) {
    return NextResponse.json({ error: 'valid project query parameter is required' }, { status: 400 });
  }

  try {
    const body = await request.json();
    const action = typeof body.action === 'string' ? body.action.trim() : undefined;
    const goal = typeof body.goal === 'string' ? body.goal.trim() : undefined;
    const idempotencyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined;
    const deliverableHints = Array.isArray(body.deliverableHints)
      ? body.deliverableHints.filter((hint: unknown): hint is string => typeof hint === 'string' && hint.trim().length > 0)
      : [];

    const artifacts = await readArtifacts(projectKey);

    const artifact = artifacts.items.find(item => item.id === artifactId);
    if (!artifact) {
      return NextResponse.json({ error: 'artifact not found' }, { status: 404 });
    }

    const now = new Date().toISOString();
    let proposalResult: PlanProposal | null = null;
    let created = false;

    await modifyJsonFile<ProjectPlanProposals>(
      getPlanProposalsPath(projectKey),
      DEFAULT_PROPOSALS,
      (current) => {
        const items = current.items ?? [];
        if (idempotencyKey) {
          const existing = items.find(item => item.artifactId === artifactId && item.idempotencyKey === idempotencyKey);
          if (existing) {
            proposalResult = existing;
            return current;
          }
        }

        const proposal: PlanProposal = {
          proposalId: generateProposalId(),
          artifactId,
          projectKey,
          action: action || defaultAction(artifact.kind),
          goal: goal || artifact.title,
          deliverableHints: deliverableHints.length > 0 ? deliverableHints : [artifact.title],
          sourceContext: {
            sourceType: artifact.provenance.sourceType,
            sourceId: artifact.provenance.sourceId,
            sourceInboxId: artifact.sourceInboxId,
            sourceSnapshot: artifact.sourceSnapshot,
            target: {
              sectionId: artifact.sectionId,
              taskId: artifact.taskId,
            },
          },
          status: 'idle',
          idempotencyKey,
          createdAt: now,
          updatedAt: now,
        };

        proposalResult = proposal;
        created = true;
        return { items: [proposal, ...items] };
      },
    );

    if (!proposalResult) {
      return NextResponse.json({ error: 'failed to create plan proposal' }, { status: 500 });
    }

    if (created) {
      await modifyJsonFile<ProjectArtifacts>(
        getArtifactsPath(projectKey),
        DEFAULT_ARTIFACTS,
        (current) => ({
          items: (current.items ?? []).map(item => (
            item.id === artifactId
              ? {
                  ...item,
                  status: item.status === 'draft' || item.status === 'confirmed' ? 'planned' : item.status,
                  updatedAt: now,
                }
              : item
          )),
        }),
      );
    }

    return NextResponse.json({ proposal: proposalResult, created });
  } catch (error) {
    console.error('[plan-proposals POST]', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
