import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { writeJsonAtomically } from './config-loader.js';

test('atomic config writes replace the complete JSON document without leaving temp files', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'character-archive-config-'));
    const configPath = path.join(directory, 'config.json');
    try {
        writeJsonAtomically(configPath, { version: 1, nested: { enabled: true } });
        writeJsonAtomically(configPath, { version: 2, nested: { enabled: false } });

        assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), {
            version: 2,
            nested: { enabled: false }
        });
        assert.deepEqual(fs.readdirSync(directory), ['config.json']);
    } finally {
        fs.rmSync(directory, { recursive: true });
    }
});
