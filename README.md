# Character Archive

**A locally-hosted, offline-first archive and search engine for AI character cards.**

This project allows you to mirror character cards from multiple sources ([Chub.ai](https://chub.ai), [Character Tavern](https://character-tavern.com), [RisuAI](https://risuai.net), and [Wyvern](https://wyvern.chat)) to your local machine. It provides a fast, rich interface for browsing, searching (including semantic vector search), and managing your collection, completely independent of external servers once downloaded.

## Key Features

*   **Multi-Source Archiving:** Syncs from four sources - Chub.ai (via API), Character Tavern (via Meilisearch), RisuAI, and Wyvern.
*   **Offline-First:** Downloads character cards (PNGs + JSON) and caches all gallery images/external assets locally.
*   **Advanced Search:**
    *   **SQL Search:** Fast filtering by tags, author, tokens, dates, and flags.
    *   **Semantic Vector Search:** (Optional) Use Ollama + Meilisearch to find characters by "vibe" or description, even if keywords don't match. Whole-card semantic search is the baseline; chunk vectors are optional if you also want snippet-level semantic matches.
    *   **Boolean Logic:** Full support for `AND`, `OR`, `NOT`, and parenthetical grouping in search queries.
*   **Integrations:**
    *   **SillyTavern:** One-click push to a running SillyTavern instance. Tracks which cards are already loaded.
    *   **Character Architect:** Push cards directly to Character Architect for editing.
*   **Rich Metadata:** Extracts and indexes everything—alternate greetings, lorebooks, system prompts, and token counts per section.
*   **Asset Caching:** Automatically scrapes and downloads all images referenced in card descriptions and galleries so your archive never "rots."

---

## Requirements

*   **Node.js:** Version 20 or higher.
*   **pnpm:** Package manager (required for workspace dependencies).
*   **SQLite:** (Bundled with Node.js drivers, no separate install usually needed).
*   **Meilisearch (Optional):** Version 1.40+ recommended (required for advanced/vector search and Character Tavern sync).
*   **Ollama (Optional):** Required only for semantic vector search embedding generation.

### Dependencies

This project uses the `@character-foundry` package suite for character card parsing and features:

*   `@character-foundry/loader` - Parse character cards from PNG, JSON, CharX formats
*   `@character-foundry/schemas` - Zod schemas for CCv2/CCv3 validation and feature derivation (workspace dependency)
*   `@character-foundry/image-utils` - URL extraction and SSRF protection (workspace dependency)
*   `@character-foundry/federation` - ActivityPub federation support
*   `@character-foundry/exporter` - Export cards to PNG, CharX, Voxta formats
*   `@character-foundry/core` - Shared utilities and error types

**Note:** Some packages (`@character-foundry/schemas`, `@character-foundry/image-utils`) use pnpm workspace protocol and require the character-foundry monorepo as a sibling directory. Others are available on public npm.

---

## Installation & Setup

### 1. Prerequisites

Character Archive requires the character-foundry monorepo as a sibling directory:

```
/your-workspace/
  character-foundry/    # Monorepo with shared packages
  character-archive/    # This application
```

### 2. Installation
Clone the repository and install dependencies:

```bash
git clone https://github.com/axAilotl/character-archive.git
cd character-archive
pnpm install
```

### 3. Configuration
The application relies on a `config.json` file. The tracked loader creates it automatically; you only edit the JSON state file.

1.  **Run the app once to generate `config.json`:**
    ```bash
    pnpm start
    ```
    (Then Ctrl+C to stop it). This will create a default `config.json` in the root directory.

2.  **Edit `config.json`:**
    Open `config.json` and configure your settings. Key fields:

    *   **Chub API:**
        ```json
        "apikey": "YOUR_CHUB_API_KEY", 
        "chubProfileName": "your_username",
        "syncFollowedCreators": true
        ```
        *(API Key is required for Timeline sync. Search sync works without it but is rate-limited/censored.)*

    *   **Character Tavern (CT) Sync:**
        ```json
        "ctSync": {
            "enabled": true,
            "bearerToken": "YOUR_CT_BEARER_TOKEN", 
            "cfClearance": "YOUR_CLOUDFLARE_COOKIE",
            "session": "YOUR_CT_SESSION_COOKIE"
        }
        ```
        *(Bearer token and cookies are required due to CT's protections. Extract these from your browser dev tools network tab.)*

    *   **SillyTavern Integration:**
        ```json
        "sillyTavern": {
            "enabled": true,
            "baseUrl": "http://127.0.0.1:8000"
        }
        ```

    *   **Vector Search:**
        ```json
        "vectorSearch": {
            "enabled": true,
            "enableChunks": false,
            "cardsIndex": "cards_vsem",
            "chunksIndex": "card_chunks",
            "embeddingProvider": "ollama",
            "embeddingUrl": "http://127.0.0.1:11434",
            "embeddingApiKey": "",
            "embedModel": "snowflake-arctic-embed2:latest"
        }
        ```
        `enableChunks: false` gives you the lower-overhead whole-card semantic index only. Set it to `true` if you also want the optional `card_chunks` index for semantic snippets and chunk reranking.

### 4. Running the Application

**Development Mode (Recommended):**
Starts both the Backend API (port 6969) and Frontend UI (port 3177) with hot-reloading.
```bash
pnpm dev
```
*   **Frontend:** [http://localhost:3177](http://localhost:3177)
*   **Backend:** [http://localhost:6969](http://localhost:6969)

**Production Mode:**
Build the frontend and run the optimized server.
```bash
pnpm build --prefix frontend
pnpm prod
```

### Docker Deployment

Run Character Archive and Meilisearch using Docker Compose:

```bash
# From parent directory containing both character-archive/ and character-foundry/
cd /path/to/character-foundry

# Set up environment
cd character-archive
cp .env.example .env
mkdir -p static data.ms dumps snapshots
touch cards.db

# Start services
docker compose up -d
```

Access the application:
*   **Frontend:** http://localhost:3177
*   **Backend API:** http://localhost:6969
*   **Meilisearch:** http://localhost:7700

The shipped Compose stack currently pins Meilisearch to `v1.40.0`, caps it at `32 GiB` RAM, and sets `MEILI_MAX_INDEXING_MEMORY=24GiB` to avoid the runaway-memory behavior seen in earlier uncapped deployments.

For detailed Docker configuration, see [docker/README.md](docker/README.md).

---

## Usage Guide

### Syncing Cards

*   **Manual Sync (Chub):**
    Click the **Sync** button in the UI header, or run:
    ```bash
    pnpm sync
    ```
    *This respects your `config.json` settings (timeline vs search, tags, etc).*

*   **Manual Sync (Character Tavern):**
    Click the **Sync CT** button (globe icon) in the UI, or run:
    ```bash
    pnpm import:ct
    ```
    *(Note: CT sync requires valid cookies in config).*

*   **Manual Sync (RisuAI/Wyvern):**
    Use the Settings modal in the UI to trigger syncs for RisuAI and Wyvern sources. Configure sync intervals in `config.json`.

### Searching

*   **Basic Search:** Type in the top bar. Searches name, description, author, and tags.
*   **Tag Search:** Use the "Include tags" / "Exclude tags" dropdowns.
*   **Advanced Flags:** Expand the "Advanced Flags" section to filter by specific features:
    *   *Has Lorebook / Embedded Lorebook*
    *   *Has Alternate Greetings*
    *   *Has Gallery* (locally cached)
    *   *Embedded Images* (images inside description/greetings)
*   **Vector Search:** If enabled, typing in the search bar automatically performs a hybrid semantic search. It finds cards that *mean* what you typed, not just text matches.

### Integration with SillyTavern

1.  Enable SillyTavern in `config.json` (`enabled: true`, correct `baseUrl`).
2.  In the Card Grid or Details Modal, click the **"Push to Silly Tavern"** button (paper plane icon).
3.  The card is uploaded to your ST instance.
4.  If successful, the card is automatically locally cached (assets downloaded) and marked as "Loaded in ST".

### Asset Caching

To ensure your archive is truly offline:
*   **Automatic:** Assets are cached automatically when you **Favorite** a card or **Push** it to SillyTavern.
*   **What gets cached?**
    *   Card PNG and metadata JSON.
    *   Gallery images (from Chub).
    *   External images linked in the description or markdown.
*   **Storage:** All assets are stored in `static/cached-assets/`.

---

## Advanced Configuration

### Vector Search Setup (Optional)
1.  Install **Meilisearch** and choose either Ollama or an OpenAI-compatible embedding endpoint.
2.  For Ollama, pull an embedding model:
    ```bash
    ollama pull snowflake-arctic-embed2
    ```
3.  Enable `vectorSearch` in `config.json` and choose whether chunk vectors are enabled:
    *   `enableChunks: false` = lower footprint, whole-card semantic search only.
    *   `enableChunks: true` = builds both `cards_vsem` and `card_chunks`, enabling semantic snippets/chunk reranking.
4.  Restart the server.
5.  Start the durable vector worker in a separate terminal, then request a shadow generation:
    ```bash
    pnpm worker:vector
    curl -X POST http://127.0.0.1:6969/api/vector/reconcile \
      -H 'content-type: application/json' -d '{}'
    ```
    Set `embeddingProvider` to `ollama` or `openai`, and set `embeddingUrl`, `embeddingApiKey`, and `embedModel` for that endpoint. `ollamaUrl` remains supported for older configs.

    *This creates or resumes a model-aware shadow index, reads cards in bounded batches, and only marks work complete after Meilisearch confirms its task. It may take a long time. Search continues using the active generation while the shadow builds.*
    The legacy `pnpm vector:backfill` command remains available for targeted repair, but it is not the normal full-rebuild path.
6.  If you only want to remove chunk vectors while keeping whole-card vectors, run:
    ```bash
    pnpm vector:flush -- --chunks-only
    ```

### Maintenance Scripts
*   `pnpm update-metadata`: Refreshes metadata for all local cards from their JSON files.
*   `pnpm fix:flags`: Scans all cards and updates database feature flags (like `hasEmbeddedImages`).
*   `pnpm sync:search`: Pushes all local database content to Meilisearch (for lexical search).

### Logging
The application uses a centralized logging system with scoped loggers for each component. Log output follows the format `[LEVEL][SCOPE] message`.

**Log Levels:** `DEBUG`, `INFO`, `WARN`, `ERROR`, `FATAL`

To enable verbose debug logging, set the `LOG_LEVEL` environment variable:
```bash
LOG_LEVEL=DEBUG pnpm dev
```

Filter logs by component using grep:
```bash
pnpm dev 2>&1 | grep '\[SYNC\]'
```

---

## Troubleshooting

*   **Sync Fails (Database not initialized):**
    Ensure you are running `pnpm sync` from the project root. If using the script directly, ensure the database is initialized.
*   **404 on Refresh:**
    Refreshing Character Tavern cards is not supported individually (only bulk sync). The UI will now warn you instead of crashing.
*   **Meilisearch Errors:**
    If searches fail, ensure Meilisearch is running. If you recently changed schema, run `pnpm sync:search`.
*   **`card_chunks` Missing:**
    If `vectorSearch.enableChunks` is `false`, a missing `card_chunks` index is expected. Whole-card vector search still works; re-enable chunks and rerun `pnpm vector:backfill` only if you want semantic snippets/chunk reranking back.
*   **"Missing Config":**
    If the app crashes complaining about config, ensure `config.json` exists and contains valid JSON. Validate your API keys.

*   **Workspace Dependency Errors:**
    If you see errors about `@character-foundry/schemas` or `@character-foundry/image-utils`, ensure the character-foundry monorepo is available as a sibling directory and run `pnpm install` again.

---

## Data Location
*   **Database:** `cards.db` (SQLite) - Keep this safe!
*   **Images/Metadata:** `static/` - Contains all your downloaded card PNGs and JSONs.
*   **Asset Cache:** `static/cached-assets/` - Cached galleries and external images.
*   **Config:** `config.json` - Your local settings and secrets.

**Note:** All user data is git-ignored. You can safely pull updates to the code without overwriting your library.
