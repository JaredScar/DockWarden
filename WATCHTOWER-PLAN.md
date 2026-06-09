# DockWarden Watchtower — Implementation Plan

> **Module name:** `watchtower`
> **Stack:** Electron + Angular 21 (signals-first, zoneless, standalone)
> **Integration:** Bitwarden CLI (`bw`), Have I Been Pwned API, local entropy analysis
> **Scope:** New feature module — no modifications to existing vault CRUD flow

---

## 1. Overview

Watchtower is DockWarden's security intelligence dashboard — a persistent, always-available panel that continuously monitors the user's Bitwarden vault for security issues and surfaces actionable findings. It is modeled after 1Password's Watchtower but built entirely client-side with no DockWarden backend, no telemetry, and no data leaving the device beyond k-Anonymity hash prefix queries to HIBP.

### What it monitors

| Check | Description | Data Source |
|---|---|---|
| **Breached Passwords** | Passwords that appear in known data breach databases | HIBP Pwned Passwords API (k-Anonymity) |
| **Breached Emails** | Email addresses found in known data breaches | HIBP Breaches API |
| **Weak Passwords** | Passwords with low entropy, short length, or common patterns | Local analysis (zxcvbn) |
| **Reused Passwords** | Same password used across multiple vault items | Local cross-reference |
| **Insecure URLs** | Login URIs using HTTP instead of HTTPS | Local URI check |
| **Missing 2FA** | Login items for sites that support TOTP but have no TOTP URI configured | Local check + optional 2fa.directory API |
| **Expiring Items** | Items with `_dw_expires` custom field approaching expiry | Local date check (cross-module with Expiry Reminders) |
| **Duplicate Items** | Near-identical vault entries (same URI + username) | Local dedup analysis |
| **Passkey Availability** | Sites where the user could switch to passkeys but hasn't | passkeys.directory or static list |

### What it does NOT do

- Does NOT send full passwords, emails, or any PII to any external service
- Does NOT write scan results to the Bitwarden vault (results are ephemeral, in-memory only)
- Does NOT modify vault items automatically — all remediation is user-initiated
- Does NOT require a DockWarden backend server

---

## 2. Architecture

### 2.1 Folder Structure

```
src/app/features/watchtower/
├── watchtower.component.ts            # Dashboard host (lazy-loaded route)
├── watchtower.routes.ts               # Route config
├── components/
│   ├── index.ts                       # Barrel
│   ├── watchtower-dashboard/
│   │   └── watchtower-dashboard.component.ts
│   ├── watchtower-category-card/
│   │   └── watchtower-category-card.component.ts
│   ├── watchtower-item-row/
│   │   └── watchtower-item-row.component.ts
│   ├── watchtower-detail-panel/
│   │   └── watchtower-detail-panel.component.ts
│   └── watchtower-scan-progress/
│       └── watchtower-scan-progress.component.ts
├── services/
│   ├── index.ts                       # Barrel
│   ├── watchtower.service.ts          # Orchestrator — kicks off scans, aggregates results
│   ├── breach-check.service.ts        # HIBP password + email breach checks
│   ├── password-strength.service.ts   # Entropy analysis via zxcvbn
│   ├── reuse-check.service.ts         # Cross-item password dedup
│   ├── uri-check.service.ts           # HTTP vs HTTPS, malformed URIs
│   ├── totp-check.service.ts          # Missing 2FA detection
│   ├── duplicate-check.service.ts     # Near-identical item detection
│   └── passkey-check.service.ts       # Passkey availability lookup
├── models/
│   ├── index.ts                       # Barrel
│   ├── watchtower-finding.model.ts    # Finding interface
│   ├── watchtower-category.model.ts   # Category enum + metadata
│   └── watchtower-scan-state.model.ts # Scan progress state
├── pipes/
│   ├── index.ts                       # Barrel
│   └── severity-label.pipe.ts         # Maps severity enum → display string
└── utils/
    ├── index.ts                       # Barrel
    ├── k-anonymity.util.ts            # SHA-1 prefix hashing for HIBP
    ├── entropy.util.ts                # Wrapper around zxcvbn
    └── uri-parser.util.ts             # URI scheme extraction + validation
```

### 2.2 Electron IPC Boundary

All network calls (HIBP API) and CPU-intensive work (SHA-1 hashing, zxcvbn scoring on large vaults) run in the **Electron main process** (or a spawned worker thread) to avoid blocking the Angular renderer.

```
┌─────────────────────────────────────────────────────┐
│  Angular Renderer (UI)                              │
│                                                     │
│  watchtower.service.ts                              │
│    ├── Sends: 'watchtower:start-scan'               │
│    ├── Sends: 'watchtower:check-password' (hash)    │
│    ├── Sends: 'watchtower:check-email' (email)      │
│    ├── Receives: 'watchtower:scan-progress'         │
│    └── Receives: 'watchtower:scan-results'          │
│                                                     │
└───────────────────┬─────────────────────────────────┘
                    │ IPC (contextBridge)
┌───────────────────▼─────────────────────────────────┐
│  Electron Main Process                              │
│                                                     │
│  watchtower.handler.ts                              │
│    ├── Worker thread: breach-check.worker.ts        │
│    │     ├── SHA-1 hash each password               │
│    │     ├── Batch HIBP range queries (5-char prefix)│
│    │     ├── Rate-limited: 1 request per 100ms      │
│    │     └── Returns: Map<itemId, breachCount>      │
│    │                                                │
│    ├── Worker thread: strength-check.worker.ts      │
│    │     ├── zxcvbn score each password              │
│    │     └── Returns: Map<itemId, score 0-4>        │
│    │                                                │
│    └── Main thread: remaining checks (fast)         │
│          ├── Reuse check (hash grouping)            │
│          ├── URI check (regex)                      │
│          ├── TOTP check (field presence)            │
│          └── Duplicate check (URI+username match)   │
│                                                     │
└─────────────────────────────────────────────────────┘
```

### 2.3 Preload Script — IPC Channel Definitions

Add to the existing preload script's `contextBridge.exposeInMainWorld` block:

```typescript
// preload.ts — add to existing electronAPI exposure
watchtower: {
  startScan: (vaultItems: SerializedVaultItem[]) =>
    ipcRenderer.invoke('watchtower:start-scan', vaultItems),
  onScanProgress: (callback: (progress: ScanProgress) => void) =>
    ipcRenderer.on('watchtower:scan-progress', (_event, progress) => callback(progress)),
  onScanResults: (callback: (results: WatchtowerResults) => void) =>
    ipcRenderer.on('watchtower:scan-results', (_event, results) => callback(results)),
  cancelScan: () =>
    ipcRenderer.send('watchtower:cancel-scan'),
  removeListeners: () => {
    ipcRenderer.removeAllListeners('watchtower:scan-progress');
    ipcRenderer.removeAllListeners('watchtower:scan-results');
  }
}
```

