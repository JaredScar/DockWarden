import { Injectable, signal, computed } from '@angular/core';
import { VaultTemplate, TemplateField } from '../shared/models';

export const BUILT_IN_TEMPLATES: VaultTemplate[] = [
  {
    id: 'builtin-ssh',
    name: 'SSH Server',
    icon: '🖥️',
    color: '#22c55e',
    baseType: 'login',
    description: 'Host, port, key path, and sudo password for SSH access',
    builtIn: true,
    defaultFolder: null,
    fields: [
      { id: 'ssh-host', name: 'Host', type: 'text', defaultValue: '', placeholder: '192.168.1.1', required: true },
      { id: 'ssh-port', name: 'Port', type: 'text', defaultValue: '22', placeholder: '22', required: false },
      { id: 'ssh-key', name: 'Key Path', type: 'text', defaultValue: '', placeholder: '~/.ssh/id_rsa', required: false },
      { id: 'ssh-sudo', name: 'Sudo Password', type: 'hidden', defaultValue: '', placeholder: '', required: false },
    ],
  },
  {
    id: 'builtin-api',
    name: 'API Key',
    icon: '🔌',
    color: '#3b82f6',
    baseType: 'login',
    description: 'Key, secret, endpoint, environment, and expiry date',
    builtIn: true,
    defaultFolder: null,
    fields: [
      { id: 'api-key', name: 'API Key', type: 'hidden', defaultValue: '', placeholder: '', required: true },
      { id: 'api-secret', name: 'API Secret', type: 'hidden', defaultValue: '', placeholder: '', required: false },
      { id: 'api-endpoint', name: 'Endpoint', type: 'url', defaultValue: '', placeholder: 'https://api.example.com', required: false },
      { id: 'api-env', name: 'Environment', type: 'text', defaultValue: 'production', placeholder: 'production', required: false },
      { id: 'api-expiry', name: 'Key Expiry', type: 'text', defaultValue: '', placeholder: '2027-01-01', required: false },
    ],
  },
  {
    id: 'builtin-database',
    name: 'Database',
    icon: '🗄️',
    color: '#f59e0b',
    baseType: 'login',
    description: 'Connection string: host, port, DB name, user, password, SSL',
    builtIn: true,
    defaultFolder: null,
    fields: [
      { id: 'db-host', name: 'Host', type: 'text', defaultValue: 'localhost', placeholder: 'localhost', required: true },
      { id: 'db-port', name: 'Port', type: 'text', defaultValue: '5432', placeholder: '5432', required: false },
      { id: 'db-name', name: 'Database Name', type: 'text', defaultValue: '', placeholder: 'mydb', required: true },
      { id: 'db-ssl', name: 'SSL Certificate', type: 'text', defaultValue: '', placeholder: '/path/to/cert.pem', required: false },
    ],
  },
  {
    id: 'builtin-license',
    name: 'Software License',
    icon: '📋',
    color: '#a855f7',
    baseType: 'note',
    description: 'License key, seats, purchase date, renewal date, and vendor',
    builtIn: true,
    defaultFolder: null,
    fields: [
      { id: 'lic-key', name: 'License Key', type: 'hidden', defaultValue: '', placeholder: 'XXXX-XXXX-XXXX-XXXX', required: true },
      { id: 'lic-seats', name: 'Seats', type: 'text', defaultValue: '1', placeholder: '1', required: false },
      { id: 'lic-purchased', name: 'Purchase Date', type: 'text', defaultValue: '', placeholder: '2024-01-01', required: false },
      { id: 'lic-renewal', name: 'Renewal Date', type: 'text', defaultValue: '', placeholder: '2025-01-01', required: false },
      { id: 'lic-vendor', name: 'Vendor', type: 'text', defaultValue: '', placeholder: 'Acme Corp', required: false },
    ],
  },
  {
    id: 'builtin-wifi',
    name: 'Wi-Fi Network',
    icon: '📶',
    color: '#06b6d4',
    baseType: 'login',
    description: 'SSID, band, router IP, and network password',
    builtIn: true,
    defaultFolder: null,
    fields: [
      { id: 'wifi-ssid', name: 'SSID', type: 'text', defaultValue: '', placeholder: 'MyNetwork', required: true },
      { id: 'wifi-band', name: 'Band', type: 'text', defaultValue: '2.4GHz', placeholder: '2.4GHz / 5GHz', required: false },
      { id: 'wifi-router', name: 'Router IP', type: 'text', defaultValue: '192.168.1.1', placeholder: '192.168.1.1', required: false },
    ],
  },
  {
    id: 'builtin-aws',
    name: 'AWS Credentials',
    icon: '☁️',
    color: '#f97316',
    baseType: 'login',
    description: 'Access key ID, secret, region, and account ID',
    builtIn: true,
    defaultFolder: null,
    fields: [
      { id: 'aws-key', name: 'Access Key ID', type: 'text', defaultValue: '', placeholder: 'AKIAIOSFODNN7EXAMPLE', required: true },
      { id: 'aws-secret', name: 'Secret Access Key', type: 'hidden', defaultValue: '', placeholder: '', required: true },
      { id: 'aws-region', name: 'Region', type: 'text', defaultValue: 'us-east-1', placeholder: 'us-east-1', required: false },
      { id: 'aws-account', name: 'Account ID', type: 'text', defaultValue: '', placeholder: '123456789012', required: false },
    ],
  },
];

