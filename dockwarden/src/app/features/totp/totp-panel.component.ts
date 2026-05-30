import {
  Component, inject, signal, computed, OnInit, OnDestroy, ChangeDetectionStrategy
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { VaultService, CustomIcon } from '../../core/vault.service';
import { ClipboardService } from '../../core/clipboard.service';
import { VaultItem } from '../../shared/models';

export interface TotpEntry {
  item: VaultItem;
  code: string;
  secondsLeft: number;
  period: number;
  urgency: 'ok' | 'warn' | 'critical';
}

// ── Minimal TOTP implementation using Web Crypto API ─────────────────────────

function base32Decode(encoded: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = encoded.toUpperCase().replace(/\s|=/g, '');
  const bytes: number[] = [];
  let buffer = 0;
  let bitsLeft = 0;
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) continue;
    buffer = (buffer << 5) | idx;
    bitsLeft += 5;
    if (bitsLeft >= 8) {
      bitsLeft -= 8;
      bytes.push((buffer >> bitsLeft) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

async function computeTotp(secret: string): Promise<{ code: string; secondsLeft: number; period: number }> {
  let rawSecret = secret;
  let period = 30;
  let digits = 6;

  if (secret.startsWith('otpauth://')) {
    try {
      const url = new URL(secret);
      rawSecret = url.searchParams.get('secret') ?? secret;
      period = parseInt(url.searchParams.get('period') ?? '30', 10);
      digits = parseInt(url.searchParams.get('digits') ?? '6', 10);
    } catch { /* fall through */ }
  }

  const keyBytes = base32Decode(rawSecret);
  if (keyBytes.length === 0) throw new Error('Invalid TOTP secret');

  const epoch = Math.floor(Date.now() / 1000);
  const counter = Math.floor(epoch / period);
  const secondsLeft = period - (epoch % period);

  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']
  );

  const counterBuf = new ArrayBuffer(8);
  const view = new DataView(counterBuf);
  // Write 64-bit big-endian counter
  view.setUint32(0, Math.floor(counter / 0x100000000) >>> 0, false);
  view.setUint32(4, counter >>> 0, false);

  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, counterBuf));
  const offset = sig[sig.length - 1] & 0x0f;
  const otp = (
    ((sig[offset] & 0x7f) << 24) |
    ((sig[offset + 1] & 0xff) << 16) |
    ((sig[offset + 2] & 0xff) << 8) |
    (sig[offset + 3] & 0xff)
  ) % Math.pow(10, digits);

  return { code: otp.toString().padStart(digits, '0'), secondsLeft, period };
}

// ── Component ─────────────────────────────────────────────────────────────────

@Component({
  selector: 'app-totp-panel',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './totp-panel.component.html',
  styleUrl: './totp-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TotpPanelComponent implements OnInit, OnDestroy {
  private readonly vaultService = inject(VaultService);
  readonly clipboardService = inject(ClipboardService);

  readonly totpEntries = signal<TotpEntry[]>([]);
  readonly copiedId = signal<string | null>(null);
  readonly customIcons = signal<Record<string, CustomIcon>>({});

  readonly totpItems = computed(() =>
    this.vaultService.items().filter(i => !!i.totp)
  );

  readonly searchQuery = signal('');
  readonly filteredEntries = computed(() => {
    const q = this.searchQuery().toLowerCase();
    const entries = this.totpEntries();
    if (!q) return entries;
    return entries.filter(e =>
      e.item.name.toLowerCase().includes(q) ||
      (e.item.username ?? '').toLowerCase().includes(q)
    );
  });

  private _interval?: ReturnType<typeof setInterval>;

  async ngOnInit(): Promise<void> {
    const icons = await this.vaultService.getCustomIcons();
    this.customIcons.set(icons);
    await this.refreshCodes();
    this._interval = setInterval(() => this.refreshCodes(), 1000);
  }

  ngOnDestroy(): void {
    clearInterval(this._interval);
  }

  private async refreshCodes(): Promise<void> {
    const items = this.totpItems();
    const entries: TotpEntry[] = [];
    for (const item of items) {
      try {
        const { code, secondsLeft, period } = await computeTotp(item.totp!);
        const urgency: TotpEntry['urgency'] =
          secondsLeft <= 5 ? 'critical' :
          secondsLeft <= 10 ? 'warn' : 'ok';
        entries.push({ item, code, secondsLeft, period, urgency });
      } catch {
        // skip invalid secrets silently
      }
    }
    // Sort by urgency (critical first), then alphabetically
    entries.sort((a, b) => {
      const urgOrder = { critical: 0, warn: 1, ok: 2 };
      const diff = urgOrder[a.urgency] - urgOrder[b.urgency];
      return diff !== 0 ? diff : a.item.name.localeCompare(b.item.name);
    });
    this.totpEntries.set(entries);
  }

  async copyCode(entry: TotpEntry): Promise<void> {
    await this.clipboardService.copy(entry.code, `${entry.item.name} TOTP`);
    this.copiedId.set(entry.item.id);
    setTimeout(() => this.copiedId.set(null), 2000);
  }

  formatCode(code: string): string {
    // Format as "123 456" for readability
    return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
  }

  getArcStrokeDashoffset(entry: TotpEntry): number {
    const radius = 14;
    const circumference = 2 * Math.PI * radius;
    const fraction = entry.secondsLeft / entry.period;
    return circumference * (1 - fraction);
  }

  arcCircumference = 2 * Math.PI * 14; // r=14

  getItemColor(item: VaultItem): string {
    const palette = ['#ef4444','#3b82f6','#f59e0b','#22c55e','#a855f7','#ec4899','#06b6d4','#f97316'];
    return palette[item.name.charCodeAt(0) % palette.length];
  }

  getInitials(name: string): string {
    return name.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
  }

  getCustomIcon(itemId: string): CustomIcon | null {
    return this.customIcons()[itemId] ?? null;
  }
}
