import { Component, inject, signal, OnInit, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { BackupService } from '../../core/backup.service';

type BackupTab = 'destinations' | 'schedule' | 'history';

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

  readonly activeTab = signal<BackupTab>('destinations');
  readonly destinations = this.backupService.destinations;
  readonly history = this.backupService.history;
  readonly running = this.backupService.running;
  readonly status = this.backupService.status;

  readonly scheduleOptions = ['Every 4 hours', 'Every 12 hours', 'Daily', 'Weekly', 'On vault sync'];
  readonly selectedSchedule = signal('Every 4 hours');
  readonly retentionCount = signal(10);

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
}
