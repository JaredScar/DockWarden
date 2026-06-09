import { Component, inject, signal, computed, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ToggleSwitch } from 'primeng/toggleswitch';
import { WatchtowerService } from './watchtower.service';
import {
  WatchtowerFinding,
  WatchtowerCategory,
  Severity,
  ScanPhase,
  CATEGORY_METADATA,
  PHASE_LABEL,
} from './watchtower.models';

@Component({
  selector: 'app-watchtower',
  standalone: true,
  imports: [CommonModule, FormsModule, ToggleSwitch],
  templateUrl: './watchtower.component.html',
  styleUrl: './watchtower.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WatchtowerComponent {
  readonly wt = inject(WatchtowerService);

  // Categories expanded state — all expanded by default after scan
  private readonly _expandedCategories = signal<Set<WatchtowerCategory>>(
    new Set(Object.values(WatchtowerCategory))
  );

  // Settings panel visibility
  readonly showSettings = signal(false);

  // Snooze menu open for which finding
  readonly snoozeMenuFindingId = signal<string | null>(null);

  // Sorted category entries with findings
  readonly sortedCategories = computed(() => {
    const map = this.wt.findingsByCategory();
    return Object.values(WatchtowerCategory)
      .map(cat => ({
        category: cat,
        meta: CATEGORY_METADATA[cat],
        findings: map.get(cat) ?? [],
      }))
      .filter(e => e.findings.length > 0)
      .sort((a, b) => a.meta.sortOrder - b.meta.sortOrder);
  });

  // Categories with zero findings (to show "all clear" rows)
  readonly cleanCategories = computed(() => {
    const withIssues = new Set(this.wt.findingsByCategory().keys());
    return Object.values(WatchtowerCategory)
      .filter(cat => !withIssues.has(cat))
      .map(cat => ({ category: cat, meta: CATEGORY_METADATA[cat] }))
      .sort((a, b) => a.meta.sortOrder - b.meta.sortOrder);
  });

  readonly scanProgressPercent = computed(() => {
    const p = this.wt.scanProgress();
    if (!p || p.totalItems === 0) return 10;
    const phaseWeight = this.phaseToWeight(p.phase);
    return Math.min(Math.round(phaseWeight + (p.processedItems / p.totalItems) * 20), 95);
  });

  // Expose enums/maps to template
  readonly ScanPhase = ScanPhase;
  readonly PHASE_LABEL = PHASE_LABEL;
  readonly Severity = Severity;
  readonly CATEGORY_METADATA = CATEGORY_METADATA;

  // ── Helpers ──────────────────────────────────────────────────────────────────

  isCategoryExpanded(cat: WatchtowerCategory): boolean {
    return this._expandedCategories().has(cat);
  }

  toggleCategory(cat: WatchtowerCategory): void {
    this._expandedCategories.update(s => {
      const next = new Set(s);
      next.has(cat) ? next.delete(cat) : next.add(cat);
      return next;
    });
  }

  severityClass(sev: Severity): string {
    return `sev-${sev}`;
  }

  severityLabel(sev: Severity): string {
    const labels: Record<Severity, string> = {
      [Severity.CRITICAL]: 'Critical',
      [Severity.HIGH]:     'High',
      [Severity.MEDIUM]:   'Medium',
      [Severity.LOW]:      'Low',
      [Severity.INFO]:     'Info',
    };
    return labels[sev];
  }

  scoreColor(score: number): string {
    if (score >= 80) return '#3fb950';
    if (score >= 60) return '#e3b341';
    return '#f85149';
  }

  timeAgo(ts: number): string {
    const secs = Math.floor((Date.now() - ts) / 1000);
    if (secs < 60) return 'just now';
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  }

  openUri(uri: string | null): void {
    if (!uri) return;
    window.electronAPI?.app?.openExternal?.(uri);
  }

  handleAction(finding: WatchtowerFinding, action: string): void {
    switch (action) {
      case 'dismiss':
        this.wt.dismissFinding(finding.id);
        break;
      case 'snooze_7':
        this.wt.snoozeFinding(finding.id, 7);
        this.snoozeMenuFindingId.set(null);
        break;
      case 'snooze_30':
        this.wt.snoozeFinding(finding.id, 30);
        this.snoozeMenuFindingId.set(null);
        break;
      case 'open_uri':
        this.openUri(finding.vaultItemUri);
        break;
    }
  }

  toggleSnoozeMenu(findingId: string, event: MouseEvent): void {
    event.stopPropagation();
    this.snoozeMenuFindingId.update(id => id === findingId ? null : findingId);
  }

  closeSnoozeMenu(): void {
    this.snoozeMenuFindingId.set(null);
  }

  toggleSettings(): void {
    this.showSettings.update(v => !v);
  }

  getCheckEnabled(key: string): boolean {
    const checks = this.wt.settings().enabledChecks;
    return (checks as Record<string, boolean>)[key] ?? true;
  }

  onCheckToggle(key: string, value: boolean): void {
    this.wt.updateEnabledCheck(key as any, value);
  }

  onAutoScanToggle(value: boolean): void {
    this.wt.saveSettings({ autoScanOnUnlock: value });
  }

  /** Called by PrimeNG ToggleSwitch ngModelChange for per-check toggles */
  onPrimeCheckChange(key: string, value: boolean): void {
    this.wt.updateEnabledCheck(key as any, value);
  }

  /** Called by PrimeNG ToggleSwitch ngModelChange for auto-scan */
  onPrimeAutoScanChange(value: boolean): void {
    this.wt.saveSettings({ autoScanOnUnlock: value });
  }

  private phaseToWeight(phase: ScanPhase): number {
    const weights: Record<ScanPhase, number> = {
      [ScanPhase.IDLE]: 0,
      [ScanPhase.CHECKING_BREACHES]: 5,
      [ScanPhase.CHECKING_STRENGTH]: 30,
      [ScanPhase.CHECKING_REUSE]: 55,
      [ScanPhase.CHECKING_URIS]: 65,
      [ScanPhase.CHECKING_TOTP]: 72,
      [ScanPhase.CHECKING_DUPLICATES]: 80,
      [ScanPhase.COMPLETE]: 100,
    };
    return weights[phase] ?? 0;
  }

  scoreLabel(overall: number): string {
    if (overall >= 90) return 'Excellent';
    if (overall >= 75) return 'Good';
    if (overall >= 55) return 'Fair';
    if (overall >= 35) return 'Poor';
    return 'Critical';
  }
}
