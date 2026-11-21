import { Component, OnInit, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ClipboardService } from '../../core/clipboard.service';

@Component({
  selector: 'app-run-desk',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './run-desk.component.html',
  styleUrl: './run-desk.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RunDeskComponent implements OnInit {
  private readonly clipboard = inject(ClipboardService);
  readonly listening = signal(false);
  readonly example = signal('');
  readonly copied = signal(false);

  async ngOnInit(): Promise<void> {
    const status = await window.electronAPI?.power.runStatus();
    this.listening.set(!!status?.listening);
    this.example.set(status?.example || 'node electron/dw-run.js run --env API_TOKEN=dw://ItemId/password -- npm start');
  }

  async copy(): Promise<void> {
    await this.clipboard.copy(this.example(), 'url');
    this.copied.set(true);
  }
}
