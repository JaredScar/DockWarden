import zxcvbn from 'zxcvbn';
import { VaultItem, BackupJob, ChangeRecord } from '../shared/models';
import { AccountProfile, CustomIcon, ExpiryPolicy, Folder } from '../core/vault.service';
import { isDemoSession, markDemoSession } from './demo-mode';

interface ScanItem {
  id: string;
  name: string;
  username?: string | null;
  password?: string | null;
  uris?: string[];
  totpUri?: string | null;
}

const BREACHED = new Set(['password', 'password123', '123456', 'qwerty']);

const TOTP_DOMAINS = new Set([
  'google.com', 'github.com', 'aws.amazon.com', 'amazon.com', 'slack.com',
  'stripe.com', 'figma.com', 'dropbox.com', 'microsoft.com', 'apple.com',
]);

function isoDays(offset: number): string {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  return d.toISOString();
}

function item(partial: VaultItem): VaultItem {
  return partial;
}

function seedItems(): VaultItem[] {
  const totp = 'otpauth://totp/DockWarden?secret=JBSWY3DPEHPK3PXP&issuer=DockWarden';
  return [
    item({
      id: 'item-nintendo',
      name: 'accounts.nintendo.com',
      username: 'thewolfbadger@gmail.com',
      password: 'Nintendo-Demo-Only-18',
      website: 'https://accounts.nintendo.com',
      type: 'login',
      tags: ['personal'],
      totp: null,
      expiresAt: null,
      folderId: 'fld-games',
      favorite: false,
      notes: '',
      lastModified: isoDays(-12),
      createdAt: isoDays(-400),
      passwordStrength: 84,
    }),
    item({
      id: 'item-amazon',
      name: 'Amazon',
      username: 'me@example.com',
      password: 'Amazon-Demo-Only-22',
      website: 'https://www.amazon.com',
      type: 'login',
      tags: ['finance'],
      totp: null,
      expiresAt: null,
      folderId: null,
      favorite: false,
      notes: '',
      lastModified: isoDays(-20),
      createdAt: isoDays(-500),
      passwordStrength: 80,
    }),
    item({
      id: 'item-kick',
      name: 'auth.li-kick.com',
      username: 'thewolfbadger@gmail.com',
      password: 'Kick-Demo-Only-44',
      website: 'https://auth.li-kick.com',
      type: 'login',
      tags: ['personal'],
      totp: null,
      expiresAt: isoDays(-3),
      folderId: 'fld-games',
      favorite: false,
      notes: '',
      lastModified: isoDays(-40),
      createdAt: isoDays(-300),
      passwordStrength: 78,
    }),
    item({
      id: 'item-rippling',
      name: 'Bitwarden Rippling',
      username: 'jared',
      password: 'Rippling-Demo-Only-91',
      website: 'https://app.rippling.com',
      type: 'login',
      tags: ['work'],
      totp,
      expiresAt: null,
      folderId: 'fld-work',
      favorite: false,
      notes: '',
      lastModified: isoDays(-6),
      createdAt: isoDays(-200),
      passwordStrength: 88,
    }),
    item({
      id: 'item-bbb',
      name: 'builtbybit.com',
      username: 'badger',
      password: 'BBB-Demo-Only-15',
      website: 'https://builtbybit.com',
      type: 'login',
      tags: ['personal'],
      totp: null,
      expiresAt: null,
      folderId: 'fld-games',
      favorite: false,
      notes: '',
      lastModified: isoDays(-15),
      createdAt: isoDays(-180),
      passwordStrength: 76,
    }),
    item({
      id: 'item-cloudflare',
      name: 'Cloudflare API token',
      username: null,
      password: null,
      website: null,
      type: 'note',
      tags: ['work', 'api-keys', 'servers'],
      totp: null,
      expiresAt: null,
      folderId: 'fld-work',
      favorite: false,
      notes: 'Demo API token. Not a real credential.',
      lastModified: isoDays(-8),
      createdAt: isoDays(-90),
      passwordStrength: null,
    }),
    item({
      id: 'item-discord',
      name: 'Discord',
      username: 'badger#0001',
      password: 'Discord-Demo-Only-33',
      website: 'https://discord.com',
      type: 'login',
      tags: ['social'],
      totp: null,
      expiresAt: null,
      folderId: 'fld-games',
      favorite: true,
      notes: '',
      lastModified: isoDays(-2),
      createdAt: isoDays(-600),
      passwordStrength: 82,
    }),
    item({
      id: 'item-github',
      name: 'GitHub',
      username: 'jaredscar',
      password: 'password',
      website: 'https://github.com',
      type: 'login',
      tags: ['work', 'important'],
      totp,
      expiresAt: null,
      folderId: 'fld-work',
      favorite: true,
      notes: '',
      lastModified: isoDays(-1),
      createdAt: isoDays(-700),
      passwordStrength: 12,
    }),
    item({
      id: 'item-nfo',
      name: 'nfoServers',
      username: 'badger',
      password: 'Nfo-Demo-Only-70',
      website: null,
      type: 'login',
      tags: ['servers', 'work'],
      totp: null,
      expiresAt: isoDays(5),
      folderId: 'fld-servers',
      favorite: false,
      notes: '',
      lastModified: isoDays(-9),
      createdAt: isoDays(-250),
      passwordStrength: 80,
    }),
    item({
      id: 'item-steam',
      name: 'Steam',
      username: 'badgerdev',
      password: 'Steam-Demo-Only-61',
      website: 'https://store.steampowered.com',
      type: 'login',
      tags: ['personal'],
      totp: null,
      expiresAt: isoDays(20),
      folderId: 'fld-games',
      favorite: false,
      notes: '',
      lastModified: isoDays(-11),
      createdAt: isoDays(-800),
      passwordStrength: 84,
    }),
    item({
      id: 'item-stripe',
      name: 'Stripe',
      username: 'jared@li-kick.com',
      password: 'Stripe-Demo-Only-28',
      website: 'https://stripe.com',
      type: 'login',
      tags: ['finance'],
      totp,
      expiresAt: null,
      folderId: null,
      favorite: false,
      notes: '',
      lastModified: isoDays(-4),
      createdAt: isoDays(-120),
      passwordStrength: 86,
    }),
    item({
      id: 'item-ovh',
      name: 'us.ovhcloud.com',
      username: 'thewolfbadger@gmail.com',
      password: 'Ovh-Demo-Only-19',
      website: 'https://us.ovhcloud.com',
      type: 'login',
      tags: ['servers'],
      totp: null,
      expiresAt: null,
      folderId: 'fld-servers',
      favorite: false,
      notes: '',
      lastModified: isoDays(-18),
      createdAt: isoDays(-340),
      passwordStrength: 80,
    }),
  ];
}

