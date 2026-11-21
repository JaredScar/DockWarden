import { Component, inject, computed, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { VaultService } from '../../core/vault.service';
import { PowerService } from '../../core/power.service';
import { VaultItem } from '../../shared/models';

@Component({
  selector: 'app-rotate',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './rotate.component.html',
  styleUrl: './rotate.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RotateComponent {
  private readonly vault = inject(VaultService);
  readonly power = inject(PowerService);

  readonly candidates = computed(() => {
    const now = Date.now();
    return this.vault.items()
      .filter(item => item.type === 'login' && item.password)
      .map(item => ({ item, reason: this.reason(item, now) }))
      .filter(row => row.reason)
      .sort((a, b) => a.item.name.localeCompare(b.item.name));
  });

  async confirm(): Promise<void> {
    await this.power.confirmRotation();
  }

  private reason(item: VaultItem, now: number): string {
    if (item.expiresAt && new Date(item.expiresAt).getTime() <= now + 30 * 86400000) {
      return new Date(item.expiresAt).getTime() < now ? 'Expired' : 'Expiring soon';
    }
    const modified = item.lastModified ? new Date(item.lastModified).getTime() : 0;
    if (modified && now - modified > 90 * 86400000) return 'Older than 90 days';
    return '';
  }
}
