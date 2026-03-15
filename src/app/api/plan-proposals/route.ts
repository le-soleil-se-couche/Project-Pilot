import { NextRequest, NextResponse } from 'next/server';
import { readPlanProposals } from '@/lib/file-store';
import { isValidProjectKey } from '@/lib/security';
import type { PlanProposal } from '@/types';

function sortByUpdatedDesc(items: PlanProposal[]): PlanProposal[] {
  return [...items].sort((a, b) => {
    const at = new Date(a.updatedAt).getTime();
    const bt = new Date(b.updatedAt).getTime();
    return bt - at;
  });
}

export async function GET(request: NextRequest) {
  try {
    const projectKey = request.nextUrl.searchParams.get('project');
    if (!projectKey || !isValidProjectKey(projectKey)) {
      return NextResponse.json({ error: 'valid project query parameter is required' }, { status: 400 });
    }

    const artifactId = request.nextUrl.searchParams.get('artifactId');
    const proposals = await readPlanProposals(projectKey);
    const items = sortByUpdatedDesc(proposals.items ?? []);
    const filtered = artifactId ? items.filter(item => item.artifactId === artifactId) : items;

    const latestByArtifact: Record<string, PlanProposal> = {};
    for (const item of filtered) {
      if (!latestByArtifact[item.artifactId]) {
        latestByArtifact[item.artifactId] = item;
      }
    }

    return NextResponse.json({
      items: filtered,
      latestByArtifact,
    });
  } catch (error) {
    console.error('[plan-proposals GET]', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
