# Docker deployment

The production stack separates the API, Next.js web UI, archive worker, and vector worker. LanceDB runs embedded in the application containers; Meilisearch is an optional Compose profile. Every application container uses Node 22. Inference remains external; the stack does not start llama.cpp or copy model weights.

Application containers run as `ARCHIVE_UID:ARCHIVE_GID` (default `1000:1000`) so files created in writable bind mounts remain readable by host-side backup and maintenance jobs.

## Persistent layout

Copy `.env.example` to `.env`, then create the writable directories and bind-mounted state files:

```bash
mkdir -p runtime/state static data backup data.ms dumps snapshots
touch \
  data/blacklist.txt \
  data/ct-blacklist.txt \
  data/risuai-blacklist.txt \
  data/wyvern-blacklist.txt
for file in data/tag-aliases.json data/risuai-cooldown.json data/wyvern-cooldown.json; do
  [ -e "$file" ] || printf '{}\n' > "$file"
done
```

`runtime/state` must contain `config.json` and `cards.db`; it also stores `search.lance` when the embedded backend is enabled. SQLite creates its WAL and shared-memory files beside the database, so the entire directory is mounted instead of a single database file. Card artifacts, scraper state, backups, and optional Meilisearch data each use separate mounts.

Create a consistent database copy while the current service is live:

```bash
sqlite3 cards.db ".backup 'runtime/state/cards.db'"
cp config.json runtime/state/config.json
```

For a new deployment, initialize an empty database and let the API create its schema:

```bash
sqlite3 runtime/state/cards.db 'PRAGMA journal_mode=WAL;'
```

The configuration is writable in Docker. API saves use a temporary file, `fsync`, and atomic rename.

## Build and validate on alternate ports

The Docker build uses the sibling `../character-foundry` checkout as a named BuildKit context, avoiding the hundreds of gigabytes of archive data in the parent directory.

```bash
docker compose build
APP_PORT=16969 FRONTEND_PORT=13177 MEILI_PORT=17700 \
MEILI_DATA_DIR=./runtime/meili-shadow \
docker compose --profile meilisearch up -d meilisearch api web
```

For a realistic search comparison, restore a Meilisearch dump into `runtime/meili-shadow` first. Do not point two running Meilisearch processes at the same `data.ms` directory.

Validate the staged API before enabling either worker:

```bash
curl -fsS http://127.0.0.1:16969/health/ready
curl -fsS http://127.0.0.1:16969/api/sync/status
curl -fsS http://127.0.0.1:16969/api/vector/status
docker compose logs --tail=200 api web meilisearch
```

## Cutover

1. Stop the process-compose API and the old sync/vector services so there is one writer.
2. Stop the validation stack; its API is still reading `runtime/state/cards.db`.
3. Take a final SQLite backup into `runtime/state/cards.db` and copy the final `config.json`.
4. Start the complete stack on the normal ports.
5. Compare card counts, source counts, lexical results, and vector status before removing the old service definitions.

```bash
docker compose down
docker compose up -d
docker compose ps
docker compose logs --tail=200 api archive-worker vector-worker
```

The service memory ceilings are:

| Service | Limit |
|---|---:|
| API | 4 GiB |
| Web | 1 GiB |
| Archive worker | 4 GiB |
| Vector worker | 8 GiB |
| Meilisearch (optional profile) | 32 GiB, with a 24 GiB indexing budget |

Container logs rotate at 25 MiB with four files. Meilisearch has no swap allowance beyond its 32 GiB cap.

## Database choice

This deployment deliberately keeps SQLite. The archive has one human user and serialized background writers, while WAL mode, a 15-second busy timeout, bounded mmap, online backups, and durable work tables cover the current reliability needs without adding a second database system. PostgreSQL support remains a later portability project rather than part of this cutover.

## Operations

Manual source runs are durable:

```bash
curl -X POST http://127.0.0.1:6969/api/sync/runs \
  -H 'content-type: application/json' \
  -d '{"sources":["chub","ct","risuai","wyvern"]}'
```

Character Tavern repair is dry-run by default. `--apply` creates a timestamped SQLite backup and manifest, quarantines duplicate artifacts, and then performs the full detail refetch. Add `--no-refetch` to split those phases.

```bash
docker compose run --rm archive-worker node scripts/repair-ct.js
docker compose run --rm archive-worker node scripts/repair-ct.js --apply
```

Create or resume a shadow vector generation through `POST /api/vector/reconcile`. LanceDB indexing continues during archive sync because revisioned leases safely requeue cards changed during an embedding batch. Meilisearch pauses during archive sync by default and also pauses above 200 pending tasks. Set `VECTOR_PAUSE_DURING_SYNC` to explicitly override either provider policy. LanceDB generations batch embeddings and build their ANN index before completion. Generation activation requires a passing 120-query benchmark report and explicit approval. A Lance-only installation uses absolute quality floors; `--baseline` additionally compares it with an existing Meilisearch generation.

Review and edit the generated fixture before treating it as a quality gate. The benchmark also enforces absolute hit-rate, MRR, and top-one floors, but hand-written intent queries are more representative than card names or taglines.

```bash
docker compose run --rm vector-worker node scripts/build-vector-benchmark-fixture.js \
  --output /state/benchmarks/vector-search-queries.json
docker compose run --rm vector-worker node scripts/benchmark-vector-generations.js \
  --candidate 2 \
  --fixture /state/benchmarks/vector-search-queries.json \
  --output /state/benchmarks/vector-report.json

# Add `--baseline 1` when a complete Meilisearch generation is available.
```

## Rollback

Stop the Docker application containers, restart the old services, and point them at the untouched original `cards.db`, `static`, and Meilisearch directories. The staged state directory and shadow indexes can be retained for diagnosis. Do not run old and new archive/vector workers simultaneously.

Scheduled Synology dumps and delta artifact backups remain a later operational phase; they are intentionally not coupled to this cutover.