---

## 3. Data Models

### 3.1 WatchtowerCategory

```typescript
// watchtower-category.model.ts

export enum WatchtowerCategory {
  BREACHED_PASSWORD = 'breached_password',
  BREACHED_EMAIL = 'breached_email',
  WEAK_PASSWORD = 'weak_password',
  REUSED_PASSWORD = 'reused_password',
  INSECURE_URI = 'insecure_uri',
  MISSING_TOTP = 'missing_totp',
  EXPIRING_ITEM = 'expiring_item',
  DUPLICATE_ITEM = 'duplicate_item',
  PASSKEY_AVAILABLE = 'passkey_available',
}

export enum Severity {
  CRITICAL = 'critical',   // Breached passwords
  HIGH = 'high',           // Weak passwords, breached emails
  MEDIUM = 'medium',       // Reused passwords, insecure URIs
  LOW = 'low',             // Missing TOTP, passkey available, expiring
  INFO = 'info',           // Duplicate items
}

export interface CategoryMeta {
  category: WatchtowerCategory;
  label: string;
  description: string;
  icon: string;              // Lucide icon name or SVG ref
  severity: Severity;
  sortOrder: number;
}

export const CATEGORY_METADATA: Record<WatchtowerCategory, CategoryMeta> = {
  [WatchtowerCategory.BREACHED_PASSWORD]: {
    category: WatchtowerCategory.BREACHED_PASSWORD,
    label: 'Breached Passwords',
    description: 'Passwords found in known data breach databases',
    icon: 'shield-alert',
    severity: Severity.CRITICAL,
    sortOrder: 0,
  },
  [WatchtowerCategory.BREACHED_EMAIL]: {
    category: WatchtowerCategory.BREACHED_EMAIL,
    label: 'Breached Emails',
    description: 'Email addresses exposed in known data breaches',
    icon: 'mail-warning',
    severity: Severity.CRITICAL,
    sortOrder: 1,
  },
  [WatchtowerCategory.WEAK_PASSWORD]: {
    category: WatchtowerCategory.WEAK_PASSWORD,
    label: 'Weak Passwords',
    description: 'Passwords with low entropy or common patterns',
    icon: 'key-round',
    severity: Severity.HIGH,
    sortOrder: 2,
  },
  [WatchtowerCategory.REUSED_PASSWORD]: {
    category: WatchtowerCategory.REUSED_PASSWORD,
    label: 'Reused Passwords',
    description: 'The same password used across multiple accounts',
    icon: 'copy',
    severity: Severity.MEDIUM,
    sortOrder: 3,
  },
  [WatchtowerCategory.INSECURE_URI]: {
    category: WatchtowerCategory.INSECURE_URI,
    label: 'Insecure Websites',
    description: 'Login URIs using HTTP instead of HTTPS',
    icon: 'unlock',
    severity: Severity.MEDIUM,
    sortOrder: 4,
  },
  [WatchtowerCategory.MISSING_TOTP]: {
    category: WatchtowerCategory.MISSING_TOTP,
    label: 'Missing Two-Factor',
    description: 'Accounts that support 2FA but have no TOTP configured',
    icon: 'smartphone',
    severity: Severity.LOW,
    sortOrder: 5,
  },
  [WatchtowerCategory.EXPIRING_ITEM]: {
    category: WatchtowerCategory.EXPIRING_ITEM,
    label: 'Expiring Credentials',
    description: 'Items approaching their configured expiry date',
    icon: 'clock',
    severity: Severity.LOW,
    sortOrder: 6,
  },
  [WatchtowerCategory.DUPLICATE_ITEM]: {
    category: WatchtowerCategory.DUPLICATE_ITEM,
    label: 'Duplicate Items',
    description: 'Near-identical vault entries that may be consolidatable',
    icon: 'files',
    severity: Severity.INFO,
    sortOrder: 7,
  },
  [WatchtowerCategory.PASSKEY_AVAILABLE]: {
    category: WatchtowerCategory.PASSKEY_AVAILABLE,
    label: 'Passkey Available',
    description: 'Sites where you could switch to passwordless login',
    icon: 'fingerprint',
    severity: Severity.LOW,
    sortOrder: 8,
  },
};
```

### 3.2 WatchtowerFinding

```typescript
// watchtower-finding.model.ts

export interface WatchtowerFinding {
  id: string;                        // Generated UUID for this finding
  category: WatchtowerCategory;
  severity: Severity;
  vaultItemId: string;               // Bitwarden item ID
  vaultItemName: string;             // Display name (e.g. "GitHub - jaredscar")
  vaultItemUri: string | null;       // Primary URI if available
  message: string;                   // Human-readable description
  detail: string | null;             // Extra context (e.g. "Found in 3 breaches")
  actionLabel: string;               // CTA button text (e.g. "Change Password")
  actionType: FindingAction;         // What the CTA does
  dismissedAt: number | null;        // Timestamp if user dismissed this finding
  snoozedUntil: number | null;       // Timestamp if user snoozed
  detectedAt: number;                // Timestamp when first found
}

export enum FindingAction {
  OPEN_ITEM = 'open_item',           // Open item in DockWarden editor
  OPEN_URI = 'open_uri',             // Open the website in browser
  GENERATE_PASSWORD = 'gen_password', // Open password generator pre-linked to item
  ENABLE_TOTP = 'enable_totp',       // Navigate to TOTP setup
  DELETE_DUPLICATE = 'delete_dup',   // Offer to delete the duplicate
  DISMISS = 'dismiss',               // Acknowledge and hide
}
```

### 3.3 ScanState

```typescript
// watchtower-scan-state.model.ts

export interface ScanProgress {
  phase: ScanPhase;
  totalItems: number;
  processedItems: number;
  currentCategory: WatchtowerCategory | null;
  startedAt: number;
}

export enum ScanPhase {
  IDLE = 'idle',
  FETCHING_VAULT = 'fetching_vault',
  CHECKING_BREACHES = 'checking_breaches',
  CHECKING_EMAILS = 'checking_emails',
  CHECKING_STRENGTH = 'checking_strength',
  CHECKING_REUSE = 'checking_reuse',
  CHECKING_URIS = 'checking_uris',
  CHECKING_TOTP = 'checking_totp',
  CHECKING_DUPLICATES = 'checking_duplicates',
  CHECKING_PASSKEYS = 'checking_passkeys',
  COMPLETE = 'complete',
}

export interface WatchtowerResults {
  findings: WatchtowerFinding[];
  scannedAt: number;
  scannedItemCount: number;
  scanDurationMs: number;
  scores: VaultHealthScore;
}

export interface VaultHealthScore {
  overall: number;           // 0-100 composite score
  breachFree: number;        // 0-100
  strengthScore: number;     // 0-100
  uniquenessScore: number;   // 0-100
  httpsScore: number;        // 0-100
  mfaCoverage: number;       // 0-100
}
```

