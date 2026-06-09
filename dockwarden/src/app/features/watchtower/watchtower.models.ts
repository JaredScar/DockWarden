// ─── Enums ───────────────────────────────────────────────────────────────────

export enum WatchtowerCategory {
  BREACHED_PASSWORD = 'breached_password',
  WEAK_PASSWORD     = 'weak_password',
  REUSED_PASSWORD   = 'reused_password',
  INSECURE_URI      = 'insecure_uri',
  MISSING_TOTP      = 'missing_totp',
  DUPLICATE_ITEM    = 'duplicate_item',
}

export enum Severity {
  CRITICAL = 'critical',
  HIGH     = 'high',
  MEDIUM   = 'medium',
  LOW      = 'low',
  INFO     = 'info',
}

export enum ScanPhase {
  IDLE               = 'idle',
  CHECKING_BREACHES  = 'checking_breaches',
  CHECKING_STRENGTH  = 'checking_strength',
  CHECKING_REUSE     = 'checking_reuse',
  CHECKING_URIS      = 'checking_uris',
  CHECKING_TOTP      = 'checking_totp',
  CHECKING_DUPLICATES = 'checking_duplicates',
  COMPLETE           = 'complete',
}

// ─── Finding ─────────────────────────────────────────────────────────────────

export interface WatchtowerFinding {
  id: string;
  category: WatchtowerCategory;
  severity: Severity;
  vaultItemId: string;
  vaultItemName: string;
  vaultItemUri: string | null;
  message: string;
  detail: string | null;
  actionLabel: string;
  dismissedAt: number | null;
  snoozedUntil: number | null;
  detectedAt: number;
}

// ─── Scan state ───────────────────────────────────────────────────────────────

export interface ScanProgress {
  phase: ScanPhase;
  totalItems: number;
  processedItems: number;
  startedAt: number;
}

export interface VaultHealthScore {
  overall: number;       // 0-100 composite
  breachFree: number;
  strengthScore: number;
  uniquenessScore: number;
  httpsScore: number;
  mfaCoverage: number;
}

export interface WatchtowerResults {
  findings: WatchtowerFinding[];
  scannedAt: number;
  scannedItemCount: number;
  scanDurationMs: number;
  scores: VaultHealthScore;
}

// ─── Category metadata (for UI display) ──────────────────────────────────────

export interface CategoryMeta {
  label: string;
  description: string;
  faIcon: string;    // FontAwesome class
  severity: Severity;
  sortOrder: number;
  color: string;
  bgColor: string;
}

export const CATEGORY_METADATA: Record<WatchtowerCategory, CategoryMeta> = {
  [WatchtowerCategory.BREACHED_PASSWORD]: {
    label: 'Breached Passwords',
    description: 'Passwords found in known data breaches via HIBP k-Anonymity',
    faIcon: 'fa-skull-crossbones',
    severity: Severity.CRITICAL,
    sortOrder: 0,
    color: '#f85149',
    bgColor: 'rgba(248,81,73,0.1)',
  },
  [WatchtowerCategory.WEAK_PASSWORD]: {
    label: 'Weak Passwords',
    description: 'Passwords with low entropy that could be easily cracked',
    faIcon: 'fa-battery-quarter',
    severity: Severity.HIGH,
    sortOrder: 1,
    color: '#f0883e',
    bgColor: 'rgba(240,136,62,0.1)',
  },
  [WatchtowerCategory.REUSED_PASSWORD]: {
    label: 'Reused Passwords',
    description: 'The same password used across multiple accounts',
    faIcon: 'fa-clone',
    severity: Severity.MEDIUM,
    sortOrder: 2,
    color: '#e3b341',
    bgColor: 'rgba(227,179,65,0.1)',
  },
  [WatchtowerCategory.INSECURE_URI]: {
    label: 'Insecure Websites',
    description: 'Login URLs using unencrypted HTTP instead of HTTPS',
    faIcon: 'fa-lock-open',
    severity: Severity.MEDIUM,
    sortOrder: 3,
    color: '#e3b341',
    bgColor: 'rgba(227,179,65,0.1)',
  },
  [WatchtowerCategory.MISSING_TOTP]: {
    label: 'Missing Two-Factor',
    description: 'Accounts that support 2FA but have no TOTP configured',
    faIcon: 'fa-mobile-screen',
    severity: Severity.LOW,
    sortOrder: 4,
    color: '#2f81f7',
    bgColor: 'rgba(47,129,247,0.1)',
  },
  [WatchtowerCategory.DUPLICATE_ITEM]: {
    label: 'Duplicate Items',
    description: 'Near-identical vault entries that may be consolidatable',
    faIcon: 'fa-copy',
    severity: Severity.INFO,
    sortOrder: 5,
    color: '#8b949e',
    bgColor: 'rgba(139,148,158,0.1)',
  },
};

export const SEVERITY_LABEL: Record<Severity, string> = {
  [Severity.CRITICAL]: 'CRITICAL',
  [Severity.HIGH]:     'HIGH',
  [Severity.MEDIUM]:   'MEDIUM',
  [Severity.LOW]:      'LOW',
  [Severity.INFO]:     'INFO',
};

export const PHASE_LABEL: Record<ScanPhase, string> = {
  [ScanPhase.IDLE]:                'Idle',
  [ScanPhase.CHECKING_BREACHES]:   'Checking for breached passwords (HIBP)…',
  [ScanPhase.CHECKING_STRENGTH]:   'Analysing password strength…',
  [ScanPhase.CHECKING_REUSE]:      'Detecting reused passwords…',
  [ScanPhase.CHECKING_URIS]:       'Inspecting URLs…',
  [ScanPhase.CHECKING_TOTP]:       'Checking for missing 2FA…',
  [ScanPhase.CHECKING_DUPLICATES]: 'Looking for duplicate items…',
  [ScanPhase.COMPLETE]:            'Scan complete',
};
