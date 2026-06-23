import { Injectable, inject, signal, computed, effect } from '@angular/core';
import { VaultService } from '../../core/vault.service';
import {
  WatchtowerFinding,
  WatchtowerResults,
  ScanPhase,
  ScanProgress,
  Severity,
  WatchtowerCategory,
} from './watchtower.models';

// ─── Settings ─────────────────────────────────────────────────────────────────

export interface WatchtowerSettings {
  autoScanOnUnlock: boolean;
  enabledChecks: {
    breachedPasswords: boolean;
    weakPasswords: boolean;
    reusedPasswords: boolean;
    insecureUris: boolean;
    missingTotp: boolean;
    duplicateItems: boolean;
  };
}

const DEFAULT_SETTINGS: WatchtowerSettings = {
  autoScanOnUnlock: true,
  enabledChecks: {
    breachedPasswords: true,
    weakPasswords: true,
    reusedPasswords: true,
    insecureUris: true,
    missingTotp: true,
    duplicateItems: true,
  },
};

const SETTINGS_STORE_KEY = 'watchtowerSettings';

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable({ providedIn: 'root' })
export class WatchtowerService {
  private readonly vaultService = inject(VaultService);

  // ── Settings ───────────────────────────────────────────────────────────────
  readonly settings = signal<WatchtowerSettings>(DEFAULT_SETTINGS);
  readonly settingsLoaded = signal(false);

  // ── Scan state ─────────────────────────────────────────────────────────────
  readonly scanPhase    = signal<ScanPhase>(ScanPhase.IDLE);
  readonly scanProgress = signal<ScanProgress | null>(null);
  readonly results      = signal<WatchtowerResults | null>(null);
  readonly findings     = signal<WatchtowerFinding[]>([]);
  readonly lastScannedAt = signal<number | null>(null);
  readonly scanError    = signal<string | null>(null);

  private readonly _dismissedIds = signal<Set<string>>(new Set());

  // ── Computed ───────────────────────────────────────────────────────────────
  readonly isScanning = computed(() =>
    this.scanPhase() !== ScanPhase.IDLE && this.scanPhase() !== ScanPhase.COMPLETE
  );

  readonly activeFindings = computed(() => {
    const dismissed = this._dismissedIds();
    return this.findings().filter(f =>
      !dismissed.has(f.id) &&
      (f.snoozedUntil === null || f.snoozedUntil < Date.now())
    );
  });

  readonly findingsByCategory = computed(() => {
    const grouped = new Map<WatchtowerCategory, WatchtowerFinding[]>();
    for (const f of this.activeFindings()) {
      const list = grouped.get(f.category) ?? [];
      list.push(f);
      grouped.set(f.category, list);
    }
    return grouped;
  });

  /** O(1) lookup: map from vaultItemId → all active findings for that item */
  readonly findingsByItemId = computed(() => {
    const map = new Map<string, WatchtowerFinding[]>();
    for (const f of this.activeFindings()) {
      const list = map.get(f.vaultItemId) ?? [];
      list.push(f);
      map.set(f.vaultItemId, list);
    }
    return map;
  });

  readonly healthScore  = computed(() => this.results()?.scores ?? null);
  readonly totalIssues  = computed(() => this.activeFindings().length);
  readonly criticalCount = computed(() =>
    this.activeFindings().filter(f => f.severity === Severity.CRITICAL).length
  );

  constructor() {
    // Load settings on init
    this.loadSettings();

    // Push tray badge update whenever active findings change
    effect(() => {
      const total    = this.totalIssues();
      const critical = this.criticalCount();
      window.electronAPI?.watchtower?.updateBadge?.(total, critical);
    });

    // Clear results when vault locks
    effect(() => {
      if (!this.vaultService.isUnlocked()) {
        this.clearResults();
      }
    });
  }

  // ── Settings management ────────────────────────────────────────────────────

  async loadSettings(): Promise<void> {
    try {
      const stored = await window.electronAPI?.vault.getSetting(SETTINGS_STORE_KEY, null) as WatchtowerSettings | null;
      if (stored) {
        // Deep-merge so new keys get their defaults
        this.settings.set({
          ...DEFAULT_SETTINGS,
          ...stored,
          enabledChecks: { ...DEFAULT_SETTINGS.enabledChecks, ...stored.enabledChecks },
        });
      }
    } catch { /* use defaults */ } finally {
      this.settingsLoaded.set(true);
    }
  }

  async saveSettings(patch: Partial<WatchtowerSettings>): Promise<void> {
    const next = { ...this.settings(), ...patch };
    this.settings.set(next);
    await window.electronAPI?.vault.setSetting(SETTINGS_STORE_KEY, next);
  }

  async updateEnabledCheck(key: keyof WatchtowerSettings['enabledChecks'], value: boolean): Promise<void> {
    await this.saveSettings({
      enabledChecks: { ...this.settings().enabledChecks, [key]: value },
    });
  }

  // ── Scan lifecycle ─────────────────────────────────────────────────────────

  async startScan(): Promise<void> {
    if (this.isScanning()) return;

    this.scanError.set(null);
    this.scanPhase.set(ScanPhase.CHECKING_BREACHES);

    const api = window.electronAPI!;
    api.watchtower.removeListeners();

    api.watchtower.onScanProgress((raw: unknown) => {
      const progress = raw as ScanProgress;
      this.scanProgress.set(progress);
      this.scanPhase.set(progress.phase);
    });

    api.watchtower.onScanResults((raw: unknown) => {
      const results = raw as WatchtowerResults;
      this.results.set(results);
      this.findings.set(results.findings);
      this.lastScannedAt.set(results.scannedAt);
      this.scanPhase.set(ScanPhase.COMPLETE);
      this.scanProgress.set(null);
      api.watchtower.removeListeners();
    });

    // Serialize only the fields Watchtower needs
    const items = this.vaultService.items()
      .filter(item => item.type === 'login')
      .map(item => ({
        id: item.id,
        name: item.name,
        username: (item as any).username ?? null,
        password: (item as any).password ?? null,
        uris:     (item as any).website ? [(item as any).website] : [],
        totpUri:  (item as any).totp ?? null,
      }));

    try {
      await api.watchtower.startScan(items, this.settings());
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Scan failed';
      this.scanError.set(msg);
      this.scanPhase.set(ScanPhase.IDLE);
      api.watchtower.removeListeners();
    }
  }

  cancelScan(): void {
    window.electronAPI?.watchtower.cancelScan();
    window.electronAPI?.watchtower.removeListeners();
    this.scanPhase.set(ScanPhase.IDLE);
    this.scanProgress.set(null);
  }

  dismissFinding(findingId: string): void {
    this._dismissedIds.update(ids => {
      const next = new Set(ids);
      next.add(findingId);
      return next;
    });
  }

  snoozeFinding(findingId: string, days: number): void {
    const until = Date.now() + days * 24 * 60 * 60 * 1000;
    this.findings.update(fs =>
      fs.map(f => f.id === findingId ? { ...f, snoozedUntil: until } : f)
    );
  }

  clearResults(): void {
    this.results.set(null);
    this.findings.set([]);
    this._dismissedIds.set(new Set());
    this.lastScannedAt.set(null);
    this.scanPhase.set(ScanPhase.IDLE);
    this.scanProgress.set(null);
    this.scanError.set(null);
    window.electronAPI?.watchtower?.removeListeners?.();
  }
}
