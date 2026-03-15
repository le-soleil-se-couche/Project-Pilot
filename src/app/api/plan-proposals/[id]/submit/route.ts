import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import { orchestratorManager } from '@/lib/chat-managers/orchestrator-manager';
import { getAppWorkingDir } from '@/lib/app-paths';
import {
  ensureProjectsMigrated,
  getArtifactsPath,
  getFlowIndexPath,
  getPlanProposalsPath,
  modifyJsonFile,
  readArtifacts,
  readPlanProposals,
  readJsonFile,
} from '@/lib/file-store';
import { isValidProjectKey } from '@/lib/security';
import type {
  Artifact,
  ArtifactStatus,
  PlanProposal,
  PlanProposalStatus,
  ProjectArtifacts,
  ProjectIndex,
  ProjectPlanProposals,
} from '@/types';
import type { OrchestratorPhase } from '@/types/orchestrator';

type Params = { params: Promise<{ id: string }> };

const DEFAULT_ARTIFACTS: ProjectArtifacts = { items: [] };
const DEFAULT_PROPOSALS: ProjectPlanProposals = { items: [] };

function mapPhaseToProposalStatus(phase: OrchestratorPhase): PlanProposalStatus {
  if (phase === 'completed') return 'succeeded';
  if (phase === 'failed') return 'failed';
  if (phase === 'executing' || phase === 'synthesizing' || phase === 'merging') return 'running';
  return 'submitted';
}

function mapPhaseToArtifactStatus(phase: OrchestratorPhase): ArtifactStatus {
  if (phase === 'completed') return 'done';
  if (phase === 'failed') return 'failed';
  if (phase === 'executing' || phase === 'synthesizing' || phase === 'merging') return 'running';
  return 'planned';
}

function buildOrchestratorPrompt(proposal: PlanProposal, artifact: Artifact): string {
  return [
    '你是执行协调器，请基于以下提案执行任务。',
    '',
    `Action: ${proposal.action}`,
    `Goal: ${proposal.goal}`,
    '',
    `Artifact Kind: ${artifact.kind}`,
    `Artifact Title: ${artifact.title}`,
    'Artifact Content:',
    artifact.content,
    '',
    proposal.deliverableHints.length > 0
      ? `Deliverable Hints: ${proposal.deliverableHints.join(' | ')}`
      : 'Deliverable Hints: (none)',
    '',
    '请先给出合理拆分计划，再按流程执行。',
  ].join('\n');
}

