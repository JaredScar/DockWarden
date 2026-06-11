import { Component, inject, signal, computed, ChangeDetectionStrategy, OnInit } from '@angular/core';
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
  readonly detectingCli = signal(false);
  readonly cliMissing = computed(() => this.errorMessage().startsWith('CLI_NOT_FOUND:'));

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

  openSettings(): void {
    this.router.navigate(['/settings']);
  }

  async autoDetectCli(): Promise<void> {
    if (!window.electronAPI || this.detectingCli()) return;
    this.detectingCli.set(true);
    try {
      const result = await window.electronAPI.bw.autoDetect();
      if (result.found && result.path) {
        await window.electronAPI.bw.setCliPath(result.path);
        this.errorMessage.set('');
        // Retry the check — if it now works, the user can proceed
        const check = await window.electronAPI.bw.checkCli();
        if (!check.success) {
          this.errorMessage.set('CLI_NOT_FOUND: Found a binary at ' + result.path + ' but it did not respond to --version. Open Settings to configure it manually.');
        }
      } else {
        this.errorMessage.set(
          'CLI_NOT_FOUND: Could not auto-detect the Bitwarden CLI. ' +
          'Install it with "npm install -g @bitwarden/cli" then open Settings to set the path.'
        );
      }
    } finally {
      this.detectingCli.set(false);
    }
  }
}
