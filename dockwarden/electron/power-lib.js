'use strict';

const crypto = require('crypto');
const zlib = require('zlib');

const STANDARD_KEYS = new Set([
  'Title', 'UserName', 'Password', 'URL', 'Notes',
  'otp', 'TOTP Seed', 'TimeOtp-Secret-Base32', 'TimeOtp-Secret',
]);

const ROTATE_URLS = {
  'github.com': 'https://github.com/settings/security',
  'google.com': 'https://myaccount.google.com/signinoptions/password',
  'accounts.google.com': 'https://myaccount.google.com/signinoptions/password',
  'microsoft.com': 'https://account.live.com/password/change',
  'live.com': 'https://account.live.com/password/change',
  'apple.com': 'https://appleid.apple.com/account/manage',
  'amazon.com': 'https://www.amazon.com/gp/css/account/info/view.html',
  'facebook.com': 'https://www.facebook.com/settings?tab=security',
  'twitter.com': 'https://x.com/settings/password',
  'x.com': 'https://x.com/settings/password',
  'linkedin.com': 'https://www.linkedin.com/psettings/change-password',
  'reddit.com': 'https://www.reddit.com/settings/account',
  'netflix.com': 'https://www.netflix.com/password',
  'dropbox.com': 'https://www.dropbox.com/account/security',
  'adobe.com': 'https://account.adobe.com/security',
  'paypal.com': 'https://www.paypal.com/myaccount/settings/password',
  'steampowered.com': 'https://store.steampowered.com/account/',
  'discord.com': 'https://discord.com/settings/account',
};

function fieldValue(fields, name) {
  const found = (fields || []).find(f => f && f.name === name);
  return found && found.value ? String(found.value) : null;
}

function upsertField(item, name, value) {
  item.fields = item.fields || [];
  const idx = item.fields.findIndex(f => f.name === name);
  if (value === null || value === undefined || value === '') {
    if (idx >= 0) item.fields.splice(idx, 1);
    return;
  }
  if (idx >= 0) item.fields[idx].value = String(value);
  else item.fields.push({ name, value: String(value), type: 0 });
}

function decorateItem(bwItem, item) {
  const fields = bwItem.fields || [];
  item.links = {
    username: fieldValue(fields, '_dw_link_username'),
    password: fieldValue(fields, '_dw_link_password'),
  };
  item.rotateUrl = fieldValue(fields, '_dw_rotate_url');
  item.defaultSequence = null;
  item.autotypeRules = [];
  const raw = fieldValue(fields, '_dw_autotype');
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) item.autotypeRules = parsed;
      else if (parsed && typeof parsed === 'object') {
        item.autotypeRules = Array.isArray(parsed.rules) ? parsed.rules : [];
        item.defaultSequence = parsed.defaultSequence || null;
      }
    } catch { /* ignore malformed rules */ }
  }
  item.customFields = fields
    .filter(f => f && f.name && !String(f.name).startsWith('_dw_'))
    .map(f => ({ name: String(f.name), value: f.value == null ? '' : String(f.value), hidden: f.type === 1 }));
  return item;
}

function applyExtra(item, patch) {
  if (!patch) return;
  if (patch.links) {
    if (patch.links.username !== undefined) upsertField(item, '_dw_link_username', patch.links.username || '');
    if (patch.links.password !== undefined) upsertField(item, '_dw_link_password', patch.links.password || '');
  }
  if (patch.autotypeRules !== undefined || patch.defaultSequence !== undefined) {
    const current = readAutotype(item);
    const next = {
      defaultSequence: patch.defaultSequence !== undefined ? (patch.defaultSequence || null) : current.defaultSequence,
      rules: patch.autotypeRules !== undefined ? (patch.autotypeRules || []) : current.rules,
    };
    const empty = !next.defaultSequence && (!next.rules || next.rules.length === 0);
    upsertField(item, '_dw_autotype', empty ? '' : JSON.stringify(next));
  }
  if (patch.rotateUrl !== undefined) upsertField(item, '_dw_rotate_url', patch.rotateUrl || '');
}