export async function POST(request: NextRequest, { params }: Params) {
  const { id: proposalId } = await params;
  const projectKey = request.nextUrl.searchParams.get('project');
  if (!projectKey || !isValidProjectKey(projectKey)) {
    return NextResponse.json({ error: 'valid project query parameter is required' }, { status: 400 });
  }
  if (process.env.PP_ENABLE_PLAN_PROPOSAL_SUBMIT === 'false') {
    return NextResponse.json({ error: 'plan proposal submit is disabled by feature flag' }, { status: 403 });
  }

  try {
    const proposalsPath = getPlanProposalsPath(projectKey);
    const artifactsPath = getArtifactsPath(projectKey);

    const proposalsSnapshot = await readPlanProposals(projectKey);
    const proposal = proposalsSnapshot.items.find(item => item.proposalId === proposalId);
    if (!proposal) {
      return NextResponse.json({ error: 'plan proposal not found' }, { status: 404 });
    }

    const artifactsSnapshot = await readArtifacts(projectKey);
    const artifact = artifactsSnapshot.items.find(item => item.id === proposal.artifactId);
    if (!artifact) {
      return NextResponse.json({ error: 'artifact not found for proposal' }, { status: 404 });
    }

    const now = new Date().toISOString();

    if (proposal.orchestratorSessionId && !proposal.orchestratorSessionId.startsWith('starting-')) {
      const runtimeStatus = orchestratorManager.getStatus(proposal.orchestratorSessionId);
      const session = runtimeStatus?.session ?? await orchestratorManager.loadSession(proposal.orchestratorSessionId);

      if (session) {
        const nextProposalStatus = mapPhaseToProposalStatus(session.phase);
        const nextArtifactStatus = mapPhaseToArtifactStatus(session.phase);

        let updatedProposal: PlanProposal | null = null;
        await modifyJsonFile<ProjectPlanProposals>(
          proposalsPath,
          DEFAULT_PROPOSALS,
          (current) => ({
            items: (current.items ?? []).map(item => {
              if (item.proposalId !== proposalId) return item;
              updatedProposal = {
                ...item,
                status: nextProposalStatus,
                lastError: session.errorMessage ?? item.lastError,
                updatedAt: now,
              };
              return updatedProposal;
            }),
          }),
        );

        await modifyJsonFile<ProjectArtifacts>(
          artifactsPath,
          DEFAULT_ARTIFACTS,
          (current) => ({
            items: (current.items ?? []).map(item => (
              item.id === artifact.id
                ? { ...item, status: nextArtifactStatus, updatedAt: now }
                : item
            )),
          }),
        );

        return NextResponse.json({
          proposal: updatedProposal,
          orchestrationId: proposal.orchestratorSessionId,
          phase: session.phase,
          reused: true,
        });
      }
    }

    const lockToken = `starting-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    let shouldStart = false;
    let lockedProposal: PlanProposal | null = null;

    await modifyJsonFile<ProjectPlanProposals>(
      proposalsPath,
      DEFAULT_PROPOSALS,
      (current) => ({
        items: (current.items ?? []).map(item => {
          if (item.proposalId !== proposalId) return item;
          if (item.orchestratorSessionId && !item.orchestratorSessionId.startsWith('starting-')) {
            lockedProposal = item;
            return item;
          }
          shouldStart = true;
          lockedProposal = {
            ...item,
            status: 'submitted',
            orchestratorSessionId: lockToken,
            submittedAt: item.submittedAt ?? now,
            updatedAt: now,
          };
          return lockedProposal;
        }),
      }),
    );

    if (!lockedProposal) {
      return NextResponse.json({ error: 'plan proposal not found' }, { status: 404 });
    }

    if (!shouldStart) {
      const existingLocked = lockedProposal as PlanProposal;
      return NextResponse.json({
        proposal: existingLocked,
        orchestrationId: existingLocked.orchestratorSessionId,
        reused: true,
      });
    }

    await ensureProjectsMigrated();
    const projectIndex = await readJsonFile<ProjectIndex>(getFlowIndexPath(), { projects: [] });
    const project = projectIndex.projects.find(entry => entry.key === projectKey && !entry.archived);
    if (!project) {
      return NextResponse.json({ error: 'project not found' }, { status: 404 });
    }

    let resolvedProjectPath = project.path?.trim();
    let projectPathFallbackApplied = false;

    if (!resolvedProjectPath) {
      resolvedProjectPath = getAppWorkingDir();
      projectPathFallbackApplied = true;

      await modifyJsonFile<ProjectIndex>(
        getFlowIndexPath(),
        { projects: [] },
        (current) => ({
          ...current,
          projects: (current.projects ?? []).map(entry => (
            entry.key === projectKey
              ? { ...entry, path: resolvedProjectPath, updatedAt: now }
              : entry
          )),
        }),
      );
    }

    try {
      await fs.access(resolvedProjectPath);
    } catch {
      return NextResponse.json(
        { error: `project path not found: ${resolvedProjectPath}. open project settings and set project path.` },
        { status: 400 },
      );
    }

    const prompt = buildOrchestratorPrompt(lockedProposal, artifact);
    const orchestrationId = await orchestratorManager.start(projectKey, resolvedProjectPath, prompt);

    let finalizedProposal: PlanProposal | null = null;
    await modifyJsonFile<ProjectPlanProposals>(
      proposalsPath,
      DEFAULT_PROPOSALS,
      (current) => ({
        items: (current.items ?? []).map(item => {
          if (item.proposalId !== proposalId) return item;
          finalizedProposal = {
            ...item,
            status: 'submitted',
            orchestratorSessionId: orchestrationId,
            submittedAt: item.submittedAt ?? now,
            lastError: undefined,
            updatedAt: new Date().toISOString(),
          };
          return finalizedProposal;
        }),
      }),
    );

    await modifyJsonFile<ProjectArtifacts>(
      artifactsPath,
      DEFAULT_ARTIFACTS,
      (current) => ({
        items: (current.items ?? []).map(item => (
          item.id === artifact.id
            ? { ...item, status: 'running', updatedAt: new Date().toISOString() }
            : item
        )),
      }),
    );

    return NextResponse.json({
      proposal: finalizedProposal,
      orchestrationId,
      phase: 'pending',
      reused: false,
      projectPath: resolvedProjectPath,
      projectPathFallbackApplied,
    });
  } catch (error) {
    console.error('[plan-proposals submit POST]', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
