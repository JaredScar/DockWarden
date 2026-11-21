import { Component, inject, input, output, signal, computed, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { VaultItem, AutotypeRule } from '../../shared/models';
import { VaultService } from '../../core/vault.service';
import { ClipboardService } from '../../core/clipboard.service';
import { PowerService } from '../../core/power.service';

@Component({
  selector: 'app-item-power-panel',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './item-power-panel.component.html',
  styleUrl: './item-power-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ItemPowerPanelComponent {
  private readonly vault = inject(VaultService);
  private readonly clipboard = inject(ClipboardService);
  readonly power = inject(PowerService);

  readonly item = input.required<VaultItem>();
  readonly changed = output<void>();

  readonly ruleWindow = signal('');
  readonly ruleSequence = signal('{USERNAME}{TAB}{PASSWORD}{ENTER}');
  readonly busy = signal('');
  readonly message = signal('');

  readonly linkChoices = computed(() =>
    this.vault.items().filter(entry => entry.type === 'login' && entry.id !== this.item().id)
  );

  field(names: string[]): string {
    const wanted = names.map(name => name.toLowerCase());
    const found = (this.item().customFields || []).find(entry => wanted.includes(entry.name.toLowerCase()));
    return found?.value || '';
  }

  linkName(id: string | null | undefined): string {
    if (!id) return '';
    return this.vault.items().find(entry => entry.id === id)?.name || 'another item';
  }

  reference(field: string): string {
    return `dw://${this.item().id}/${field}`;
  }

  async saveLinks(username: string, password: string): Promise<void> {
    await this.save({
      links: {
        username: username || null,
        password: password || null,
      },
    });
  }

  async saveSequence(sequence: string): Promise<void> {
    await this.save({ defaultSequence: sequence.trim() || null });
  }

  onSequence(event: Event): void {
    this.saveSequence((event.target as HTMLInputElement).value);
  }

  async saveRotateUrl(url: string): Promise<void> {
    await this.save({ rotateUrl: url.trim() || null });
  }

  onRotateUrl(event: Event): void {
    this.saveRotateUrl((event.target as HTMLInputElement).value);
  }

  async confirmRotate(): Promise<void> {
    const ok = await this.power.confirmRotation();
    if (ok) this.changed.emit();
  }

  async addRule(): Promise<void> {
    const value = this.ruleWindow().trim();
    if (!value) return;
    const rules: AutotypeRule[] = [...(this.item().autotypeRules || []), {
      id: crypto.randomUUID(),
      match: 'contains',
      value,
      sequence: this.ruleSequence().trim() || '{USERNAME}{TAB}{PASSWORD}{ENTER}',
    }];
    const ok = await this.save({ autotypeRules: rules });
    if (ok) this.ruleWindow.set('');
  }

  async removeRule(id: string): Promise<void> {
    const rules = (this.item().autotypeRules || []).filter(rule => rule.id !== id);
    await this.save({ autotypeRules: rules });
  }

  async showLargeType(): Promise<void> {
    const item = this.item();
    if (!item.password || !window.electronAPI?.power) return;
    const ssid = this.field(['SSID', 'ssid']);
    await window.electronAPI.power.showLargeType({ title: item.name, secret: item.password, ssid });
  }

  async copyReference(field: string): Promise<void> {
    await this.clipboard.copy(this.reference(field), field);
    this.message.set('Reference copied. Use it with dw-run while this vault is unlocked.');
  }

  async launchSsh(): Promise<void> {
    const host = this.field(['Host', 'host', 'Hostname', 'IP']);
    if (!host || !window.electronAPI?.launch) return;
    const result = await window.electronAPI.launch.ssh(this.item().username || '', host, this.field(['Port', 'port']));
    this.message.set(result.success ? `Opening SSH to ${host}` : (result.error || 'Could not launch SSH'));
  }

  async launchRdp(): Promise<void> {
    const host = this.field(['Host', 'host', 'Hostname', 'IP']);
    if (!host || !window.electronAPI?.launch) return;
    const result = await window.electronAPI.launch.rdp(host, this.field(['Port', 'port']));
    this.message.set(result.success ? `Opening Remote Desktop to ${host}` : (result.error || 'Could not launch Remote Desktop'));
  }

  async copyDatabaseUrl(): Promise<void> {
    const host = this.field(['Host', 'host', 'Hostname']);
    if (!host) return;
    const user = this.item().username || '';
    const port = this.field(['Port', 'port']) || '5432';
    const database = this.field(['Database', 'Database Name']) || '';
    const url = `postgresql://${user}@${host}:${port}/${database}`;
    await this.clipboard.copy(url, 'url');
    this.message.set('Connection string copied.');
  }

  private async save(patch: Parameters<VaultService['updateItemMeta']>[1]): Promise<boolean> {
    this.busy.set('Saving…');
    this.message.set('');
    const result = await this.vault.updateItemMeta(this.item().id, patch);
    this.busy.set('');
    if (!result.success) {
      this.message.set(result.error || 'Could not save');
      return false;
    }
    this.changed.emit();
    return true;
  }
}
