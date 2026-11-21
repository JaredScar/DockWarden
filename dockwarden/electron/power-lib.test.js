'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const power = require('./power-lib');

const XML = `<?xml version="1.0" encoding="utf-8"?>
<KeePassFile>
  <Meta><Binaries><Binary ID="1" Compressed="False">aGVsbG8=</Binary></Binaries></Meta>
  <Root>
    <Group>
      <Name>Database</Name>
      <Group>
        <Name>Internet</Name>
        <Entry>
          <String><Key>Title</Key><Value>GitHub</Value></String>
          <String><Key>UserName</Key><Value>octo</Value></String>
          <String><Key>Password</Key><Value ProtectInMemory="True">s3cret</Value></String>
          <String><Key>URL</Key><Value>https://github.com</Value></String>
          <String><Key>Notes</Key><Value>hello</Value></String>
          <String><Key>otp</Key><Value>otpauth://totp/GitHub?secret=JBSWY3DPEHPK3PXP</Value></String>
          <String><Key>API Key</Key><Value>abc</Value></String>
          <Times><Expires>True</Expires><ExpiryTime>2026-12-01T00:00:00Z</ExpiryTime></Times>
          <AutoType>
            <DefaultSequence>{USERNAME}{TAB}{PASSWORD}{ENTER}</DefaultSequence>
            <Association>
              <Window>*GitHub*</Window>
              <KeystrokeSequence>{PASSWORD}{ENTER}</KeystrokeSequence>
            </Association>
          </AutoType>
          <History>
            <Entry>
              <String><Key>Password</Key><Value>oldpass</Value></String>
              <Times><LastModificationTime>2024-01-02T00:00:00Z</LastModificationTime></Times>
            </Entry>
          </History>
          <Binary><Key>note.txt</Key><Value Ref="1" /></Binary>
        </Entry>
      </Group>
    </Group>
  </Root>
</KeePassFile>`;

test('sequence expands KeePass tokens and ignores empty fields', () => {
  const steps = power.sequenceToSteps('{USERNAME}{TAB}{PASSWORD}{DELAY 40}{ENTER}', {
    username: 'ada',
    password: 'secret',
  });
  assert.deepEqual(steps, [
    { kind: 'text', value: 'ada' },
    { kind: 'key', value: 'TAB' },
    { kind: 'text', value: 'secret' },
    { kind: 'delay', ms: 40 },
    { kind: 'key', value: 'ENTER' },
  ]);
});

test('field diff reports a password change without the password', () => {
  const before = power.snapshotItem({ id: '1', name: 'A', type: 'login', lastModified: 't', username: 'a', website: 'https://a.test', password: 'one', notes: 'n', totp: null });
  const after = power.snapshotItem({ id: '1', name: 'A', type: 'login', lastModified: 't2', username: 'b', website: 'https://a.test', password: 'two', notes: 'n', totp: null });
  const fields = power.fieldDiff(before, after);
  assert.equal(fields.find(field => field.field === 'password').secret, true);
  assert.equal(JSON.stringify(fields).includes('one'), false);
  assert.equal(JSON.stringify(fields).includes('two'), false);
  assert.equal(fields.find(field => field.field === 'username').after, 'b');
});

test('the first fingerprint baseline does not flood the inbox', () => {
  const next = [power.snapshotItem({ id: '1', name: 'A', type: 'login', password: 'x' })];
  const result = power.inboxFromFingerprints([], next, {});
  assert.equal(result.records.length, 0);
});

test('a later sync records a remote change and a local edit stays local', () => {
  const prev = [power.snapshotItem({ id: '1', name: 'A', type: 'login', password: 'x', username: 'a' })];
  const next = [power.snapshotItem({ id: '1', name: 'A', type: 'login', password: 'y', username: 'a' })];
  const remote = power.inboxFromFingerprints(prev, next, {});
  assert.equal(remote.records[0].origin, 'remote');
  assert.equal(remote.records[0].kind, 'modified');
  const local = power.inboxFromFingerprints(prev, next, { '1': Date.now() });
  assert.equal(local.records[0].origin, 'local');
  assert.equal(local.marks['1'], undefined);
});

