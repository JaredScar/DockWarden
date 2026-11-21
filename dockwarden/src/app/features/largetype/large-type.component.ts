import { Component, OnInit, signal, ChangeDetectionStrategy } from '@angular/core';

@Component({
  selector: 'app-large-type',
  standalone: true,
  templateUrl: './large-type.component.html',
  styleUrl: './large-type.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LargeTypeComponent implements OnInit {
  readonly title = signal('Password');
  readonly secret = signal('');
  readonly qr = signal<string | null>(null);
  readonly wifiQr = signal<string | null>(null);
  readonly showWifi = signal(false);

  async ngOnInit(): Promise<void> {
    const payload = await window.electronAPI?.power.getLargeType();
    if (!payload) return;
    this.title.set(payload.title);
    this.secret.set(payload.secret);
    this.qr.set(payload.qr);
    this.wifiQr.set(payload.wifiQr);
  }

  close(): void {
    window.electronAPI?.power.closeLargeType();
  }

  fontSize(): string {
    const length = this.secret().length || 1;
    if (length < 16) return '72px';
    if (length < 28) return '52px';
    if (length < 48) return '36px';
    return '24px';
  }
}
