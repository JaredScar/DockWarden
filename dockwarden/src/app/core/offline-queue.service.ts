import { Injectable, signal, computed, effect } from '@angular/core';
import { OfflineQueueEntry, ConflictItem, ConflictResolution } from './vault.service';

@Injectable({ providedIn: 'root' })
export class OfflineQueueService {
  // ── State signals ──────────────────────────────────────────────────────────
  readonly isOffline   = signal(false);
  readonly queue       = signal<OfflineQueueEntry[]>([]);
  readonly conflicts   = signal<ConflictItem[]>([]);
  readonly flushing    = signal(false);
  readonly flushError  = signal('');

  readonly queueLength  = computed(() => this.queue().length);
  readonly hasConflicts = computed(() => this.conflicts().length > 0);

  // Per-conflict resolution choices (entryId → 'apply' | 'discard' | null)
  readonly resolutions  = signal<Record<string, 'apply' | 'discard'>>({});
  readonly allResolved  = computed(() => {
    const res = this.resolutions();
    return this.conflicts().length > 0 &&
      this.conflicts().every(c => res[c.entryId] != null);
  });

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    if (!window.electronAPI?.offline) return;

    // Fetch initial state
    const status = await window.electronAPI.offline.getStatus();
    this.isOffline.set(status.offline);
    this.queue.set(status.queue);

    // Listen for main-process pushes
    window.electronAPI.offline.onStatusChanged(({ offline, queueLength }) => {
      this.isOffline.set(offline);
      // If we went offline and queue is already loaded, don't overwrite
    });

    window.electronAPI.offline.onQueueUpdated(({ queue }) => {
      this.queue.set(queue);
    });

    window.electronAPI.offline.onConflictsDetected(({ conflicts }) => {
      this.conflicts.set(conflicts);
      // Prime all resolutions to null
      const initial: Record<string, 'apply' | 'discard'> = {};
      for (const c of conflicts) initial[c.entryId] = 'apply';
      this.resolutions.set(initial);
    });
  }

  destroy(): void {
    window.electronAPI?.offline?.removeListeners();
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  async setOfflineMode(offline: boolean): Promise<void> {
    if (!window.electronAPI?.offline) return;
    await window.electronAPI.offline.setMode(offline);
    this.isOffline.set(offline);
  }

  async flushQueue(): Promise<void> {
    if (!window.electronAPI?.offline) return;
    this.flushing.set(true);
    this.flushError.set('');
    try {
      const result = await window.electronAPI.offline.flushQueue();
      if (result.conflicts.length > 0) {
        this.conflicts.set(result.conflicts);
        const initial: Record<string, 'apply' | 'discard'> = {};
        for (const c of result.conflicts) initial[c.entryId] = 'apply';
        this.resolutions.set(initial);
      }
      if ((result.errors as unknown[]).length > 0) {
        this.flushError.set(`${(result.errors as unknown[]).length} item(s) failed to sync.`);
      }
    } catch (err: unknown) {
      this.flushError.set(err instanceof Error ? err.message : 'Flush failed.');
    } finally {
      this.flushing.set(false);
    }
  }

  async discardEntry(entryId: string): Promise<void> {
    if (!window.electronAPI?.offline) return;
    await window.electronAPI.offline.discardEntry(entryId);
    this.queue.update(q => q.filter(e => e.id !== entryId));
  }

  setResolution(entryId: string, action: 'apply' | 'discard'): void {
    this.resolutions.update(r => ({ ...r, [entryId]: action }));
  }

  async applyResolutions(): Promise<void> {
    if (!window.electronAPI?.offline) return;
    const res = this.resolutions();
    const payload: ConflictResolution[] = this.conflicts().map(c => ({
      entryId: c.entryId,
      action: res[c.entryId] ?? 'discard',
    }));
    this.flushing.set(true);
    try {
      await window.electronAPI.offline.resolveConflicts(payload);
      this.conflicts.set([]);
      this.resolutions.set({});
    } catch (err: unknown) {
      this.flushError.set(err instanceof Error ? err.message : 'Resolution failed.');
    } finally {
      this.flushing.set(false);
    }
  }

  dismissConflicts(): void {
    this.conflicts.set([]);
    this.resolutions.set({});
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /** Human-readable label for the changed fields of a queue entry */
  formatChangedFields(fields: string[]): string {
    const labels: Record<string, string> = {
      name: 'Name', username: 'Username', password: 'Password',
      website: 'URL', notes: 'Notes', folderId: 'Folder',
      tags: 'Tags', expiresAt: 'Expiry',
    };
    return fields.map(f => labels[f] ?? f).join(', ');
  }

  /** Format a UTC ISO string as a short local date+time */
  formatTime(iso: string): string {
    try {
      return new Date(iso).toLocaleString(undefined, {
        month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
      });
    } catch { return iso; }
  }
}