function seedFolders(): Folder[] {
  return [
    { id: 'fld-servers', name: 'Servers' },
    { id: 'fld-games', name: 'Game hosts' },
    { id: 'fld-work', name: 'Work' },
  ];
}

function seedAccounts(): AccountProfile[] {
  return [
    {
      id: 'acct-demo',
      name: 'Personal',
      email: 'thewolfbadger@gmail.com',
      serverUrl: 'https://vault.bitwarden.com',
      color: 'linear-gradient(135deg, #6d5efc, #8b5cf6)',
    },
    {
      id: 'acct-work',
      name: 'Work',
      email: 'ada@example.com',
      serverUrl: 'https://vault.bitwarden.com',
      color: '#22c55e',
    },
  ];
}


function seedPolicies(): ExpiryPolicy[] {
  return [
    {
      id: 'policy-90',
      name: '90-day rotation',
      description: 'Flag logins that have not been updated in 90 days',
      type: 'password-age',
      thresholdDays: 90,
      itemTypes: ['login'],
      enabled: true,
      notifyDaysBefore: 14,
    },
    {
      id: 'policy-1year',
      name: 'Annual Review',
      description: 'Flag credentials not updated in 365 days',
      type: 'password-age',
      thresholdDays: 365,
      itemTypes: ['login', 'card'],
      enabled: false,
      notifyDaysBefore: 30,
    },
  ];
}

