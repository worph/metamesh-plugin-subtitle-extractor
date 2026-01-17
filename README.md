# MetaMesh Plugin: Subtitle Extractor

Extracts embedded subtitles from video files and saves them as standalone text files. The extracted subtitles are republished in the MetaMesh pipeline and linked to the original video via CID.

## Features

- **Automatic extraction**: Extracts all text-based subtitle tracks from video files
- **Multiple formats**: Supports SRT, ASS, SSA, WebVTT, and MOV_TEXT codecs
- **Smart filtering**: Automatically skips image-based subtitles (PGS, DVD, DVB) that cannot be converted to text
- **Language preservation**: Maintains language metadata from video streams
- **Pipeline integration**: Extracted files are saved to `/output` and automatically picked up by meta-sort
- **CID linking**: Stores subtitle CIDs as metadata on the source video

## Dependencies

This plugin requires the following plugins to run first:
- `file-info` - Determines file type
- `ffmpeg` - Provides subtitle stream information

## Installation

### Build from source

```bash
cd packages/plugins/metamesh-plugin-subtitle-extractor
npm install
npm run build
```

### Build Docker image

```bash
docker build -t metamesh-plugin-subtitle-extractor:main .
```

### Configure in plugins.yml

Add to `dev/plugins.yml`:

```yaml
plugins:
  subtitle-extractor:
    enabled: true
    image: metamesh-plugin-subtitle-extractor:main
    instances: 1
    resources:
      memory: 256m
      cpus: 0.5
```

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `forceRecompute` | boolean | `false` | Re-extract subtitles even if already processed |
| `outputFormat` | select | `srt` | Output format: `srt`, `vtt`, or `ass` |

## Output

### Extracted Files

Subtitle files are saved to `/output` with the naming pattern:

```
{Title} ({Year})[{VideoCID}]_subtitle.{lang}.{ext}
```

Example: `Sintel (2010)[bafk...abc]_subtitle.eng.srt`

### Metadata

The plugin stores the following metadata on the source video:

| Field | Type | Description |
|-------|------|-------------|
| `extractedSubtitles` | array | CIDs of extracted subtitle files |
| `subtitleLanguages` | array | Language codes of extracted subtitles |

## Supported Codecs

### Text-based (supported)
- `subrip` / `srt` - SubRip
- `ass` - Advanced SubStation Alpha
- `ssa` - SubStation Alpha
- `webvtt` - WebVTT
- `mov_text` - QuickTime text

### Image-based (skipped)
- `hdmv_pgs_subtitle` - Blu-ray PGS
- `dvd_subtitle` - DVD VOB
- `dvb_subtitle` - DVB
- `xsub` - DivX XSUB

## Architecture

```
Video File (MKV/MP4/AVI)
        │
        ▼
┌───────────────────┐
│ ffmpeg plugin     │  ← Provides stream info
└───────────────────┘
        │
        ▼
┌───────────────────┐
│ subtitle-extractor│
│                   │
│  1. Parse streams │
│  2. Filter codecs │
│  3. Extract via   │
│     ffmpeg        │
│  4. Save to       │
│     /output       │
│  5. Compute CID   │
│  6. Store in      │
│     Redis         │
└───────────────────┘
        │
        ▼
┌───────────────────┐
│ /output folder    │  ← Watched by meta-sort
│ *.srt files       │
└───────────────────┘
        │
        ▼
┌───────────────────┐
│ meta-sort         │  ← Processes extracted files
│ file watcher      │     like any other media
└───────────────────┘
```

## Container Mounts

| Mount | Access | Purpose |
|-------|--------|---------|
| `/files` | READ-ONLY | Source video files |
| `/cache` | READ-WRITE | Plugin cache |
| `/output` | READ-WRITE | Extracted subtitle output |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PORT` | HTTP server port (default: 8080) |
| `WEBDAV_URL` | WebDAV base URL for file access |

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/manifest` | GET | Plugin manifest |
| `/configure` | POST | Update configuration |
| `/process` | POST | Process a video file |

## License

MIT
