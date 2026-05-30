import { Component, inject, signal, OnInit, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { VaultService, AccountProfile } from '../../core/vault.service';

const ACCOUNT_COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#06b6d4', '#ec4899', '#f97316'];

@Component({
  selector: 'app-accounts',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './accounts.component.html',
  styleUrl: './accounts.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AccountsComponent implements OnInit {
  private readonly vaultService = inject(VaultService);
  private readonly router = inject(Router);

  readonly profiles = signal<AccountProfile[]>([]);
  readonly activeId = signal<string | null>(null);
  readonly loading = signal(true);

  // ── Add Account form ───────────────────────────────────────────────────────
  readonly showAddForm = signal(false);
  readonly addEmail = signal('');
  readonly addPassword = signal('');
  readonly addServer = signal('https://bitwarden.com');
  readonly addShowPw = signal(false);
  readonly addSaving = signal(false);
  readonly addError = signal('');

  readonly COLORS = ACCOUNT_COLORS;

  async ngOnInit(): Promise<void> {
    const [profiles, activeId] = await Promise.all([
      this.vaultService.getAccountProfiles(),
      this.vaultService.getActiveAccountId(),
    ]);
    this.profiles.set(profiles);
    this.activeId.set(activeId);
    this.loading.set(false);
  }

  openAddForm(): void {
    this.addEmail.set('');
    this.addPassword.set('');
    this.addServer.set('https://bitwarden.com');
    this.addError.set('');
    this.addShowPw.set(false);
    this.showAddForm.set(true);
  }

  cancelAdd(): void {
    this.showAddForm.set(false);
    this.addError.set('');
  }

  async submitAdd(): Promise<void> {
    const email = this.addEmail().trim();
    const password = this.addPassword();
    const server = this.addServer().trim() || 'https://bitwarden.com';
    if (!email || !password) { this.addError.set('Email and password are required.'); return; }

    this.addSaving.set(true);
    this.addError.set('');

    // Logout of current session then login with new credentials
    await window.electronAPI?.vault.logout();
    const result = await window.electronAPI?.vault.login(email, password, server);

    this.addSaving.set(false);

    if (result?.success) {
      const [profiles, activeId] = await Promise.all([
        this.vaultService.getAccountProfiles(),
        this.vaultService.getActiveAccountId(),
      ]);
      this.profiles.set(profiles);
      this.activeId.set(activeId);
      this.showAddForm.set(false);
      // Navigate home with new vault loaded
      this.router.navigate(['/home']);
    } else if (result?.requiresTwoFactor) {
      this.addError.set('This account requires 2FA. Please use the main login screen to sign in with a verification code.');
    } else {
      this.addError.set(result?.error ?? 'Login failed. Check your credentials and try again.');
    }
  }

  async switchTo(profile: AccountProfile): Promise<void> {
    if (profile.id === this.activeId()) return;
    await this.vaultService.switchAccount(profile.id);
    // switchAccount navigates to /unlock; nothing else needed here
  }

  async remove(id: string): Promise<void> {
    if (id === this.activeId()) return; // can't remove active
    await this.vaultService.removeAccountProfile(id);
    this.profiles.update(list => list.filter(p => p.id !== id));
  }

  getInitials(name: string): string {
    return name.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
  }

  colorForIndex(i: number): string {
    return ACCOUNT_COLORS[i % ACCOUNT_COLORS.length];
  }
}
