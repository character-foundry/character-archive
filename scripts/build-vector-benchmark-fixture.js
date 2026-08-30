#!/usr/bin/env node
import path from 'path';

import { initDatabase, getDatabase } from '../backend/database.js';
import { writeJsonAtomically } from '../config-loader.js';

const outputArg = process.argv.indexOf('--output');
const outputPath = path.resolve(outputArg >= 0 ? process.argv[outputArg + 1] : 'benchmarks/vector-search-queries.json');
initDatabase({ skipTagRebuild: true, skipTokenBackfill: true });
const database = getDatabase();
const sources = ['chub', 'ct', 'risuai', 'wyvern'];
const fixture = [];

for (const source of sources) {
    const rows = database.prepare(`
        SELECT id, name, tagline, topics
        FROM cards
        WHERE source = ? AND name IS NOT NULL AND TRIM(name) <> ''
        ORDER BY favorited DESC, nMessages DESC, id ASC
        LIMIT 30
    `).all(source);
    rows.forEach(row => fixture.push({
        query: row.tagline?.trim() || row.name.trim(),
        expectedIds: [String(row.id)],
        source,
        note: row.name
    }));
}

if (fixture.length < 120) throw new Error(`Only ${fixture.length} fixture rows available; 120 are required`);
writeJsonAtomically(outputPath, fixture.slice(0, 120));
process.stdout.write(`Wrote 120-query review fixture to ${outputPath}\n`);
