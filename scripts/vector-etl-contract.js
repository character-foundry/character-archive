export const VECTOR_RESULT_PREFIX = '[VECTOR_RESULT] ';

export function resolveExplicitIdMode({ forceReembed = false, chunksEnabled = false } = {}) {
    return {
        forceReembedAll: Boolean(forceReembed),
        forceChunkReembed: Boolean(forceReembed && chunksEnabled),
        verifyCardDocs: false
    };
}

export function parseVectorEtlResult(output) {
    const line = String(output || '')
        .split(/\r?\n/)
        .reverse()
        .find(candidate => candidate.startsWith(VECTOR_RESULT_PREFIX));
    if (!line) throw new Error('Vector ETL did not report a machine-readable result');
    return JSON.parse(line.slice(VECTOR_RESULT_PREFIX.length));
}

export function validateVectorEtlResult(result, { upsertCount = 0, deleteCount = 0, forceReembed = false } = {}) {
    const processed = Number(result?.processed || 0);
    const cardUpdates = Number(result?.cardUpdates || 0);
    const skippedNoText = Number(result?.skippedNoText || 0);
    const skippedUnchanged = Number(result?.skippedUnchanged || 0);
    const expected = Number(upsertCount) + Number(deleteCount);

    if (processed !== expected) {
        throw new Error(`Vector ETL processed ${processed}/${expected} claimed work items`);
    }
    if (forceReembed && skippedUnchanged > 0) {
        throw new Error(`Vector ETL skipped ${skippedUnchanged} unchanged cards during a forced shadow rebuild`);
    }
    if (forceReembed && cardUpdates + skippedNoText !== Number(upsertCount)) {
        throw new Error(`Vector ETL persisted ${cardUpdates}/${upsertCount} forced upserts (${skippedNoText} had no usable text)`);
    }
    return result;
}