---

## 4. Service Implementations

### 4.1 WatchtowerService (Orchestrator)

This is the main Angular service that the UI interacts with. It talks to Electron's main process via IPC.

```typescript
// watchtower.service.ts

@Injectable({ providedIn: 'root' })
export class WatchtowerService {
  private readonly vaultService = inject(VaultService);

  // --- Signals (UI binds to these) ---
  readonly scanState = signal<ScanPhase>(ScanPhase.IDLE);
  readonly scanProgress = signal<ScanProgress | null>(null);
  readonly results = signal<WatchtowerResults | null>(null);
  readonly findings = signal<WatchtowerFinding[]>([]);
  readonly dismissedIds = signal<Set<string>>(new Set());
  readonly lastScannedAt = signal<number | null>(null);

  // --- Computed ---
  readonly activeFindings = computed(() =>
    this.findings().filter(f =>
      !this.dismissedIds().has(f.id) &&
      (f.snoozedUntil === null || f.snoozedUntil < Date.now())
    )
  );

  readonly findingsByCategory = computed(() => {
    const grouped = new Map<WatchtowerCategory, WatchtowerFinding[]>();
    for (const finding of this.activeFindings()) {
      const existing = grouped.get(finding.category) ?? [];
      existing.push(finding);
      grouped.set(finding.category, existing);
    }
    return grouped;
  });

  readonly healthScore = computed(() =>
    this.results()?.scores ?? null
  );

  readonly totalIssueCount = computed(() =>
    this.activeFindings().length
  );

  readonly criticalCount = computed(() =>
    this.activeFindings().filter(f => f.severity === Severity.CRITICAL).length
  );

  // --- Methods ---

  async startScan(): Promise<void> {
    this.scanState.set(ScanPhase.FETCHING_VAULT);

    // 1. Get vault items via existing VaultService
    const vaultItems = await this.vaultService.getAllItems();

    // 2. Serialize only the fields Watchtower needs (never send master password)
    const serialized: SerializedVaultItem[] = vaultItems
      .filter(item => item.type === VaultItemType.LOGIN)
      .map(item => ({
        id: item.id,
        name: item.name,
        username: item.login?.username ?? null,
        password: item.login?.password ?? null,
        uris: item.login?.uris?.map(u => u.uri) ?? [],
        totpUri: item.login?.totp ?? null,
        customFields: item.fields ?? [],
        folderId: item.folderId ?? null,
        revisionDate: item.revisionDate,
      }));

    // 3. Send to main process for heavy lifting
    this.scanState.set(ScanPhase.CHECKING_BREACHES);

    window.electronAPI.watchtower.onScanProgress((progress) => {
      this.scanProgress.set(progress);
      this.scanState.set(progress.phase);
    });

    window.electronAPI.watchtower.onScanResults((results) => {
      this.results.set(results);
      this.findings.set(results.findings);
      this.lastScannedAt.set(results.scannedAt);
      this.scanState.set(ScanPhase.COMPLETE);
      // Clean up listeners
      window.electronAPI.watchtower.removeListeners();
    });

    await window.electronAPI.watchtower.startScan(serialized);
  }

  dismissFinding(findingId: string): void {
    this.dismissedIds.update(ids => {
      const next = new Set(ids);
      next.add(findingId);
      return next;
    });
    this.findings.update(findings =>
      findings.map(f =>
        f.id === findingId ? { ...f, dismissedAt: Date.now() } : f
      )
    );
  }

  snoozeFinding(findingId: string, durationMs: number): void {
    this.findings.update(findings =>
      findings.map(f =>
        f.id === findingId ? { ...f, snoozedUntil: Date.now() + durationMs } : f
      )
    );
  }

  cancelScan(): void {
    window.electronAPI.watchtower.cancelScan();
    window.electronAPI.watchtower.removeListeners();
    this.scanState.set(ScanPhase.IDLE);
  }
}
```

### 4.2 Breach Check (Electron Main Process — Worker)

