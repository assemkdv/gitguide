#!/usr/bin/env node
// Verifies the built extension in apps/extension/dist and packages it as a Chrome Web
// Store upload: release/gitguide-extension-v<version>.zip with manifest.json at the root,
// plus a .sha256 checksum. Fails (exit 1) instead of packaging anything suspicious.
//
// Usage: npm run package:extension   (builds first, then runs this script)
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'apps/extension/dist');
const outDir = join(root, 'release');

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function listFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? listFiles(full) : [full];
  });
}

// ---------------------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------------------

let manifest;
try {
  manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
} catch {
  fail('apps/extension/dist/manifest.json is missing or invalid. Run `npm run build:extension` first.');
}

const files = listFiles(dist).sort();
const relPaths = files.map((f) => relative(dist, f).split(sep).join('/'));

if (manifest.manifest_version !== 3) fail('manifest_version must be 3.');
for (const permission of manifest.host_permissions ?? []) {
  if (!permission.startsWith('https://')) fail(`Insecure or local host permission: ${permission}`);
  if (/localhost|127\.0\.0\.1|\[::1\]/.test(permission)) fail(`Local host permission in a release build: ${permission}`);
}
if (relPaths.some((p) => p.endsWith('.map'))) fail('Source maps found in the release build.');
if (relPaths.some((p) => /(^|\/)\.env/.test(p))) fail('An .env file was found in the release build.');

const forbidden = [
  { name: 'loopback API URL', re: /https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?/ },
  { name: 'Vite dev client', re: /@vite\/client|vite\/dist\/client/ },
  { name: 'Groq API key', re: /gsk_[A-Za-z0-9]{20,}/ },
  { name: 'GitHub token', re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}/ },
  { name: 'private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'GROQ_API_KEY reference', re: /GROQ_API_KEY/ },
  { name: 'eval()', re: /\beval\(/ },
  { name: 'remote script import', re: /import\(\s*["']https?:/ },
];
for (const file of files) {
  if (!/\.(js|json|html|css)$/.test(file)) continue;
  const text = readFileSync(file, 'utf8');
  for (const { name, re } of forbidden) {
    if (re.test(text)) fail(`${name} found in ${relative(dist, file)}`);
  }
}

const apiPermission = (manifest.host_permissions ?? [])[0];
if (!apiPermission) fail('No API host permission in the manifest.');
const apiOrigin = apiPermission.replace(/\/\*$/, '');
const bundleText = files.filter((f) => f.endsWith('.js')).map((f) => readFileSync(f, 'utf8')).join('\n');
if (!bundleText.includes(apiOrigin)) fail(`The bundle does not reference the permitted API origin ${apiOrigin}.`);

// ---------------------------------------------------------------------------------------
// Deterministic ZIP (fixed timestamps, sorted entries, manifest.json at the root)
// ---------------------------------------------------------------------------------------

const DOS_TIME = 0; // 00:00:00
const DOS_DATE = ((2024 - 1980) << 9) | (1 << 5) | 1; // 2024-01-01
const localParts = [];
const centralParts = [];
let offset = 0;

for (let i = 0; i < files.length; i++) {
  const name = Buffer.from(relPaths[i], 'utf8');
  const data = readFileSync(files[i]);
  const compressed = deflateRawSync(data, { level: 9 });
  const crc = crc32(data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0x0800, 6); // UTF-8 names
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  localParts.push(local, name, compressed);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(0x031e, 4); // made by: Unix, v3.0
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt16LE(DOS_TIME, 12);
  central.writeUInt16LE(DOS_DATE, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // -rw-r--r--
  central.writeUInt32LE(offset, 42);
  centralParts.push(central, name);

  offset += local.length + name.length + compressed.length;
}

const centralDir = Buffer.concat(centralParts);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralDir.length, 12);
end.writeUInt32LE(offset, 16);

const zip = Buffer.concat([...localParts, centralDir, end]);
mkdirSync(outDir, { recursive: true });
const zipName = `gitguide-extension-v${manifest.version}.zip`;
const sha256 = createHash('sha256').update(zip).digest('hex');
writeFileSync(join(outDir, zipName), zip);
writeFileSync(join(outDir, `${zipName}.sha256`), `${sha256}  ${zipName}\n`);

console.log(`✓ ${files.length} files verified (MV3, ${apiPermission}, no source maps, no local URLs, no secrets)`);
console.log(`✓ release/${zipName} (${(zip.length / 1024).toFixed(1)} KiB)`);
console.log(`  sha256 ${sha256}`);
