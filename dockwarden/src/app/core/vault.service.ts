import { Injectable, signal, computed } from '@angular/core';
import {
  VaultItem, Tag, BackupJob,
  SyncResult, VaultStats, RecentActivity, ExpiryStatus,
  VaultTemplate,
} from '../shared/models';

export type AuthStatus = 'unauthenticated' | 'locked' | 'unlocked';

export interface Folder {
  id: string;
  name: string;
}

export interface ExpiryPolicy {
  id: string;
  name: string;
  description: string;
  type: 'password-age';
  thresholdDays: number;
  itemTypes: string[];
  enabled: boolean;
  notifyDaysBefore: number;
}

export interface AccountProfile {
  id: string;
  name: string;
  email: string;
  serverUrl: string;
  color: string;
}

export interface VaultSnapshot {
  id: string;
  label: string;
  timestamp: string;
  itemCount: number;
}

export interface SnapshotItem {
  id: string;
  name: string;
  type: string;
  lastModified: string;
  folderId: string | null;
}

export interface SnapshotDiff {
  added: SnapshotItem[];
  deleted: SnapshotItem[];
  modified: { before: SnapshotItem; after: SnapshotItem }[];
  unchanged: number;
  snapA: { label: string; timestamp: string };
  snapB: { label: string; timestamp: string };
}

export interface CustomIcon {
  type: 'emoji' | 'color';
  value: string;
  bg?: string;
}

export interface OfflineQueueEntry {
  id: string;
  operation: 'create' | 'edit';
  itemId: string;
  name: string;
  itemType: string;
  timestamp: string;
  changedFields: string[];
  revisionDate: string | null;
}

export interface ConflictItem {
  entryId: string;
  itemId: string;
  name: string;
  itemType: string;
  changedFields: string[];
  queuedAt: string;
  remoteModifiedAt: string;
}

export interface ConflictResolution {
  entryId: string;
  action: 'apply' | 'discard';
}

export interface GeneratorOptions {
  length: number;
  upper: boolean;
  lower: boolean;
  numbers: boolean;
  symbols: boolean;
  ambiguous: boolean;
}

export interface GeneratorSettings extends GeneratorOptions {
  defaultUsername: string;
}

export interface SiteHint {
  name: string;
  url: string;
}