function readAutotype(item) {
  const raw = fieldValue(item.fields, '_dw_autotype');
  if (!raw) return { defaultSequence: null, rules: [] };
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return { defaultSequence: null, rules: parsed };
    return {
      defaultSequence: parsed.defaultSequence || null,
      rules: Array.isArray(parsed.rules) ? parsed.rules : [],
    };
  } catch {
    return { defaultSequence: null, rules: [] };
  }
}

function fingerprint(value) {
  if (!value) return '';
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 16);
}

function snapshotItem(item) {
  return {
    id: item.id,
    name: item.name,
    type: item.type,
    lastModified: item.lastModified,
    folderId: item.folderId || null,
    username: (item.username || '').slice(0, 200),
    website: (item.website || '').slice(0, 500),
    passwordFp: fingerprint(item.password),
    notesFp: fingerprint(item.notes),
    totpFp: fingerprint(item.totp),
  };
}

function publicSnap(item) {
  return {
    id: item.id,
    name: item.name,
    type: item.type,
    lastModified: item.lastModified,
    folderId: item.folderId || null,
  };
}

function fieldDiff(before, after) {
  const fields = [];
  if (!before || !after) return fields;
  if (before.name !== after.name) {
    fields.push({ field: 'name', secret: false, before: before.name || '', after: after.name || '' });
  }
  if ('username' in before && 'username' in after && before.username !== after.username) {
    fields.push({ field: 'username', secret: false, before: before.username || '', after: after.username || '' });
  }
  if ('website' in before && 'website' in after && before.website !== after.website) {
    fields.push({ field: 'website', secret: false, before: before.website || '', after: after.website || '' });
  }
  if ('passwordFp' in before && 'passwordFp' in after && before.passwordFp !== after.passwordFp) {
    fields.push({ field: 'password', secret: true });
  }
  if ('notesFp' in before && 'notesFp' in after && before.notesFp !== after.notesFp) {
    fields.push({ field: 'notes', secret: true });
  }
  if ('totpFp' in before && 'totpFp' in after && before.totpFp !== after.totpFp) {
    fields.push({ field: 'totp', secret: true });
  }
  return fields;
}

function inboxFromFingerprints(prev, next, marks, now = Date.now()) {
  const sourceMarks = marks || {};
  if (!Array.isArray(prev) || prev.length === 0) {
    return { records: [], marks: { ...sourceMarks } };
  }
  const prevMap = new Map(prev.map(item => [item.id, item]));
  const nextMap = new Map(next.map(item => [item.id, item]));
  const nextMarks = { ...sourceMarks };
  const originFor = (id) => {
    const ts = sourceMarks[id];
    if (typeof ts === 'number' && now - ts < 15 * 60 * 1000) {
      delete nextMarks[id];
      return 'local';
    }
    return 'remote';
  };
  const records = [];
  const stamp = new Date(now).toISOString();
  const push = (item, kind, fields) => {
    records.push({
      id: crypto.randomUUID(),
      itemId: item.id,
      itemName: item.name || 'Untitled',
      timestamp: stamp,
      origin: originFor(item.id),
      kind,
      fields: fields || [],
      seen: false,
    });
  };
  for (const item of next) {
    if (!prevMap.has(item.id)) push(item, 'added', []);
  }
  for (const item of prev) {
    if (!nextMap.has(item.id)) push(item, 'deleted', []);
  }
  for (const item of next) {
    const before = prevMap.get(item.id);
    if (!before) continue;
    const fields = fieldDiff(before, item);
    if (fields.length) push(item, 'modified', fields);
  }
  return { records, marks: nextMarks };
}

