import { Injectable, signal } from '@angular/core';
import { BackupJob, BackupDestination } from '../shared/models';

@Injectable({ providedIn: 'root' })
export class BackupService {
  private readonly _running = signal(false);
  private readonly _history = signal<BackupJob[]>([]);
  private readonly _destinations = signal<BackupDestination[]>([
    { id: '1', type: 'local', label: 'Local Backup', enabled: true, config: { path: '~/Documents/DockWarden/backups' }, lastBackup: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() },
    { id: '2', type: 's3', label: 'AWS S3 Bucket', enabled: true, config: { bucket: 'my-vault-backups', region: 'us-east-1' }, lastBackup: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() },
    { id: '3', type: 'b2', label: 'Backblaze B2', enabled: false, config: {}, lastBackup: null },
  ]);

  readonly running = this._running.asReadonly();
  readonly history = this._history.asReadonly();
  readonly destinations = this._destinations.asReadonly();

  readonly status = {
    active: true,
    lastBackup: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    nextScheduled: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
    totalBackups: 42,
  };

  async loadHistory(): Promise<void> {
    if (window.electronAPI) {
      const history = await window.electronAPI.backup.getHistory();
      this._history.set(history);
    }
  }

  async runNow(): Promise<void> {
    this._running.set(true);
    try {
      if (window.electronAPI) {
        const result = await window.electronAPI.backup.runNow();
        const newJob: BackupJob = {
          id: crypto.randomUUID(),
          timestamp: result.timestamp,
          destination: 'Local + Cloud',
          size: result.size,
          status: result.success ? 'success' : 'failed',
        };
        this._history.update(h => [newJob, ...h]);
      }
    } finally {
      this._running.set(false);
    }
  }

  toggleDestination(id: string): void {
    this._destinations.update(dests =>
      dests.map(d => d.id === id ? { ...d, enabled: !d.enabled } : d)
    );
  }
}
