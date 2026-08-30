import { getDatabase } from '../database.js';
import { getVectorGenerationRepository } from '../db/repositories/VectorGenerationRepository.js';
import { appConfig } from '../services/ConfigState.js';
import { configureVectorSearch, getVectorRuntimeStatus } from '../services/search-index.js';
import { saveConfig } from '../../config-loader.js';
import { logger } from '../utils/logger.js';

const log = logger.scoped('VECTOR:API');

function configuredSpec(overrides = {}) {
    const vector = appConfig.vectorSearch || {};
    return {
        modelName: overrides.modelName || vector.embedModel,
        embedderName: overrides.embedderName || vector.embedderName,
        dimensions: Number(overrides.dimensions || vector.embedDimensions),
        cardsIndexBase: overrides.cardsIndexBase || vector.cardsIndex || 'cards_vsem',
        chunksIndexBase: overrides.chunksIndexBase ?? vector.chunksIndex ?? 'card_chunks',
        chunksEnabled: overrides.chunksEnabled ?? vector.enableChunks !== false,
        forceNewGeneration: overrides.forceNewGeneration === true
    };
}

class VectorController {
    status = (req, res) => {
        try {
            const database = getDatabase();
            const generations = getVectorGenerationRepository().list();
            const legacyQueue = database.prepare('SELECT COUNT(*) AS count FROM vector_index_queue').get().count;
            const metadata = database.prepare(`
                SELECT model_name, embedder_name, dims, COUNT(*) AS rows, COUNT(DISTINCT cardId) AS cards
                FROM card_embedding_meta
                GROUP BY model_name, embedder_name, dims
                ORDER BY cards DESC
            `).all();
            res.json({
                runtime: getVectorRuntimeStatus(),
                generations,
                queue: {
                    legacy: legacyQueue,
                    durable: generations.reduce((total, generation) => total + generation.queued_items + generation.retry_items + generation.running_items, 0),
                    dead: generations.reduce((total, generation) => total + generation.dead_items, 0)
                },
                embeddingMetadata: metadata
            });
        } catch (error) {
            log.error('Vector status failed', error);
            res.status(500).json({ error: error.message });
        }
    };

    reconcile = (req, res) => {
        try {
            const repository = getVectorGenerationRepository();
            if (req.body?.activateGenerationId != null) {
                const report = req.body?.qualityReport;
                const generationId = Number(req.body.activateGenerationId);
                if (
                    req.body?.qualityApproved !== true
                    || report?.passed !== true
                    || Number(report?.candidate?.generationId) !== generationId
                    || Number(report?.queryCount) < 120
                    || typeof report?.fixture !== 'string'
                ) {
                    return res.status(400).json({ error: 'Activation requires a passing 120-query report bound to this candidate and explicit quality approval' });
                }
                const candidate = repository.get(generationId);
                if (!candidate) return res.status(404).json({ error: 'Vector generation not found' });
                const nextVectorConfig = {
                    ...(appConfig.vectorSearch || {}),
                    cardsIndex: candidate.cards_index,
                    chunksIndex: candidate.chunks_index || '',
                    enableChunks: Boolean(candidate.chunks_index),
                    embedModel: candidate.model_name,
                    embedderName: candidate.embedder_name,
                    embedDimensions: candidate.dimensions
                };
                const nextConfig = { ...appConfig, vectorSearch: nextVectorConfig };
                const previousConfig = structuredClone(appConfig);
                let configPersisted = false;
                let generation;
                try {
                    generation = repository.activate(generationId, {
                        qualityApproved: true,
                        qualityReport: report,
                        beforeCommit: () => {
                            saveConfig(nextConfig);
                            configPersisted = true;
                        }
                    });
                } catch (error) {
                    if (configPersisted) {
                        try { saveConfig(previousConfig); } catch (rollbackError) {
                            log.error('Failed to restore vector config after activation rollback', rollbackError);
                        }
                    }
                    throw error;
                }
                Object.assign(appConfig, nextConfig);
                configureVectorSearch(nextVectorConfig);
                return res.json(generation);
            }

            const generation = repository.reconcile(configuredSpec(req.body || {}));
            return res.status(generation.status === 'building' ? 202 : 200).json(generation);
        } catch (error) {
            log.error('Vector reconcile failed', error);
            return res.status(400).json({ error: error.message });
        }
    };
}

export const vectorController = new VectorController();