```typescript
// electron/workers/breach-check.worker.ts

import { createHash } from 'crypto';
import { parentPort, workerData } from 'worker_threads';

interface BreachCheckInput {
  items: Array<{ id: string; password: string | null; username: string | null }>;
}

interface HibpRangeResult {
  hash: string;
  count: number;
}

const HIBP_API_BASE = 'https://api.pwnedpasswords.com';
const HIBP_BREACH_API = 'https://haveibeenpwned.com/api/v3';
const REQUEST_DELAY_MS = 100; // Rate limit: ~10 req/sec (HIBP allows 10/sec for non-auth'd)

/**
 * k-Anonymity password check:
 * 1. SHA-1 hash the password locally
 * 2. Send the first 5 hex characters to HIBP
 * 3. HIBP returns all hash suffixes matching that prefix
 * 4. Compare locally — HIBP never sees the full hash
 */
async function checkPasswordBreach(password: string): Promise<number> {
  const sha1 = createHash('sha1').update(password).digest('hex').toUpperCase();
  const prefix = sha1.substring(0, 5);
  const suffix = sha1.substring(5);

  const response = await fetch(`${HIBP_API_BASE}/range/${prefix}`, {
    headers: {
      'User-Agent': 'DockWarden-Watchtower',
      'Add-Padding': 'true', // Prevents response-length fingerprinting
    },
  });

  if (!response.ok) {
    throw new Error(`HIBP range request failed: ${response.status}`);
  }

  const text = await response.text();
  const lines = text.split('\r\n');

  for (const line of lines) {
    const [hashSuffix, count] = line.split(':');
    if (hashSuffix === suffix) {
      return parseInt(count, 10);
    }
  }

  return 0; // Not found in any breach
}

/**
 * Email breach check via HIBP Breaches API:
 * Note: This endpoint requires an HIBP API key ($3.50/mo) for production use.
 * For DockWarden MVP, this can be optional — skip if no key configured.
 * The user can supply their own HIBP API key in DockWarden settings.
 */
async function checkEmailBreach(
  email: string,
  apiKey: string | null
): Promise<{ name: string; date: string }[]> {
  if (!apiKey) return []; // Skip if no API key configured

  const response = await fetch(
    `${HIBP_BREACH_API}/breachedaccount/${encodeURIComponent(email)}?truncateResponse=false`,
    {
      headers: {
        'User-Agent': 'DockWarden-Watchtower',
        'hibp-api-key': apiKey,
      },
    }
  );

  if (response.status === 404) return []; // Not breached
  if (!response.ok) throw new Error(`HIBP breach API failed: ${response.status}`);

  const breaches = await response.json();
  return breaches.map((b: any) => ({ name: b.Name, date: b.BreachDate }));
}

// --- Worker Entry Point ---

async function run() {
  const { items, hibpApiKey } = workerData as BreachCheckInput & { hibpApiKey: string | null };
  const passwordResults: Map<string, number> = new Map();
  const emailResults: Map<string, { name: string; date: string }[]> = new Map();

  // Deduplicate passwords to minimize API calls
  const passwordToItemIds = new Map<string, string[]>();
  const emailToItemIds = new Map<string, string[]>();

  for (const item of items) {
    if (item.password) {
      const existing = passwordToItemIds.get(item.password) ?? [];
      existing.push(item.id);
      passwordToItemIds.set(item.password, existing);
    }
    if (item.username && item.username.includes('@')) {
      const existing = emailToItemIds.get(item.username) ?? [];
      existing.push(item.id);
      emailToItemIds.set(item.username, existing);
    }
  }

  // Check unique passwords
  const uniquePasswords = Array.from(passwordToItemIds.keys());
  let processed = 0;

  for (const password of uniquePasswords) {
    try {
      const breachCount = await checkPasswordBreach(password);
      const itemIds = passwordToItemIds.get(password)!;
      for (const id of itemIds) {
        passwordResults.set(id, breachCount);
      }
    } catch (err) {
      // Log error but continue — don't fail entire scan for one item
      console.error(`Breach check failed for item batch:`, err);
    }

    processed++;
    parentPort?.postMessage({
      type: 'progress',
      processed,
      total: uniquePasswords.length,
    });

    // Rate limit
    await new Promise(resolve => setTimeout(resolve, REQUEST_DELAY_MS));
  }

  // Check unique emails (if API key available)
  const uniqueEmails = Array.from(emailToItemIds.keys());
  for (const email of uniqueEmails) {
    try {
      const breaches = await checkEmailBreach(email, hibpApiKey);
      const itemIds = emailToItemIds.get(email)!;
      for (const id of itemIds) {
        emailResults.set(id, breaches);
      }
    } catch (err) {
      console.error(`Email breach check failed:`, err);
    }
    await new Promise(resolve => setTimeout(resolve, REQUEST_DELAY_MS));
  }

  parentPort?.postMessage({
    type: 'complete',
    passwordResults: Object.fromEntries(passwordResults),
    emailResults: Object.fromEntries(emailResults),
  });
}

run();
```

### 4.3 Password Strength Check (Electron Worker)

```typescript
// electron/workers/strength-check.worker.ts

import { parentPort, workerData } from 'worker_threads';
import zxcvbn from 'zxcvbn';

interface StrengthInput {
  items: Array<{ id: string; password: string | null; username: string | null }>;
}

async function run() {
  const { items } = workerData as StrengthInput;
  const results: Map<string, {
    score: number;          // 0-4 (zxcvbn scale)
    crackTimeDisplay: string;
    feedback: string[];
  }> = new Map();

  for (const item of items) {
    if (!item.password) continue;

    // Pass username as user_inputs so zxcvbn penalizes passwords containing it
    const userInputs = item.username ? [item.username] : [];
    const result = zxcvbn(item.password, userInputs);

    results.set(item.id, {
      score: result.score,
      crackTimeDisplay: result.crack_times_display.offline_slow_hashing_1e4_per_second as string,
      feedback: [
        ...(result.feedback.warning ? [result.feedback.warning] : []),
        ...result.feedback.suggestions,
      ],
    });
  }

  parentPort?.postMessage({
    type: 'complete',
    results: Object.fromEntries(results),
  });
}

run();
```

### 4.4 Remaining Checks (Electron Main Thread — Fast)

These checks are lightweight and don't need worker threads.

