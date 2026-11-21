import { Component, inject, signal, computed, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { VaultService } from '../../core/vault.service';
import { VaultItem } from '../../shared/models';

interface DuplicateGroup {
  key: string;
  label: string;
  items: VaultItem[];
}

@Component({
  selector: 'app-merge',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './merge.component.html',
  styleUrl: './merge.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MergeComponent {
  private readonly vault = inject(VaultService);

  readonly groups = computed(() => this.buildGroups(this.vault.items()));
  readonly groupKey = signal<string | null>(null);
  readonly keeperId = signal<string | null>(null);
  readonly loserId = signal<string | null>(null);
  readonly keepBothUrls = signal(true);
  readonly choices = signal<Record<string, 'keeper' | 'loser'>>({
    name: 'keeper', username: 'keeper', password: 'keeper', website: 'keeper', notes: 'keeper',
  });
  readonly busy = signal(false);
  readonly message = signal('');

  readonly active = computed(() => this.groups().find(group => group.key === this.groupKey()) || null);

  selectGroup(key: string): void {
    const group = this.groups().find(entry => entry.key === key);
    this.groupKey.set(key);
    this.keeperId.set(group?.items[0]?.id || null);
    this.loserId.set(group?.items[1]?.id || null);
    this.message.set('');
  }

  keeper(): VaultItem | null {
    return this.active()?.items.find(item => item.id === this.keeperId()) || null;
  }

  loser(): VaultItem | null {
    return this.active()?.items.find(item => item.id === this.loserId()) || null;
  }

  display(item: VaultItem, field: string): string {
    if (field === 'password') return item.password ? '••••••••' : 'Empty';
    const value = (item as unknown as Record<string, string | null | undefined>)[field];
    return value || 'Empty';
  }

  choose(field: string, side: 'keeper' | 'loser'): void {
    this.choices.update(current => ({ ...current, [field]: side }));
  }

  async merge(): Promise<void> {
    const keeper = this.keeper();
    const loser = this.loser();
    if (!keeper || !loser || !window.electronAPI) return;
    this.busy.set(true);
    this.message.set('');
    const pick = <T>(field: string, left: T, right: T): T => this.choices()[field] === 'loser' ? right : left;
    const tags = [...new Set([...(keeper.tags || []), ...(loser.tags || [])])];
    const result = await window.electronAPI.vault.mergeItems(keeper.id, loser.id, {
      name: pick('name', keeper.name, loser.name),
      username: pick('username', keeper.username || '', loser.username || ''),
      password: pick('password', keeper.password || '', loser.password || ''),
      website: pick('website', keeper.website || '', loser.website || ''),
      notes: pick('notes', keeper.notes || '', loser.notes || ''),
      tags,
      extraWebsite: this.keepBothUrls() && loser.website && loser.website !== keeper.website ? loser.website : '',
    });
    this.busy.set(false);
    if (!result.success) {
      this.message.set(result.error || 'Merge failed');
      return;
    }
    await this.vault.loadItems();
    this.message.set(`Merged into ${pick('name', keeper.name, loser.name)}. The other copy is in the Bitwarden trash.`);
    this.groupKey.set(null);
  }

  private buildGroups(items: VaultItem[]): DuplicateGroup[] {
    const buckets = new Map<string, VaultItem[]>();
    for (const item of items) {
      if (item.type !== 'login') continue;
      const host = this.hostOf(item.website);
      const user = (item.username || '').trim().toLowerCase();
      if (!host || !user) continue;
      const key = `${host}|${user}`;
      const list = buckets.get(key) || [];
      list.push(item);
      buckets.set(key, list);
    }
    return [...buckets.entries()]
      .filter(([, list]) => list.length > 1)
      .map(([key, list]) => ({ key, label: `${list[0].username} · ${this.hostOf(list[0].website)}`, items: list }));
  }

  private hostOf(website: string | null): string {
    if (!website) return '';
    try {
      const href = /^https?:\/\//i.test(website) ? website : `https://${website}`;
      return new URL(href).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      return '';
    }
  }
}
