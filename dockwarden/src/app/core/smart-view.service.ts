import { Injectable, signal, computed } from '@angular/core';
import { SmartView, FilterCondition, VaultItem } from '../shared/models';
import { VaultService } from './vault.service';
import { inject } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class SmartViewService {
  private readonly vaultService = inject(VaultService);

  private readonly _views = signal<SmartView[]>([
    { id: '1', name: 'Work Logins', conditions: [{ id: '1', field: 'folder', operator: 'equals', value: 'work' }, { id: '2', field: 'type', operator: 'equals', value: 'login' }], operator: 'AND', itemCount: 45 },
    { id: '2', name: 'Expiring This Month', conditions: [{ id: '1', field: 'expiry', operator: 'before', value: '30' }], operator: 'AND', itemCount: 8 },
    { id: '3', name: 'Without TOTP', conditions: [{ id: '1', field: 'totp', operator: 'not-exists', value: '' }], operator: 'AND', itemCount: 124 },
    { id: '4', name: 'API Keys & Tokens', conditions: [{ id: '1', field: 'tag', operator: 'equals', value: 'api-keys' }], operator: 'OR', itemCount: 31 },
    { id: '5', name: 'Shared Credentials', conditions: [{ id: '1', field: 'tag', operator: 'equals', value: 'shared' }], operator: 'AND', itemCount: 18 },
  ]);

  readonly views = this._views.asReadonly();

  readonly pinnedViews = computed(() => this._views().filter(v => v.pinned));

  addView(view: Omit<SmartView, 'id' | 'itemCount'>): void {
    const newView: SmartView = {
      ...view,
      id: crypto.randomUUID(),
      itemCount: this.evaluateView({ ...view, id: '', itemCount: 0 }).length,
    };
    this._views.update(v => [...v, newView]);
  }

  deleteView(id: string): void {
    this._views.update(v => v.filter(view => view.id !== id));
  }

  togglePin(id: string): void {
    this._views.update(v => v.map(view => view.id === id ? { ...view, pinned: !view.pinned } : view));
  }

  evaluateView(view: SmartView): VaultItem[] {
    const items = this.vaultService.items();
    return items.filter(item => {
      const results = view.conditions.map(c => this.evalCondition(item, c));
      return view.operator === 'AND' ? results.every(Boolean) : results.some(Boolean);
    });
  }

  private evalCondition(item: VaultItem, condition: FilterCondition): boolean {
    switch (condition.field) {
      case 'tag': return item.tags.includes(condition.value);
      case 'folder': return item.folderId === condition.value;
      case 'type': return item.type === condition.value;
      case 'totp':
        return condition.operator === 'exists' ? !!item.totp : !item.totp;
      case 'expiry': {
        if (!item.expiresAt) return false;
        const days = parseInt(condition.value, 10);
        const diff = new Date(item.expiresAt).getTime() - Date.now();
        return diff < days * 24 * 60 * 60 * 1000;
      }
      default: return false;
    }
  }
}
