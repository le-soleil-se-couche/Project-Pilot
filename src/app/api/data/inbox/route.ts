import { NextRequest, NextResponse } from 'next/server';
import { readInbox, writeInbox } from '@/lib/file-store';
import type { InboxItem, InboxItemStatus } from '@/types';

/** Sanitize project key — only allow safe characters */
function sanitizeKey(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, '');
}

/** Extract and validate the project key from query params */
function getProjectKey(request: NextRequest): string | null {
  const raw = request.nextUrl.searchParams.get('project');
  if (!raw) return null;
  const safe = sanitizeKey(raw);
  return safe || null;
}

/** Generate inbox item ID: inbox-{timestamp}-{random4} */
function generateInboxId(): string {
  return `inbox-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function normalizeInboxStatus(status: unknown): InboxItemStatus | null {
  if (status === 'inbox') return 'open';
  if (status === 'open' || status === 'inferred' || status === 'converted' || status === 'archived' || status === 'conversion_failed') {
    return status;
  }
  return null;
}

/**
 * GET /api/data/inbox?project={key}
 * 返回该项目的收件箱数据
 */
export async function GET(request: NextRequest) {
  try {
    const projectKey = getProjectKey(request);
    if (!projectKey) {
      return NextResponse.json({ error: 'project query parameter is required' }, { status: 400 });
    }

    const inbox = await readInbox(projectKey);
    return NextResponse.json(inbox);
  } catch (error) {
    console.error('[inbox GET]', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}

/**
 * POST /api/data/inbox?project={key}
 * Body: { content: string }
 * 创建新的 inbox item
 */
export async function POST(request: NextRequest) {
  try {
    const projectKey = getProjectKey(request);
    if (!projectKey) {
      return NextResponse.json({ error: 'project query parameter is required' }, { status: 400 });
    }

    const body = await request.json();
    const { content, source, sourceSessionId } = body;
    if (!content || typeof content !== 'string') {
      return NextResponse.json({ error: 'content is required and must be a string' }, { status: 400 });
    }

    const now = new Date().toISOString();
    const item: InboxItem = {
      id: generateInboxId(),
      content: content.trim(),
      createdAt: now,
      updatedAt: now,
      status: 'open',
      source: source === 'chat' || source === 'flow' || source === 'agent' ? source : 'manual',
      sourceSessionId: typeof sourceSessionId === 'string' ? sourceSessionId : undefined,
    };

    const inbox = await readInbox(projectKey);
    inbox.items.push(item);
    await writeInbox(projectKey, inbox);

    return NextResponse.json(item, { status: 201 });
  } catch (error) {
    console.error('[inbox POST]', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}

/**
 * PATCH /api/data/inbox?project={key}
 * Body: { id: string, content?: string, status?: InboxItemStatus, archivedTo?: { sectionId?, taskId?, artifactId? } }
 * 更新指定 item
 */
export async function PATCH(request: NextRequest) {
  try {
    const projectKey = getProjectKey(request);
    if (!projectKey) {
      return NextResponse.json({ error: 'project query parameter is required' }, { status: 400 });
    }

    const body = await request.json();
    const { id, content, status, archivedTo, lastError, conversionAttemptAt } = body;
    if (!id || typeof id !== 'string') {
      return NextResponse.json({ error: 'id is required' }, { status: 400 });
    }

    const inbox = await readInbox(projectKey);
    const item = inbox.items.find(i => i.id === id);
    if (!item) {
      return NextResponse.json({ error: 'item not found' }, { status: 404 });
    }

    if (content !== undefined) item.content = String(content);
    if (status !== undefined) {
      const normalizedStatus = normalizeInboxStatus(status);
      if (!normalizedStatus) {
        return NextResponse.json({ error: 'invalid status' }, { status: 400 });
      }
      item.status = normalizedStatus;
    }
    if (archivedTo !== undefined) item.archivedTo = archivedTo;
    if (lastError !== undefined) item.lastError = typeof lastError === 'string' ? lastError : undefined;
    if (conversionAttemptAt !== undefined) {
      item.conversionAttemptAt = typeof conversionAttemptAt === 'string' ? conversionAttemptAt : undefined;
    }
    item.updatedAt = new Date().toISOString();

    await writeInbox(projectKey, inbox);
    return NextResponse.json(item);
  } catch (error) {
    console.error('[inbox PATCH]', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/data/inbox?project={key}&id={itemId}
 * 删除指定 item
 */
export async function DELETE(request: NextRequest) {
  try {
    const projectKey = getProjectKey(request);
    if (!projectKey) {
      return NextResponse.json({ error: 'project query parameter is required' }, { status: 400 });
    }

    const itemId = request.nextUrl.searchParams.get('id');
    if (!itemId) {
      return NextResponse.json({ error: 'id query parameter is required' }, { status: 400 });
    }

    const inbox = await readInbox(projectKey);
    const idx = inbox.items.findIndex(i => i.id === itemId);
    if (idx === -1) {
      return NextResponse.json({ error: 'item not found' }, { status: 404 });
    }

    inbox.items.splice(idx, 1);
    await writeInbox(projectKey, inbox);

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[inbox DELETE]', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
