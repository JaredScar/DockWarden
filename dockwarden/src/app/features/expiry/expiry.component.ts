import { Component, inject, signal, computed, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { VaultService } from '../../core/vault.service';
import { VaultItem } from '../../shared/models';

type ExpiryTab = 'all' | 'expired' | 'this-week' | 'this-month';

@Component({
  selector: 'app-expiry',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './expiry.component.html',
  styleUrl: './expiry.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ExpiryComponent {
  private readonly vaultService = inject(VaultService);

  readonly activeTab = signal<ExpiryTab>('all');
  readonly snoozed = signal<Set<string>>(new Set());

  readonly allExpiryItems = computed(() => {
    return this.vaultService.items()
      .filter(i => i.expiresAt)
      .map(item => ({
        item,
        status: this.vaultService.getExpiryStatus(item),
        days: this.vaultService.getDaysUntilExpiry(item),
      }))
      .filter(e => e.status !== 'ok')
      .sort((a, b) => new Date(a.item.expiresAt!).getTime() - new Date(b.item.expiresAt!).getTime());
  });

  readonly expiredItems = computed(() => this.allExpiryItems().filter(e => e.status === 'expired'));
  readonly thisWeekItems = computed(() => this.allExpiryItems().filter(e => e.status === 'this-week'));
  readonly thisMonthItems = computed(() => this.allExpiryItems().filter(e => e.status === 'this-month'));

  readonly displayedItems = computed(() => {
    switch (this.activeTab()) {
      case 'expired': return this.expiredItems();
      case 'this-week': return this.thisWeekItems();
      case 'this-month': return this.thisMonthItems();
      default: return this.allExpiryItems();
    }
  });

  snoozeItem(id: string): void {
    this.snoozed.update(s => new Set([...s, id]));
  }

  isSnooze(id: string): boolean {
    return this.snoozed().has(id);
  }

  getStatusBadge(status: string, days: number | null): { label: string; cssClass: string } {
    if (status === 'expired') return { label: 'Expired', cssClass: 'badge-expired' };
    if (days !== null) return { label: `${days} days`, cssClass: status === 'this-week' ? 'badge-warning' : 'badge-info' };
    return { label: '', cssClass: '' };
  }

  getExpiryDate(item: VaultItem): string {
    if (!item.expiresAt) return '';
    return new Date(item.expiresAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
}
