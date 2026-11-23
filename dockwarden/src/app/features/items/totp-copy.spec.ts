import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ItemsComponent } from './items.component';
import { VaultService } from '../../core/vault.service';
import { ClipboardService } from '../../core/clipboard.service';
import { VaultItem } from '../../shared/models';

const SECRET = 'otpauth://totp/GitHub?secret=JBSWY3DPEHPK3PXP&issuer=GitHub';
const CODE = '482913';

const login: VaultItem = {
  id: '11111111-2222-3333-4444-555555555555',
  name: 'GitHub',
  username: 'octo',
  password: 'hunter2',
  website: 'https://github.com',
  type: 'login',
  tags: [],
  totp: SECRET,
  expiresAt: null,
  folderId: null,
  favorite: false,
  lastModified: '2026-01-01T00:00:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
  passwordStrength: 80,
};

describe('TOTP click to copy', () => {
  const written: string[] = [];
  let getTotp: () => Promise<{ success: boolean; code?: string; error?: string }>;

  beforeEach(async () => {
    written.length = 0;
    getTotp = async () => ({ success: true, code: CODE });
    Object.assign(window, {
      electronAPI: {
        vault: {
          getItems: async () => [login],
          getFolders: async () => [],
          getTotp: () => getTotp(),
          getSetting: async () => null,
          setSetting: async () => true,
        },
        icon: { getAll: async () => ({}) },
        usage: { getAll: async () => ({ marker: 1 }), increment: async () => 1 },
        primary: { getAll: async () => [] },
        clipboard: {
          write: async (text: string) => {
            written.push(text);
            return true;
          },
        },
        watchtower: { updateBadge: () => undefined },
      },
    });

    await TestBed.configureTestingModule({
      imports: [ItemsComponent],
      providers: [provideRouter([])],
    }).compileComponents();
    TestBed.inject(ClipboardService).clearDelay.set(0);
  });

  let fixture: ReturnType<typeof TestBed.createComponent<ItemsComponent>> | undefined;

  afterEach(() => {
    fixture?.destroy();
    fixture = undefined;
    Reflect.deleteProperty(window, 'electronAPI');
  });

  async function openLogin(): Promise<ReturnType<typeof TestBed.createComponent<ItemsComponent>>> {
    await TestBed.inject(VaultService).loadItems();
    fixture = TestBed.createComponent(ItemsComponent);
    fixture.detectChanges();
    await vi.waitFor(() => expect(fixture!.componentInstance.usageCounts()['marker']).toBe(1));
    fixture.componentInstance.selectItem(login);
    fixture.detectChanges();
    return fixture;
  }

  it('copies the current code and leaves the stored secret off the clipboard', async () => {
    const fixture = await openLogin();
    await vi.waitFor(() => expect(fixture.componentInstance.totpCode()).toBe(CODE));
    fixture.detectChanges();

    const row = fixture.nativeElement.querySelector('[title="Click to copy the current code"]') as HTMLElement;
    expect(row.textContent).toContain('482 913');
    expect(row.textContent).not.toContain(SECRET);
    expect(row.textContent).not.toContain('JBSWY3DPEHPK3PXP');

    row.click();
    await vi.waitFor(() => {
      expect(written).toEqual([CODE]);
      expect(fixture.componentInstance.copiedField()).toBe('totp');
    });
  });

  it('does not copy when the current code cannot be read', async () => {
    getTotp = async () => ({ success: false, error: 'Vault is locked' });
    const fixture = await openLogin();
    await vi.waitFor(() => expect(fixture.componentInstance.totpError()).toContain('Could not read'));
    fixture.detectChanges();

    const row = fixture.nativeElement.querySelector('[title="Click to copy the current code"]') as HTMLElement;
    expect(row.textContent).toContain('Could not read the current code');
    expect(row.textContent).not.toContain(SECRET);
    expect(row.textContent).not.toContain('JBSWY3DPEHPK3PXP');

    row.click();
    await Promise.resolve();
    expect(written).toEqual([]);
    expect(fixture.componentInstance.copiedField()).toBeNull();
  });
});
