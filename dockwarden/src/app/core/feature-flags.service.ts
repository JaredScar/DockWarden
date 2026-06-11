import { Injectable, signal, computed } from '@angular/core';

export interface FeatureFlags {
  watchtower: boolean;
  expiry: boolean;
  totp: boolean;
  tags: boolean;
  smartViews: boolean;
  backup: boolean;
  accounts: boolean;
  templates: boolean;
  folders: boolean;
  quickLauncher: boolean;
  autoType: boolean;
  customIcons: boolean;
}

export interface FeatureMeta {
  key: keyof FeatureFlags;
  label: string;
  icon: string;
  description: string;
  restartRequired?: boolean;
}

export const FEATURE_META: FeatureMeta[] = [
  {
    key: 'watchtower',
    label: 'Watchtower',
    icon: 'fas fa-shield-halved',
    description: 'Security scanner: breach detection, weak & reused passwords, HIBP checks, and insecure URIs.',
  },
  {
    key: 'expiry',
    label: 'Expiry Tracker',
    icon: 'fas fa-calendar-xmark',
    description: 'Track password expiry dates and enforce rotation policies across your vault.',
  },
  {
    key: 'totp',
    label: 'TOTP Codes',
    icon: 'fas fa-clock-rotate-left',
    description: 'Built-in TOTP authenticator with live countdown timers. Copy codes with a single click.',
  },
  {
    key: 'tags',
    label: 'Tags',
    icon: 'fas fa-tags',
    description: 'Organize vault items with custom tags and the bulk tag editor. Tags appear in the sidebar.',
  },
  {
    key: 'smartViews',
    label: 'Smart Views',
    icon: 'fas fa-layer-group',
    description: 'Create and pin saved filter combinations (type, tag, folder) for instant vault segments.',
  },
  {
    key: 'backup',
    label: 'Backups & Snapshots',
    icon: 'fas fa-database',
    description: 'Automated encrypted vault backups on a schedule, plus manual point-in-time snapshots.',
  },
  {
    key: 'accounts',
    label: 'Multi-Account',
    icon: 'fas fa-users',
    description: 'Switch between multiple Bitwarden accounts. Color-coded profiles appear in the sidebar header.',
  },
  {
    key: 'templates',
    label: 'Item Templates',
    icon: 'fas fa-file-lines',
    description: 'Reusable item templates for quick vault entry creation with pre-filled custom fields.',
  },
  {
    key: 'folders',
    label: 'Folders',
    icon: 'fas fa-folder-tree',
    description: 'Hierarchical folder tree in the sidebar with drag-and-drop item organization.',
  },
  {
    key: 'quickLauncher',
    label: 'Quick Launcher',
    icon: 'fas fa-magnifying-glass',
    description: 'Global floating search popup (Ctrl+Alt+\\) that lets you find and copy items instantly.',
    restartRequired: true,
  },
  {
    key: 'autoType',
    label: 'Auto-Type',
    icon: 'fas fa-keyboard',
    description: 'Automatically type usernames and passwords into any focused application via a hotkey.',
    restartRequired: true,
  },
  {
    key: 'customIcons',
    label: 'Custom Icons',
    icon: 'fas fa-image',
    description: 'Set custom icons on individual vault items for quick visual identification.',
  },
];

const STORE_KEY = 'featureFlags';

const DEFAULT_FLAGS: FeatureFlags = {
  watchtower: true,
  expiry: true,
  totp: true,
  tags: true,
  smartViews: true,
  backup: true,
  accounts: true,
  templates: true,
  folders: true,
  quickLauncher: true,
  autoType: true,
  customIcons: true,
};

@Injectable({ providedIn: 'root' })
export class FeatureFlagsService {
  private readonly _flags = signal<FeatureFlags>({ ...DEFAULT_FLAGS });

  readonly flags = this._flags.asReadonly();

  // Per-feature convenience computed signals
  readonly watchtower    = computed(() => this._flags().watchtower);
  readonly expiry        = computed(() => this._flags().expiry);
  readonly totp          = computed(() => this._flags().totp);
  readonly tags          = computed(() => this._flags().tags);
  readonly smartViews    = computed(() => this._flags().smartViews);
  readonly backup        = computed(() => this._flags().backup);
  readonly accounts      = computed(() => this._flags().accounts);
  readonly templates     = computed(() => this._flags().templates);
  readonly folders       = computed(() => this._flags().folders);
  readonly quickLauncher = computed(() => this._flags().quickLauncher);
  readonly autoType      = computed(() => this._flags().autoType);
  readonly customIcons   = computed(() => this._flags().customIcons);

  readonly meta = FEATURE_META;

  async load(): Promise<void> {
    if (!window.electronAPI) return;
    const saved = await window.electronAPI.vault.getSetting(STORE_KEY, null) as Partial<FeatureFlags> | null;
    if (saved && typeof saved === 'object') {
      this._flags.set({ ...DEFAULT_FLAGS, ...saved });
    }
  }

  async setFlag(key: keyof FeatureFlags, value: boolean): Promise<void> {
    this._flags.update(f => ({ ...f, [key]: value }));
    if (window.electronAPI) {
      await window.electronAPI.vault.setSetting(STORE_KEY, this._flags());
    }
  }
}