function sequenceToSteps(sequence, fields) {
  const steps = [];
  const re = /\{([^{}]+)\}|([^{]+)/g;
  let match;
  const source = String(sequence || '');
  while ((match = re.exec(source))) {
    if (match[2]) {
      steps.push({ kind: 'text', value: match[2] });
      continue;
    }
    const token = match[1].trim();
    const upper = token.toUpperCase();
    if (upper === 'USERNAME' || upper === 'USER') steps.push({ kind: 'text', value: fields.username || '' });
    else if (upper === 'PASSWORD' || upper === 'PASS') steps.push({ kind: 'text', value: fields.password || '' });
    else if (['TAB', 'ENTER', 'SPACE', 'UP', 'DOWN', 'LEFT', 'RIGHT'].includes(upper)) {
      steps.push({ kind: 'key', value: upper });
    } else if (upper.startsWith('DELAY')) {
      const num = Number(token.replace(/delay\s*=?\s*/i, ''));
      const ms = Number.isFinite(num) ? Math.min(10000, Math.max(0, num)) : 0;
      if (ms) steps.push({ kind: 'delay', ms });
    } else {
      steps.push({ kind: 'text', value: `{${token}}` });
    }
  }
  return steps.filter(step => step.kind === 'delay' || step.kind === 'key' || step.value);
}

function legacySteps(username, password, pressEnter) {
  const steps = [];
  if (username) steps.push({ kind: 'text', value: username });
  if (username && password) steps.push({ kind: 'key', value: 'TAB' });
  if (password) steps.push({ kind: 'text', value: password });
  if (pressEnter) steps.push({ kind: 'key', value: 'ENTER' });
  return steps;
}

function ruleMatches(rule, title) {
  if (!rule || !title || !rule.value) return false;
  const value = String(rule.value);
  if (value.length > 200) return false;
  if (rule.match === 'regex') {
    try { return new RegExp(value, 'i').test(title); } catch { return false; }
  }
  return title.toLowerCase().includes(value.toLowerCase());
}

function matchRules(items, title) {
  if (!title) return [];
  const matches = [];
  for (const item of items || []) {
    for (const rule of item.autotypeRules || []) {
      if (ruleMatches(rule, title)) matches.push({ itemId: item.id, sequence: rule.sequence, ruleId: rule.id });
    }
  }
  return matches;
}

function suggestWindowValue(title) {
  const stripped = String(title || '')
    .replace(/\s[–—-]\s*(Google Chrome|Mozilla Firefox|Firefox|Microsoft Edge|Safari|Brave|Opera|Arc)\s*$/i, '')
    .trim();
  const parts = stripped.split(/\s[–—-]\s/).map(part => part.trim()).filter(Boolean);
  return (parts[0] || stripped).slice(0, 60);
}

function parseRef(ref) {
  if (typeof ref !== 'string' || !ref.startsWith('dw://')) return null;
  const rest = ref.slice('dw://'.length);
  const idx = rest.lastIndexOf('/');
  if (idx <= 0 || idx === rest.length - 1) return null;
  try {
    return {
      item: decodeURIComponent(rest.slice(0, idx)),
      field: decodeURIComponent(rest.slice(idx + 1)),
    };
  } catch {
    return null;
  }
}

function base32Decode(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = String(input || '').replace(/=+$/g, '').replace(/\s/g, '').toUpperCase();
  let bits = '';
  for (const char of clean) {
    const val = alphabet.indexOf(char);
    if (val < 0) continue;
    bits += val.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function totpCode(secret, now = Date.now()) {
  let raw = String(secret || '');
  let digits = 6;
  let period = 30;
  if (raw.startsWith('otpauth://')) {
    const url = new URL(raw);
    raw = url.searchParams.get('secret') || '';
    digits = Number(url.searchParams.get('digits') || 6);
    period = Number(url.searchParams.get('period') || 30);
  }
  const key = base32Decode(raw);
  if (!key.length) throw new Error('empty TOTP secret');
  const counter = Math.floor(now / 1000 / period);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const binary = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  const count = Number.isFinite(digits) ? Math.min(8, Math.max(6, digits)) : 6;
  return String(binary % (10 ** count)).padStart(count, '0');
}

function resolveRef(items, ref) {
  const parsed = parseRef(ref);
  if (!parsed) return { error: `Not a dw:// reference: ${ref}` };
  const needle = parsed.item.toLowerCase();
  const byId = (items || []).filter(item => item.id === parsed.item);
  const byName = (items || []).filter(item => (item.name || '').toLowerCase() === needle);
  const matches = byId.length ? byId : byName;
  if (!matches.length) return { error: `No vault item named "${parsed.item}"` };
  if (matches.length > 1) return { error: `More than one item is named "${parsed.item}". Use the item id.` };
  const item = matches[0];
  const field = parsed.field.toLowerCase();
  if (field === 'totp' || field === 'otp') {
    if (!item.totp) return { error: `${item.name} has no TOTP seed` };
    try { return { value: totpCode(item.totp) }; }
    catch { return { error: `Could not generate a TOTP code for ${item.name}` }; }
  }
  const direct = {
    password: item.password,
    username: item.username,
    notes: item.notes,
    uri: item.website,
    url: item.website,
    website: item.website,
  };
  if (Object.prototype.hasOwnProperty.call(direct, field)) {
    if (!direct[field]) return { error: `${item.name} has no ${field}` };
    return { value: String(direct[field]) };
  }
  const custom = (item.customFields || []).find(f => f.name.toLowerCase() === field);
  if (!custom || !custom.value) return { error: `${item.name} has no field "${parsed.field}"` };
  return { value: String(custom.value) };
}

function hostnameOf(website) {
  if (!website) return '';
  try {
    const href = /^https?:\/\//i.test(website) ? website : `https://${website}`;
    return new URL(href).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function rotateUrlFor(item) {
  if (item && item.rotateUrl) return item.rotateUrl;
  const host = hostnameOf(item && item.website);
  if (!host) return null;
  const domains = Object.keys(ROTATE_URLS);
  const hit = domains.find(domain => host === domain || host.endsWith(`.${domain}`));
  return hit ? ROTATE_URLS[hit] : (item.website || null);
}

function textOf(value) {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object' && value['#text'] != null) return String(value['#text']);
  return '';
}

function stringMap(entry) {
  const map = {};
  for (const row of entry.String || []) {
    const key = textOf(row.Key);
    if (key) map[key] = textOf(row.Value);
  }
  return map;
}

function tagify(name) {
  return String(name || '').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 40);
}

function folderAndTags(pathNames) {
  const cleaned = (pathNames || []).filter(name => name && name.toLowerCase() !== 'recycle bin');
  const leaf = cleaned.length > 1 ? cleaned.slice(1) : cleaned;
  return {
    folder: leaf.join('/'),
    tags: leaf.map(tagify).filter(Boolean),
  };
}

function windowRule(windowTitle, sequence, fallback) {
  const raw = String(windowTitle || '').trim();
  if (!raw || raw === '*') return null;
  const value = raw.replace(/^\*+|\*+$/g, '').trim();
  if (!value) return null;
  return {
    id: crypto.randomUUID(),
    match: 'contains',
    value: value.slice(0, 120),
    sequence: sequence || fallback || '{USERNAME}{TAB}{PASSWORD}{ENTER}',
  };
}

function historyFromXml(entry) {
  const rows = entry.History && entry.History.Entry ? entry.History.Entry : [];
  return rows.map(past => {
    const fields = stringMap(past);
    const when = textOf(past.Times && past.Times.LastModificationTime) || new Date().toISOString();
    return fields.Password ? { password: fields.Password, lastUsedDate: when } : null;
  }).filter(Boolean).slice(0, 20);
}

function attachmentsFromXml(entry, binaries) {
  const files = [];
  for (const binary of entry.Binary || []) {
    const name = textOf(binary.Key) || 'attachment';
    const ref = binary.Value && binary.Value['@_Ref'];
    if (ref == null || !binaries.has(String(ref))) continue;
    const data = binaries.get(String(ref));
    if (!data || data.length > 5 * 1024 * 1024) continue;
    files.push({ name, data });
  }
  return files;
}

function entryFromFields(fields, extra) {
  let totp = fields.otp || fields['TOTP Seed'] || fields['TimeOtp-Secret-Base32'] || fields['TimeOtp-Secret'] || '';
  if (!totp) {
    const otpauth = Object.values(fields).find(value => String(value).startsWith('otpauth://'));
    if (otpauth) totp = otpauth;
  }
  const customFields = Object.entries(fields)
    .filter(([key, value]) => !STANDARD_KEYS.has(key) && value && !String(value).startsWith('otpauth://'))
    .slice(0, 40)
    .map(([name, value]) => ({ name, value: String(value).slice(0, 10000), hidden: /pass|secret|key|token/i.test(name) }));
  return {
    title: fields.Title || 'Imported item',
    username: fields.UserName || '',
    password: fields.Password || '',
    url: fields.URL || '',
    notes: fields.Notes || '',
    totp: totp || '',
    customFields,
    ...extra,
  };
}

function loadXmlBinaries(doc) {
  const bins = doc?.KeePassFile?.Meta?.Binaries?.Binary || [];
  const map = new Map();
  for (const binary of bins) {
    const id = binary['@_ID'];
    if (id == null) continue;
    let data = Buffer.from(textOf(binary), 'base64');
    if (String(binary['@_Compressed']).toLowerCase() === 'true') {
      try { data = zlib.gunzipSync(data); } catch { /* keep raw */ }
    }
    map.set(String(id), data);
  }
  return map;
}

function parseXmlEntry(entry, pathNames, binaries) {
  const fields = stringMap(entry);
  const place = folderAndTags(pathNames);
  const expires = textOf(entry.Times && entry.Times.Expires).toLowerCase() === 'true';
  const expiry = textOf(entry.Times && entry.Times.ExpiryTime);
  const auto = entry.AutoType || {};
  const defaultSequence = textOf(auto.DefaultSequence) || null;
  const rules = (auto.Association || [])
    .map(assoc => windowRule(textOf(assoc.Window), textOf(assoc.KeystrokeSequence), defaultSequence))
    .filter(Boolean);
  return entryFromFields(fields, {
    expiresAt: expires && expiry ? expiry.slice(0, 10) : null,
    tags: place.tags,
    folder: place.folder,
    autotype: { defaultSequence, rules },
    history: historyFromXml(entry),
    attachments: attachmentsFromXml(entry, binaries),
  });
}

function walkXmlGroup(group, parentPath, out, binaries) {
  const name = textOf(group.Name);
  if (name.toLowerCase() === 'recycle bin') return;
  const pathNames = name ? [...parentPath, name] : parentPath;
  for (const child of group.Group || []) walkXmlGroup(child, pathNames, out, binaries);
  for (const entry of group.Entry || []) out.push(parseXmlEntry(entry, pathNames, binaries));
}

function parseKeepassXml(xml) {
  const { XMLParser } = require('fast-xml-parser');
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: (tagName) => ['Group', 'Entry', 'String', 'Association', 'Binary'].includes(tagName),
  });
  const doc = parser.parse(xml);
  const groups = doc?.KeePassFile?.Root?.Group;
  if (!groups) throw new Error('This file is not a KeePass 2 XML export.');
  const binaries = loadXmlBinaries(doc);
  const entries = [];
  for (const group of groups) walkXmlGroup(group, [], entries, binaries);
  return entries;
}

function kdbxText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value.getText === 'function') return value.getText();
  return '';
}

