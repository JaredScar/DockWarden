import { Component, OnInit, OnDestroy, inject, signal, computed, ChangeDetectionStrategy } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive, Router, NavigationEnd } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { VaultService, AccountProfile } from './core/vault.service';
import { SmartViewService } from './core/smart-view.service';
import { ClipboardService } from './core/clipboard.service';
import { TemplateService } from './core/template.service';
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
  private _kbHandler?: (e: KeyboardEvent) => void;

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

  // ── Sidebar folders ────────────────────────────────────────────────────────
  readonly sidebarFolders = computed(() => {
    const folders = this.vaultService.folders();
    const items = this.vaultService.items();
    const result: { id: string; label: string; count: number; icon: string }[] = [];

    const favCount = items.filter(i => i.favorite).length;
    if (favCount > 0) result.push({ id: '__favorites__', label: 'Favorites', count: favCount, icon: 'fas fa-star' });

    const noFolderCount = items.filter(i => !i.folderId).length;
    if (noFolderCount > 0) result.push({ id: '__none__', label: 'No Folder', count: noFolderCount, icon: 'fas fa-inbox' });

    folders.forEach(folder => {
      const count = items.filter(i => i.folderId === folder.id).length;
      if (count > 0) result.push({ id: folder.id, label: folder.name, count, icon: 'fas fa-folder' });
    });

    return result;
  });

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