test('dw:// references resolve a field and TOTP returns a code', () => {
  const parsed = power.parseRef('dw://Work/GitHub/password');
  assert.deepEqual(parsed, { item: 'Work/GitHub', field: 'password' });
  const items = [{ id: 'id-1', name: 'GitHub', password: 's3cret', username: 'octo', totp: 'otpauth://totp/GitHub?secret=JBSWY3DPEHPK3PXP', customFields: [] }];
  assert.equal(power.resolveRef(items, 'dw://GitHub/password').value, 's3cret');
  const code = power.resolveRef(items, 'dw://id-1/totp').value;
  assert.match(code, /^\d{6}$/);
  assert.equal(code.includes('JBSWY'), false);
});

test('TOTP matches the RFC 6238 SHA1 vector', () => {
  assert.equal(power.totpCode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59 * 1000), '287082');
});

test('KeePass XML keeps expiry, auto-type, history, and attachments', () => {
  const entries = power.parseKeepassXml(XML);
  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.equal(entry.title, 'GitHub');
  assert.equal(entry.password, 's3cret');
  assert.equal(entry.expiresAt, '2026-12-01');
  assert.equal(entry.folder, 'Internet');
  assert.equal(entry.autotype.rules[0].value, 'GitHub');
  assert.equal(entry.autotype.rules[0].sequence, '{PASSWORD}{ENTER}');
  assert.equal(entry.history[0].password, 'oldpass');
  assert.equal(entry.attachments[0].data.toString(), 'hello');
  assert.equal(entry.customFields[0].name, 'API Key');
  const preview = power.previewEntry(entry, 0);
  assert.equal(JSON.stringify(preview).includes('s3cret'), false);
  assert.equal(JSON.stringify(preview).includes('oldpass'), false);
});

test('window matching is a contains match and does not match an empty rule', () => {
  const items = [{ id: '1', autotypeRules: [{ id: 'r', match: 'contains', value: 'PuTTY', sequence: '{PASSWORD}{ENTER}' }] }];
  assert.equal(power.matchRules(items, 'octo@host - PuTTY').length, 1);
  assert.equal(power.matchRules(items, 'Notepad').length, 0);
  assert.equal(power.suggestWindowValue('GitHub — Google Chrome'), 'GitHub');
});

test('known sites get a password-change URL', () => {
  assert.equal(power.rotateUrlFor({ website: 'https://github.com/login' }), 'https://github.com/settings/security');
  assert.equal(power.rotateUrlFor({ website: 'https://example.com', rotateUrl: 'https://example.com/pw' }), 'https://example.com/pw');
});

test('a KDBX database round-trips through the same entry mapper', async () => {
  power.installArgon2();
  const kdbxweb = require('kdbxweb');
  const credentials = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString('test-password'));
  const db = kdbxweb.Kdbx.create(credentials, 'Test');
  const entry = db.createEntry(db.getDefaultGroup());
  entry.fields.set('Title', 'GitHub');
  entry.fields.set('UserName', 'octo');
  entry.fields.set('Password', kdbxweb.ProtectedValue.fromString('s3cret'));
  entry.fields.set('URL', 'https://github.com');
  entry.times.expires = true;
  entry.times.expiryTime = new Date('2026-12-01T00:00:00Z');
  entry.autoType.defaultSequence = '{USERNAME}{TAB}{PASSWORD}{ENTER}';
  entry.autoType.items.push({ window: '*GitHub*', keystrokeSequence: '{PASSWORD}{ENTER}' });
  const saved = await db.save();
  const loaded = await power.loadKdbxBuffer(Buffer.from(saved), 'test-password');
  const found = loaded.find(item => item.title === 'GitHub');
  assert.ok(found);
  assert.equal(found.password, 's3cret');
  assert.equal(found.expiresAt, '2026-12-01');
  assert.equal(found.autotype.rules[0].value, 'GitHub');
  await assert.rejects(() => power.loadKdbxBuffer(Buffer.from(saved), 'wrong'), /key|credential|password|Invalid/i);
});
