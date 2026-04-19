# SermonPublisher

Desktop app to publish sermon media and content to a Hugo site (Cloudflare Pages) and optionally YouTube.

## App location

The Windows desktop application scaffold is in:

- `/home/runner/work/SermonPublisher/SermonPublisher/desktop`

It uses:

- Tauri (Rust backend commands)
- React + TypeScript + Vite frontend

## Current implementation

The app currently provides a non-technical publish form and a backend `build_publish_plan` command that validates sermon metadata and generates:

- canonical slug
- Hugo markdown output path
- website audio output path
- thumbnail output path
- cleaned YouTube video output path
- markdown template content
- full pipeline step plan (extract audio → Jivetalking → silence handling → output generation → GitHub write → optional YouTube patch)

## Run locally

```bash
cd desktop
npm install
npm run dev
```
