# Commands for running the `web` app

React 19 + TypeScript + Vite 8. Run every command from this folder:

```bash
cd /Users/tongcai/Desktop/T/I/Interview/web
```

## Setup (first time, or after `package.json` changes)

```bash
npm install          # install dependencies
npm ci               # clean install that follows package-lock.json exactly
```

## Running the full app (frontend + backend)

The frontend (`web/`) and the API (`../server/`) are separate projects. Run each one in its own terminal:

```bash
# Terminal 1: API (Express + SQLite) → http://localhost:4000
cd /Users/tongcai/Desktop/T/I/Interview/server
npm install        # first time only
npm run dev        # restarts on file changes

# Terminal 2: frontend → http://localhost:5173 (sends /api requests to :4000)
cd /Users/tongcai/Desktop/T/I/Interview/web
npm run dev
```

Log in as `alice@dexmate.ai` (or `bob@` / `carol@`) with password `demo`.
To get the MFA code, run `npm run totp` in `server/`.

Other server commands: `npm start` (no auto-restart), `npm test`, `npm run typecheck`,
`npm run reset` (deletes the SQLite DB; it gets re-seeded on the next start).

## Development

```bash
npm run dev                  # start the Vite dev server with hot reload → http://localhost:5173
npm run dev -- --open        # start it and open the browser
npm run dev -- --port 3000   # use a different port
npm run dev -- --host        # make it reachable from other devices on your network
```

Press `Ctrl+C` to stop the server.

## Production build

```bash
npm run build                # type-check (tsc -b), then build into dist/
npm run preview              # serve the built dist/ locally → http://localhost:4173
npm run preview -- --open    # serve it and open the browser
```

## Code quality

```bash
npm run lint                 # lint with oxlint
npx tsc -b                   # type-check only, no build
```

## Troubleshooting

```bash
rm -rf node_modules package-lock.json && npm install   # full reinstall of dependencies
rm -rf dist                                            # delete build output
lsof -ti :5173 | xargs kill                            # free port 5173 if it's already in use
```