```typescript
// electron/handlers/watchtower-checks.ts

import { v4 as uuid } from 'uuid';
import {
  WatchtowerFinding,
  WatchtowerCategory,
  Severity,
  FindingAction,
} from '../../shared/models';

// -------------------------------------------------------------------
// REUSE CHECK
// -------------------------------------------------------------------
export function checkReusedPasswords(
  items: SerializedVaultItem[]
): WatchtowerFinding[] {
  const findings: WatchtowerFinding[] = [];
  const passwordGroups = new Map<string, SerializedVaultItem[]>();

  for (const item of items) {
    if (!item.password) continue;
    const group = passwordGroups.get(item.password) ?? [];
    group.push(item);
    passwordGroups.set(item.password, group);
  }

  for (const [_password, group] of passwordGroups) {
    if (group.length < 2) continue;
    for (const item of group) {
      const otherNames = group
        .filter(g => g.id !== item.id)
        .map(g => g.name)
        .slice(0, 3)
        .join(', ');

      findings.push({
        id: uuid(),
        category: WatchtowerCategory.REUSED_PASSWORD,
        severity: Severity.MEDIUM,
        vaultItemId: item.id,
        vaultItemName: item.name,
        vaultItemUri: item.uris[0] ?? null,
        message: `Password reused across ${group.length} accounts`,
        detail: `Also used by: ${otherNames}`,
        actionLabel: 'Change Password',
        actionType: FindingAction.GENERATE_PASSWORD,
        dismissedAt: null,
        snoozedUntil: null,
        detectedAt: Date.now(),
      });
    }
  }
  return findings;
}

// -------------------------------------------------------------------
// INSECURE URI CHECK
// -------------------------------------------------------------------
export function checkInsecureUris(
  items: SerializedVaultItem[]
): WatchtowerFinding[] {
  const findings: WatchtowerFinding[] = [];

  for (const item of items) {
    for (const uri of item.uris) {
      if (uri.startsWith('http://') && !isLocalhostUri(uri)) {
        findings.push({
          id: uuid(),
          category: WatchtowerCategory.INSECURE_URI,
          severity: Severity.MEDIUM,
          vaultItemId: item.id,
          vaultItemName: item.name,
          vaultItemUri: uri,
          message: 'Login page uses unencrypted HTTP',
          detail: `${uri} — credentials sent in plain text`,
          actionLabel: 'Open Item',
          actionType: FindingAction.OPEN_ITEM,
          dismissedAt: null,
          snoozedUntil: null,
          detectedAt: Date.now(),
        });
        break; // One finding per item, not per URI
      }
    }
  }
  return findings;
}

function isLocalhostUri(uri: string): boolean {
  try {
    const url = new URL(uri);
    return (
      url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname === '::1' ||
      url.hostname.endsWith('.local')
    );
  } catch {
    return false;
  }
}

// -------------------------------------------------------------------
// MISSING TOTP CHECK
// -------------------------------------------------------------------
export function checkMissingTotp(
  items: SerializedVaultItem[]
): WatchtowerFinding[] {
  const findings: WatchtowerFinding[] = [];

  // Static list of popular domains known to support TOTP
  // This can be replaced with a 2fa.directory API call in Phase 2
  const totpSupportedDomains = new Set([
    'google.com', 'github.com', 'gitlab.com', 'bitbucket.org',
    'amazon.com', 'aws.amazon.com', 'microsoft.com', 'live.com',
    'outlook.com', 'apple.com', 'facebook.com', 'twitter.com',
    'x.com', 'instagram.com', 'linkedin.com', 'reddit.com',
    'discord.com', 'slack.com', 'dropbox.com', 'paypal.com',
    'stripe.com', 'twitch.tv', 'steam.com', 'epicgames.com',
    'cloudflare.com', 'digitalocean.com', 'heroku.com',
    'namecheap.com', 'godaddy.com', 'hover.com',
    'bitwarden.com', 'protonmail.com', 'tutanota.com',
    'coinbase.com', 'binance.com', 'kraken.com',
    'npmjs.com', 'pypi.org', 'hub.docker.com',
    // ... extend this or move to a JSON file / 2fa.directory API
  ]);

  for (const item of items) {
    if (item.totpUri) continue; // Already has TOTP

    const matchedDomain = item.uris
      .map(uri => {
        try { return new URL(uri).hostname.replace('www.', ''); } catch { return null; }
      })
      .find(host => host && totpSupportedDomains.has(host));

    if (matchedDomain) {
      findings.push({
        id: uuid(),
        category: WatchtowerCategory.MISSING_TOTP,
        severity: Severity.LOW,
        vaultItemId: item.id,
        vaultItemName: item.name,
        vaultItemUri: item.uris[0] ?? null,
        message: `${matchedDomain} supports 2FA but none is configured`,
        detail: 'Adding TOTP significantly improves account security',
        actionLabel: 'Set Up 2FA',
        actionType: FindingAction.ENABLE_TOTP,
        dismissedAt: null,
        snoozedUntil: null,
        detectedAt: Date.now(),
      });
    }
  }
  return findings;
}

// -------------------------------------------------------------------
// DUPLICATE ITEMS CHECK
// -------------------------------------------------------------------
export function checkDuplicateItems(
  items: SerializedVaultItem[]
): WatchtowerFinding[] {
  const findings: WatchtowerFinding[] = [];
  const seen = new Map<string, SerializedVaultItem>();

  for (const item of items) {
    if (!item.username || item.uris.length === 0) continue;

    // Key: normalized primary URI + lowercase username
    let host: string;
    try {
      host = new URL(item.uris[0]).hostname.replace('www.', '');
    } catch {
      continue;
    }
    const key = `${host}|${item.username.toLowerCase()}`;

    if (seen.has(key)) {
      const original = seen.get(key)!;
      findings.push({
        id: uuid(),
        category: WatchtowerCategory.DUPLICATE_ITEM,
        severity: Severity.INFO,
        vaultItemId: item.id,
        vaultItemName: item.name,
        vaultItemUri: item.uris[0] ?? null,
        message: `Possible duplicate of "${original.name}"`,
        detail: `Both use ${item.username} on ${host}`,
        actionLabel: 'Review',
        actionType: FindingAction.OPEN_ITEM,
        dismissedAt: null,
        snoozedUntil: null,
        detectedAt: Date.now(),
      });
    } else {
      seen.set(key, item);
    }
  }
  return findings;
}
```

### 4.5 Health Score Calculator

```typescript
// electron/handlers/health-score.ts

export function calculateHealthScore(
  totalItems: number,
  findings: WatchtowerFinding[]
): VaultHealthScore {
  if (totalItems === 0) {
    return { overall: 100, breachFree: 100, strengthScore: 100, uniquenessScore: 100, httpsScore: 100, mfaCoverage: 100 };
  }

  const count = (cat: WatchtowerCategory) =>
    findings.filter(f => f.category === cat && !f.dismissedAt).length;

  const breachFree = Math.max(0, Math.round(
    ((totalItems - count(WatchtowerCategory.BREACHED_PASSWORD)) / totalItems) * 100
  ));

  const strengthScore = Math.max(0, Math.round(
    ((totalItems - count(WatchtowerCategory.WEAK_PASSWORD)) / totalItems) * 100
  ));

  const uniquenessScore = Math.max(0, Math.round(
    ((totalItems - count(WatchtowerCategory.REUSED_PASSWORD)) / totalItems) * 100
  ));

  const httpsScore = Math.max(0, Math.round(
    ((totalItems - count(WatchtowerCategory.INSECURE_URI)) / totalItems) * 100
  ));

  const mfaCoverage = Math.max(0, Math.round(
    ((totalItems - count(WatchtowerCategory.MISSING_TOTP)) / totalItems) * 100
  ));

  // Weighted composite
  const overall = Math.round(
    breachFree * 0.30 +
    strengthScore * 0.25 +
    uniquenessScore * 0.20 +
    httpsScore * 0.10 +
    mfaCoverage * 0.15
  );

  return { overall, breachFree, strengthScore, uniquenessScore, httpsScore, mfaCoverage };
}
```

---

## 5. Electron Main Process Handler

This is the IPC handler that orchestrates all workers and checks.

