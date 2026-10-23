import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { CREDITS, WHATS_NEW } from '../../src/lib/about';

const root = join(import.meta.dir, '..', '..', '..');

describe('about page', () => {
  test('lists the same releases as the README, newest first, starting at the app version', () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    const section = readme.slice(readme.indexOf("## What's new"), readme.indexOf('## Features'));
    const readmeVersions = [...section.matchAll(/^### v(\S+)$/gm)].map((match) => match[1]);
    const packageVersion = JSON.parse(readFileSync(join(root, 'frontend', 'package.json'), 'utf8')).version;

    expect(WHATS_NEW.map((release) => release.version)).toEqual(readmeVersions);
    expect(WHATS_NEW[0].version).toBe(packageVersion);
  });

  test('keeps every release and credit short and complete', () => {
    for (const release of WHATS_NEW) {
      expect(release.highlights.length).toBeGreaterThan(0);
      expect(release.highlights.length).toBeLessThanOrEqual(2);
    }
    for (const credit of CREDITS) {
      expect(credit.license).not.toBe('');
      expect(credit.url.startsWith('https://')).toBe(true);
    }
  });
});
