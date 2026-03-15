'use client';

import { useState, useEffect, useCallback, useRef, type KeyboardEvent } from 'react';
import { Plus, X, Check, Inbox, Zap } from 'lucide-react';
import type { InboxItem } from '@/types';

interface ProjectInboxProps {
  projectKey: string;
}

export function ProjectInbox({ projectKey }: ProjectInboxProps) {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [newContent, setNewContent] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [convertingId, setConvertingId] = useState<string | null>(null);
  const [convertHint, setConvertHint] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const editRef = useRef<HTMLInputElement>(null);

  // Fetch inbox items
  const fetchItems = useCallback(async () => {
    try {
      const res = await fetch(`/api/data/inbox?project=${encodeURIComponent(projectKey)}`);
      if (!res.ok) return;
      const data = await res.json();
      const allItems: InboxItem[] = data.items ?? [];
      // Only show non-archived, sorted by createdAt descending
      setItems(
        allItems
          .filter((i) => i.status === 'open' || i.status === 'conversion_failed')
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      );
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [projectKey]);

  useEffect(() => {
    setLoading(true);
    fetchItems();
  }, [fetchItems]);

  // Add new item
  const handleAdd = useCallback(async () => {
    const content = newContent.trim();
    if (!content) return;
    setNewContent('');

    // Optimistic: create a temporary item
    const tempId = `temp-${Date.now()}`;
    const tempItem: InboxItem = {
      id: tempId,
      content,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'open',
      source: 'manual',
    };
    setItems((prev) => [tempItem, ...prev]);

    try {
      const res = await fetch(`/api/data/inbox?project=${encodeURIComponent(projectKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      if (res.ok) {
        // Re-fetch to get the real item with server-generated ID
        await fetchItems();
      }
    } catch {
      // Revert on failure
      setItems((prev) => prev.filter((i) => i.id !== tempId));
    }

    inputRef.current?.focus();
  }, [newContent, projectKey, fetchItems]);

  // Archive item (optimistic)
  const handleArchive = useCallback(
    async (id: string) => {
      setItems((prev) => prev.filter((i) => i.id !== id));
      try {
        await fetch(`/api/data/inbox?project=${encodeURIComponent(projectKey)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, status: 'archived' }),
        });
      } catch {
        await fetchItems(); // revert
      }
    },
    [projectKey, fetchItems]
  );

  // Convert item to artifact
  const handleConvert = useCallback(
    async (id: string) => {
      setConvertingId(id);
      try {
        const res = await fetch(
          `/api/inbox/${encodeURIComponent(id)}/convert-to-artifact?project=${encodeURIComponent(projectKey)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ archive: false }),
          }
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.error || '转化失败');
        }

        const artifactKind = data?.artifact?.kind ?? 'artifact';
        const artifactTitle = data?.artifact?.title ?? '';
        const top1 = data?.recommendation?.top1;
        const tip = top1
          ? `已转为 ${artifactKind}: ${artifactTitle}；推荐基因: ${top1.title}`
          : `已转为 ${artifactKind}: ${artifactTitle}`;
        setConvertHint(tip);
        setItems((prev) => prev.filter((i) => i.id !== id));
        window.dispatchEvent(new CustomEvent('pp:artifacts-changed', { detail: { projectKey } }));
      } catch (error) {
        setConvertHint(error instanceof Error ? `转化失败: ${error.message}` : '转化失败');
        await fetchItems();
      } finally {
        setConvertingId(null);
      }
    },
    [projectKey, fetchItems]
  );

  // Delete item (optimistic)
  const handleDelete = useCallback(
    async (id: string) => {
      setItems((prev) => prev.filter((i) => i.id !== id));
      try {
        await fetch(
          `/api/data/inbox?project=${encodeURIComponent(projectKey)}&id=${encodeURIComponent(id)}`,
          { method: 'DELETE' }
        );
      } catch {
        await fetchItems(); // revert
      }
    },
    [projectKey, fetchItems]
  );

  // Start inline editing
  const startEditing = useCallback((item: InboxItem) => {
    setEditingId(item.id);
    setEditingContent(item.content);
  }, []);

  // Save inline edit
  const saveEdit = useCallback(
    async (id: string) => {
      const content = editingContent.trim();
      if (!content) {
        setEditingId(null);
        return;
      }
      // Optimistic update
      setItems((prev) => prev.map((i) => (i.id === id ? { ...i, content } : i)));
      setEditingId(null);

      try {
        await fetch(`/api/data/inbox?project=${encodeURIComponent(projectKey)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, content }),
        });
      } catch {
        await fetchItems(); // revert
      }
    },
    [editingContent, projectKey, fetchItems]
  );

  // Cancel edit
  const cancelEdit = useCallback(() => {
    setEditingId(null);
    setEditingContent('');
  }, []);

  // Focus edit input when editing starts
  useEffect(() => {
    if (editingId && editRef.current) {
      editRef.current.focus();
      editRef.current.select();
    }
  }, [editingId]);

  // Key handlers
  const handleAddKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleAdd();
    }
  };

  const handleEditKeyDown = (e: KeyboardEvent<HTMLInputElement>, id: string) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      saveEdit(id);
    } else if (e.key === 'Escape') {
      cancelEdit();
    }
  };

  return (
    <div className="flex flex-col">
      {/* Input area */}
      <div className="flex items-center gap-2 rounded-lg bg-zinc-50 p-2 dark:bg-zinc-800/60">
        <Inbox className="h-4 w-4 shrink-0 text-zinc-400" />
        <input
          ref={inputRef}
          type="text"
          value={newContent}
          onChange={(e) => setNewContent(e.target.value)}
          onKeyDown={handleAddKeyDown}
          placeholder="快速记录..."
          className="min-w-0 flex-1 bg-transparent text-sm text-zinc-800 outline-none placeholder:text-zinc-400 dark:text-zinc-200"
        />
        <button
          onClick={handleAdd}
          disabled={!newContent.trim()}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-zinc-400 transition-colors hover:bg-zinc-200 hover:text-zinc-600 disabled:opacity-30 disabled:hover:bg-transparent dark:hover:bg-zinc-700 dark:hover:text-zinc-300"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>

      {/* Item list */}
      {loading ? (
        <div className="py-4 text-center text-xs text-zinc-400">加载中...</div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-1 py-6 text-zinc-400">
          <Inbox className="h-5 w-5" />
          <span className="text-xs">收件箱为空，记录一些想法吧</span>
        </div>
      ) : (
        <div className="mt-1 max-h-64 overflow-y-auto">
          {convertHint && (
            <div className="mb-2 rounded border border-zinc-200 bg-zinc-50 px-2 py-1 text-xs text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/50 dark:text-zinc-300">
              {convertHint}
            </div>
          )}
          {items.map((item) => (
            <div
              key={item.id}
              className="group flex items-center gap-1.5 rounded px-2 py-1.5 transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/40"
            >
              {editingId === item.id ? (
                <input
                  ref={editRef}
                  type="text"
                  value={editingContent}
                  onChange={(e) => setEditingContent(e.target.value)}
                  onKeyDown={(e) => handleEditKeyDown(e, item.id)}
                  onBlur={() => saveEdit(item.id)}
                  className="min-w-0 flex-1 rounded border border-zinc-300 bg-white px-1.5 py-0.5 text-sm outline-none focus:border-zinc-400 dark:border-zinc-600 dark:bg-zinc-800 dark:focus:border-zinc-500"
                />
              ) : (
                <span
                  className="min-w-0 flex-1 cursor-text truncate text-sm text-zinc-700 dark:text-zinc-300"
                  onClick={() => startEditing(item)}
                  title={item.content}
                >
                  {item.status === 'conversion_failed' ? `[转换失败] ${item.content}` : item.content}
                </span>
              )}

              {/* Action buttons — visible on hover */}
              <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                <button
                  onClick={() => handleConvert(item.id)}
                  disabled={convertingId === item.id}
                  title="转化为 Artifact"
                  className="flex h-5 w-5 items-center justify-center rounded text-amber-500/80 transition-colors hover:bg-amber-50 hover:text-amber-600 disabled:opacity-40 dark:hover:bg-amber-900/30"
                >
                  <Zap className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => handleArchive(item.id)}
                  title="归档"
                  className="flex h-5 w-5 items-center justify-center rounded text-green-500/70 transition-colors hover:bg-green-50 hover:text-green-600 dark:hover:bg-green-900/30"
                >
                  <Check className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => handleDelete(item.id)}
                  title="删除"
                  className="flex h-5 w-5 items-center justify-center rounded text-red-400/70 transition-colors hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-900/30"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