declare global {
  interface Window {
    electronAPI?: {
      vault: {
        getItems: () => Promise<VaultItem[]>;
        getCachedItems: () => Promise<VaultItem[]>;
        getFolders: () => Promise<Folder[]>;
        getTotp: (itemId: string) => Promise<{ success: boolean; code?: string; error?: string }>;
        sync: () => Promise<SyncResult>;
        editItem: (id: string, patch: Partial<VaultItem> & { folderId?: string | null; expiresAt?: string | null; username?: string; password?: string; website?: string }) => Promise<{ success: boolean; error?: string }>;
        createItem: (item: object) => Promise<{ success: boolean; item?: VaultItem; error?: string }>;
        status: () => Promise<{ success: boolean; status: { status: string } }>;
        login: (email: string, password: string, serverUrl?: string) => Promise<{ success: boolean; requiresTwoFactor?: boolean; error?: string }>;
        login2fa: (code: string, method?: number) => Promise<{ success: boolean; error?: string }>;
        unlock: (password: string) => Promise<{ success: boolean; error?: string }>;
        lock: () => Promise<{ success: boolean }>;
        logout: () => Promise<{ success: boolean }>;
        getExpiryPolicies: () => Promise<ExpiryPolicy[]>;
        setExpiryPolicies: (policies: ExpiryPolicy[]) => Promise<boolean>;
        getSetting: (key: string, defaultValue: unknown) => Promise<unknown>;
        setSetting: (key: string, value: unknown) => Promise<boolean>;
      };
      autotype: {
        send: (username: string, password: string, pressEnter: boolean) => Promise<{ success: boolean; error?: string }>;
      };
      launcher: {
        close: () => void;
        navigateToItem: (itemId: string) => void;
        openSearch: () => Promise<void>;
        openAutotype: () => Promise<void>;
      };
      bw: {
        getConfig: () => Promise<{ bwEmail: string; bwServerUrl: string; bwCliPath: string; isSessionActive: boolean }>;
        setCliPath: (cliPath: string) => Promise<boolean>;
        checkCli: () => Promise<{ success: boolean; version: string | null }>;
        autoDetect: () => Promise<{ found: boolean; path: string | null }>;
      };
      backup: {
        runNow: () => Promise<{ success: boolean; timestamp: string; size: string }>;
        getHistory: () => Promise<BackupJob[]>;
        getDir: () => Promise<string>;
        setDir: (dir: string) => Promise<{ success: boolean; dir?: string; error?: string }>;
      };
      account: {
        getProfiles: () => Promise<AccountProfile[]>;
        addProfile: (profile: Omit<AccountProfile, 'id' | 'color'>) => Promise<AccountProfile>;
        updateProfile: (id: string, patch: Partial<AccountProfile>) => Promise<boolean>;
        removeProfile: (id: string) => Promise<boolean>;
        getActive: () => Promise<string | null>;
        setActive: (id: string) => Promise<boolean>;
        switch: (id: string) => Promise<{ success: boolean; error?: string }>;
      };
      snapshot: {
        getAll: () => Promise<VaultSnapshot[]>;
        saveManual: (label: string) => Promise<{ success: boolean; snapshot?: VaultSnapshot; error?: string }>;
        delete: (id: string) => Promise<boolean>;
        diff: (idA: string, idB: string) => Promise<{ success: boolean; diff?: SnapshotDiff; error?: string }>;
      };
      icon: {
        getAll: () => Promise<Record<string, CustomIcon>>;
        set: (itemId: string, icon: CustomIcon) => Promise<boolean>;
        remove: (itemId: string) => Promise<boolean>;
      };
      folder: {
        create: (name: string) => Promise<{ success: boolean; folder?: Folder; error?: string }>;
        rename: (id: string, name: string) => Promise<{ success: boolean; error?: string }>;
        delete: (id: string) => Promise<{ success: boolean; error?: string }>;
        move: (folders: Folder[], oldPath: string, newPath: string) => Promise<{ success: boolean; error?: string }>;
      };
      template: {
        getAll: () => Promise<VaultTemplate[]>;
        save: (template: VaultTemplate) => Promise<boolean>;
        delete: (id: string) => Promise<boolean>;
      };
      watchtower: {
        startScan: (items: unknown[], settings?: unknown) => Promise<unknown>;
        onScanProgress: (callback: (progress: unknown) => void) => void;
        onScanResults: (callback: (results: unknown) => void) => void;
        cancelScan: () => void;
        updateBadge: (total: number, critical: number) => void;
        removeListeners: () => void;
      };
      generator: {
        generate: (opts: GeneratorOptions) => Promise<string>;
        getSettings: () => Promise<GeneratorSettings>;
        setSettings: (settings: GeneratorSettings) => Promise<boolean>;
        getActiveWindow: () => Promise<SiteHint>;
        open: () => Promise<void>;
        onSiteHint: (callback: (hint: SiteHint) => void) => void;
        removeListeners: () => void;
      };
      offline: {
        getStatus: () => Promise<{ offline: boolean; queue: OfflineQueueEntry[] }>;
        setMode: (offline: boolean) => Promise<{ offline: boolean }>;
        flushQueue: () => Promise<{ applied: number; conflicts: ConflictItem[]; errors: unknown[] }>;
        discardEntry: (entryId: string) => Promise<{ success: boolean }>;
        resolveConflicts: (resolutions: ConflictResolution[]) => Promise<{ success: boolean; results: unknown[] }>;
        onStatusChanged: (cb: (data: { offline: boolean; queueLength: number }) => void) => void;
        onQueueUpdated: (cb: (data: { queue: OfflineQueueEntry[] }) => void) => void;
        onConflictsDetected: (cb: (data: { conflicts: ConflictItem[] }) => void) => void;
        removeListeners: () => void;
      };
      primary: {
        getAll: () => Promise<string[]>;
        setAll: (items: string[]) => Promise<boolean>;
      };
      usage: {
        increment: (itemId: string) => Promise<number>;
        getAll: () => Promise<Record<string, number>>;
      };
      app: {
        getStore: (key: string) => Promise<unknown>;
        setStore: (key: string, value: unknown) => Promise<boolean>;
        notify: (title: string, body: string) => Promise<boolean>;
        openExternal: (url: string) => Promise<void>;
        getVersion: () => Promise<string>;
      };
      on: (channel: string, callback: (...args: unknown[]) => void) => void;
      removeListener: (channel: string, callback: (...args: unknown[]) => void) => void;
    };
  }
}

