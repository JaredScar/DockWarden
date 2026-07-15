import { Component, inject, signal, computed, effect, ChangeDetectionStrategy, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Params, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { VaultService, CustomIcon } from '../../core/vault.service';
import { SmartViewService } from '../../core/smart-view.service';
import { ClipboardService } from '../../core/clipboard.service';
import { FolderService } from '../../core/folder.service';
import { WatchtowerService } from '../watchtower/watchtower.service';
import { WatchtowerCategory, Severity } from '../watchtower/watchtower.models';
import { MarkdownPipe } from '../../shared/pipes/markdown.pipe';
import { VaultItem } from '../../shared/models';
import Fuse from 'fuse.js';

const PRESET_EMOJIS = ['🔑','🏦','💳','📧','🛒','🏠','💼','🔒','🌐','📱','🖥️','⚙️','☁️','🎮','🎵','📚','🏥','✈️','🔐','💡'];
const PRESET_COLORS = ['#ef4444','#f97316','#f59e0b','#22c55e','#14b8a6','#3b82f6','#8b5cf6','#ec4899'];

// Risk label metadata keyed by WatchtowerCategory
const RISK_LABEL_META: Record<WatchtowerCategory, { label: string; short: string; icon: string; cls: string }> = {
  [WatchtowerCategory.BREACHED_PASSWORD]: { label: 'Breached',     short: 'Breached', icon: 'fa-biohazard',            cls: 'risk-breached' },
  [WatchtowerCategory.WEAK_PASSWORD]:     { label: 'Weak',         short: 'Weak',     icon: 'fa-unlock',               cls: 'risk-weak' },
  [WatchtowerCategory.REUSED_PASSWORD]:   { label: 'Reused',       short: 'Reused',   icon: 'fa-clone',                cls: 'risk-reused' },
  [WatchtowerCategory.INSECURE_URI]:      { label: 'Insecure URL', short: 'HTTP',     icon: 'fa-triangle-exclamation', cls: 'risk-insecure' },
  [WatchtowerCategory.MISSING_TOTP]:      { label: 'No 2FA',       short: 'No 2FA',   icon: 'fa-shield-halved',        cls: 'risk-no2fa' },
  [WatchtowerCategory.DUPLICATE_ITEM]:    { label: 'Duplicate',    short: 'Dupe',     icon: 'fa-copy',                 cls: 'risk-duplicate' },
};

export interface RiskLabel {
  category: WatchtowerCategory;
  label: string;
  short: string;
  icon: string;
  cls: string;
  severity: Severity;
  message: string;
  findingId: string;
}

@Component({
  selector: 'app-items',
  standalone: true,
  imports: [CommonModule, FormsModule, MarkdownPipe],
  templateUrl: './items.component.html',
  styleUrl: './items.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ItemsComponent implements OnInit, OnDestroy {
  readonly vaultService = inject(VaultService);
  readonly clipboardService = inject(ClipboardService);
  private readonly smartViewService = inject(SmartViewService);
  private readonly folderService = inject(FolderService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  readonly watchtowerService = inject(WatchtowerService);
  private paramSub?: Subscription;
  private _editHandler?: () => void;

  readonly selectedItem = signal<VaultItem | null>(null);
  readonly searchQuery = signal('');
  readonly showPassword = signal(false);
  readonly copiedField = signal<string | null>(null);
  readonly showTagPicker = signal(false);

  // Markdown note display state
  /** true = show raw markdown source instead of rendered output */
  readonly showRawNote = signal(false);
  /** true = show live preview panel below the textarea while editing */
  readonly showEditPreview = signal(true);

  // ── Sort state ─────────────────────────────────────────────────────────────
  readonly sortBy = signal<'name-asc' | 'name-desc' | 'modified-desc' | 'modified-asc' | 'most-used'>('name-asc');
  /** Usage counts loaded from the Electron store: Record<itemId, count> */
  readonly usageCounts = signal<Record<string, number>>({});

  // ── Primary account per site ───────────────────────────────────────────────
  /** IDs of items the user has pinned as "primary" for their site. */
  readonly primaryItemIds = signal<Set<string>>(new Set());

  /** Extract a normalised hostname from an item URL (null if absent/invalid). */
  private extractDomain(url: string | null | undefined): string | null {
    if (!url) return null;
    try {
      const href = /^https?:\/\//i.test(url) ? url : `https://${url}`;
      return new URL(href).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      return null;
    }
  }

  isPrimary(item: VaultItem): boolean {
    return this.primaryItemIds().has(item.id);
  }

  async togglePrimary(item: VaultItem): Promise<void> {
    const ids = new Set(this.primaryItemIds());

    if (ids.has(item.id)) {
      ids.delete(item.id);
    } else {
      // Demote any existing primary that shares the same domain
      const domain = this.extractDomain(item.website);
      if (domain) {
        for (const existingId of ids) {
          const existingItem = this.items().find(i => i.id === existingId);
          if (existingItem && this.extractDomain(existingItem.website) === domain) {
            ids.delete(existingId);
          }
        }
      }
      ids.add(item.id);
    }

    this.primaryItemIds.set(ids);
    await window.electronAPI!.primary.setAll([...ids]);
  }

  // Custom icons
  readonly customIcons = signal<Record<string, CustomIcon>>({});
  readonly iconPickerOpen = signal(false);
  readonly presetEmojis = PRESET_EMOJIS;
  readonly presetColors = PRESET_COLORS;

  // Live query-params signal — updated whenever the route changes
  readonly activeParams = signal<Params>({});

  // ── Multi-tag filter state ─────────────────────────────────────────────────

  /** All tags currently applied as a filter (supports both ?tag=x and ?tags=x,y) */
  readonly activeTags = computed(() => {
    const params = this.activeParams();
    const multi = params['tags'] as string | undefined;
    const single = params['tag'] as string | undefined;
    if (multi) return multi.split(',').map(t => t.trim()).filter(Boolean);
    if (single) return [single];
    return [] as string[];
  });

  /** 'and' = item must have ALL selected tags; 'any' = item needs just one */
  readonly tagMode = computed<'and' | 'any'>(() =>
    this.activeParams()['tagMode'] === 'any' ? 'any' : 'and'
  );

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

  constructor() {
    // Auto-select the top search result as the user types — like 1Password's
    // inline search behaviour where the best match is shown immediately.
    effect(() => {
      const q = this.searchQuery();
      if (!q) return;
      const results = this.filteredItems();
      if (results.length > 0) {
        this.selectedItem.set(results[0]);
        this.showPassword.set(false);
        this.editing.set(false);
        this.saveError.set('');
      } else {
        this.selectedItem.set(null);
      }
    });
  }

  /** Filtered list (no sort applied yet) — used for count and auto-select. */
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
    } else if (params['tag'] || params['tags']) {
      const tags = this.activeTags();
      const mode = this.tagMode();
      base = mode === 'any'
        ? base.filter(i => tags.some(t => i.tags.includes(t)))
        : base.filter(i => tags.every(t => i.tags.includes(t)));
    } else if (params['folder']) {
      // Include items in this folder AND all descendant folders (nested tree support)
      const folderId = params['folder'] as string;
      const subtreeIds = this.folderService.getSubtreeIds(folderId);
      base = base.filter(i => i.folderId && subtreeIds.has(i.folderId));
    }

    if (!q) return base;
    const fuse = new Fuse(base, { keys: ['name', 'username', 'website'], threshold: 0.4 });
    return fuse.search(q).map(r => r.item);
  });

  /** Filtered list with the user-chosen sort applied.
   *  Primary items always float to the top, then the rest follow the base sort. */
  readonly sortedFilteredItems = computed(() => {
    const items = [...this.filteredItems()];
    const sort = this.sortBy();
    const counts = this.usageCounts();
    const primaries = this.primaryItemIds();

    // ── Base sort ──────────────────────────────────────────────────────────
    switch (sort) {
      case 'name-desc':
        items.sort((a, b) => b.name.localeCompare(a.name)); break;
      case 'modified-desc':
        items.sort((a, b) =>
          new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime()); break;
      case 'modified-asc':
        items.sort((a, b) =>
          new Date(a.lastModified).getTime() - new Date(b.lastModified).getTime()); break;
      case 'most-used':
        items.sort((a, b) => (counts[b.id] ?? 0) - (counts[a.id] ?? 0)); break;
      default:
        items.sort((a, b) => a.name.localeCompare(b.name)); break;
    }

    // ── Float primaries to the top (stable — preserves relative base-sort order) ──
    if (primaries.size === 0) return items;
    return [
      ...items.filter(i => primaries.has(i.id)),
      ...items.filter(i => !primaries.has(i.id)),
    ];
  });

  readonly listTitle = computed(() => {
    const params = this.activeParams();
    if (params['smartView']) {
      const view = this.smartViewService.views().find(v => v.id === params['smartView']);
      return view ? view.name : 'Smart View';
    }
    if (params['favorites']) return 'Favorites';
    if (params['noFolder']) return 'No Folder';
    if (params['tags']) {
      const tags = (params['tags'] as string).split(',').map(t => t.trim()).filter(Boolean);
      return tags.length === 1 ? `#${tags[0]}` : `${tags.length} Tags`;
    }
    if (params['tag']) return `#${params['tag']}`;
    if (params['folder']) {
      const folder = this.vaultService.folders().find(f => f.id === params['folder']);
      if (folder) {
        const parts = folder.name.split('/');
        return parts[parts.length - 1];
      }
      return 'Folder';
    }
    return 'All Items';
  });

  readonly searchPlaceholder = computed(() => {
    const title = this.listTitle();
    return title === 'All Items' ? 'Search all items...' : `Search in ${title}...`;
  });

  readonly groupedItems = computed(() => {
    const items = this.sortedFilteredItems();
    const sort = this.sortBy();

    if (sort === 'name-asc' || sort === 'name-desc') {
      // Alphabetical grouping — items are already name-sorted, so groups maintain order
      const groups = new Map<string, VaultItem[]>();
      items.forEach(item => {
        const letter = item.name[0]?.toUpperCase() ?? '#';
        if (!groups.has(letter)) groups.set(letter, []);
        groups.get(letter)!.push(item);
      });
      return Array.from(groups.entries());
    }

    // For all other sorts: single flat list with no letter header
    return [['', items]] as [string, VaultItem[]][];
  });

  // ── Multi-tag navigation ───────────────────────────────────────────────────

  toggleTagFilter(tag: string): void {
    const current = this.activeTags();
    const next = current.includes(tag)
      ? current.filter(t => t !== tag)
      : [...current, tag];
    this._navigateTags(next, this.tagMode());
  }

  removeTagFilter(tag: string): void {
    this._navigateTags(this.activeTags().filter(t => t !== tag), this.tagMode());
  }

  clearTagFilter(): void {
    this.showTagPicker.set(false);
    this.router.navigate(['/items']);
  }

  toggleTagMode(): void {
    const mode = this.tagMode() === 'and' ? 'any' : 'and';
    this._navigateTags(this.activeTags(), mode);
  }

  private _navigateTags(tags: string[], mode: 'and' | 'any'): void {
    if (tags.length === 0) { this.router.navigate(['/items']); return; }
    const qp = tags.length === 1 && mode === 'and'
      ? { tags: tags[0] }
      : { tags: tags.join(','), tagMode: mode };
    this.router.navigate(['/items'], { queryParams: qp });
  }

  async ngOnInit(): Promise<void> {
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

    // Load custom icons from local store
    const icons = await this.vaultService.getCustomIcons();
    this.customIcons.set(icons);

    // Ctrl+E global event from the app shell
    this._editHandler = () => { if (this.selectedItem()) this.startEdit(); };
    document.addEventListener('dw:start-edit', this._editHandler as EventListener);

    // Load usage counts (frequency-of-use sort) and primary item IDs in parallel
    const [counts, primaryIds] = await Promise.all([
      window.electronAPI!.usage.getAll(),
      window.electronAPI!.primary.getAll(),
    ]);
    this.usageCounts.set(counts);
    this.primaryItemIds.set(new Set(primaryIds));
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
    this.showRawNote.set(false);
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
    await this.clipboardService.copy(text, field);
    this.copiedField.set(field);
    setTimeout(() => this.copiedField.set(null), 2000);

    // Track usage for the "Most Used" sort — only meaningful copy actions count
    const item = this.selectedItem();
    if (item && (field === 'password' || field === 'username')) {
      const newCount = await window.electronAPI!.usage.increment(item.id);
      this.usageCounts.update(m => ({ ...m, [item.id]: newCount }));
    }
  }

  // ── Custom icon management ─────────────────────────────────────────────────

  getCustomIcon(itemId: string): CustomIcon | null {
    return this.customIcons()[itemId] ?? null;
  }

  toggleIconPicker(): void {
    this.iconPickerOpen.update(v => !v);
  }

  async pickEmoji(emoji: string): Promise<void> {
    const item = this.selectedItem();
    if (!item) return;
    const icon: CustomIcon = { type: 'emoji', value: emoji };
    await this.vaultService.setCustomIcon(item.id, icon);
    this.customIcons.update(m => ({ ...m, [item.id]: icon }));
    this.iconPickerOpen.set(false);
  }

  async pickColor(color: string): Promise<void> {
    const item = this.selectedItem();
    if (!item) return;
    const initials = this.getInitials(item.name);
    const icon: CustomIcon = { type: 'color', value: initials, bg: color };
    await this.vaultService.setCustomIcon(item.id, icon);
    this.customIcons.update(m => ({ ...m, [item.id]: icon }));
    this.iconPickerOpen.set(false);
  }

  async resetIcon(): Promise<void> {
    const item = this.selectedItem();
    if (!item) return;
    await this.vaultService.removeCustomIcon(item.id);
    this.customIcons.update(m => { const copy = { ...m }; delete copy[item.id]; return copy; });
    this.iconPickerOpen.set(false);
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

  onItemDragStart(event: DragEvent, itemId: string): void {
    event.dataTransfer?.setData('dw-item-id', itemId);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }

  /** Returns risk labels for an item based on active Watchtower findings. */
  getItemRiskLabels(itemId: string): RiskLabel[] {
    const findings = this.watchtowerService.findingsByItemId().get(itemId);
    if (!findings?.length) return [];
    return findings.map(f => ({
      ...RISK_LABEL_META[f.category],
      category: f.category,
      severity: f.severity,
      message: f.message,
      findingId: f.id,
    }));
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
