export type ItemType = 'login' | 'card' | 'identity' | 'note';

export type ExpiryStatus = 'expired' | 'this-week' | 'this-month' | 'ok';

export interface VaultItem {
  id: string;
  name: string;
  username: string | null;
  password: string | null;
  website: string | null;
  type: ItemType;
  tags: string[];
  totp: string | null;
  expiresAt: string | null;
  folderId: string | null;
  favorite: boolean;
  notes?: string;
  cardNumber?: string;
  lastModified: string;
  createdAt: string;
  passwordStrength: number | null;
}

export interface Tag {
  name: string;
  color: string;
  itemCount: number;
}

export interface SmartView {
  id: string;
  name: string;
  conditions: FilterCondition[];
  operator: 'AND' | 'OR';
  itemCount: number;
  pinned?: boolean;
}

export interface FilterCondition {
  id: string;
  field: 'tag' | 'folder' | 'type' | 'uri' | 'expiry' | 'totp' | 'attachment' | 'password-age';
  operator: 'equals' | 'contains' | 'before' | 'after' | 'exists' | 'not-exists';
  value: string;
}

export interface BackupJob {
  id: string;
  timestamp: string;
  destination: string;
  size: string;
  status: 'success' | 'failed' | 'running';
}

export interface BackupDestination {
  id: string;
  type: 'local' | 's3' | 'b2' | 'webdav';
  label: string;
  enabled: boolean;
  config: Record<string, string>;
  lastBackup: string | null;
}

export interface SyncResult {
  success: boolean;
  itemCount: number;
  syncedAt: string;
}

export interface VaultStats {
  totalItems: number;
  expiringSoon: number;
  tagCount: number;
  lastBackup: string | null;
  securityScore: number;
  strongPasswords: number;
  twoFAEnabled: number;
  noDuplicates: number;
  recentlyUpdated: number;
}

export interface RecentActivity {
  id: string;
  itemName: string;
  action: string;
  timestamp: string;
  itemType: ItemType;
}
