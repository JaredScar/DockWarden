import { Component, inject, OnInit, ChangeDetectionStrategy, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CommonModule } from '@angular/common';
import { VaultService } from '../../core/vault.service';
import { BackupService } from '../../core/backup.service';

@Component({
  selector: 'app-home',
  standalone: true,
  imports: [RouterLink, CommonModule],
  templateUrl: './home.component.html',
  styleUrl: './home.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HomeComponent implements OnInit {
  private readonly vaultService = inject(VaultService);
  private readonly backupService = inject(BackupService);

  readonly stats = this.vaultService.stats;
  readonly expiringItems = this.vaultService.expiringItems;
  readonly recentActivity = this.vaultService.recentActivity;
  readonly backupStatus = this.backupService.status;
  readonly backupRunning = this.backupService.running;

  async ngOnInit(): Promise<void> {
    await this.backupService.loadHistory();
  }

  async runBackup(): Promise<void> {
    await this.backupService.runNow();
  }

  getExpiryLabel(item: { item: { expiresAt: string | null }; status: string }): string {
    if (item.status === 'expired') return 'Expired';
    const days = this.vaultService.getDaysUntilExpiry(item.item as never);
    return days !== null ? `${days} days` : '';
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

  formatNextBackup(dateStr: string): string {
    const diff = new Date(dateStr).getTime() - Date.now();
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const mins = Math.floor((diff % (1000 * 60 * 60)) / 60000);
    if (hours > 0) return `In ${hours}h`;
    return `In ${mins}m`;
  }

  getItemIcon(type: string): string {
    switch (type) {
      case 'login': return 'fas fa-key';
      case 'card': return 'fas fa-credit-card';
      case 'note': return 'fas fa-note-sticky';
      case 'identity': return 'fas fa-user';
      default: return 'fas fa-key';
    }
  }
}
