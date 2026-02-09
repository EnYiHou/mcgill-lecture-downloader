import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const manifestPath = resolve(process.cwd(), 'manifest.json');
const manifestRaw = readFileSync(manifestPath, 'utf8');
const versionRegex = /("version"\s*:\s*")(\d+)\.(\d+)\.(\d+)(")/;
const match = versionRegex.exec(manifestRaw);

if (!match) {
  throw new Error('manifest.json version must use major.minor.patch');
}

const major = Number.parseInt(match[2], 10);
const minor = Number.parseInt(match[3], 10);
const patch = Number.parseInt(match[4], 10) + 1;
const nextVersion = `${major}.${minor}.${patch}`;

const manifestNext = manifestRaw.replace(versionRegex, `$1${nextVersion}$5`);
writeFileSync(manifestPath, manifestNext, 'utf8');

process.stdout.write(nextVersion);
