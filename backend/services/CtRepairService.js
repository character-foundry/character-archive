const PRESERVED_COLUMNS = new Set(['id', 'favorited', 'firstDownloadedAt']);

function normalizePath(value) {
    return String(value || '').trim().toLowerCase().replace(/\s+/g, '_');
}

export function createCtRepairService(database) {
    if (!database) throw new Error('Database is required for CT repair');

    return {
        plan() {
            const duplicatePaths = database.prepare(`
                SELECT LOWER(REPLACE(TRIM(sourcePath), ' ', '_')) AS normalized_path, COUNT(*) AS count
                FROM cards
                WHERE source = 'ct' AND sourcePath IS NOT NULL AND TRIM(sourcePath) <> ''
                GROUP BY normalized_path
                HAVING COUNT(*) > 1
                ORDER BY normalized_path ASC
            `).all();

            const rowsForPath = database.prepare(`
                SELECT id, sourceId, sourcePath, favorited, firstDownloadedAt, lastModified
                FROM cards
                WHERE source = 'ct' AND LOWER(REPLACE(TRIM(sourcePath), ' ', '_')) = ?
                ORDER BY id ASC
            `);
            const groups = duplicatePaths.map(group => {
                const rows = rowsForPath.all(group.normalized_path);
                const canonical = rows[0];
                const donor = [...rows].sort((left, right) => {
                    const timeDelta = new Date(right.lastModified || 0).getTime() - new Date(left.lastModified || 0).getTime();
                    return timeDelta || right.id - left.id;
                })[0];
                return {
                    normalizedPath: group.normalized_path,
                    canonicalId: canonical.id,
                    metadataDonorId: donor.id,
                    loserIds: rows.slice(1).map(row => row.id),
                    rows
                };
            });
            return {
                duplicateGroups: groups.length,
                duplicateRows: groups.reduce((total, group) => total + group.loserIds.length, 0),
                groups
            };
        },

        apply(plan = this.plan()) {
            const cardColumns = database.prepare('PRAGMA table_info(cards)').all()
                .map(column => column.name)
                .filter(column => !PRESERVED_COLUMNS.has(column));
            const copyMetadata = database.prepare(`
                UPDATE cards SET ${cardColumns.map(column => `"${column}" = (SELECT "${column}" FROM cards WHERE id = @donorId)`).join(', ')}
                WHERE id = @canonicalId
            `);
            const mergeTags = database.prepare(`
                INSERT OR IGNORE INTO card_tags (cardId, tag, normalizedTag)
                SELECT @canonicalId, tag, normalizedTag FROM card_tags WHERE cardId = @loserId
            `);
            const mergeAssets = database.prepare(`
                INSERT OR IGNORE INTO cached_assets (
                    cardId, originalUrl, localPath, assetType, fileSize, cachedAt, metadata
                )
                SELECT @canonicalId, originalUrl, localPath, assetType, fileSize, cachedAt, metadata
                FROM cached_assets WHERE cardId = @loserId
            `);
            const recordAlias = database.prepare(`
                INSERT OR IGNORE INTO card_source_aliases (
                    source, source_id, source_path, canonical_card_id, retired_card_id
                ) VALUES ('ct', @sourceId, @sourcePath, @canonicalId, @loserId)
            `);
            const deleteCard = database.prepare('DELETE FROM cards WHERE id = ?');
            const queueSearch = database.prepare("INSERT INTO search_index_queue (cardId, action) VALUES (?, 'upsert')");
            const queueVector = database.prepare(`
                INSERT INTO vector_index_queue (cardId, action) VALUES (?, 'upsert')
                ON CONFLICT(cardId) DO UPDATE SET action = excluded.action, queuedAt = CURRENT_TIMESTAMP
            `);

            const transaction = database.transaction(() => {
                for (const group of plan.groups) {
                    const favorite = group.rows.some(row => row.favorited) ? 1 : 0;
                    const earliest = group.rows
                        .map(row => row.firstDownloadedAt)
                        .filter(Boolean)
                        .sort()[0] || null;
                    copyMetadata.run({ canonicalId: group.canonicalId, donorId: group.metadataDonorId });
                    database.prepare(`
                        UPDATE cards
                        SET favorited = ?, firstDownloadedAt = ?, sourcePath = ?
                        WHERE id = ?
                    `).run(favorite, earliest, normalizePath(group.normalizedPath), group.canonicalId);

                    for (const loserId of group.loserIds) {
                        const loser = group.rows.find(row => row.id === loserId);
                        mergeTags.run({ canonicalId: group.canonicalId, loserId });
                        mergeAssets.run({ canonicalId: group.canonicalId, loserId });
                        recordAlias.run({
                            sourceId: loser?.sourceId || null,
                            sourcePath: loser?.sourcePath || group.normalizedPath,
                            canonicalId: group.canonicalId,
                            loserId
                        });
                        deleteCard.run(loserId);
                    }
                    queueSearch.run(String(group.canonicalId));
                    queueVector.run(String(group.canonicalId));
                }
                database.exec(`
                    CREATE UNIQUE INDEX IF NOT EXISTS idx_cards_ct_source_path_unique
                    ON cards(LOWER(REPLACE(TRIM(sourcePath), ' ', '_')))
                    WHERE source = 'ct' AND sourcePath IS NOT NULL AND TRIM(sourcePath) <> '';
                `);
            });
            transaction();
            return {
                mergedGroups: plan.duplicateGroups,
                mergedRows: plan.duplicateRows,
                canonicalIds: plan.groups.map(group => group.canonicalId),
                retiredIds: plan.groups.flatMap(group => group.loserIds)
            };
        }
    };
}
