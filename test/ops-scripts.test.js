const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');

const REPO_ROOT = path.resolve(__dirname, '..');
const OPS_DIR = path.join(REPO_ROOT, 'servidor', 'ops');

const SH_FILES = [
  'backup/bingoelus-backup.sh',
  'backup/restore-state.sh',
  'gcp/audit-vm.sh',
  'gcp/harden-vm.sh',
  'gcp/install.sh',
  'gcp/update.sh',
  'watchdog/cloudflared-watchdog.sh',
];

const tempDirs = new Set();

function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.add(dir);
  return dir;
}

function findRunnableBash() {
  const candidates = process.platform === 'win32'
    ? ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe', 'bash']
    : ['bash'];

  for (const candidate of candidates) {
    if (path.isAbsolute(candidate) && !fs.existsSync(candidate)) continue;
    const probe = spawnSync(candidate, ['-c', 'echo ok'], { encoding: 'utf8' });
    if (probe.status === 0 && (probe.stdout || '').trim() === 'ok') {
      return candidate;
    }
  }
  return null;
}

function toBashPath(bashExe, targetPath) {
  if (process.platform !== 'win32') return targetPath;
  const resolved = path.resolve(targetPath);
  return resolved.replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`).replace(/\\/g, '/');
}

function makeSampleCard(prefix = 'frase') {
  return Array.from({ length: 5 }, (_, row) =>
    Array.from({ length: 5 }, (__, col) => `${prefix}-${row * 5 + col}`)
  );
}

function makeSampleSnapshot(cantadas = ['frase-0', 'frase-1']) {
  return {
    schemaVersion: 1,
    savedAt: Date.now(),
    frases: Array.from({ length: 25 }, (_, idx) => `frase-${idx}`),
    cantadas,
    verificadas: ['frase-0'],
    olvidadas: [],
    tokens: {
      tester: {
        carton: makeSampleCard('frase'),
        marcadas: ['frase-0'],
        cantadoLinea: false,
        cantadoBingo: false,
        nombre: 'Tester',
        twitchVerified: true,
      },
    },
    lineaGanada: false,
    bingoGanado: false,
    partidaActiva: true,
    partidaIniciadaTs: Date.now() - 1000,
    discordCartonesNotificados: {},
    reclamacionesHabilitadas: false,
    umbralReclamo: 0,
  };
}

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

test('all ops shell scripts enforce bash strict mode and pass syntax check when bash is runnable', (t) => {
  const bashExe = findRunnableBash();
  for (const rel of SH_FILES) {
    const fullPath = path.join(OPS_DIR, rel);
    assert.ok(fs.existsSync(fullPath), `missing script ${rel}`);
    const content = fs.readFileSync(fullPath, 'utf8');
    assert.match(content, /^#!\/usr\/bin\/env bash\r?\n/);
    assert.match(content, /^set -Eeuo pipefail\r?$/m);

    if (bashExe) {
      // Strip CR in memory so git core.autocrlf=true on Windows does not break bash -n.
      const normalized = content.replace(/\r\n/g, '\n');
      const res = spawnSync(bashExe, ['-n'], { input: normalized, encoding: 'utf8' });
      assert.equal(res.status, 0, `bash -n failed for ${rel}: ${res.stderr}`);
    }
  }
  if (!bashExe) {
    t.diagnostic('Runnable bash not available in this environment; bash -n skipped.');
  }
});

test('backup scripts and systemd units are consistent for live /opt/bingoelus/datos backup', () => {
  const backupSh = fs.readFileSync(path.join(OPS_DIR, 'backup/bingoelus-backup.sh'), 'utf8');
  const backupEnv = fs.readFileSync(path.join(OPS_DIR, 'backup/bingoelus-backup.env.example'), 'utf8');
  const backupSvc = fs.readFileSync(path.join(OPS_DIR, 'backup/bingoelus-backup.service'), 'utf8');
  const backupTimer = fs.readFileSync(path.join(OPS_DIR, 'backup/bingoelus-backup.timer'), 'utf8');

  assert.match(backupSh, /\/opt\/bingoelus\/datos/);
  assert.match(backupSh, /LIVE_ONLY_DIRS=/);
  assert.match(backupSh, /--exclude='\*\.tmp'/);
  assert.match(backupEnv, /^SOURCE_DIRS=.*\/opt\/bingoelus\/datos/m);
  assert.match(backupEnv, /^LIVE_ONLY_DIRS=\/opt\/bingoelus\/datos/m);
  assert.match(backupSvc, /datos/);
  assert.match(backupTimer, /^OnUnitActiveSec=1min/m);
});

test('restore-state.sh handles dry-run, real restore, .bak fallback, and invalid snapshots', (t) => {
  const bashExe = findRunnableBash();
  if (!bashExe) {
    t.skip('Runnable bash not available in this environment');
    return;
  }

  const restoreScript = toBashPath(bashExe, path.join(OPS_DIR, 'backup/restore-state.sh'));
  const tmpDir = makeTempDir('bingoelus-restore-');
  const mirrorDir = path.join(tmpDir, 'mirror');
  const targetDir = path.join(tmpDir, 'target');
  fs.mkdirSync(mirrorDir, { recursive: true });
  fs.mkdirSync(targetDir, { recursive: true });

  const validSnap = makeSampleSnapshot(['frase-0', 'frase-1']);
  const bans = [{ login: 'baduser', bannedAt: 1700000000000 }];
  fs.writeFileSync(path.join(mirrorDir, 'estado-partida.json'), JSON.stringify(validSnap), 'utf8');
  fs.writeFileSync(path.join(mirrorDir, 'cuentas-baneadas.json'), JSON.stringify(bans), 'utf8');

  // Pre-existing files in target should remain untouched on --dry-run and get backed up on real restore.
  const existingState = makeSampleSnapshot(['frase-old']);
  fs.writeFileSync(path.join(targetDir, 'estado-partida.json'), JSON.stringify(existingState), 'utf8');

  const env = { ...process.env, BINGOELUS_BACKUP_ENV: path.join(tmpDir, 'nonexistent.env') };

  const dryRun = spawnSync(
    bashExe,
    [restoreScript, '--from-local', toBashPath(bashExe, mirrorDir), '--target-dir', toBashPath(bashExe, targetDir), '--dry-run'],
    { env, encoding: 'utf8' }
  );
  assert.equal(dryRun.status, 0, `dry-run failed: ${dryRun.stderr}`);
  assert.match(dryRun.stdout, /\[DRY-RUN\]/);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(targetDir, 'estado-partida.json'), 'utf8')).cantadas,
    ['frase-old']
  );

  const realRun = spawnSync(
    bashExe,
    [restoreScript, '--from-local', toBashPath(bashExe, mirrorDir), '--target-dir', toBashPath(bashExe, targetDir)],
    { env, encoding: 'utf8' }
  );
  assert.equal(realRun.status, 0, `real restore failed: ${realRun.stderr}`);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(targetDir, 'estado-partida.json'), 'utf8')).cantadas,
    ['frase-0', 'frase-1']
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(targetDir, 'cuentas-baneadas.json'), 'utf8')), bans);
  assert.ok(
    fs.readdirSync(targetDir).some(name => name.startsWith('estado-partida.json.pre-restore-')),
    'expected pre-restore backup file in targetDir'
  );

  // Corrupt primary in mirror -> should fall back to .bak automatically.
  const bakSnap = makeSampleSnapshot(['frase-0', 'frase-1', 'frase-2']);
  fs.writeFileSync(path.join(mirrorDir, 'estado-partida.json'), '{corrupt', 'utf8');
  fs.writeFileSync(path.join(mirrorDir, 'estado-partida.json.bak'), JSON.stringify(bakSnap), 'utf8');

  const bakRun = spawnSync(
    bashExe,
    [restoreScript, '--from-local', toBashPath(bashExe, mirrorDir), '--target-dir', toBashPath(bashExe, targetDir)],
    { env, encoding: 'utf8' }
  );
  assert.equal(bakRun.status, 0, `fallback restore failed: ${bakRun.stderr}`);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(targetDir, 'estado-partida.json'), 'utf8')).cantadas,
    ['frase-0', 'frase-1', 'frase-2']
  );

  // Both corrupt -> must fail non-zero and not overwrite target.
  fs.writeFileSync(path.join(mirrorDir, 'estado-partida.json.bak'), '{also-corrupt', 'utf8');
  const failRun = spawnSync(
    bashExe,
    [restoreScript, '--from-local', toBashPath(bashExe, mirrorDir), '--target-dir', toBashPath(bashExe, targetDir)],
    { env, encoding: 'utf8' }
  );
  assert.notEqual(failRun.status, 0);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(targetDir, 'estado-partida.json'), 'utf8')).cantadas,
    ['frase-0', 'frase-1', 'frase-2']
  );
});

test('harden-vm.sh --dry-run runs cleanly without mutating the host', (t) => {
  const bashExe = findRunnableBash();
  if (!bashExe) {
    t.skip('Runnable bash not available in this environment');
    return;
  }

  const tmpDir = makeTempDir('bingoelus-harden-');
  const hardenScript = toBashPath(bashExe, path.join(OPS_DIR, 'gcp/harden-vm.sh'));
  const res = spawnSync(
    bashExe,
    [hardenScript, '--dry-run', '--install-dir', toBashPath(bashExe, tmpDir)],
    { encoding: 'utf8' }
  );
  assert.equal(res.status, 0, `harden-vm.sh --dry-run failed: ${res.stderr}`);
  assert.match(res.stdout, /Journald persistente/);
  assert.match(res.stdout, /Swap/);
});
