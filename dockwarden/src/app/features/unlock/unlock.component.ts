import { Component, inject, signal, ChangeDetectionStrategy, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { VaultService } from '../../core/vault.service';

type UnlockMode = 'unlock' | 'login' | 'two-factor';

@Component({
  selector: 'app-unlock',
  standalone: true,
  imports: [FormsModule, CommonModule],
  templateUrl: './unlock.component.html',
  styleUrl: './unlock.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UnlockComponent implements OnInit {
  private readonly vaultService = inject(VaultService);
  private readonly router = inject(Router);

  readonly mode = signal<UnlockMode>('unlock');
  readonly email = signal('');
  readonly password = signal('');
  readonly serverUrl = signal('');
  readonly twoFactorCode = signal('');
  readonly twoFactorMethod = signal(1); // default to Email (1) since it's most common for web accounts
  readonly showPassword = signal(false);
  readonly loading = signal(false);
  readonly errorMessage = signal('');
  readonly showAdvanced = signal(false);

  readonly twoFactorMethods = [
    { value: 0, label: 'Authenticator App (TOTP)' },
    { value: 1, label: 'Email' },
    { value: 3, label: 'YubiKey' },
  ];

  async ngOnInit(): Promise<void> {
    const status = await this.vaultService.checkAuthStatus();
    if (status === 'unlocked') {
      this.router.navigate(['/home']);
      return;
    }
    if (status === 'unauthenticated') {
      this.mode.set('login');
      // Pre-fill email from stored config
      if (window.electronAPI) {
        const config = await window.electronAPI.bw.getConfig();
        if (config.bwEmail) this.email.set(config.bwEmail);
        if (config.bwServerUrl && config.bwServerUrl !== 'https://bitwarden.com') {
          this.serverUrl.set(config.bwServerUrl);
        }
      }
    } else {
      this.mode.set('unlock');
      if (window.electronAPI) {
        const config = await window.electronAPI.bw.getConfig();
        if (config.bwEmail) this.email.set(config.bwEmail);
      }
    }
  }

  async submit(): Promise<void> {
    if (this.loading()) return;
    this.errorMessage.set('');
    this.loading.set(true);

    try {
      if (this.mode() === 'two-factor') {
        const result = await this.vaultService.login2fa(
          this.twoFactorCode(),
          this.twoFactorMethod(),
        );
        if (result.success) {
          this.router.navigate(['/home']);
        } else {
          this.errorMessage.set(result.error ?? 'Invalid verification code. Please try again.');
        }
        return;
      }

      let result: { success: boolean; requiresTwoFactor?: boolean; error?: string };

      if (this.mode() === 'login') {
        result = await this.vaultService.login(
          this.email(),
          this.password(),
          this.serverUrl() || undefined,
        );
      } else {
        result = await this.vaultService.unlock(this.password());
      }

      if (result.success) {
        this.router.navigate(['/home']);
      } else if (result.requiresTwoFactor) {
        this.mode.set('two-factor');
        this.twoFactorCode.set('');
      } else {
        this.errorMessage.set(result.error ?? 'Authentication failed. Please try again.');
      }
    } catch (err: unknown) {
      this.errorMessage.set(err instanceof Error ? err.message : 'An unexpected error occurred.');
    } finally {
      this.loading.set(false);
    }
  }

  switchToLogin(): void {
    this.mode.set('login');
    this.password.set('');
    this.errorMessage.set('');
  }
}
