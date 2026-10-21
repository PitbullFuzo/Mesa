import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync('.github/workflows/release.yml', 'utf8');

describe('the release workflow', () => {
  it('runs on a version tag only, with exactly the permissions it needs', () => {
    expect(workflow).toMatch(
      /tags:\s*\n\s*- '\[0-9\]\+\.\[0-9\]\+\.\[0-9\]\+'/,
    );
    expect(workflow).toMatch(/contents: write/);
    expect(workflow).toMatch(/id-token: write/);
    expect(workflow).toMatch(/attestations: write/);
    expect(workflow).not.toMatch(/branches:/);
  });

  it('pins every action to an exact version', () => {
    const uses = [...workflow.matchAll(/uses: (\S+)/g)].map((m) => m[1]!);
    expect(uses.length).toBeGreaterThanOrEqual(3);
    for (const action of uses) expect(action).toMatch(/@v?\d+\.\d+\.\d+$/);
  });

  it('checks the tag against the manifest, tests, builds, then attests the three files', () => {
    const order = [
      'Check the tag equals the manifest version',
      'npm test',
      'npm run package',
      'attest-build-provenance',
    ].map((marker) => workflow.indexOf(marker));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const file of ['main.js', 'styles.css', 'manifest.json'])
      expect(workflow).toContain(`release-files/${file}`);
  });

  it('attaches the assets to a draft and only then publishes it', () => {
    const create = workflow.indexOf('gh release create');
    const publish = workflow.indexOf('gh release edit');
    expect(create).toBeGreaterThan(workflow.indexOf('attest-build-provenance'));
    expect(workflow.slice(create, publish)).toContain('--draft');
    expect(workflow.slice(create, publish)).toContain('release-files/main.js');
    expect(workflow.slice(publish)).toContain('--draft=false');
  });
});
