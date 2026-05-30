import { Component, inject, signal, computed, ChangeDetectionStrategy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { VaultService, ExpiryPolicy } from '../../core/vault.service';
import { VaultItem } from '../../shared/models';

type ExpiryTab = 'all' | 'expired' | 'this-week' | 'this-month';
type MainTab = 'tracker' | 'policies';

@Component({
  selector: 'app-expiry',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './expiry.component.html',
  styleUrl: './expiry.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ExpiryComponent implements OnInit {
  private readonly vaultService = inject(VaultService);

  readonly mainTab = signal<MainTab>('tracker');
  readonly activeTab = signal<ExpiryTab>('all');
  readonly snoozed = signal<Set<string>>(new Set());

  // ── Per-item expiry tracker ────────────────────────────────────────────────

  readonly allExpiryItems = computed(() => {
    return this.vaultService.items()
      .filter(i => i.expiresAt)
      .map(item => ({
        item,
        status: this.vaultService.getExpiryStatus(item),
        days: this.vaultService.getDaysUntilExpiry(item),
      }))
      .filter(e => e.status !== 'ok')
      .sort((a, b) => new Date(a.item.expiresAt!).getTime() - new Date(b.item.expiresAt!).getTime());
  });

  readonly expiredItems = computed(() => this.allExpiryItems().filter(e => e.status === 'expired'));
  readonly thisWeekItems = computed(() => this.allExpiryItems().filter(e => e.status === 'this-week'));
  readonly thisMonthItems = computed(() => this.allExpiryItems().filter(e => e.status === 'this-month'));

  readonly displayedItems = computed(() => {
    switch (this.activeTab()) {
      case 'expired': return this.expiredItems();
      case 'this-week': return this.thisWeekItems();
      case 'this-month': return this.thisMonthItems();
      default: return this.allExpiryItems();
    }
  });

  // ── Policy dashboard ───────────────────────────────────────────────────────

  readonly policies = signal<ExpiryPolicy[]>([]);
  readonly loadingPolicies = signal(true);
  readonly savingPolicies = signal(false);

  readonly enabledPolicies = computed(() => this.policies().filter(p => p.enabled));

  readonly policyResults = computed(() => {
    const items = this.vaultService.items();
    return this.policies().map(policy => ({
      policy,
      flaggedItems: this.vaultService.getPolicyFlaggedItems(items, policy),
    }));
  });

  readonly totalViolations = computed(() =>
    this.policyResults().reduce((sum, r) => sum + r.flaggedItems.length, 0)
  );

  // Policy editor modal state
  readonly editingPolicy = signal<ExpiryPolicy | null>(null);
  readonly editPolicyName = signal('');
  readonly editPolicyDesc = signal('');
  readonly editPolicyDays = signal(90);
  readonly editPolicyNotifyDays = signal(14);
  readonly editPolicyTypes = signal<string[]>(['login']);
  readonly editPolicyEnabled = signal(true);

  readonly ITEM_TYPES = ['login', 'card', 'note', 'identity'];

  // Policy detail panel (expand in right panel)
  readonly selectedPolicy = signal<string | null>(null);

  readonly selectedPolicyResult = computed(() => {
    const id = this.selectedPolicy();
    if (!id) return null;
    return this.policyResults().find(r => r.policy.id === id) ?? null;
  });

  async ngOnInit(): Promise<void> {
    const loaded = await this.vaultService.getExpiryPolicies();
    this.policies.set(loaded);
    this.loadingPolicies.set(false);
  }

  // ── Tracker helpers ────────────────────────────────────────────────────────

  snoozeItem(id: string): void {
    this.snoozed.update(s => new Set([...s, id]));
  }

  isSnooze(id: string): boolean {
    return this.snoozed().has(id);
  }

  getStatusBadge(status: string, days: number | null): { label: string; cssClass: string } {
    if (status === 'expired') return { label: 'Expired', cssClass: 'badge-expired' };
    if (days !== null) return { label: `${days} days`, cssClass: status === 'this-week' ? 'badge-warning' : 'badge-info' };
    return { label: '', cssClass: '' };
  }

  getExpiryDate(item: VaultItem): string {
    if (!item.expiresAt) return '';
    return new Date(item.expiresAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  getLastModified(item: VaultItem): string {
    if (!item.lastModified) return 'Unknown';
    return new Date(item.lastModified).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  getDaysStale(item: VaultItem): number {
    if (!item.lastModified) return 0;
    return Math.floor((Date.now() - new Date(item.lastModified).getTime()) / (1000 * 60 * 60 * 24));
  }

  // ── Policy CRUD ────────────────────────────────────────────────────────────

  async togglePolicy(id: string): Promise<void> {
    const updated = this.policies().map(p =>
      p.id === id ? { ...p, enabled: !p.enabled } : p
    );
    this.policies.set(updated);
    await this.vaultService.setExpiryPolicies(updated);
  }

  openAddPolicy(): void {
    this.editPolicyName.set('');
    this.editPolicyDesc.set('');
    this.editPolicyDays.set(90);
    this.editPolicyNotifyDays.set(14);
    this.editPolicyTypes.set(['login']);
    this.editPolicyEnabled.set(true);
    this.editingPolicy.set({
      id: '',
      name: '',
      description: '',
      type: 'password-age',
      thresholdDays: 90,
      itemTypes: ['login'],
      enabled: true,
      notifyDaysBefore: 14,
    });
  }

  openEditPolicy(policy: ExpiryPolicy): void {
    this.editPolicyName.set(policy.name);
    this.editPolicyDesc.set(policy.description);
    this.editPolicyDays.set(policy.thresholdDays);
    this.editPolicyNotifyDays.set(policy.notifyDaysBefore);
    this.editPolicyTypes.set([...policy.itemTypes]);
    this.editPolicyEnabled.set(policy.enabled);
    this.editingPolicy.set(policy);
  }

  closeEditPolicy(): void {
    this.editingPolicy.set(null);
  }

  toggleEditType(type: string): void {
    const current = this.editPolicyTypes();
    if (current.includes(type)) {
      this.editPolicyTypes.set(current.filter(t => t !== type));
    } else {
      this.editPolicyTypes.set([...current, type]);
    }
  }

  async savePolicy(): Promise<void> {
    const editing = this.editingPolicy();
    if (!editing) return;

    const isNew = !editing.id;
    const updated: ExpiryPolicy = {
      id: isNew ? `policy-${Date.now()}` : editing.id,
      name: this.editPolicyName() || 'Unnamed Policy',
      description: this.editPolicyDesc(),
      type: 'password-age',
      thresholdDays: this.editPolicyDays(),
      itemTypes: this.editPolicyTypes().length > 0 ? this.editPolicyTypes() : ['login'],
      enabled: this.editPolicyEnabled(),
      notifyDaysBefore: this.editPolicyNotifyDays(),
    };

    this.savingPolicies.set(true);
    const newList = isNew
      ? [...this.policies(), updated]
      : this.policies().map(p => p.id === updated.id ? updated : p);
    this.policies.set(newList);
    await this.vaultService.setExpiryPolicies(newList);
    this.savingPolicies.set(false);
    this.editingPolicy.set(null);
  }

  async deletePolicy(id: string): Promise<void> {
    const updated = this.policies().filter(p => p.id !== id);
    this.policies.set(updated);
    await this.vaultService.setExpiryPolicies(updated);
    if (this.selectedPolicy() === id) this.selectedPolicy.set(null);
  }
}