@Injectable({ providedIn: 'root' })
export class VaultService {
  private readonly _items = signal<VaultItem[]>([]);
  private readonly _folders = signal<Folder[]>([]);
  private readonly _syncing = signal(false);
  private readonly _lastSynced = signal<Date | null>(null);
  private readonly _searchQuery = signal('');
  private readonly _authStatus = signal<AuthStatus>('locked');

  readonly items = this._items.asReadonly();
  readonly folders = this._folders.asReadonly();
  readonly syncing = this._syncing.asReadonly();
  readonly lastSynced = this._lastSynced.asReadonly();
  readonly searchQuery = this._searchQuery.asReadonly();
  readonly authStatus = this._authStatus.asReadonly();
  readonly isUnlocked = computed(() => this._authStatus() === 'unlocked');

  readonly filteredItems = computed(() => {
    const q = this._searchQuery().toLowerCase();
    if (!q) return this._items();
    return this._items().filter(item =>
      item.name.toLowerCase().includes(q) ||
      (item.username?.toLowerCase().includes(q)) ||
      (item.website?.toLowerCase().includes(q))
    );
  });

  readonly stats = computed<VaultStats>(() => {
    const items = this._items();
    const now = new Date();
    const in30Days = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    const logins = items.filter(i => i.type === 'login');
    const withStrong = logins.filter(i => (i.passwordStrength ?? 0) >= 80).length;
    const withTotp = logins.filter(i => i.totp).length;
    const expiring = items.filter(i => {
      if (!i.expiresAt) return false;
      const d = new Date(i.expiresAt);
      return d <= in30Days;
    }).length;

    const tags = this.allTags();

    return {
      totalItems: items.length,
      expiringSoon: expiring,
      tagCount: tags.length,
      lastBackup: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      securityScore: logins.length > 0
        ? Math.round((withStrong / logins.length) * 100 * 0.5 + (withTotp / logins.length) * 100 * 0.5)
        : 0,
      strongPasswords: logins.length > 0 ? Math.round((withStrong / logins.length) * 100) : 0,
      twoFAEnabled: logins.length > 0 ? Math.round((withTotp / logins.length) * 100) : 0,
      noDuplicates: 95,
      recentlyUpdated: 78,
    };
  });

  readonly allTags = computed<Tag[]>(() => {
    const items = this._items();
    const tagMap = new Map<string, { count: number; color: string }>();
    const colors = ['#ef4444', '#3b82f6', '#f59e0b', '#ec4899', '#22c55e', '#a855f7', '#f97316', '#06b6d4'];

    items.forEach(item => {
      item.tags.forEach(tag => {
        if (!tagMap.has(tag)) {
          tagMap.set(tag, { count: 0, color: colors[tagMap.size % colors.length] });
        }
        tagMap.get(tag)!.count++;
      });
    });

    return Array.from(tagMap.entries()).map(([name, { count, color }]) => ({
      name, color, itemCount: count
    }));
  });

  readonly expiringItems = computed(() => {
    const now = new Date();
    return this._items()
      .filter(i => i.expiresAt)
      .map(item => ({ item, status: this.getExpiryStatus(item) }))
      .filter(({ status }) => status !== 'ok')
      .sort((a, b) => new Date(a.item.expiresAt!).getTime() - new Date(b.item.expiresAt!).getTime());
  });

  readonly recentActivity = computed<RecentActivity[]>(() => []);

  getExpiryStatus(item: VaultItem): ExpiryStatus {
    if (!item.expiresAt) return 'ok';
    const now = new Date();
    const exp = new Date(item.expiresAt);
    if (exp < now) return 'expired';
    const diff = exp.getTime() - now.getTime();
    const days = diff / (1000 * 60 * 60 * 24);
    if (days <= 7) return 'this-week';
    if (days <= 30) return 'this-month';
    return 'ok';
  }

  getDaysUntilExpiry(item: VaultItem): number | null {
    if (!item.expiresAt) return null;
    const diff = new Date(item.expiresAt).getTime() - Date.now();
    return Math.ceil(diff / (1000 * 60 * 60 * 24));
  }

