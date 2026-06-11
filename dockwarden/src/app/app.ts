import { Component, OnInit, OnDestroy, inject, signal, computed, effect, ChangeDetectionStrategy } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive, Router, NavigationEnd } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { VaultService, AccountProfile } from './core/vault.service';
import { SmartViewService } from './core/smart-view.service';
import { ClipboardService } from './core/clipboard.service';
import { TemplateService } from './core/template.service';
import { FolderService } from './core/folder.service';
import { WatchtowerService } from './features/watchtower/watchtower.service';
import { FeatureFlagsService } from './core/feature-flags.service';
import { VaultTemplate } from './shared/models';
import { CommonModule } from '@angular/common';
import { filter } from 'rxjs/operators';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, CommonModule, FormsModule],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App implements OnInit, OnDestroy {
  private readonly vaultService = inject(VaultService);
  private readonly smartViewService = inject(SmartViewService);
  private readonly router = inject(Router);
  readonly clipboardService = inject(ClipboardService);
  readonly templateService = inject(TemplateService);
  readonly folderService = inject(FolderService);
  readonly watchtowerService = inject(WatchtowerService);
  readonly watchtowerCriticalCount = this.watchtowerService.criticalCount;
  readonly featureFlagsService = inject(FeatureFlagsService);
  private _kbHandler?: (e: KeyboardEvent) => void;

  constructor() {
    // Auto-scan on vault unlock when the setting is enabled
    let previouslyLocked = true;
    effect(() => {
      const unlocked = this.isUnlocked();
      const justUnlocked = unlocked && previouslyLocked;
      previouslyLocked = !unlocked;
      if (justUnlocked && this.watchtowerService.settingsLoaded()) {
        const { autoScanOnUnlock } = this.watchtowerService.settings();
        if (autoScanOnUnlock) {
          // Small delay so vault items are populated before the scan starts
          setTimeout(() => this.watchtowerService.startScan(), 1500);
        }
      }
    });
  }

  readonly stats = this.vaultService.stats;
  readonly allTags = this.vaultService.allTags;
  readonly syncing = this.vaultService.syncing;
  readonly isUnlocked = this.vaultService.isUnlocked;
  readonly currentUrl = signal('');

  readonly showShell = computed(() => {
    const url = this.currentUrl();
    return (
      this.isUnlocked() &&
      !url.startsWith('/unlock') &&
      !url.startsWith('/launcher') &&
      !url.startsWith('/autotype')
    );
  });

  readonly pinnedViews = this.smartViewService.pinnedViews;
  readonly folders = this.vaultService.folders;

  // ── Sidebar special counts ────────────────────────────────────────────────
  readonly sidebarFavCount = computed(() => this.vaultService.items().filter(i => i.favorite).length);
  readonly sidebarNoFolderCount = computed(() => this.vaultService.items().filter(i => !i.folderId).length);

  // ── Sidebar folder tree (from FolderService) ──────────────────────────────
  readonly folderTreeRows = this.folderService.sidebarRows;

  // ── Folder inline operations ──────────────────────────────────────────────
  /** fullPath of the folder whose row is in inline-rename mode */
  readonly folderRenamingPath = signal<string | null>(null);
  readonly folderRenameValue = signal('');
  readonly folderRenameSaving = signal(false);
  readonly folderRenameError = signal('');

  /** Whether the new folder input row is open (null = not open; string or '__root__' = parent path) */
  readonly folderNewParentPath = signal<string | null | '__root__'>('__none__');
  readonly folderNewName = signal('');
  readonly folderNewSaving = signal(false);
  readonly folderNewError = signal('');

  /** fullPath whose ⋮ context menu is currently open */
  readonly folderMenuPath = signal<string | null>(null);

  /** fullPath confirming delete */
  readonly folderDeleteConfirmPath = signal<string | null>(null);
  readonly folderDeleteSaving = signal(false);

  /** Folder being dragged over (for item drop) */
  readonly folderDragOverId = signal<string | null>(null);

  // ── Folder tree actions ───────────────────────────────────────────────────

  toggleFolder(fullPath: string): void { this.folderService.toggle(fullPath); }

  openFolderMenu(fullPath: string, event: MouseEvent): void {
    event.stopPropagation();
    this.folderMenuPath.set(this.folderMenuPath() === fullPath ? null : fullPath);
    this.folderDeleteConfirmPath.set(null);
  }

  closeFolderMenu(): void { this.folderMenuPath.set(null); }

  startFolderRename(fullPath: string): void {
    const parts = fullPath.split('/');
    this.folderRenameValue.set(parts[parts.length - 1]);
    this.folderRenameError.set('');
    this.folderRenamingPath.set(fullPath);
    this.folderMenuPath.set(null);
  }

  cancelFolderRename(): void {
    this.folderRenamingPath.set(null);
    this.folderRenameValue.set('');
    this.folderRenameError.set('');
  }

  async commitFolderRename(): Promise<void> {
    const path = this.folderRenamingPath();
    const newSegment = this.folderRenameValue().trim();
    if (!path || !newSegment) return;

    const folder = this.folderService.getByPath(path);
    this.folderRenameSaving.set(true);

    // Virtual nodes (id === null) have no BW folder ID — rename by path cascade
    const result = folder
      ? await this.folderService.renameWithCascade(folder.id, newSegment)
      : await this.folderService.renameWithCascadeByPath(path, newSegment);

    this.folderRenameSaving.set(false);
    if (result.success) {
      this.cancelFolderRename();
    } else {
      this.folderRenameError.set(result.error ?? 'Rename failed');
    }
  }

  startNewSubfolder(parentPath: string | null, event?: MouseEvent): void {
    event?.stopPropagation();
    this.folderNewParentPath.set(parentPath === null ? '__root__' : parentPath);
    this.folderNewName.set('');
    this.folderNewError.set('');
    this.folderMenuPath.set(null);
    if (parentPath) this.folderService.expand(parentPath);
  }

  cancelNewSubfolder(): void {
    this.folderNewParentPath.set('__none__');
    this.folderNewName.set('');
    this.folderNewError.set('');
  }

  async commitNewSubfolder(): Promise<void> {
    const rawParent = this.folderNewParentPath();
    const rawName = this.folderNewName().trim();
    if (!rawName) return;

    const parentPath = rawParent === '__root__' || rawParent === '__none__' ? null : rawParent;
    const fullPath = parentPath ? `${parentPath}/${rawName}` : rawName;
    this.folderNewSaving.set(true);
    const result = await this.folderService.createFolder(fullPath);
    this.folderNewSaving.set(false);
    if (result.success) {
      this.cancelNewSubfolder();
    } else {
      this.folderNewError.set(result.error ?? 'Could not create folder');
    }
  }

  confirmFolderDelete(fullPath: string): void {
    this.folderDeleteConfirmPath.set(fullPath);
    this.folderMenuPath.set(null);
  }

  cancelFolderDelete(): void { this.folderDeleteConfirmPath.set(null); }

  async doFolderDelete(fullPath: string): Promise<void> {
    const folder = this.folderService.getByPath(fullPath);
    if (!folder) { this.folderDeleteConfirmPath.set(null); return; }
    this.folderDeleteSaving.set(true);
    await this.folderService.deleteFolder(folder.id);
    this.folderDeleteSaving.set(false);
    this.folderDeleteConfirmPath.set(null);
  }

  // ── Drag-to-folder (items dragged from items list) ────────────────────────

  onFolderDragOver(event: DragEvent, folderId: string | null): void {
    if (!event.dataTransfer?.types.includes('dw-item-id')) return;
    event.preventDefault();
    this.folderDragOverId.set(folderId);
  }

  onFolderDragLeave(): void { this.folderDragOverId.set(null); }

  async onFolderDrop(event: DragEvent, folderId: string | null): Promise<void> {
    event.preventDefault();
    this.folderDragOverId.set(null);
    const itemId = event.dataTransfer?.getData('dw-item-id');
    if (!itemId) return;
    await this.vaultService.updateItemMeta(itemId, { folderId });
  }

  // ── Account switcher ──────────────────────────────────────────────────────
  readonly accounts = signal<AccountProfile[]>([]);
  readonly activeAccountId = signal<string | null>(null);
  readonly showAccountSwitcher = signal(false);

  readonly activeAccount = computed(() => {
    const id = this.activeAccountId();
    return this.accounts().find(a => a.id === id) ?? null;
  });

  toggleAccountSwitcher(): void {
    this.showAccountSwitcher.update(v => !v);
  }

  async switchAccount(account: AccountProfile): Promise<void> {
    if (account.id === this.activeAccountId()) {
      this.showAccountSwitcher.set(false);
      return;
    }
    this.showAccountSwitcher.set(false);
    await this.vaultService.switchAccount(account.id);
  }

  addAccount(): void {
    this.showAccountSwitcher.set(false);
    this.router.navigate(['/accounts']);
  }

  async removeAccount(id: string): Promise<void> {
    await this.vaultService.removeAccountProfile(id);
    this.accounts.update(list => list.filter(a => a.id !== id));
  }

  // ── New Item modal (stays in-app) ──────────────────────────────────────────
  readonly newItemOpen = signal(false);
  /** 'pick' = template picker step; 'form' = fill-in-details step */
  readonly newItemStep = signal<'pick' | 'form'>('pick');
  readonly newItemType = signal<'login' | 'note'>('login');
  readonly newItemName = signal('');
  readonly newItemUsername = signal('');
  readonly newItemPassword = signal('');
  readonly newItemWebsite = signal('');
  readonly newItemNotes = signal('');
  readonly newItemFolder = signal('');
  readonly newItemSaving = signal(false);
  readonly newItemError = signal('');
  readonly newItemShowPw = signal(false);
  readonly newItemTemplateId = signal<string | null>(null);
  readonly newItemTemplateFields = signal<{ id: string; name: string; type: 'text' | 'hidden' | 'boolean' | 'url'; value: string; placeholder: string; required: boolean }[]>([]);

  readonly newItemSelectedTemplate = computed<VaultTemplate | null>(() => {
    const id = this.newItemTemplateId();
    return id ? (this.templateService.allTemplates().find(t => t.id === id) ?? null) : null;
  });

  openQuickSearch(): void {
    window.electronAPI?.launcher?.openSearch();
  }

  openNewItem(templateId?: string | null): void {
    this.newItemName.set('');
    this.newItemUsername.set('');
    this.newItemPassword.set('');
    this.newItemWebsite.set('');
    this.newItemNotes.set('');
    this.newItemFolder.set('');
    this.newItemError.set('');
    this.newItemShowPw.set(false);
    this.newItemTemplateId.set(null);
    this.newItemTemplateFields.set([]);

    if (templateId) {
      this.applyTemplate(templateId);
      this.newItemStep.set('form');
    } else {
      this.newItemType.set('login');
      this.newItemStep.set('pick');
    }
    this.newItemOpen.set(true);
  }

  selectTemplateAndProceed(templateId: string): void {
    this.applyTemplate(templateId);
    this.newItemStep.set('form');
  }

  selectBlankType(type: 'login' | 'note'): void {
    this.newItemType.set(type);
    this.newItemTemplateId.set(null);
    this.newItemTemplateFields.set([]);
    this.newItemFolder.set('');
    this.newItemStep.set('form');
  }

  backToPicker(): void {
    this.newItemStep.set('pick');
  }

  private applyTemplate(templateId: string): void {
    const t = this.templateService.allTemplates().find(t => t.id === templateId);
    if (!t) return;
    this.newItemTemplateId.set(t.id);
    this.newItemType.set(t.baseType);
    this.newItemFolder.set(t.defaultFolder ?? '');
    this.newItemTemplateFields.set(
      t.fields.map(f => ({
        id: f.id,
        name: f.name,
        type: f.type,
        value: f.defaultValue,
        placeholder: f.placeholder,
        required: f.required,
      }))
    );
  }

  updateTemplateFieldValue(fieldId: string, value: string): void {
    this.newItemTemplateFields.update(fields =>
      fields.map(f => f.id === fieldId ? { ...f, value } : f)
    );
  }

  closeNewItem(): void { this.newItemOpen.set(false); }

  async saveNewItem(): Promise<void> {
    if (!this.newItemName().trim()) { this.newItemError.set('Name is required.'); return; }
    this.newItemSaving.set(true);
    this.newItemError.set('');
    const result = await this.vaultService.createItem({
      type: this.newItemType(),
      name: this.newItemName().trim(),
      username: this.newItemUsername() || undefined,
      password: this.newItemPassword() || undefined,
      website: this.newItemWebsite() || undefined,
      notes: this.newItemNotes() || undefined,
      folderId: this.newItemFolder() || null,
      templateId: this.newItemTemplateId() || null,
      templateFields: this.newItemTemplateFields().length > 0
        ? this.newItemTemplateFields().map(f => ({ name: f.name, type: f.type, value: f.value }))
        : undefined,
    });
    this.newItemSaving.set(false);
    if (result.success) {
      this.closeNewItem();
      this.router.navigate(['/items']);
    } else {
      this.newItemError.set(result.error ?? 'Failed to create item.');
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async ngOnInit(): Promise<void> {
    this.router.events.pipe(filter(e => e instanceof NavigationEnd)).subscribe(async e => {
      this.currentUrl.set((e as NavigationEnd).urlAfterRedirects);
      this.showAccountSwitcher.set(false);
      // Refresh account list whenever we navigate (e.g. after unlock)
      if (window.electronAPI && this.isUnlocked()) {
        const profiles = await window.electronAPI.account.getProfiles();
        this.accounts.set(profiles);
        const activeId = await window.electronAPI.account.getActive();
        this.activeAccountId.set(activeId);

        // Handle ?newFromTemplate=<id> query param from templates page
        const url = (e as NavigationEnd).urlAfterRedirects;
        const match = url.match(/[?&]newFromTemplate=([^&]+)/);
        if (match) {
          const templateId = decodeURIComponent(match[1]);
          // Strip the query param from the URL to avoid re-triggering
          this.router.navigate(['/items'], { replaceUrl: true }).then(() => {
            this.openNewItem(templateId);
          });
        }
      }
    });

    if (window.electronAPI) {
      window.electronAPI.on('navigate', (path: unknown) => {
        this.router.navigateByUrl(path as string);
      });
      window.electronAPI.on('vault:lock-requested', () => {
        this.vaultService.lock().then(() => this.router.navigate(['/unlock']));
      });
      window.electronAPI.on('vault:sync-requested', () => { this.syncVault(); });
      // Launcher window picked an item → open it in the items view
      window.electronAPI.on('navigate-to-item', (itemId: unknown) => {
        this.router.navigate(['/items'], { queryParams: { select: itemId as string } });
      });

      // Restore saved custom CSS
      const savedCSS = await window.electronAPI.app.getStore('customCSS') as string | null;
      if (savedCSS) App.injectCSS(savedCSS);

      // Load account profiles
      const profiles = await window.electronAPI.account.getProfiles();
      this.accounts.set(profiles);
      const activeId = await window.electronAPI.account.getActive();
      this.activeAccountId.set(activeId);

      // Initialise clipboard auto-clear delay from persisted setting
      await this.clipboardService.init();

      // Pre-load user-defined templates
      await this.templateService.loadTemplates();

      // Load feature flags
      await this.featureFlagsService.load();
    }

    this._kbHandler = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (!ctrl) return;

      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      const editable = tag === 'input' || tag === 'textarea' || tag === 'select';

      if (e.key === 'Escape') {
        if (this.newItemOpen()) { this.closeNewItem(); return; }
      }

      switch (e.key.toLowerCase()) {
        case 's':
          if (!e.altKey) { e.preventDefault(); this.syncVault(); }
          break;
        case 'n':
          if (!editable && !e.altKey) { e.preventDefault(); this.openNewItem(); }
          break;
        case 'e':
          if (!editable && !e.altKey) {
            e.preventDefault();
            document.dispatchEvent(new CustomEvent('dw:start-edit'));
          }
          break;
        case 'l':
          if (!editable && !e.altKey) { e.preventDefault(); this.lockVault(); }
          break;
      }
    };
    document.addEventListener('keydown', this._kbHandler);
  }

  ngOnDestroy(): void {
    if (this._kbHandler) document.removeEventListener('keydown', this._kbHandler);
  }

  /** Upsert a <style id="dw-custom-css"> tag — called by both app startup and settings component */
  static injectCSS(css: string): void {
    let el = document.getElementById('dw-custom-css') as HTMLStyleElement | null;
    if (!el) {
      el = document.createElement('style');
      el.id = 'dw-custom-css';
      document.head.appendChild(el);
    }
    el.textContent = css;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  async syncVault(): Promise<void> { await this.vaultService.sync(); }

  async lockVault(): Promise<void> {
    await this.vaultService.lock();
    this.router.navigate(['/unlock']);
  }

  getFolderQueryParams(id: string): Record<string, string> {
    if (id === '__favorites__') return { favorites: '1' };
    if (id === '__none__') return { noFolder: '1' };
    return { folder: id };
  }

  getItemIcon(type: string): string {
    switch (type) {
      case 'login':    return 'fas fa-key';
      case 'card':     return 'fas fa-credit-card';
      case 'note':     return 'fas fa-note-sticky';
      case 'identity': return 'fas fa-id-card';
      default:         return 'fas fa-key';
    }
  }

  getItemColor(item: { name: string }): string {
    const palette = ['#ef4444','#3b82f6','#f59e0b','#22c55e','#a855f7','#ec4899','#06b6d4'];
    return palette[item.name.charCodeAt(0) % palette.length];
  }

  getInitials(name: string): string {
    return name.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
  }
}
