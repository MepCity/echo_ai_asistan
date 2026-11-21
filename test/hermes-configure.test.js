import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/** Hermes' config.yaml merge (deploy/oracle/hermes/configure.py, Python), tested by test/hermes_configure_test.py. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const python = spawnSync('python3', ['-c', 'import yaml']).status === 0 ? 'python3' : null;
const skip = python ? false : 'python3 with PyYAML is not installed';

describe('Hermes config.yaml (configure.py)', { skip }, () => {
    it('python tests pass: voice messages local/tr/small/int8, user choices kept', () => {
        const result = spawnSync(python, ['-B', '-I', join(ROOT, 'test/hermes_configure_test.py')], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr + result.stdout);
        assert.match(result.stderr, /Ran \d+ tests[\s\S]*OK/);
    });
});