  async checkAuthStatus(): Promise<AuthStatus> {
    if (!window.electronAPI) {
      this._authStatus.set('unlocked');
      return 'unlocked';
    }
    try {
      const result = await window.electronAPI.vault.status();
      const status = result.status?.status ?? 'unauthenticated';
      if (status === 'unlocked') {
        this._authStatus.set('unlocked');
        return 'unlocked';
      } else if (status === 'locked') {
        this._authStatus.set('locked');
        return 'locked';
      } else {
        this._authStatus.set('unauthenticated');
        return 'unauthenticated';
      }
    } catch {
      this._authStatus.set('unauthenticated');
      return 'unauthenticated';
    }
  }

  async login(email: string, password: string, serverUrl?: string): Promise<{ success: boolean; requiresTwoFactor?: boolean; error?: string }> {
    if (!window.electronAPI) return { success: false, error: 'Not running in Electron' };
    const result = await window.electronAPI.vault.login(email, password, serverUrl);
    if (result.success) {
      this._authStatus.set('unlocked');
      this.loadItems().catch(() => {});
      this.loadFolders().catch(() => {});
    }
    return result;
  }

  async login2fa(code: string, method = 0): Promise<{ success: boolean; error?: string }> {
    if (!window.electronAPI) return { success: false, error: 'Not running in Electron' };
    const result = await window.electronAPI.vault.login2fa(code, method);
    if (result.success) {
      this._authStatus.set('unlocked');
      this.loadItems().catch(() => {});
      this.loadFolders().catch(() => {});
    }
    return result;
  }

  async unlock(password: string): Promise<{ success: boolean; error?: string }> {
    if (!window.electronAPI) return { success: false, error: 'Not running in Electron' };
    const result = await window.electronAPI.vault.unlock(password);
    if (result.success) {
      this._authStatus.set('unlocked');
      this.loadItems().catch(() => {});
      this.loadFolders().catch(() => {});
    }
    return result;
  }

  async lock(): Promise<void> {
    if (window.electronAPI) {
      await window.electronAPI.vault.lock();
    }
    this._authStatus.set('locked');
    this._items.set([]);
  }

  async logout(): Promise<void> {
    if (window.electronAPI) {
      await window.electronAPI.vault.logout();
    }
    this._authStatus.set('unauthenticated');
    this._items.set([]);
  }

  async loadItems(): Promise<void> {
    if (window.electronAPI) {
      const items = await window.electronAPI.vault.getItems();
      this._items.set(items);
    }
  }

  async loadFolders(): Promise<void> {
    if (window.electronAPI) {
      const folders = await window.electronAPI.vault.getFolders();
      this._folders.set(folders);
    }
  }

  /** Persist changes to a vault item (credentials + metadata). */
  async updateItemMeta(id: string, patch: {
    name?: string; username?: string; password?: string; website?: string; notes?: string;
    tags?: string[]; expiresAt?: string | null; folderId?: string | null;
  }): Promise<{ success: boolean; error?: string }> {
    if (!window.electronAPI) return { success: false, error: 'Not running in Electron' };
    const result = await window.electronAPI.vault.editItem(id, {
      name: patch.name,
      username: patch.username,
      password: patch.password,
      website: patch.website,
      notes: patch.notes,
      tags: patch.tags,
      expiresAt: patch.expiresAt ?? null,
      folderId: patch.folderId ?? null,
    });
    if (result.success) {
      this._items.update(items => items.map(item => {
        if (item.id !== id) return item;
        return {
          ...item,
          ...(patch.name !== undefined ? { name: patch.name! } : {}),
          ...(patch.username !== undefined ? { username: patch.username ?? null } : {}),
          ...(patch.password !== undefined ? { password: patch.password ?? null } : {}),
          ...(patch.website !== undefined ? { website: patch.website ?? null } : {}),
          ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
          ...(patch.tags !== undefined ? { tags: patch.tags! } : {}),
          ...(patch.expiresAt !== undefined ? { expiresAt: patch.expiresAt } : {}),
          ...(patch.folderId !== undefined ? { folderId: patch.folderId } : {}),
        };
      }));
    }
    return result;
  }

