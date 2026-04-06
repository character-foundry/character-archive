# Docker Deployment Guide

This guide covers running Character Archive using Docker and Docker Compose.

## Prerequisites

- Docker 20.10+ and Docker Compose v2
- Enough RAM for your chosen Meilisearch cap. The bundled compose file currently caps Meilisearch at `32 GiB` and sets `MEILI_MAX_INDEXING_MEMORY=24GiB`.
- Storage for your card collection (varies by usage)

## Quick Start

### 1. Navigate to the parent directory

The build context requires both `character-archive/` and `character-foundry/` to be siblings:

```bash
cd /path/to/character-foundry  # Parent directory containing both projects
```

### 2. Create environment file

```bash
cd character-archive
cp .env.example .env
# Edit .env to set MEILI_MASTER_KEY if desired
```

### 3. Create data directories

```bash
mkdir -p static data.ms dumps snapshots
touch cards.db
```

### 4. Start the stack

```bash
# From parent directory
docker compose -f character-archive/docker-compose.yml up -d

# Or from character-archive directory
docker compose up -d
```

### 5. Access the application

- **Frontend UI**: http://localhost:3177
- **Backend API**: http://localhost:6969
- **Meilisearch**: http://localhost:7700

## Configuration

### config.json

The container creates a default `config.json` on first run. To customize:

1. Create your own config.json:

```json
{
    "port": 6969,
    "ip": "0.0.0.0",
    "autoUpdateMode": false,
    "autoUpdateInterval": 60,
    "apikey": "YOUR_CHUB_API_KEY",
    "meilisearch": {
        "enabled": true,
        "host": "http://meilisearch:7700",
        "apiKey": "",
        "indexName": "cards"
    },
    "vectorSearch": {
        "enabled": false,
        "enableChunks": false,
        "cardsIndex": "cards_vsem",
        "chunksIndex": "card_chunks",
        "ollamaUrl": "http://host.docker.internal:11434",
        "embedModel": "snowflake-arctic-embed2:latest"
    },
    "sillyTavern": {
        "enabled": false,
        "baseUrl": ""
    },
    "ctSync": {
        "enabled": false,
        "bearerToken": "",
        "cfClearance": "",
        "session": ""
    }
}
```

2. Mount it as read-only in docker-compose.yml (already configured)

`enableChunks: false` keeps vector search on the whole-card index only. Set it to `true` if you also want semantic snippets/chunk reranking via the optional `card_chunks` index.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `APP_PORT` | 6969 | Backend API port on host |
| `FRONTEND_PORT` | 3177 | Frontend UI port on host |
| `MEILI_PORT` | 7700 | Meilisearch port on host |
| `MEILI_MASTER_KEY` | (empty) | Meilisearch authentication key |
| `OLLAMA_URL` | http://host.docker.internal:11434 | Ollama server for vector search |
| `LOG_LEVEL` | INFO | Application log level |

## Volume Mapping

| Container Path | Host Path | Description |
|----------------|-----------|-------------|
| `/app/static` | `./static` | Card images and JSON files |
| `/app/cards.db` | `./cards.db` | SQLite database |
| `/app/config.json` | `./config.json` | Application configuration |
| `/meili_data/data.ms` | `./data.ms` | Meilisearch database files |
| `/meili_data/dumps` | `./dumps` | Meilisearch dumps |
| `/meili_data/snapshots` | `./snapshots` | Meilisearch snapshots |

## Using with Ollama

To enable vector/semantic search, you need Ollama running:

### Option 1: Host Machine Ollama (Recommended)

1. Install and start Ollama on your host:
   ```bash
   ollama serve
   ollama pull snowflake-arctic-embed2
   ```

2. The default `OLLAMA_URL=http://host.docker.internal:11434` will work

### Option 2: Remote Ollama Server

Set in `.env`:
```env
OLLAMA_URL=http://your-ollama-server:11434
```

### Option 3: Ollama in Docker (Advanced)

