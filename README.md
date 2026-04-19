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
- markdown template content (supports multiple scripture references)
- full pipeline step plan (extract audio → Jivetalking → silence handling → output generation → GitHub write → optional YouTube patch)

### GitHub integration

The settings panel stores GitHub repository details (owner, repo, branch, PAT) in
localStorage and passes them through to the publish plan. A `list_series` Tauri
command fetches the `content/sermons` directory from the configured repo, reads
recent sermon front-matter, and returns a deduplicated list of series sorted by
most-recent date so the user can pick one or create a new series.

### Silence detection

The `detect_leading_silence` command runs `ffmpeg -af silencedetect` against the
source video and returns the end-time of the first silent region, allowing the
app to fill in the leading-silence value automatically.

## Run locally

```bash
cd desktop
npm install
npm run dev
```