  async createItem(data: {
    type: 'login' | 'note';
    name: string;
    username?: string;
    password?: string;
    website?: string;
    notes?: string;
    folderId?: string | null;
    templateId?: string | null;
    templateFields?: { name: string; type: 'text' | 'hidden' | 'boolean' | 'url'; value: string }[];
  }): Promise<{ success: boolean; error?: string }> {
    if (!window.electronAPI) return { success: false, error: 'Not running in Electron' };

    // Build Bitwarden custom fields: template marker + template field values
    const fields: { name: string; value: string; type: number }[] = [];
    if (data.templateId) {
      fields.push({ name: '_dw_template', value: data.templateId, type: 0 });
    }
    if (data.templateFields) {
      data.templateFields.forEach(f => {
        // Bitwarden field types: 0 = text, 1 = hidden, 2 = boolean
        const bwType = f.type === 'hidden' ? 1 : f.type === 'boolean' ? 2 : 0;
        fields.push({ name: f.name, value: f.value, type: bwType });
      });
    }

    const bwItem: Record<string, unknown> = {
      organizationId: null,
      collectionIds: [],
      folderId: data.folderId || null,
      type: data.type === 'login' ? 1 : 2,
      name: data.name,
      notes: data.notes || null,
      favorite: false,
      fields,
      reprompt: 0,
    };

    if (data.type === 'login') {
      bwItem['login'] = {
        uris: data.website ? [{ match: null, uri: data.website }] : [],
        username: data.username || null,
        password: data.password || null,
        totp: null,
      };
      bwItem['secureNote'] = null;
      bwItem['card'] = null;
      bwItem['identity'] = null;
    } else {
      bwItem['login'] = null;
      bwItem['secureNote'] = { type: 0 };
      bwItem['card'] = null;
      bwItem['identity'] = null;
    }

    const result = await window.electronAPI.vault.createItem(bwItem);
    if (result.success && result.item) {
      this._items.update(items => [result.item!, ...items]);
    }
    return result;
  }

  async sync(): Promise<void> {
    this._syncing.set(true);
    try {
      if (window.electronAPI) {
        await window.electronAPI.vault.sync();
        await this.loadItems();
      }
      this._lastSynced.set(new Date());
    } finally {
      this._syncing.set(false);
    }
  }