function entriesFromKdbx(db) {
  const entries = [];
  const recycle = db.meta && db.meta.recycleBinUuid;
  const walk = (group, parentPath) => {
    if (recycle && group.uuid && String(group.uuid) === String(recycle)) return;
    const name = typeof group.name === 'string' ? group.name : '';
    if (name.toLowerCase() === 'recycle bin') return;
    const pathNames = name ? [...parentPath, name] : parentPath;
    for (const child of group.groups || []) walk(child, pathNames);
    for (const entry of group.entries || []) entries.push(entryFromKdbx(entry, pathNames));
  };
  for (const group of db.groups || []) walk(group, []);
  return entries;
}

function entryFromKdbx(entry, pathNames) {
  const fields = {};
  for (const [key, value] of entry.fields || []) fields[key] = kdbxText(value);
  const place = folderAndTags(pathNames);
  const expires = Boolean(entry.times && entry.times.expires);
  const expiry = entry.times && entry.times.expiryTime instanceof Date ? entry.times.expiryTime.toISOString() : '';
  const auto = entry.autoType || {};
  const defaultSequence = auto.defaultSequence || null;
  const rules = (auto.items || [])
    .map(item => windowRule(item.window, item.keystrokeSequence, defaultSequence))
    .filter(Boolean);
  const history = (entry.history || []).map(past => {
    const password = kdbxText(past.fields && past.fields.get && past.fields.get('Password'));
    const when = past.times && past.times.lastModTime instanceof Date
      ? past.times.lastModTime.toISOString()
      : new Date().toISOString();
    return password ? { password, lastUsedDate: when } : null;
  }).filter(Boolean).slice(0, 20);
  const attachments = [];
  for (const [name, binary] of entry.binaries || []) {
    try {
      const value = binary && (binary.value || binary);
      const bytes = value && typeof value.getBinary === 'function' ? Buffer.from(value.getBinary()) : null;
      if (bytes && bytes.length && bytes.length <= 5 * 1024 * 1024) attachments.push({ name, data: bytes });
    } catch { /* skip unreadable attachment */ }
  }
  const tags = [...place.tags];
  for (const tag of entry.tags || []) {
    const clean = tagify(tag);
    if (clean && !tags.includes(clean)) tags.push(clean);
  }
  return entryFromFields(fields, {
    expiresAt: expires && expiry ? expiry.slice(0, 10) : null,
    tags,
    folder: place.folder,
    autotype: { defaultSequence, rules },
    history,
    attachments,
  });
}

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return value;
}

