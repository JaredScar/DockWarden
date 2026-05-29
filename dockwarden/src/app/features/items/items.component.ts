import { Component, inject, signal, computed, ChangeDetectionStrategy, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Params } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { VaultService } from '../../core/vault.service';
import { SmartViewService } from '../../core/smart-view.service';
import { VaultItem } from '../../shared/models';
import Fuse from 'fuse.js';

@Component({
  selector: 'app-items',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './items.component.html',
  styleUrl: './items.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ItemsComponent implements OnInit, OnDestroy {
  readonly vaultService = inject(VaultService);
  private readonly smartViewService = inject(SmartViewService);
  private readonly route = inject(ActivatedRoute);
  private paramSub?: Subscription;
  private _editHandler?: () => void;

  readonly selectedItem = signal<VaultItem | null>(null);
  readonly searchQuery = signal('');
  readonly showPassword = signal(false);
  readonly copiedField = signal<string | null>(null);

  // Live query-params signal — updated whenever the route changes
  readonly activeParams = signal<Params>({});

  // ── Edit-mode state ────────────────────────────────────────────────────────
  readonly editing = signal(false);
  readonly saving = signal(false);
  readonly saveError = signal('');
  readonly editName = signal('');
  readonly editUsername = signal('');
  readonly editPassword = signal('');
  readonly editWebsite = signal('');
  readonly editNotes = signal('');
  readonly editTags = signal<string[]>([]);
  readonly editExpiry = signal('');
  readonly editFolder = signal('');
  readonly newTagInput = signal('');
  readonly showEditPassword = signal(false);

  readonly items = this.vaultService.items;
  readonly folders = this.vaultService.folders;

  readonly filteredItems = computed(() => {
    const q = this.searchQuery();
    const params = this.activeParams();
    let base = this.items();

    if (params['smartView']) {
      const view = this.smartViewService.views().find(v => v.id === params['smartView']);
      if (view) base = this.smartViewService.evaluateView(view);
    } else if (params['favorites']) {
      base = base.filter(i => i.favorite);
    } else if (params['noFolder']) {
      base = base.filter(i => !i.folderId);
    } else if (params['tag']) {
      base = base.filter(i => i.tags.includes(params['tag']));
    } else if (params['folder']) {
      base = base.filter(i => i.folderId === params['folder']);
    }

    if (!q) return base;
    const fuse = new Fuse(base, { keys: ['name', 'username', 'website'], threshold: 0.4 });
    return fuse.search(q).map(r => r.item);
  });

  readonly listTitle = computed(() => {
    const params = this.activeParams();
    if (params['smartView']) {
      const view = this.smartViewService.views().find(v => v.id === params['smartView']);
      return view ? view.name : 'Smart View';
    }
    if (params['favorites']) return 'Favorites';
    if (params['noFolder']) return 'No Folder';
    if (params['tag']) return `#${params['tag']}`;
    if (params['folder']) {
      const folder = this.vaultService.folders().find(f => f.id === params['folder']);
      return folder ? folder.name : 'Folder';
    }
    return 'All Items';
  });

  readonly searchPlaceholder = computed(() => {
    const title = this.listTitle();
    return title === 'All Items' ? 'Search all items...' : `Search in ${title}...`;
  });

  readonly groupedItems = computed(() => {
    const items = this.filteredItems();
    const groups = new Map<string, VaultItem[]>();
    items.forEach(item => {
      const letter = item.name[0]?.toUpperCase() ?? '#';
      if (!groups.has(letter)) groups.set(letter, []);
      groups.get(letter)!.push(item);
    });
    return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
  });

  async ngOnInit(): Promise<void> {
    // Seed with current params immediately, then track all future changes
    this.activeParams.set(this.route.snapshot.queryParams);
    this.paramSub = this.route.queryParams.subscribe(params => {
      this.activeParams.set(params);
      this.editing.set(false);
      this.searchQuery.set('');

      // Auto-select item when navigated here via quick-search (?select=<id>)
      const selectId = params['select'];
      if (selectId) {
        const found = this.vaultService.items().find(i => i.id === selectId);
        if (found) {
          this.selectedItem.set(found);
          this.showPassword.set(false);
          this.saveError.set('');
        }
      } else {
        this.selectedItem.set(null);
      }
    });
    await this.vaultService.loadFolders();

    // Ctrl+E global event from the app shell
    this._editHandler = () => { if (this.selectedItem()) this.startEdit(); };
    document.addEventListener('dw:start-edit', this._editHandler as EventListener);
  }

  ngOnDestroy(): void {
    this.paramSub?.unsubscribe();
    if (this._editHandler) document.removeEventListener('dw:start-edit', this._editHandler as EventListener);
  }

  selectItem(item: VaultItem): void {
    this.selectedItem.set(item);
    this.showPassword.set(false);
    this.editing.set(false);
    this.saveError.set('');
  }

  // ── Edit panel ─────────────────────────────────────────────────────────────

  startEdit(): void {
    const item = this.selectedItem();
    if (!item) return;
    this.editName.set(item.name);
    this.editUsername.set(item.username ?? '');
    this.editPassword.set(item.password ?? '');
    this.editWebsite.set(item.website ?? '');
    this.editNotes.set(item.notes ?? '');
    this.editTags.set([...item.tags]);
    this.editExpiry.set(item.expiresAt ? item.expiresAt.substring(0, 10) : '');
    this.editFolder.set(item.folderId ?? '');
    this.newTagInput.set('');
    this.saveError.set('');
    this.showEditPassword.set(false);
    this.editing.set(true);
  }

  cancelEdit(): void {
    this.editing.set(false);
    this.saveError.set('');
  }

  addTag(): void {
    const raw = this.newTagInput().trim().toLowerCase().replace(/\s+/g, '-');
    if (!raw || this.editTags().includes(raw)) return;
    this.editTags.update(t => [...t, raw]);
    this.newTagInput.set('');
  }

  addTagOnEnter(event: KeyboardEvent): void {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      this.addTag();
    }
  }

  removeTag(tag: string): void {
    this.editTags.update(t => t.filter(x => x !== tag));
  }

  async saveEdit(): Promise<void> {
    const item = this.selectedItem();
    if (!item || this.saving()) return;
    this.saving.set(true);
    this.saveError.set('');

    const expiresAt = this.editExpiry() || null;
    const folderId = this.editFolder() || null;

    const result = await this.vaultService.updateItemMeta(item.id, {
      name: this.editName() || item.name,
      username: item.username !== null ? this.editUsername() : undefined,
      password: item.password !== null ? this.editPassword() : undefined,
      website: item.website !== null || this.editWebsite() ? this.editWebsite() || undefined : undefined,
      notes: this.editNotes() || undefined,
      tags: this.editTags(),
      expiresAt,
      folderId,
    });

    this.saving.set(false);
    if (result.success) {
      this.editing.set(false);
      this.selectedItem.set({
        ...item,
        name: this.editName() || item.name,
        username: item.username !== null ? (this.editUsername() || null) : item.username,
        password: item.password !== null ? (this.editPassword() || null) : item.password,
        website: this.editWebsite() || null,
        notes: this.editNotes() || undefined,
        tags: this.editTags(),
        expiresAt,
        folderId,
      });
    } else {
      this.saveError.set(result.error ?? 'Failed to save. Please try again.');
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  async copyToClipboard(text: string, field: string): Promise<void> {
    await navigator.clipboard.writeText(text);
    this.copiedField.set(field);
    setTimeout(() => this.copiedField.set(null), 2000);
  }

  getFolderName(id: string | null): string {
    if (!id) return 'No Folder';
    return this.folders().find(f => f.id === id)?.name ?? 'No Folder';
  }

  getPasswordStrengthLabel(score: number | null): string {
    if (score === null) return '';
    if (score >= 90) return 'Fantastic';
    if (score >= 75) return 'Strong';
    if (score >= 50) return 'Fair';
    return 'Weak';
  }

  getPasswordStrengthColor(score: number | null): string {
    if (score === null) return '';
    if (score >= 75) return '#3fb950';
    if (score >= 50) return '#e3b341';
    return '#f85149';
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

  getItemColor(item: VaultItem): string {
    const colors: Record<string, string> = {
      'github.com': '#2d333b', 'amazon': '#FF9900', 'google': '#4285F4',
      'microsoft': '#00A4EF', 'facebook': '#1877F2', 'twitter': '#1DA1F2',
    };
    for (const [key, color] of Object.entries(colors)) {
      if (item.website?.includes(key)) return color;
    }
    const palette = ['#ef4444','#3b82f6','#f59e0b','#22c55e','#a855f7','#ec4899','#06b6d4','#f97316'];
    return palette[item.name.charCodeAt(0) % palette.length];
  }

  getInitials(name: string): string {
    return name.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
  }

  getExpiryBadge(item: VaultItem): { label: string; class: string } | null {
    const status = this.vaultService.getExpiryStatus(item);
    if (status === 'ok') return null;
    if (status === 'expired') return { label: 'Expired', class: 'badge-expired' };
    const days = this.vaultService.getDaysUntilExpiry(item);
    const label = days !== null && days < 0 ? 'Expired' : `${days}d`;
    return { label, class: status === 'this-week' ? 'badge-warning' : 'badge-info' };
  }

  get totpDisplay(): string {
    const item = this.selectedItem();
    if (!item?.totp) return '';
    return item.totp.replace(/(\d{3})(\d{3})/, '$1  $2');
  }
}