function hostOf(uri: string): string | null {
  try {
    return new URL(uri).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function scanDemo(items: ScanItem[]) {
  const now = Date.now();
  const findings: Array<Record<string, unknown>> = [];

  for (const item of items) {
    if (item.password && BREACHED.has(item.password)) {
      findings.push({
        id: `breach-${item.id}`,
        category: 'breached_password',
        severity: 'critical',
        vaultItemId: item.id,
        vaultItemName: item.name,
        vaultItemUri: item.uris?.[0] ?? null,
        message: 'Password found in a known data breach',
        detail: 'Demo flag for a well-known weak password. No breach API was contacted.',
        actionLabel: 'Change Password',
        dismissedAt: null,
        snoozedUntil: null,
        detectedAt: now,
      });
    }
  }

  for (const item of items) {
    if (!item.password) continue;
    const result = zxcvbn(item.password, item.username ? [item.username] : []);
    if (result.score <= 1) {
      const crackTime = result.crack_times_display?.offline_slow_hashing_1e4_per_second ?? 'unknown';
      findings.push({
        id: `weak-${item.id}`,
        category: 'weak_password',
        severity: 'high',
        vaultItemId: item.id,
        vaultItemName: item.name,
        vaultItemUri: item.uris?.[0] ?? null,
        message: `Weak password — estimated crack time: ${crackTime}`,
        detail: result.feedback?.warning ?? null,
        actionLabel: 'Generate Stronger',
        dismissedAt: null,
        snoozedUntil: null,
        detectedAt: now,
      });
    }
  }

  const groups = new Map<string, ScanItem[]>();
  for (const item of items) {
    if (!item.password) continue;
    const list = groups.get(item.password) ?? [];
    list.push(item);
    groups.set(item.password, list);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const item of group) {
      const others = group.filter(g => g.id !== item.id).map(g => g.name).join(', ');
      findings.push({
        id: `reused-${item.id}`,
        category: 'reused_password',
        severity: 'medium',
        vaultItemId: item.id,
        vaultItemName: item.name,
        vaultItemUri: item.uris?.[0] ?? null,
        message: `Password reused across ${group.length} accounts`,
        detail: `Also used by: ${others}`,
        actionLabel: 'Change Password',
        dismissedAt: null,
        snoozedUntil: null,
        detectedAt: now,
      });
    }
  }

  for (const item of items) {
    for (const uri of item.uris ?? []) {
      if (!uri.startsWith('http://')) continue;
      const host = hostOf(uri);
      if (!host || host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local')) continue;
      findings.push({
        id: `http-${item.id}`,
        category: 'insecure_uri',
        severity: 'medium',
        vaultItemId: item.id,
        vaultItemName: item.name,
        vaultItemUri: uri,
        message: 'Login page uses unencrypted HTTP',
        detail: uri,
        actionLabel: 'Open Item',
        dismissedAt: null,
        snoozedUntil: null,
        detectedAt: now,
      });
      break;
    }
  }

  for (const item of items) {
    if (item.totpUri) continue;
    const matched = (item.uris ?? []).map(hostOf).find(host => host && TOTP_DOMAINS.has(host));
    if (!matched) continue;
    findings.push({
      id: `totp-${item.id}`,
      category: 'missing_totp',
      severity: 'low',
      vaultItemId: item.id,
      vaultItemName: item.name,
      vaultItemUri: item.uris?.[0] ?? null,
      message: `${matched} supports 2FA but none is configured`,
      detail: 'Adding TOTP significantly improves account security',
      actionLabel: 'Set Up 2FA',
      dismissedAt: null,
      snoozedUntil: null,
      detectedAt: now,
    });
  }

  const seen = new Map<string, ScanItem>();
  for (const item of items) {
    if (!item.username || !item.uris?.length) continue;
    const host = hostOf(item.uris[0]);
    if (!host) continue;
    const key = `${host}|${item.username.toLowerCase()}`;
    const original = seen.get(key);
    if (original) {
      findings.push({
        id: `dup-${item.id}`,
        category: 'duplicate_item',
        severity: 'info',
        vaultItemId: item.id,
        vaultItemName: item.name,
        vaultItemUri: item.uris[0],
        message: `Possible duplicate of "${original.name}"`,
        detail: `Both use ${item.username} on ${host}`,
        actionLabel: 'Review',
        dismissedAt: null,
        snoozedUntil: null,
        detectedAt: now,
      });
    } else {
      seen.set(key, item);
    }
  }

  return findings;
}

function scoreFindings(items: ScanItem[], findings: Array<Record<string, unknown>>) {
  const n = items.length || 1;
  const count = (cat: string) => findings.filter(f => f['category'] === cat).length;
  const breachFree = Math.max(0, Math.round(((n - count('breached_password')) / n) * 100));
  const strengthScore = Math.max(0, Math.round(((n - count('weak_password')) / n) * 100));
  const uniquenessScore = Math.max(0, Math.round(((n - count('reused_password')) / n) * 100));
  const httpsScore = Math.max(0, Math.round(((n - count('insecure_uri')) / n) * 100));
  const mfaCoverage = Math.max(0, Math.round(((n - count('missing_totp')) / n) * 100));
  const overall = Math.round(
    breachFree * 0.30 + strengthScore * 0.25 + uniquenessScore * 0.20 + httpsScore * 0.10 + mfaCoverage * 0.15,
  );
  return { overall, breachFree, strengthScore, uniquenessScore, httpsScore, mfaCoverage };
}

function mapCreatedItem(raw: Record<string, unknown>): VaultItem {
  const login = (raw['login'] ?? null) as { username?: string | null; password?: string | null; uris?: { uri?: string }[] } | null;
  const typeNum = raw['type'];
  const type = typeNum === 2 ? 'note' : 'login';
  const password = login?.password ?? null;
  return {
    id: `item-${crypto.randomUUID()}`,
    name: String(raw['name'] || 'Untitled'),
    username: login?.username ?? null,
    password,
    website: login?.uris?.[0]?.uri ?? null,
    type,
    tags: [],
    totp: null,
    expiresAt: null,
    folderId: (raw['folderId'] as string | null) ?? null,
    favorite: false,
    notes: (raw['notes'] as string | null) ?? '',
    lastModified: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    passwordStrength: password ? Math.min(100, password.length * 4) : null,
  };
}

function demoCode(itemId: string): string {
  const step = Math.floor(Date.now() / 30000);
  let n = step;
  for (const ch of itemId) n = (n * 33 + ch.charCodeAt(0)) >>> 0;
  return String(n % 1000000).padStart(6, '0');
}

/** In-memory vault used when the app is opened without a Bitwarden account. */
export function installDemoApi(): void {
  if (isDemoSession() && window.electronAPI) return;

  let items = seedItems();
  let folders = seedFolders();
  const accounts = seedAccounts();
  let activeAccountId = accounts[0].id;
  let unlocked = true;
  let policies = seedPolicies();
  let templates: unknown[] = [];
  const settings: Record<string, unknown> = {};
  const store: Record<string, unknown> = {};
  const usage: Record<string, number> = {
    'item-github': 24,
    'item-discord': 11,
    'item-nfo': 7,
    'item-stripe': 3,
  };
  let primary = ['item-github'];
  const icons: Record<string, CustomIcon> = {};
  let backupHistory: BackupJob[] = [
    { id: 'bak-1', timestamp: isoDays(0), destination: 'Local', size: '184 KB', status: 'success' },
    { id: 'bak-2', timestamp: isoDays(-1), destination: 'Local', size: '181 KB', status: 'success' },
    { id: 'bak-3', timestamp: isoDays(-8), destination: 'Local', size: '176 KB', status: 'success' },
  ];
  const changes: ChangeRecord[] = [
    {
      id: 'chg-1',
      itemId: 'item-github',
      itemName: 'GitHub',
      timestamp: isoDays(-1),
      origin: 'local',
      kind: 'modified',
      fields: [{ field: 'password', secret: true }],
      seen: false,
    },
    {
      id: 'chg-2',
      itemId: 'item-nfo',
      itemName: 'nfoServers',
      timestamp: isoDays(-4),
      origin: 'remote',
      kind: 'modified',
      fields: [{ field: 'expires', secret: false, before: isoDays(40).slice(0, 10), after: isoDays(6).slice(0, 10) }],
      seen: true,
    },
  ];

  let progressCb: ((progress: unknown) => void) | null = null;
  let resultsCb: ((results: unknown) => void) | null = null;

  const api = {
    vault: {
      getItems: async () => items.map(entry => ({ ...entry })),
      getCachedItems: async () => items.map(entry => ({ ...entry })),
      getFolders: async () => folders.map(folder => ({ ...folder })),
      getTotp: async (itemId: string) => {
        const found = items.find(entry => entry.id === itemId);
        if (!found?.totp) return { success: false, error: 'This item has no TOTP seed' };
        return { success: true, code: demoCode(itemId) };
      },
      sync: async () => ({ success: true, itemCount: items.length, syncedAt: new Date().toISOString() }),
      editItem: async (id: string, patch: Partial<VaultItem>) => {
        const idx = items.findIndex(entry => entry.id === id);
        if (idx < 0) return { success: false, error: 'Item not found' };
        items[idx] = { ...items[idx], ...patch, lastModified: new Date().toISOString() };
        return { success: true };
      },
      deleteItem: async (id: string) => {
        items = items.filter(entry => entry.id !== id);
        return { success: true };
      },
      mergeItems: async (keeperId: string, loserId: string, patch: object) => {
        const idx = items.findIndex(entry => entry.id === keeperId);
        if (idx < 0) return { success: false, error: 'Item not found' };
        items[idx] = { ...items[idx], ...(patch as Partial<VaultItem>), lastModified: new Date().toISOString() };
        items = items.filter(entry => entry.id !== loserId);
        return { success: true };
      },
      createItem: async (raw: object) => {
        const created = mapCreatedItem(raw as Record<string, unknown>);
        items = [created, ...items];
        return { success: true, item: created };
      },
      status: async () => ({ success: true, status: { status: unlocked ? 'unlocked' : 'locked' } }),
      login: async () => {
        unlocked = true;
        return { success: true };
      },
      login2fa: async () => ({ success: true }),
      unlock: async () => {
        unlocked = true;
        return { success: true };
      },
      lock: async () => {
        unlocked = false;
        return { success: true };
      },
      logout: async () => {
        unlocked = false;
        return { success: true };
      },
      getExpiryPolicies: async () => policies,
      setExpiryPolicies: async (next: ExpiryPolicy[]) => {
        policies = next;
        return true;
      },
      getSetting: async (key: string, defaultValue: unknown) =>
        Object.prototype.hasOwnProperty.call(settings, key) ? settings[key] : defaultValue,
      setSetting: async (key: string, value: unknown) => {
        settings[key] = value;
        return true;
      },
    },
    autotype: {
      send: async () => ({ success: false, error: 'Auto-type is unavailable in the demo vault.' }),
      getContext: async () => ({ title: 'DockWarden Demo', matches: [] }),
    },
    power: {
      runStatus: async () => ({ listening: false, example: 'node electron/dw-run.js run --env API_TOKEN=dw://GitHub/password -- npm start' }),
      getChanges: async () => changes,
      unseenCount: async () => changes.filter(change => !change.seen).length,
      markSeen: async () => {
        for (const change of changes) change.seen = true;
        return 0;
      },
      rotateUrl: async (website: string | null) => website,
      saveAutotypeRule: async () => ({ success: true, rules: [] }),
      showLargeType: async () => ({ success: false, error: 'Large type needs the desktop window.' }),
      getLargeType: async () => null,
      closeLargeType: async () => undefined,
    },
    launch: {
      ssh: async () => ({ success: false, error: 'Launch is unavailable in the demo vault.' }),
      rdp: async () => ({ success: false, error: 'Launch is unavailable in the demo vault.' }),
    },
    keepass: {
      pick: async () => ({ canceled: true }),
      preview: async () => ({ success: false, error: 'KeePass import is unavailable in the demo vault.' }),
      import: async () => ({ success: false, error: 'KeePass import is unavailable in the demo vault.' }),
      onProgress: () => undefined,
      removeListeners: () => undefined,
    },
    launcher: {
      close: () => undefined,
      navigateToItem: () => undefined,
      openSearch: async () => undefined,
      openAutotype: async () => undefined,
    },
    bw: {
      getConfig: async () => ({
        bwEmail: accounts.find(account => account.id === activeAccountId)?.email ?? 'demo@dockwarden.test',
        bwServerUrl: 'https://vault.bitwarden.com',
        bwCliPath: 'demo',
        isSessionActive: unlocked,
      }),
      setCliPath: async () => true,
      checkCli: async () => ({ success: true, version: 'demo' }),
      autoDetect: async () => ({ found: true, path: 'demo' }),
    },
    backup: {
      runNow: async () => {
        const timestamp = new Date().toISOString();
        backupHistory = [
          { id: `bak-${Date.now()}`, timestamp, destination: 'Local', size: '186 KB', status: 'success' },
          ...backupHistory,
        ];
        return { success: true, timestamp, size: '186 KB' };
      },
      getHistory: async () => backupHistory,
      getDir: async () => 'C:\\Users\\Demo\\Documents\\DockWarden\\backups',
      setDir: async () => ({ success: true }),
    },
    account: {
      getProfiles: async () => accounts,
      addProfile: async (profile: Omit<AccountProfile, 'id' | 'color'>) => {
        const created: AccountProfile = { ...profile, id: `acct-${Date.now()}`, color: '#a855f7' };
        accounts.push(created);
        return created;
      },
      updateProfile: async (id: string, patch: Partial<AccountProfile>) => {
        const idx = accounts.findIndex(account => account.id === id);
        if (idx >= 0) accounts[idx] = { ...accounts[idx], ...patch };
        return true;
      },
      removeProfile: async (id: string) => {
        const idx = accounts.findIndex(account => account.id === id);
        if (idx >= 0) accounts.splice(idx, 1);
        return true;
      },
      getActive: async () => activeAccountId,
      setActive: async (id: string) => {
        activeAccountId = id;
        return true;
      },
      switch: async (id: string) => {
        activeAccountId = id;
        unlocked = true;
        return { success: true, alreadyUnlocked: true };
      },
      getSessionStates: async () => {
        const states: Record<string, 'unlocked' | 'locked'> = {};
        for (const account of accounts) states[account.id] = account.id === activeAccountId && unlocked ? 'unlocked' : 'locked';
        return states;
      },
      addLogin: async () => ({ success: true }),
    },
    snapshot: {
      getAll: async () => ([
        { id: 'snap-a', label: 'Before cleanup', timestamp: isoDays(-7), itemCount: items.length - 1 },
        { id: 'snap-b', label: 'This morning', timestamp: isoDays(0), itemCount: items.length },
      ]),
      saveManual: async (label: string) => ({
        success: true,
        snapshot: { id: `snap-${Date.now()}`, label, timestamp: new Date().toISOString(), itemCount: items.length },
      }),
      delete: async () => true,
      diff: async () => ({
        success: true,
        diff: {
          added: [{ id: 'item-npm', name: 'npm publish token', type: 'login', lastModified: isoDays(-4), folderId: 'fld-work' }],
          deleted: [],
          modified: [],
          unchanged: items.length - 1,
          snapA: { label: 'Before cleanup', timestamp: isoDays(-7) },
          snapB: { label: 'This morning', timestamp: isoDays(0) },
        },
      }),
    },
    icon: {
      getAll: async () => ({ ...icons }),
      set: async (itemId: string, icon: CustomIcon) => {
        icons[itemId] = icon;
        return true;
      },
      remove: async (itemId: string) => {
        delete icons[itemId];
        return true;
      },
    },
    folder: {
      create: async (name: string) => {
        const folder = { id: `fld-${crypto.randomUUID()}`, name };
        folders = [...folders, folder];
        return { success: true, folder };
      },
      rename: async (id: string, name: string) => {
        folders = folders.map(folder => folder.id === id ? { ...folder, name } : folder);
        return { success: true };
      },
      delete: async (id: string) => {
        folders = folders.filter(folder => folder.id !== id);
        return { success: true };
      },
      move: async () => ({ success: true }),
    },
    template: {
      getAll: async () => templates,
      save: async (template: { id: string }) => {
        const idx = templates.findIndex(entry => (entry as { id: string }).id === template.id);
        if (idx >= 0) templates[idx] = template;
        else templates = [...templates, template];
        return true;
      },
      delete: async (id: string) => {
        templates = templates.filter(entry => (entry as { id: string }).id !== id);
        return true;
      },
    },
    watchtower: {
      startScan: async (serialized: unknown) => {
        const list = Array.isArray(serialized) ? serialized as ScanItem[] : [];
        const startedAt = Date.now();
        progressCb?.({ phase: 'checking_breaches', totalItems: list.length, processedItems: list.length, startedAt });
        const findings = scanDemo(list);
        resultsCb?.({
          findings,
          scannedAt: Date.now(),
          scannedItemCount: list.length,
          scanDurationMs: Date.now() - startedAt,
          scores: scoreFindings(list, findings),
        });
        return { success: true };
      },
      onScanProgress: (callback: (progress: unknown) => void) => { progressCb = callback; },
      onScanResults: (callback: (results: unknown) => void) => { resultsCb = callback; },
      cancelScan: () => undefined,
      updateBadge: () => undefined,
      removeListeners: () => {
        progressCb = null;
        resultsCb = null;
      },
    },
    generator: {
      generate: async () => `Demo-${crypto.randomUUID().slice(0, 8)}-aA1!`,
      getSettings: async () => ({
        length: 20, upper: true, lower: true, numbers: true, symbols: true, ambiguous: false, defaultUsername: 'ada@example.com',
      }),
      setSettings: async () => true,
      getActiveWindow: async () => ({ name: 'Example', url: 'https://example.com' }),
      open: async () => undefined,
      onSiteHint: () => undefined,
      removeListeners: () => undefined,
    },
    offline: {
      getStatus: async () => ({ offline: false, queue: [] }),
      setMode: async () => ({ offline: false }),
      flushQueue: async () => ({ applied: 0, conflicts: [], errors: [] }),
      discardEntry: async () => ({ success: true }),
      resolveConflicts: async () => ({ success: true, results: [] }),
      onStatusChanged: () => undefined,
      onQueueUpdated: () => undefined,
      onConflictsDetected: () => undefined,
      removeListeners: () => undefined,
    },
    primary: {
      getAll: async () => [...primary],
      setAll: async (next: string[]) => {
        primary = [...next];
        return true;
      },
    },
    usage: {
      increment: async (itemId: string) => {
        usage[itemId] = (usage[itemId] ?? 0) + 1;
        return usage[itemId];
      },
      getAll: async () => ({ ...usage }),
    },
    clipboard: {
      write: async (text: string) => {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          /* The demo still reports success so the toast can show. */
        }
        return true;
      },
    },
    app: {
      getStore: async (key: string) => store[key] ?? null,
      setStore: async (key: string, value: unknown) => {
        store[key] = value;
        return true;
      },
      notify: async () => true,
      openExternal: async (url: string) => {
        window.open(url, '_blank', 'noopener');
      },
      getVersion: async () => '2.8.1-demo',
    },
    on: () => undefined,
    removeListener: () => undefined,
  };

  window.electronAPI = api as unknown as NonNullable<Window['electronAPI']>;
  markDemoSession();
  document.title = 'DockWarden — demo vault';
}
