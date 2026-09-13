# MetaMesh Plugin: Subtitle Extractor

Extracts a video's embedded **text** subtitle streams into standalone files and links them to the video so clients (meta-watch) can offer them.

## What it writes (METADATA_KEYS.md §8 / §9)

On the **video record**, per extracted file `<subCid>` (midhash256 of its bytes) in `<lang3>` (ISO 639-2/B — `fre`, `ger`, `chi` — normalised the same way meta-watch does; `und` when the stream declares no language):

| Key | Value |
|-----|-------|
| `subtitles/<lang3>/<subCid>` | `"true"` — the leaf meta-watch lists |
| `extractedSubtitles/<lang3>/<subCid>` | `"true"` — provenance: came out of the container |
| `subtitleLanguages/<lang3>` | `"true"` (not for `und`) |
| `languages/<lang3>` | `"true"` (not for `und`) |

On the **subtitle file's own record**: `videos/<videoCid> = "true"` and `subtitleLanguage = <lang3>` (not for `und`).

Writes are a single `PATCH /meta/{cid}` carrying only keys the record does not already hold; a failed write fails the task. Legacy comma-joined scalars written by the old version (`extractedSubtitles`, `subtitleLanguages`, `subtitles`) are deleted first — a scalar next to `field/...` keys breaks meta-sort's nested document.

## Behaviour

- Reads the ffmpeg plugin's stream table in any shape: meta-sort's nested `stream` array (JSON strings or objects), an index-keyed object, a JSON string, or meta-core's flat `stream/{n}`.
- **One ffmpeg pass** extracts every text track (one `-map`/output per track). Subtitle packets are interleaved through the whole container, so that pass is still one full read of the video over WebDAV — but one, not one per track. If the shared pass fails, tracks are retried one by one.
- Image codecs (PGS, VobSub, DVB, teletext, XSUB) are skipped explicitly; other unknown codecs are skipped and logged.
- Skips a video that already carries the `extractedSubtitles` key-set (unless `forceRecompute`), and reuses an output file that already exists instead of re-reading the video.
- Output: `/files/plugin/subtitle-extractor/<Title> (<Year>)[<videoCid>]_subtitle.s<streamIndex>.<lang3>[.forced].<ext>` — the stream index keeps two tracks in one language apart.
- WebDAV endpoint resolved per request from the driving meta-core (`/urls` → `webdavUrlInternal`); `WEBDAV_URL` overrides.

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `forceRecompute` | boolean | `false` | Re-extract even if already processed |
| `outputFormat` | select | `native` | `native` keeps ASS as ASS (stream copy) and SubRip/WebVTT as-is, converts mov_text to SRT; `srt`, `vtt`, `ass` convert everything |
| `extractionTimeoutMs` | number | `270000` | Timeout of the single ffmpeg pass |

## Supported codecs

Text (extracted): `subrip`/`srt`, `ass`, `ssa`, `webvtt`, `mov_text`, `text`.
Image (skipped): `hdmv_pgs_subtitle`, `dvd_subtitle`, `dvb_subtitle`, `dvb_teletext`, `xsub`.

## Tests

```bash
pnpm install && pnpm test        # locally (ffmpeg tests need ffmpeg + ./test/fixtures/generate-test-fixtures.sh)
./test.sh                        # in Docker, fixtures generated in the image
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PORT` | HTTP server port (default: 8080) |
| `WEBDAV_URL` | Optional WebDAV override (otherwise resolved from the meta-core `/urls`) |
| `CACHE_PATH` | Temp root (default `/cache`; files go to `$CACHE_PATH/temp`) |

## License

MIT