function installArgon2() {
  if (installArgon2.ready) return;
  const kdbxweb = require('kdbxweb');
  const { argon2d, argon2i, argon2id } = require('hash-wasm');
  kdbxweb.CryptoEngine.setArgon2Impl(async (pass, salt, memory, iterations, length, parallelism, type) => {
    const fn = type === 0 ? argon2d : type === 1 ? argon2i : argon2id;
    const hash = await fn({
      password: asBytes(pass),
      salt: asBytes(salt),
      iterations,
      parallelism,
      memorySize: memory,
      hashLength: length,
      outputType: 'binary',
    });
    return hash instanceof Uint8Array ? hash : new Uint8Array(hash);
  });
  installArgon2.ready = true;
}

async function loadKdbxBuffer(buffer, password) {
  installArgon2();
  const kdbxweb = require('kdbxweb');
  const bytes = buffer instanceof ArrayBuffer
    ? buffer
    : buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const credentials = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(password || ''));
  const db = await kdbxweb.Kdbx.load(bytes, credentials);
  return entriesFromKdbx(db);
}

function previewEntry(entry, index) {
  return {
    index,
    title: entry.title || 'Untitled',
    username: entry.username || '',
    group: entry.folder || '',
    expiresAt: entry.expiresAt || null,
    autotypeCount: (entry.autotype?.rules?.length || 0) + (entry.autotype?.defaultSequence ? 1 : 0),
    hasTotp: Boolean(entry.totp),
    historyCount: entry.history?.length || 0,
    attachments: (entry.attachments || []).map(file => file.name),
  };
}