```typescript
// electron/handlers/watchtower.handler.ts

import { ipcMain, BrowserWindow } from 'electron';
import { Worker } from 'worker_threads';
import path from 'path';
import {
  checkReusedPasswords,
  checkInsecureUris,
  checkMissingTotp,
  checkDuplicateItems,
} from './watchtower-checks';
import { calculateHealthScore } from './health-score';
import { WatchtowerFinding, ScanPhase } from '../../shared/models';

let activeWorkers: Worker[] = [];

export function registerWatchtowerHandlers(mainWindow: BrowserWindow) {
  ipcMain.handle('watchtower:start-scan', async (_event, serializedItems) => {
    const startTime = Date.now();
    const allFindings: WatchtowerFinding[] = [];

    const sendProgress = (phase: ScanPhase, processed: number, total: number) => {
      mainWindow.webContents.send('watchtower:scan-progress', {
        phase,
        totalItems: total,
        processedItems: processed,
        currentCategory: null,
        startedAt: startTime,
      });
    };

    // ------- PHASE 1: Breach check (worker thread) -------
    sendProgress(ScanPhase.CHECKING_BREACHES, 0, serializedItems.length);

    const breachFindings = await runWorker<any>(
      path.join(__dirname, '../workers/breach-check.worker.js'),
      {
        items: serializedItems.map((i: any) => ({
          id: i.id,
          password: i.password,
          username: i.username,
        })),
        hibpApiKey: getStoredHibpApiKey(), // From DockWarden settings
      },
      (msg) => {
        if (msg.type === 'progress') {
          sendProgress(ScanPhase.CHECKING_BREACHES, msg.processed, msg.total);
        }
      }
    );

    // Convert breach results to findings
    for (const [itemId, breachCount] of Object.entries(breachFindings.passwordResults)) {
      if ((breachCount as number) > 0) {
        const item = serializedItems.find((i: any) => i.id === itemId);
        if (!item) continue;
        allFindings.push({
          id: crypto.randomUUID(),
          category: 'breached_password',
          severity: 'critical',
          vaultItemId: itemId,
          vaultItemName: item.name,
          vaultItemUri: item.uris[0] ?? null,
          message: `Password found in ${breachCount} data breach(es)`,
          detail: 'This password has been exposed publicly and should be changed immediately',
          actionLabel: 'Change Password',
          actionType: 'gen_password',
          dismissedAt: null,
          snoozedUntil: null,
          detectedAt: Date.now(),
        } as any);
      }
    }

    for (const [itemId, breaches] of Object.entries(breachFindings.emailResults)) {
      if ((breaches as any[]).length > 0) {
        const item = serializedItems.find((i: any) => i.id === itemId);
        if (!item) continue;
        const breachNames = (breaches as any[]).map(b => b.name).slice(0, 3).join(', ');
        allFindings.push({
          id: crypto.randomUUID(),
          category: 'breached_email',
          severity: 'critical',
          vaultItemId: itemId,
          vaultItemName: item.name,
          vaultItemUri: item.uris[0] ?? null,
          message: `Email found in ${(breaches as any[]).length} breach(es)`,
          detail: `Breaches include: ${breachNames}`,
          actionLabel: 'Review Account',
          actionType: 'open_item',
          dismissedAt: null,
          snoozedUntil: null,
          detectedAt: Date.now(),
        } as any);
      }
    }

    // ------- PHASE 2: Strength check (worker thread) -------
    sendProgress(ScanPhase.CHECKING_STRENGTH, 0, serializedItems.length);

    const strengthResults = await runWorker<any>(
      path.join(__dirname, '../workers/strength-check.worker.js'),
      {
        items: serializedItems.map((i: any) => ({
          id: i.id,
          password: i.password,
          username: i.username,
        })),
      }
    );

    for (const [itemId, result] of Object.entries(strengthResults.results)) {
      const r = result as any;
      if (r.score <= 1) { // 0 = terrible, 1 = weak
        const item = serializedItems.find((i: any) => i.id === itemId);
        if (!item) continue;
        allFindings.push({
          id: crypto.randomUUID(),
          category: 'weak_password',
          severity: 'high',
          vaultItemId: itemId,
          vaultItemName: item.name,
          vaultItemUri: item.uris[0] ?? null,
          message: `Weak password — could be cracked in ${r.crackTimeDisplay}`,
          detail: r.feedback.length > 0 ? r.feedback.join('. ') : null,
          actionLabel: 'Generate Stronger',
          actionType: 'gen_password',
          dismissedAt: null,
          snoozedUntil: null,
          detectedAt: Date.now(),
        } as any);
      }
    }

    // ------- PHASE 3: Fast local checks (main thread) -------
    sendProgress(ScanPhase.CHECKING_REUSE, 0, serializedItems.length);
    allFindings.push(...checkReusedPasswords(serializedItems));

    sendProgress(ScanPhase.CHECKING_URIS, 0, serializedItems.length);
    allFindings.push(...checkInsecureUris(serializedItems));

    sendProgress(ScanPhase.CHECKING_TOTP, 0, serializedItems.length);
    allFindings.push(...checkMissingTotp(serializedItems));

    sendProgress(ScanPhase.CHECKING_DUPLICATES, 0, serializedItems.length);
    allFindings.push(...checkDuplicateItems(serializedItems));

    // ------- PHASE 4: Calculate health score -------
    const scores = calculateHealthScore(serializedItems.length, allFindings);

    const results = {
      findings: allFindings,
      scannedAt: Date.now(),
      scannedItemCount: serializedItems.length,
      scanDurationMs: Date.now() - startTime,
      scores,
    };

    mainWindow.webContents.send('watchtower:scan-results', results);
    return results;
  });

  ipcMain.on('watchtower:cancel-scan', () => {
    for (const worker of activeWorkers) {
      worker.terminate();
    }
    activeWorkers = [];
  });
}

// --- Worker helper ---
function runWorker<T>(
  workerPath: string,
  workerData: any,
  onMessage?: (msg: any) => void
): Promise<T> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, { workerData });
    activeWorkers.push(worker);

    worker.on('message', (msg) => {
      if (msg.type === 'complete') {
        activeWorkers = activeWorkers.filter(w => w !== worker);
        resolve(msg as T);
      } else if (onMessage) {
        onMessage(msg);
      }
    });

    worker.on('error', (err) => {
      activeWorkers = activeWorkers.filter(w => w !== worker);
      reject(err);
    });
  });
}

function getStoredHibpApiKey(): string | null {
  // Read from DockWarden's encrypted settings store
  // Implementation depends on existing settings infrastructure
  return null; // MVP: no email breach checks until user provides key
}
```

---

## 6. UI Components

### 6.1 Dashboard Component

