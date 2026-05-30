import { Component, inject, signal, computed, OnInit, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { BackupService } from '../../core/backup.service';
import { VaultService, VaultSnapshot, SnapshotDiff } from '../../core/vault.service';

type BackupTab = 'destinations' | 'schedule' | 'history' | 'snapshots';

@Component({
  selector: 'app-backup',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './backup.component.html',
  styleUrl: './backup.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BackupComponent implements OnInit {
  private readonly backupService = inject(BackupService);
  private readonly vaultService = inject(VaultService);

  readonly activeTab = signal<BackupTab>('destinations');
  readonly destinations = this.backupService.destinations;
  readonly history = this.backupService.history;
  readonly running = this.backupService.running;
  readonly status = this.backupService.status;

  readonly scheduleOptions = ['Every 4 hours', 'Every 12 hours', 'Daily', 'Weekly', 'On vault sync'];
  readonly selectedSchedule = signal('Every 4 hours');
  readonly retentionCount = signal(10);

  // ── Snapshots ──────────────────────────────────────────────────────────────
  readonly snapshots = signal<VaultSnapshot[]>([]);
  readonly snapshotLoading = signal(false);
  readonly savingSnapshot = signal(false);
  readonly newSnapshotLabel = signal('');

  // Diff state
  readonly diffIdA = signal<string | null>(null);
  readonly diffIdB = signal<string | null>(null);
  readonly diffLoading = signal(false);
  readonly diffResult = signal<SnapshotDiff | null>(null);
  readonly diffError = signal('');

  readonly canDiff = computed(() => !!this.diffIdA() && !!this.diffIdB() && this.diffIdA() !== this.diffIdB());

  async ngOnInit(): Promise<void> {
    await this.backupService.loadHistory();
  }

  async runBackup(): Promise<void> {
    await this.backupService.runNow();
  }

  toggleDestination(id: string): void {
    this.backupService.toggleDestination(id);
  }

  getDestIcon(type: string): string {
    switch (type) {
      case 'local': return 'fas fa-hard-drive';
      case 's3': return 'fas fa-cloud';
      case 'b2': return 'fas fa-globe';
      case 'webdav': return 'fas fa-link';
      default: return 'fas fa-database';
    }
  }

  formatTimestamp(ts: string): string {
    return new Date(ts).toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  }

  formatTimeAgo(dateStr: string | null): string {
    if (!dateStr) return 'Never';
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    const hours = Math.floor(mins / 60);
    if (mins < 60) return `${mins} min ago`;
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  // ── Snapshot methods ───────────────────────────────────────────────────────

  async loadSnapshots(): Promise<void> {
    this.snapshotLoading.set(true);
    const snaps = await this.vaultService.getSnapshots();
    this.snapshots.set(snaps);
    this.snapshotLoading.set(false);
  }

  async onSnapshotTab(): Promise<void> {
    this.activeTab.set('snapshots');
    await this.loadSnapshots();
  }

  async saveSnapshot(): Promise<void> {
    this.savingSnapshot.set(true);
    const label = this.newSnapshotLabel().trim() || 'Manual snapshot';
    const result = await this.vaultService.saveSnapshot(label);
    this.savingSnapshot.set(false);
    if (result.success && result.snapshot) {
      this.snapshots.update(s => [result.snapshot!, ...s]);
      this.newSnapshotLabel.set('');
    }
  }

  async deleteSnapshot(id: string): Promise<void> {
    await this.vaultService.deleteSnapshot(id);
    this.snapshots.update(s => s.filter(x => x.id !== id));
    if (this.diffIdA() === id) { this.diffIdA.set(null); this.diffResult.set(null); }
    if (this.diffIdB() === id) { this.diffIdB.set(null); this.diffResult.set(null); }
  }

  async runDiff(): Promise<void> {
    const a = this.diffIdA(), b = this.diffIdB();
    if (!a || !b) return;
    this.diffLoading.set(true);
    this.diffError.set('');
    this.diffResult.set(null);
    const result = await this.vaultService.diffSnapshots(a, b);
    this.diffLoading.set(false);
    if (result.success && result.diff) {
      this.diffResult.set(result.diff);
    } else {
      this.diffError.set(result.error ?? 'Diff failed');
    }
  }

  getSnapshotLabel(id: string | null): string {
    if (!id) return '—';
    return this.snapshots().find(s => s.id === id)?.label ?? id;
  }

  getTypeIcon(type: string): string {
    switch (type) {
      case 'login': return 'fas fa-key';
      case 'card': return 'fas fa-credit-card';
      case 'note': return 'fas fa-note-sticky';
      case 'identity': return 'fas fa-id-card';
      default: return 'fas fa-key';
    }
  }
}