function toBitwardenItem(entry, folderId) {
  const fields = [];
  if (entry.expiresAt) fields.push({ name: '_dw_expires', value: entry.expiresAt, type: 0 });
  if (entry.tags?.length) fields.push({ name: '_dw_tags', value: entry.tags.join(','), type: 0 });
  if (entry.autotype && (entry.autotype.defaultSequence || entry.autotype.rules?.length)) {
    fields.push({ name: '_dw_autotype', value: JSON.stringify(entry.autotype), type: 0 });
  }
  for (const field of entry.customFields || []) {
    fields.push({ name: field.name, value: field.value, type: field.hidden ? 1 : 0 });
  }
  const item = {
    organizationId: null,
    folderId: folderId || null,
    type: 1,
    name: entry.title || 'Imported item',
    notes: entry.notes || null,
    favorite: false,
    login: {
      username: entry.username || null,
      password: entry.password || null,
      totp: entry.totp || null,
      uris: entry.url ? [{ match: null, uri: entry.url }] : [],
    },
    fields,
  };
  if (entry.history?.length) {
    item.passwordHistory = entry.history.map(row => ({
      password: row.password,
      lastUsedDate: row.lastUsedDate,
    }));
  }
  return item;
}

function escapeWifi(value) {
  return String(value || '').replace(/([\\;,:"])/g, '\\$1');
}

module.exports = {
  decorateItem,
  applyExtra,
  snapshotItem,
  publicSnap,
  fieldDiff,
  inboxFromFingerprints,
  sequenceToSteps,
  legacySteps,
  matchRules,
  suggestWindowValue,
  parseRef,
  resolveRef,
  totpCode,
  rotateUrlFor,
  parseKeepassXml,
  entriesFromKdbx,
  loadKdbxBuffer,
  previewEntry,
  toBitwardenItem,
  escapeWifi,
  installArgon2,
  ROTATE_URLS,
};
