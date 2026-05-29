import { Component, inject, signal, computed, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { VaultService } from '../../core/vault.service';
import { Tag, VaultItem } from '../../shared/models';

@Component({
  selector: 'app-tags',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './tags.component.html',
  styleUrl: './tags.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TagsComponent {
  readonly vaultService = inject(VaultService);

  readonly allTags = this.vaultService.allTags;
  readonly allItems = this.vaultService.items;

  readonly searchQuery = signal('');
  readonly selectedTagName = signal<string | null>(null);

  // ── Bulk editor state ──────────────────────────────────────────────────────
  readonly bulkOpen = signal(false);
  readonly bulkSearch = signal('');
  readonly bulkSelected = signal<Set<string>>(new Set());
  readonly bulkTagsToAdd = signal<string[]>([]);
  readonly bulkTagsToRemove = signal<string[]>([]);
  readonly bulkNewTag = signal('');
  readonly bulkRemoveTag = signal('');
  readonly bulkSaving = signal(false);
  readonly bulkResult = signal('');

  readonly filteredTags = computed(() => {
    const q = this.searchQuery().toLowerCase();
    if (!q) return this.allTags();
    return this.allTags().filter(t => t.name.toLowerCase().includes(q));
  });

  readonly tagItems = computed(() => {
    const tag = this.selectedTagName();
    if (!tag) return [];
    return this.vaultService.getItemsByTag(tag);
  });

  readonly bulkFilteredItems = computed(() => {
    const q = this.bulkSearch().toLowerCase();
    const items = this.allItems();
    if (!q) return items;
    return items.filter(i =>
      i.name.toLowerCase().includes(q) ||
      (i.username?.toLowerCase().includes(q)) ||
      (i.website?.toLowerCase().includes(q))
    );
  });

  readonly bulkSelectedCount = computed(() => this.bulkSelected().size);

  toggleBulkItem(id: string): void {
    this.bulkSelected.update(s => {
      const copy = new Set(s);
      if (copy.has(id)) copy.delete(id); else copy.add(id);
      return copy;
    });
  }

  isBulkSelected(id: string): boolean {
    return this.bulkSelected().has(id);
  }

  selectAllBulk(): void {
    const ids = new Set(this.bulkFilteredItems().map(i => i.id));
    this.bulkSelected.set(ids);
  }

  clearBulkSelection(): void {
    this.bulkSelected.set(new Set());
  }

  addBulkTagToAdd(): void {
    const t = this.bulkNewTag().trim().toLowerCase().replace(/\s+/g, '-');
    if (!t || this.bulkTagsToAdd().includes(t)) return;
    this.bulkTagsToAdd.update(arr => [...arr, t]);
    this.bulkNewTag.set('');
  }

  addBulkTagOnEnter(event: KeyboardEvent): void {
    if (event.key === 'Enter' || event.key === ',') { event.preventDefault(); this.addBulkTagToAdd(); }
  }

  removeBulkTagToAdd(tag: string): void {
    this.bulkTagsToAdd.update(arr => arr.filter(t => t !== tag));
  }

  addBulkTagToRemove(): void {
    const t = this.bulkRemoveTag().trim().toLowerCase().replace(/\s+/g, '-');
    if (!t || this.bulkTagsToRemove().includes(t)) return;
    this.bulkTagsToRemove.update(arr => [...arr, t]);
    this.bulkRemoveTag.set('');
  }

  addBulkRemoveOnEnter(event: KeyboardEvent): void {
    if (event.key === 'Enter' || event.key === ',') { event.preventDefault(); this.addBulkTagToRemove(); }
  }

  removeBulkTagToRemove(tag: string): void {
    this.bulkTagsToRemove.update(arr => arr.filter(t => t !== tag));
  }

  async applyBulkTags(): Promise<void> {
    const ids = Array.from(this.bulkSelected());
    if (!ids.length || this.bulkSaving()) return;
    if (!this.bulkTagsToAdd().length && !this.bulkTagsToRemove().length) return;

    this.bulkSaving.set(true);
    this.bulkResult.set('');
    let saved = 0; let failed = 0;

    for (const id of ids) {
      const item = this.allItems().find(i => i.id === id);
      if (!item) continue;
      let tags = [...item.tags];
      for (const t of this.bulkTagsToAdd()) { if (!tags.includes(t)) tags.push(t); }
      for (const t of this.bulkTagsToRemove()) { tags = tags.filter(x => x !== t); }
      const result = await this.vaultService.updateItemMeta(id, { tags });
      if (result.success) saved++; else failed++;
    }

    this.bulkSaving.set(false);
    this.bulkResult.set(`Done — ${saved} updated${failed ? `, ${failed} failed` : ''}.`);
    this.bulkSelected.set(new Set());
    this.bulkTagsToAdd.set([]);
    this.bulkTagsToRemove.set([]);
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