  updateItem(id: string, patch: Partial<VaultItem>): void {
    this._items.update(items =>
      items.map(item => item.id === id ? { ...item, ...patch } : item)
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    window.electronAPI?.vault.editItem(id, patch as any);
  }

  setSearch(query: string): void {
    this._searchQuery.set(query);
  }

  getItemsByTag(tag: string): VaultItem[] {
    return this._items().filter(i => i.tags.includes(tag));
  }

  getItemsByFolder(folder: string): VaultItem[] {
    return this._items().filter(i => i.folderId === folder);
  }

  // ── Folder CRUD ────────────────────────────────────────────────────────────

  async createFolder(name: string): Promise<{ success: boolean; folder?: Folder; error?: string }> {
    if (!window.electronAPI) return { success: false, error: 'Not running in Electron' };
    const result = await window.electronAPI.folder.create(name);
    if (result.success && result.folder) {
      this._folders.update(list => [...list, result.folder!]);
    }
    return result;
  }

  async renameFolder(id: string, newName: string): Promise<{ success: boolean; error?: string }> {
    if (!window.electronAPI) return { success: false, error: 'Not running in Electron' };
    const result = await window.electronAPI.folder.rename(id, newName);
    if (result.success) {
      this._folders.update(list => list.map(f => f.id === id ? { ...f, name: newName } : f));
    }
    return result;
  }

  async deleteFolder(id: string): Promise<{ success: boolean; error?: string }> {
    if (!window.electronAPI) return { success: false, error: 'Not running in Electron' };
    const result = await window.electronAPI.folder.delete(id);
    if (result.success) {
      this._folders.update(list => list.filter(f => f.id !== id));
    }
    return result;
  }

  async moveFolderTree(oldPath: string, newPath: string): Promise<{ success: boolean; error?: string }> {
    if (!window.electronAPI) return { success: false, error: 'Not running in Electron' };
    const allFolders = this._folders();
    const result = await window.electronAPI.folder.move(allFolders, oldPath, newPath);
    if (result.success) {
      // Update local signal: rename all affected paths
      this._folders.update(list => list.map(f => {
        if (f.name === oldPath) return { ...f, name: newPath };
        if (f.name.startsWith(oldPath + '/')) {
          return { ...f, name: newPath + f.name.slice(oldPath.length) };
        }
        return f;
      }));
    }
    return result;
  }

  // ── Expiry policies ────────────────────────────────────────────────────────

  async getExpiryPolicies(): Promise<ExpiryPolicy[]> {
    if (!window.electronAPI) return [];
    return window.electronAPI.vault.getExpiryPolicies();
  }

  async setExpiryPolicies(policies: ExpiryPolicy[]): Promise<boolean> {
    if (!window.electronAPI) return false;
    return window.electronAPI.vault.setExpiryPolicies(policies);
  }

  /** Items flagged by a policy based on lastModified age vs thresholdDays */
  getPolicyFlaggedItems(items: VaultItem[], policy: ExpiryPolicy): VaultItem[] {
    if (!policy.enabled) return [];
    const cutoff = new Date(Date.now() - policy.thresholdDays * 24 * 60 * 60 * 1000);
    return items.filter(item => {
      if (!policy.itemTypes.includes(item.type)) return false;
      const modified = item.lastModified ? new Date(item.lastModified) : null;
      if (!modified) return false;
      return modified < cutoff;
    });
  }

  // ── Account profiles ───────────────────────────────────────────────────────

  async getAccountProfiles(): Promise<AccountProfile[]> {
    if (!window.electronAPI) return [];
    return window.electronAPI.account.getProfiles();
  }

  async addAccountProfile(profile: Omit<AccountProfile, 'id' | 'color'>): Promise<AccountProfile | null> {
    if (!window.electronAPI) return null;
    return window.electronAPI.account.addProfile(profile);
  }

  async removeAccountProfile(id: string): Promise<boolean> {
    if (!window.electronAPI) return false;
    return window.electronAPI.account.removeProfile(id);
  }

  async updateAccountProfile(id: string, patch: Partial<AccountProfile>): Promise<boolean> {
    if (!window.electronAPI) return false;
    return window.electronAPI.account.updateProfile(id, patch);
  }

  async getActiveAccountId(): Promise<string | null> {
    if (!window.electronAPI) return null;
    return window.electronAPI.account.getActive();
  }

  async switchAccount(id: string): Promise<{ success: boolean; error?: string }> {
    if (!window.electronAPI) return { success: false, error: 'Not in Electron' };
    const result = await window.electronAPI.account.switch(id);
    if (result.success) {
      this._authStatus.set('locked');
      this._items.set([]);
    }
    return result;
  }

  // ── Snapshots ──────────────────────────────────────────────────────────────

  async getSnapshots(): Promise<VaultSnapshot[]> {
    if (!window.electronAPI) return [];
    return window.electronAPI.snapshot.getAll();
  }

  async saveSnapshot(label: string): Promise<{ success: boolean; snapshot?: VaultSnapshot; error?: string }> {
    if (!window.electronAPI) return { success: false, error: 'Not in Electron' };
    return window.electronAPI.snapshot.saveManual(label);
  }

  async deleteSnapshot(id: string): Promise<boolean> {
    if (!window.electronAPI) return false;
    return window.electronAPI.snapshot.delete(id);
  }

  async diffSnapshots(idA: string, idB: string): Promise<{ success: boolean; diff?: SnapshotDiff; error?: string }> {
    if (!window.electronAPI) return { success: false, error: 'Not in Electron' };
    return window.electronAPI.snapshot.diff(idA, idB);
  }

  // ── Custom Icons ───────────────────────────────────────────────────────────

  async getCustomIcons(): Promise<Record<string, CustomIcon>> {
    if (!window.electronAPI) return {};
    return window.electronAPI.icon.getAll();
  }

  async setCustomIcon(itemId: string, icon: CustomIcon): Promise<boolean> {
    if (!window.electronAPI) return false;
    return window.electronAPI.icon.set(itemId, icon);
  }

  async removeCustomIcon(itemId: string): Promise<boolean> {
    if (!window.electronAPI) return false;
    return window.electronAPI.icon.remove(itemId);
  }
}