@Injectable({ providedIn: 'root' })
export class TemplateService {
  private readonly _userTemplates = signal<VaultTemplate[]>([]);
  private readonly _builtInTemplates = signal<VaultTemplate[]>(BUILT_IN_TEMPLATES);
  private _loaded = false;

  readonly userTemplates = this._userTemplates.asReadonly();
  readonly builtInTemplates = this._builtInTemplates.asReadonly();

  readonly allTemplates = computed<VaultTemplate[]>(() => [
    ...this._builtInTemplates(),
    ...this._userTemplates(),
  ]);

  async loadTemplates(): Promise<void> {
    if (this._loaded) return;
    this._loaded = true;
    if (!window.electronAPI) return;
    const stored = (await window.electronAPI.template?.getAll()) as VaultTemplate[] | undefined;
    this._userTemplates.set(stored ?? []);
  }

  async saveTemplate(template: VaultTemplate): Promise<boolean> {
    if (!window.electronAPI) return false;
    const ok = await window.electronAPI.template?.save(template);
    if (ok) {
      this._userTemplates.update(list => {
        const idx = list.findIndex(t => t.id === template.id);
        if (idx >= 0) {
          const next = [...list];
          next[idx] = template;
          return next;
        }
        return [...list, template];
      });
    }
    return !!ok;
  }

  async deleteTemplate(id: string): Promise<boolean> {
    if (!window.electronAPI) return false;
    const ok = await window.electronAPI.template?.delete(id);
    if (ok) {
      this._userTemplates.update(list => list.filter(t => t.id !== id));
    }
    return !!ok;
  }

  getById(id: string): VaultTemplate | undefined {
    return this.allTemplates().find(t => t.id === id);
  }

  createBlankTemplate(): VaultTemplate {
    return {
      id: `tpl-${Date.now()}`,
      name: '',
      icon: '📁',
      color: '#3b82f6',
      baseType: 'login',
      fields: [],
      defaultFolder: null,
      description: '',
    };
  }

  createBlankField(): TemplateField {
    return {
      id: `field-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: '',
      type: 'text',
      defaultValue: '',
      placeholder: '',
      required: false,
    };
  }

  exportTemplate(template: VaultTemplate): string {
    const exportable = { ...template, id: undefined, builtIn: undefined };
    return JSON.stringify(exportable, null, 2);
  }

  importTemplate(json: string): VaultTemplate | null {
    try {
      const t = JSON.parse(json) as VaultTemplate;
      if (!t.name || !t.fields) return null;
      return {
        ...t,
        id: `tpl-${Date.now()}`,
        builtIn: false,
      };
    } catch {
      return null;
    }
  }
}
