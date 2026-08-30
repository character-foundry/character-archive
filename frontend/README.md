# Character Archive frontend

The Next.js UI is part of the Character Archive workspace. Run commands from the repository root unless you are working only on the frontend.

```bash
pnpm dev
```

The development UI is available at <http://localhost:3177> and talks to the API on port 6969. Build the production frontend with:

```bash
npm run build --prefix frontend
```

The Docker image serves the standalone Next.js build as the `web` service on port 3177. Fonts use the local system stack so production builds do not depend on a live Google Fonts request.
