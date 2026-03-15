'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Boxes, Pencil, Save, RefreshCw, Plus, Play, Link2 } from 'lucide-react';
import type { Artifact, ArtifactKind, ArtifactStatus } from '@/types';

interface ArtifactPanelProps {
  projectKey: string;
}

interface ProposalRef {
  proposalId: string;
  status: string;
  orchestrationId?: string;
}

const KIND_OPTIONS: ArtifactKind[] = ['idea', 'decision', 'hypothesis', 'gene'];
const STATUS_OPTIONS: ArtifactStatus[] = ['draft', 'confirmed', 'planned', 'running', 'done', 'failed', 'abandoned'];

function kindBadgeClass(kind: ArtifactKind): string {
  switch (kind) {
    case 'decision':
      return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300';
    case 'hypothesis':
      return 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300';
    case 'gene':
      return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300';
    default:
      return 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300';
  }
}

function buildProposalIdempotencyKey(artifact: Artifact): string {
  return `proposal:${artifact.id}:${artifact.updatedAt}:${artifact.sourceHash ?? 'nohash'}`;
}

export function ArtifactPanel({ projectKey }: ArtifactPanelProps) {
  const [items, setItems] = useState<Artifact[]>([]);
  const [loading, setLoading] = useState(true);
  const [kindFilter, setKindFilter] = useState<'all' | ArtifactKind>('all');
  const [message, setMessage] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftContent, setDraftContent] = useState('');
  const [draftStatus, setDraftStatus] = useState<ArtifactStatus>('draft');
  const [newKind, setNewKind] = useState<ArtifactKind>('idea');
  const [newTitle, setNewTitle] = useState('');
  const [newContent, setNewContent] = useState('');
  const [proposalByArtifact, setProposalByArtifact] = useState<Record<string, ProposalRef>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const fetchArtifacts = useCallback(async () => {
    setLoading(true);
    try {
      const [artifactRes, proposalRes] = await Promise.all([
        fetch(`/api/artifacts?project=${encodeURIComponent(projectKey)}`),
        fetch(`/api/plan-proposals?project=${encodeURIComponent(projectKey)}`),
      ]);

      if (!artifactRes.ok) throw new Error('加载 Artifact 失败');

      const artifactData = await artifactRes.json().catch(() => ({}));
      setItems((artifactData.items ?? []) as Artifact[]);

      if (proposalRes.ok) {
        const proposalData = await proposalRes.json().catch(() => ({}));
        const latest = (proposalData.latestByArtifact ?? {}) as Record<string, {
          proposalId: string;
          status: string;
          orchestratorSessionId?: string;
        }>;

        const mapped: Record<string, ProposalRef> = {};
        for (const [artifactId, proposal] of Object.entries(latest)) {
          mapped[artifactId] = {
            proposalId: proposal.proposalId,
            status: proposal.status,
            orchestrationId: proposal.orchestratorSessionId,
          };
        }

        setProposalByArtifact(mapped);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '加载 Artifact 失败');
    } finally {
      setLoading(false);
    }
  }, [projectKey]);

  useEffect(() => {
    setLoading(true);
    fetchArtifacts();
  }, [fetchArtifacts]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ projectKey?: string }>).detail;
      if (!detail?.projectKey || detail.projectKey === projectKey) {
        void fetchArtifacts();
      }
    };

    window.addEventListener('pp:artifacts-changed', handler);
    return () => window.removeEventListener('pp:artifacts-changed', handler);
  }, [fetchArtifacts, projectKey]);

  const filtered = useMemo(() => {
    if (kindFilter === 'all') return items;
    return items.filter(item => item.kind === kindFilter);
  }, [items, kindFilter]);

  const handleCreate = useCallback(async () => {
    if (!newTitle.trim() || !newContent.trim()) return;
    try {
      const res = await fetch(`/api/artifacts?project=${encodeURIComponent(projectKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: newKind,
          title: newTitle.trim(),
          content: newContent.trim(),
          status: 'draft',
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '创建失败');
      setNewTitle('');
      setNewContent('');
      setMessage('Artifact 已创建');
      await fetchArtifacts();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '创建失败');
    }
  }, [fetchArtifacts, newContent, newKind, newTitle, projectKey]);

  const startEdit = useCallback((item: Artifact) => {
    setEditingId(item.id);
    setDraftTitle(item.title);
    setDraftContent(item.content);
    setDraftStatus(item.status);
  }, []);

  const saveEdit = useCallback(async () => {
    if (!editingId) return;
    try {
      const res = await fetch(`/api/artifacts?project=${encodeURIComponent(projectKey)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: editingId,
          title: draftTitle.trim(),
          content: draftContent,
          status: draftStatus,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '保存失败');
      setEditingId(null);
      setMessage('Artifact 已更新');
      await fetchArtifacts();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '保存失败');
    }
  }, [draftContent, draftStatus, draftTitle, editingId, fetchArtifacts, projectKey]);

  const handleGenerateProposal = useCallback(async (artifact: Artifact) => {
    setBusyId(artifact.id);
    try {
      const idempotencyKey = buildProposalIdempotencyKey(artifact);
      const res = await fetch(
        `/api/artifacts/${encodeURIComponent(artifact.id)}/plan-proposals?project=${encodeURIComponent(projectKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idempotencyKey }),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '生成提案失败');
      const proposal = data.proposal as { proposalId: string; status: string };
      setProposalByArtifact(prev => ({
        ...prev,
        [artifact.id]: {
          proposalId: proposal.proposalId,
          status: proposal.status,
        },
      }));
      setMessage(`提案已生成：${proposal.proposalId}`);
      await fetchArtifacts();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '生成提案失败');
    } finally {
      setBusyId(null);
    }
  }, [fetchArtifacts, projectKey]);

  const handleSubmitProposal = useCallback(async (artifactId: string, proposalId: string) => {
    setBusyId(artifactId);
    try {
      const res = await fetch(
        `/api/plan-proposals/${encodeURIComponent(proposalId)}/submit?project=${encodeURIComponent(projectKey)}`,
        { method: 'POST' },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '提交失败');
      const proposal = data.proposal as { proposalId: string; status: string } | undefined;
      setProposalByArtifact(prev => ({
        ...prev,
        [artifactId]: {
          proposalId,
          status: proposal?.status ?? prev[artifactId]?.status ?? 'submitted',
          orchestrationId: data.orchestrationId as string | undefined,
        },
      }));
      setMessage(data.reused ? '提案已在执行，返回当前状态' : '提案已提交到 Orchestrator');
      await fetchArtifacts();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '提交失败');
    } finally {
      setBusyId(null);
    }
  }, [fetchArtifacts, projectKey]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-300">
          <Boxes className="h-4 w-4" />
          <span>Artifact</span>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value as 'all' | ArtifactKind)}
            className="rounded border border-zinc-200 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
          >
            <option value="all">全部类型</option>
            {KIND_OPTIONS.map(kind => <option key={kind} value={kind}>{kind}</option>)}
          </select>
          <button
            onClick={fetchArtifacts}
            className="flex h-7 w-7 items-center justify-center rounded border border-zinc-200 text-zinc-500 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
            title="刷新"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-2 md:grid-cols-[110px_1fr_1fr_auto]">
        <select
          value={newKind}
          onChange={(e) => setNewKind(e.target.value as ArtifactKind)}
          className="rounded border border-zinc-200 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
        >
          {KIND_OPTIONS.map(kind => <option key={kind} value={kind}>{kind}</option>)}
        </select>
        <input
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          placeholder="Artifact 标题"
          className="rounded border border-zinc-200 bg-white px-2 py-1 text-xs outline-none focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-900"
        />
        <input
          value={newContent}
          onChange={(e) => setNewContent(e.target.value)}
          placeholder="Artifact 内容"
          className="rounded border border-zinc-200 bg-white px-2 py-1 text-xs outline-none focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-900"
        />
        <button
          onClick={handleCreate}
          className="inline-flex items-center justify-center gap-1 rounded border border-zinc-200 px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
        >
          <Plus className="h-3.5 w-3.5" />
          新建
        </button>
      </div>

      {message && (
        <div className="rounded border border-zinc-200 bg-zinc-50 px-2 py-1 text-xs text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/40 dark:text-zinc-300">
          {message}
        </div>
      )}

      {loading ? (
        <div className="py-2 text-xs text-zinc-400">加载中...</div>
      ) : filtered.length === 0 ? (
        <div className="py-2 text-xs text-zinc-400">暂无 Artifact</div>
      ) : (
        <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
          {filtered.map(item => {
            const proposalRef = proposalByArtifact[item.id];
            const isEditing = editingId === item.id;
            return (
              <div key={item.id} className="rounded border border-zinc-200 bg-white p-2 text-xs dark:border-zinc-700 dark:bg-zinc-900">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className={`inline-flex rounded px-1.5 py-0.5 text-[11px] ${kindBadgeClass(item.kind)}`}>
                    {item.kind}
                  </span>
                  <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                    {item.status}
                  </span>
                </div>

                {isEditing ? (
                  <div className="space-y-1.5">
                    <input
                      value={draftTitle}
                      onChange={(e) => setDraftTitle(e.target.value)}
                      className="w-full rounded border border-zinc-200 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
                    />
                    <textarea
                      value={draftContent}
                      onChange={(e) => setDraftContent(e.target.value)}
                      rows={3}
                      className="w-full rounded border border-zinc-200 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
                    />
                    <div className="flex items-center justify-between gap-2">
                      <select
                        value={draftStatus}
                        onChange={(e) => setDraftStatus(e.target.value as ArtifactStatus)}
                        className="rounded border border-zinc-200 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
                      >
                        {STATUS_OPTIONS.map(status => <option key={status} value={status}>{status}</option>)}
                      </select>
                      <button
                        onClick={saveEdit}
                        className="inline-flex items-center gap-1 rounded border border-zinc-200 px-2 py-1 text-xs hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                      >
                        <Save className="h-3.5 w-3.5" />
                        保存
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="font-medium text-zinc-700 dark:text-zinc-200">{item.title}</div>
                    <div className="mt-1 whitespace-pre-wrap text-zinc-500 dark:text-zinc-400">{item.content}</div>
                    {(item.sectionId || item.taskId) && (
                      <a
                        href={`?${new URLSearchParams({
                          ...(item.sectionId ? { sectionId: item.sectionId } : {}),
                          ...(item.taskId ? { itemId: item.taskId } : {}),
                        }).toString()}`}
                        className="mt-1 inline-flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
                      >
                        <Link2 className="h-3 w-3" />
                        查看关联 Flow 节点
                      </a>
                    )}
                  </>
                )}

                {!isEditing && (
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <button
                      onClick={() => startEdit(item)}
                      className="inline-flex items-center gap-1 rounded border border-zinc-200 px-2 py-1 text-[11px] hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                    >
                      <Pencil className="h-3 w-3" />
                      编辑
                    </button>
                    <button
                      onClick={() => handleGenerateProposal(item)}
                      disabled={busyId === item.id}
                      className="rounded border border-zinc-200 px-2 py-1 text-[11px] hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                    >
                      生成计划
                    </button>
                    {proposalRef && (
                      <button
                        onClick={() => handleSubmitProposal(item.id, proposalRef.proposalId)}
                        disabled={busyId === item.id}
                        className="inline-flex items-center gap-1 rounded border border-zinc-200 px-2 py-1 text-[11px] hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                      >
                        <Play className="h-3 w-3" />
                        提交执行
                      </button>
                    )}
                    {proposalRef && (
                      <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
                        {proposalRef.status}
                        {proposalRef.orchestrationId ? ` · ${proposalRef.orchestrationId}` : ''}
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
