# Sermon Publisher

Desktop app to publish sermon media and content to a Hugo site (Cloudflare Pages) and optionally YouTube.

Built with **Tauri 2** (Rust backend) and **React + TypeScript + Vite** (frontend).

![Publish form](docs/screenshots/publish-form.png)

![GitHub settings panel](docs/screenshots/settings-panel.png)

## Download

Grab the latest installer for your platform from the
[**Releases**](../../releases) page:

| Platform | Artifact |
|---|---|
| Windows (x64) | `.msi` or `.exe` installer |
| macOS (Apple Silicon) | `.dmg` |
| macOS (Intel) | `.dmg` |
| Linux (x64) | `.deb` or `.AppImage` |

> **macOS note:** You may need to right-click → Open the first time to bypass
> Gatekeeper.

### Bundled dependencies

The release installers include:

- **ffmpeg** — used for audio extraction, silence detection, and video
  processing. A platform-specific static build is bundled as a Tauri sidecar so
  you do not need to install ffmpeg separately.

## Features

- **Non-technical publish form** — fill in title, speaker, date, series,
  scripture references, and summary without touching any config files.
- **Publish plan generation** — validates metadata and produces a canonical slug,
  Hugo markdown, output paths, and a full pipeline step plan:
  1. Extract audio from source video
  2. Run Jivetalking on extracted audio
  3. Trim leading silence
  4. Create website audio file
  5. Generate thumbnail image
  6. Create cleaned YouTube video
  7. Generate sermon markdown
  8. Write files to GitHub via API
  9. *(optional)* Upload cleaned video to YouTube and patch markdown with
     `youtubeID`
- **GitHub integration** — the settings panel stores repository details (owner,
  repo, branch, PAT) in localStorage. A `list_series` command fetches the
  `content/sermons` directory from the configured repo, parses front-matter, and
  returns a deduplicated series list sorted by most-recent date.
- **Silence detection** — `detect_leading_silence` runs
  `ffmpeg -af silencedetect` against the source video and returns the end-time
  of the first silent region, letting the app auto-fill the leading-silence
  value.

## Development

### Prerequisites

- [Node.js](https://nodejs.org/) (LTS)
- [Rust](https://www.rust-lang.org/tools/install) (stable)
- Tauri v2 system dependencies — see
  [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)

### Run locally

```bash
cd desktop
npm install
npm run tauri dev
```

### Build a release locally

```bash
cd desktop
npm run tauri build
```

Installers are written to `desktop/src-tauri/target/release/bundle/`.

## Creating a release

Releases are built automatically by the **Release** GitHub Actions workflow.

1. Tag a commit with a version tag:
   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```
2. The workflow builds the Tauri app on Windows, macOS (Intel + Apple Silicon),
   and Linux, downloads a static ffmpeg for each platform, and uploads the
   installers to a **draft** GitHub release.
3. Review the draft release on the Releases page and publish it when ready.

You can also trigger the workflow manually from the **Actions** tab using
`workflow_dispatch`.

## Project layout

```
desktop/
├── src/             # React + TypeScript frontend
├── src-tauri/       # Rust backend (Tauri commands)
│   ├── binaries/    # Sidecar binaries (ffmpeg) — populated by CI
│   └── src/
│       ├── lib.rs   # Tauri commands & helpers
│       └── main.rs  # App entry point
├── package.json
└── vite.config.ts
```

## License

See [LICENSE](LICENSE).