Add to docker-compose.yml:
```yaml
services:
  ollama:
    image: ollama/ollama
    container_name: ollama
    ports:
      - "11434:11434"
    volumes:
      - ./ollama-data:/root/.ollama
    networks:
      - archive-net
```

Then set `OLLAMA_URL=http://ollama:11434`

## Building the Image

### Standard Build

```bash
# From parent directory (character-foundry/)
docker build -f character-archive/Dockerfile -t character-archive .
```

### Build with Custom Tag

```bash
docker build -f character-archive/Dockerfile -t character-archive:v1.0.0 .
```

### Build Arguments

The Dockerfile doesn't currently use build arguments, but the build context must include:
- `character-archive/` - This application
- `character-foundry/packages/` - Workspace packages (core, schemas, image-utils)

## Management Commands

### View Logs

```bash
# All services
docker compose -f character-archive/docker-compose.yml logs -f

# Specific service
docker compose -f character-archive/docker-compose.yml logs -f app
docker compose -f character-archive/docker-compose.yml logs -f meilisearch
```

### Stop Services

```bash
docker compose -f character-archive/docker-compose.yml down
```

### Restart Services

```bash
docker compose -f character-archive/docker-compose.yml restart
```

### Rebuild After Code Changes

```bash
docker compose -f character-archive/docker-compose.yml up -d --build
```

### Shell Access

```bash
docker exec -it character-archive sh
```

### Database Maintenance

```bash
# Run sync manually
docker exec character-archive node scripts/sync.js

# Sync Meilisearch index
docker exec character-archive node scripts/sync-meilisearch.js

# Vector backfill (if Ollama configured)
docker exec character-archive node scripts/etl_cards_vector_search.js

# Remove only the optional chunk vector index/artifacts
docker exec character-archive node scripts/flush-vector-indexes.js --chunks-only
```

## Troubleshooting

### Container won't start

Check logs:
```bash
docker compose -f character-archive/docker-compose.yml logs app
```

Common issues:
- Missing `config.json` - Container creates default, but verify permissions
- Database locked - Ensure no other process is accessing cards.db
- Port conflict - Change `APP_PORT` or `FRONTEND_PORT` in `.env`

### Meilisearch connection failed

1. Verify Meilisearch is healthy:
   ```bash
   docker compose -f character-archive/docker-compose.yml ps
   curl http://localhost:7700/health
   ```

2. Check config.json has correct host:
   ```json
   "meilisearch": {
       "host": "http://meilisearch:7700"
   }
   ```
3. If `vectorSearch.enableChunks` is `false`, `card_chunks` being absent is expected. Whole-card semantic search still works without that index.

### Can't connect from other machines

By default, ports are bound to all interfaces. If using a firewall:
```bash
# Allow ports
sudo ufw allow 3177/tcp
sudo ufw allow 6969/tcp
```

### Permission denied on volumes

Ensure directories are writable:
```bash
chmod 755 static meili-data
chmod 644 cards.db config.json
```

### Vector search not working

1. Verify Ollama is accessible:
   ```bash
   curl http://localhost:11434/api/tags
   ```

2. Ensure model is pulled:
   ```bash
   ollama pull snowflake-arctic-embed2
   ```

3. Check config.json has vectorSearch enabled:
   ```json
   "vectorSearch": {
       "enabled": true,
       "ollamaUrl": "http://host.docker.internal:11434"
   }
   ```

## Resource Usage

Typical resource consumption:

| Service | RAM | CPU | Storage |
|---------|-----|-----|---------|
| character-archive | 200-500MB | Low | Depends on static/ |
| meilisearch | 500MB-2GB | Low-Medium | ~10-20% of indexed data |

For large collections (100k+ cards), consider:
- Allocating 4GB+ RAM to Meilisearch
- Using SSD storage for meili-data/
- Setting `MEILI_HTTP_PAYLOAD_SIZE_LIMIT` for large batch imports