```typescript
// watchtower-dashboard.component.ts

@Component({
  standalone: true,
  selector: 'dw-watchtower-dashboard',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    WatchtowerCategoryCardComponent,
    WatchtowerScanProgressComponent,
  ],
  template: `
    @if (watchtower.scanState() !== 'idle' && watchtower.scanState() !== 'complete') {
      <dw-watchtower-scan-progress
        [progress]="watchtower.scanProgress()"
        (cancel)="watchtower.cancelScan()"
      />
    }

    <!-- Health Score Ring -->
    <section class="health-score">
      @if (watchtower.healthScore(); as score) {
        <dw-health-ring [score]="score.overall" />
        <div class="sub-scores">
          <dw-mini-score label="Breach-Free" [value]="score.breachFree" />
          <dw-mini-score label="Strength" [value]="score.strengthScore" />
          <dw-mini-score label="Unique" [value]="score.uniquenessScore" />
          <dw-mini-score label="HTTPS" [value]="score.httpsScore" />
          <dw-mini-score label="2FA" [value]="score.mfaCoverage" />
        </div>
      } @else {
        <button class="scan-btn" (click)="watchtower.startScan()">
          Run Security Scan
        </button>
      }
    </section>

    <!-- Category Cards -->
    <section class="findings">
      @for (entry of sortedCategories(); track entry[0]) {
        <dw-watchtower-category-card
          [category]="entry[0]"
          [findings]="entry[1]"
          (findingAction)="handleAction($event)"
        />
      }
    </section>

    @if (watchtower.lastScannedAt(); as ts) {
      <footer class="scan-footer">
        Last scanned: {{ ts | date:'medium' }}
        <button (click)="watchtower.startScan()">Re-scan</button>
      </footer>
    }
  `,
})
export class WatchtowerDashboardComponent {
  readonly watchtower = inject(WatchtowerService);

  readonly sortedCategories = computed(() => {
    const entries = Array.from(this.watchtower.findingsByCategory().entries());
    return entries.sort(([a], [b]) =>
      CATEGORY_METADATA[a].sortOrder - CATEGORY_METADATA[b].sortOrder
    );
  });

  handleAction(event: { finding: WatchtowerFinding; action: string }) {
    switch (event.action) {
      case 'dismiss':
        this.watchtower.dismissFinding(event.finding.id);
        break;
      case 'snooze_30d':
        this.watchtower.snoozeFinding(event.finding.id, 30 * 24 * 60 * 60 * 1000);
        break;
      case 'open_item':
        // Navigate to item editor via existing router/service
        break;
      case 'gen_password':
        // Open password generator pre-linked to item
        break;
    }
  }
}
```

### 6.2 Route Configuration

```typescript
// watchtower.routes.ts

export const WATCHTOWER_ROUTES: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./components/watchtower-dashboard/watchtower-dashboard.component')
        .then(m => m.WatchtowerDashboardComponent),
  },
];

// Add to app.routes.ts:
{
  path: 'watchtower',
  loadChildren: () =>
    import('./features/watchtower/watchtower.routes')
      .then(m => m.WATCHTOWER_ROUTES),
}
```

---

## 7. Tray Icon Badge Integration

Show the total issue count as a badge on the system tray icon.

```typescript
// electron/tray/tray-badge.ts — add to existing tray setup

import { Tray } from 'electron';

export function updateTrayBadge(tray: Tray, issueCount: number) {
  if (issueCount === 0) {
    tray.setToolTip('DockWarden — Vault Healthy');
    // Reset to default icon
    return;
  }

  tray.setToolTip(`DockWarden — ${issueCount} security issue${issueCount > 1 ? 's' : ''}`);
  // Optionally overlay a red badge on the tray icon
  // Implementation depends on platform (NativeImage overlay on Windows/Linux,
  // dock badge on macOS)
}
```

---

## 8. Auto-Scan Configuration

Allow users to configure when scans run automatically.

```typescript
// Settings UI additions (add to existing DockWarden settings)

interface WatchtowerSettings {
  autoScanOnUnlock: boolean;          // Run scan every time vault is unlocked
  autoScanIntervalMinutes: number;    // Periodic re-scan (0 = disabled)
  weakPasswordThreshold: number;      // zxcvbn score threshold (default: 1)
  showTrayBadge: boolean;             // Badge on tray icon
  hibpApiKey: string | null;          // Optional HIBP API key for email breach checks
  enabledChecks: {
    breachedPasswords: boolean;
    breachedEmails: boolean;
    weakPasswords: boolean;
    reusedPasswords: boolean;
    insecureUris: boolean;
    missingTotp: boolean;
    duplicateItems: boolean;
    passkeyAvailable: boolean;
  };
}

const DEFAULT_WATCHTOWER_SETTINGS: WatchtowerSettings = {
  autoScanOnUnlock: true,
  autoScanIntervalMinutes: 0,
  weakPasswordThreshold: 1,
  showTrayBadge: true,
  hibpApiKey: null,
  enabledChecks: {
    breachedPasswords: true,
    breachedEmails: false,           // Off by default until API key configured
    weakPasswords: true,
    reusedPasswords: true,
    insecureUris: true,
    missingTotp: true,
    duplicateItems: true,
    passkeyAvailable: false,         // Phase 2
  },
};
```

---

## 9. Security Considerations

### 9.1 Password Handling

- Passwords are decrypted by the Bitwarden CLI and exist in memory only during the scan
- Worker threads receive passwords as strings, process them, and terminate — no persistence
- SHA-1 hashes are computed in the worker and discarded after HIBP comparison
- At no point are passwords or full hashes written to disk, logs, or sent externally
- On scan cancellation, workers are terminated immediately

### 9.2 HIBP API Privacy

- Only the first 5 characters of the SHA-1 hash are sent to HIBP (k-Anonymity)
- The `Add-Padding: true` header is sent to prevent response-length fingerprinting
- HIBP cannot determine which hash suffix was being checked
- Email breach checks require the full email address — this is opt-in only, gated behind a user-provided API key, and clearly disclosed in the settings UI

### 9.3 Result Storage

- All scan results live in Electron memory only (Angular signals + main process variables)
- Results are cleared on vault lock
- Dismissed/snoozed state can optionally be persisted via `_dw_watchtower_dismissed` custom field (Phase 2) or local encrypted storage
- No DockWarden server, no analytics, no telemetry

---

## 10. Dependencies

| Package | Purpose | Install |
|---|---|---|
| `zxcvbn` | Password strength estimation | `npm install zxcvbn` |
| `@types/zxcvbn` | TypeScript types for zxcvbn | `npm install -D @types/zxcvbn` |
| `uuid` | Unique IDs for findings | Already in project or `npm install uuid` |

**No other external dependencies.** HIBP is accessed via native `fetch`. SHA-1 is via Node's built-in `crypto`. Worker threads are built-in `worker_threads`.

---

## 11. Testing Strategy

### 11.1 Unit Tests (Vitest)

