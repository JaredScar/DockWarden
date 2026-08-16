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
  /** Per-account session states for status badges. */
  readonly sessionStates = signal<Record<string, 'unlocked' | 'locked'>>({});
  /** ID of the account currently being switched to (shows a spinner). */
  readonly switchingId = signal<string | null>(null);

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
    const [profiles, activeId, states] = await Promise.all([
      this.vaultService.getAccountProfiles(),
      this.vaultService.getActiveAccountId(),
      this.vaultService.getAccountSessionStates(),
    ]);
    this.profiles.set(profiles);
    this.activeId.set(activeId);
    this.sessionStates.set(states);
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

    // Use account:add-login so the current session is NOT terminated
    const result = await window.electronAPI?.account.addLogin(email, password, server);

    this.addSaving.set(false);

    if (result?.success) {
      const [profiles, activeId, states] = await Promise.all([
        this.vaultService.getAccountProfiles(),
        this.vaultService.getActiveAccountId(),
        this.vaultService.getAccountSessionStates(),
      ]);
      this.profiles.set(profiles);
      this.activeId.set(activeId);
      this.sessionStates.set(states);
      this.showAddForm.set(false);
      this.router.navigate(['/home']);
    } else if (result?.requiresTwoFactor) {
      this.addError.set('This account requires 2FA — enter the verification code on the sign-in screen.');
    } else {
      this.addError.set(result?.error ?? 'Login failed. Check your credentials and try again.');
    }
  }

  async switchTo(profile: AccountProfile): Promise<void> {
    if (profile.id === this.activeId() || this.switchingId()) return;
    this.switchingId.set(profile.id);
    try {
      const result = await this.vaultService.switchAccount(profile.id);
      if (result.success) {
        this.activeId.set(profile.id);
        // Refresh session state badges
        this.vaultService.getAccountSessionStates().then(s => this.sessionStates.set(s));
        if (result.alreadyUnlocked) {
          // Fast switch — vault is already live, go straight to home
          this.router.navigate(['/home']);
        }
        // If not already unlocked, main process already sent navigate → /unlock
      }
    } finally {
      this.switchingId.set(null);
    }
  }

  async remove(id: string): Promise<void> {
    if (id === this.activeId()) return; // can't remove active
    await this.vaultService.removeAccountProfile(id);
    this.profiles.update(list => list.filter(p => p.id !== id));
    this.sessionStates.update(s => { const n = { ...s }; delete n[id]; return n; });
  }

  getInitials(name: string): string {
    return name.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
  }

  colorForIndex(i: number): string {
    return ACCOUNT_COLORS[i % ACCOUNT_COLORS.length];
  }

  sessionState(id: string): 'unlocked' | 'locked' {
    return this.sessionStates()[id] ?? 'locked';
  }
}