```
tests/watchtower/
├── k-anonymity.util.spec.ts        # SHA-1 prefix extraction, suffix matching
├── reuse-check.spec.ts             # Password grouping, finding generation
├── uri-check.spec.ts               # HTTP detection, localhost exclusion
├── totp-check.spec.ts              # Domain matching, TOTP field detection
├── duplicate-check.spec.ts         # URI+username dedup logic
├── health-score.spec.ts            # Score calculation, edge cases (0 items, all bad)
├── strength-check.spec.ts          # zxcvbn integration, threshold logic
└── watchtower.service.spec.ts      # Orchestrator signal updates, dismiss/snooze
```

### 11.2 Key Test Cases

**k-anonymity.util.spec.ts:**
- Correctly computes SHA-1 of known passwords (e.g. `password` → `5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8`)
- Extracts first 5 chars as prefix
- Parses HIBP response text format (`SUFFIX:COUNT\r\n`)
- Returns 0 when suffix not in response
- Returns correct count when suffix is in response

**reuse-check.spec.ts:**
- No findings when all passwords are unique
- Generates findings for all items sharing a password
- Groups correctly with 3+ items sharing same password
- Ignores items with null passwords
- `detail` field lists other item names correctly

**uri-check.spec.ts:**
- Flags `http://example.com` as insecure
- Does NOT flag `https://example.com`
- Does NOT flag `http://localhost:3000`
- Does NOT flag `http://127.0.0.1`
- Does NOT flag `http://myapp.local`
- Handles malformed URIs gracefully

**health-score.spec.ts:**
- Returns all 100s for zero findings
- Returns all 100s for zero items (empty vault)
- Calculates each sub-score independently
- Weighted overall score matches formula
- Dismissed findings are excluded from score

### 11.3 Integration Tests

- Mock HIBP API responses (MSW or similar) to test full breach check flow
- Mock Bitwarden CLI output to test vault item serialization
- End-to-end scan flow: vault fetch → worker dispatch → result aggregation → signal update

---

## 12. Phased Rollout

### Phase 1 — MVP (Target: 2-3 weeks)

- Breached password check (HIBP k-Anonymity)
- Weak password check (zxcvbn)
- Reused password detection
- Insecure URI detection
- Health score dashboard with 5 sub-scores
- Scan progress indicator
- Dismiss / snooze per finding
- Settings: enable/disable individual checks
- Tray badge with issue count
- Auto-scan on vault unlock (configurable)

### Phase 2 — Enhanced (Target: +2 weeks)

- Breached email check (HIBP API key gated)
- Missing TOTP detection (static domain list)
- Duplicate item detection
- Persist dismissed/snoozed state across sessions (local encrypted storage)
- "Fix now" actions: link to password generator, open item editor
- OS notifications for new critical findings between scans

### Phase 3 — Advanced (Target: +2 weeks)

- Passkey availability check (passkeys.directory or 2fa.directory API)
- Replace static TOTP domain list with 2fa.directory API
- Trend tracking: "Your score improved from 72 → 85 this month"
- Export security report as PDF (for compliance / sharing)
- Watchtower findings surfaced in Quick Launcher results
- Inline item badges in main vault browser view (red dot on breached items)

---

## 13. API Reference

### HIBP Pwned Passwords (k-Anonymity)

```
GET https://api.pwnedpasswords.com/range/{first5HashChars}

Headers:
  User-Agent: DockWarden-Watchtower
  Add-Padding: true

Response: text/plain
  0018A45C4D1DEF81644B54AB7F969B88D65:1
  00D4F6E8FA6EECAD2A3AA415EEC418D38EC:2
  011053FD0102E94D6AE2F8B83D76FAF94F6:1
  ...

Rate limit: 10 requests/second (unauthenticated)
Cost: Free, no API key required
```

### HIBP Breached Account (Phase 2, requires API key)

```
GET https://haveibeenpwned.com/api/v3/breachedaccount/{email}?truncateResponse=false

Headers:
  User-Agent: DockWarden-Watchtower
  hibp-api-key: {user's API key}

Response: application/json
  [{ "Name": "LinkedIn", "BreachDate": "2012-05-05", ... }]

Rate limit: Dependent on HIBP subscription
Cost: $3.50/month for API key — user-provided, optional
```

---

## 14. Files to Create / Modify

### New Files

| Path | Description |
|---|---|
| `src/app/features/watchtower/` | Entire feature folder (structure in §2.1) |
| `electron/handlers/watchtower.handler.ts` | Main process IPC handler |
| `electron/handlers/watchtower-checks.ts` | Fast local check functions |
| `electron/handlers/health-score.ts` | Score calculator |
| `electron/workers/breach-check.worker.ts` | HIBP k-Anonymity worker |
| `electron/workers/strength-check.worker.ts` | zxcvbn password scoring worker |
| `shared/models/watchtower.models.ts` | Shared TypeScript interfaces/enums |
| `tests/watchtower/` | All test files (structure in §11.1) |

### Modified Files

| Path | Change |
|---|---|
| `electron/preload.ts` | Add `watchtower` API to `contextBridge` |
| `electron/main.ts` | Import and call `registerWatchtowerHandlers()` |
| `src/app/app.routes.ts` | Add lazy-loaded `watchtower` route |
| `src/app/shared/layout/sidebar` | Add Watchtower nav item with badge |
| `electron/tray/` | Add badge count update hook |
| `src/app/features/settings/` | Add Watchtower settings section |
| `package.json` | Add `zxcvbn` + `@types/zxcvbn` |

---

## 15. Acceptance Criteria

- [ ] User can trigger a manual scan from the Watchtower dashboard
- [ ] Scan completes within 60 seconds for a vault with 200 items
- [ ] Breached passwords are correctly identified via HIBP k-Anonymity
- [ ] No full passwords or full hashes are sent to any external service
- [ ] Weak passwords (zxcvbn score 0-1) are flagged with crack time estimate
- [ ] Reused passwords show which other accounts share the same password
- [ ] HTTP URIs (non-localhost) are flagged as insecure
- [ ] Health score displays 5 sub-scores and 1 composite score (0-100)
- [ ] Each finding has a dismiss and snooze (30 day) action
- [ ] Dismissed findings are excluded from the dashboard and score
- [ ] Scan progress is displayed in real-time with phase indicators
- [ ] System tray icon shows issue count badge
- [ ] All results are cleared from memory on vault lock
- [ ] Auto-scan on unlock works when enabled in settings
- [ ] All checks can be individually enabled/disabled in settings
- [ ] All unit tests pass
- [ ] Scan can be cancelled mid-run without hanging workers
