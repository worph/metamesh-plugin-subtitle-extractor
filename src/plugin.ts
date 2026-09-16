/**
 * Subtitle Extractor Plugin
 *
 * Extracts a video's embedded TEXT subtitle streams into standalone files under
 * /files/plugin/subtitle-extractor/ and links them to the video so meta-watch can
 * offer them.
 *
 * ============================================================================
 * WHAT IT WRITES (METADATA_KEYS.md §8 / §9)
 * ============================================================================
 * On the video record, per extracted file `<subCid>` (midhash256 of its bytes)
 * in language `<lang3>` (ISO 639-2/B, `und` when the stream declares none):
 *   subtitles/<lang3>/<subCid>          = "true"   what meta-watch lists
 *   extractedSubtitles/<lang3>/<subCid> = "true"   provenance: came out of the container
 *   subtitleLanguages/<lang3>           = "true"   (not for `und`)
 *   languages/<lang3>                   = "true"   (not for `und`)
 * On the subtitle file's own record:
 *   videos/<videoCid>                   = "true"
 *   subtitleLanguage                    = <lang3>  (not for `und`; the `subtitle`
 *                                                   plugin's text sniff fills it)
 * Writes are one PATCH carrying only keys the record does not already hold.
 * Legacy scalar csv-sets from the old `_add` path (`extractedSubtitles`,
 * `subtitleLanguages`, `subtitles`) are deleted first; see meta-shape.ts.
 *
 * Image codecs (PGS, VobSub, DVB) are skipped: turning them into text is OCR.
 *
 * ============================================================================
 * READ COST
 * ============================================================================
 * Subtitle packets are interleaved through the whole container, so extracting
 * even one track means demuxing the file end to end — over WebDAV, one full
 * sequential read of the video. All text tracks therefore come out of ONE ffmpeg
 * pass with one output per track (one read, not N). A per-track retry happens
 * only when that pass fails outright (one broken track aborts every output).
 *
 * ============================================================================
 * FILE ACCESS - WebDAV
 * ============================================================================
 * The WebDAV endpoint is resolved per request from the meta-core that drove the
 * /process call (its /urls -> webdavUrlInternal; WEBDAV_URL overrides), so the
 * bytes land in the same core the CIDs are written to.
 *   - Read media:   GET  /webdav/watch/...
 *   - Write output: PUT  /webdav/plugin/subtitle-extractor/...
 *   - Temp:         $CACHE_PATH/temp (default /cache/temp)
 */

import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'fs';
import * as path from 'path';
import type { PluginManifest, ProcessRequest, CallbackPayload } from './types.js';
import { MetaCoreClient } from './meta-core-client.js';
import { getWebDAVClient } from './webdav-client.js';
import { toLang3 } from './langs.js';
import { flattenMeta, onlyNewKeys, legacyCsvMembers, staleLanguageLeaves } from './meta-shape.js';

const PLUGIN_OUTPUT_WEBDAV_PATH = '/files/plugin/subtitle-extractor';

function tempDir(): string {
    return path.join(globalThis.process.env.CACHE_PATH || '/cache', 'temp');
}

/** Bitmap subtitle codecs: no text to extract without OCR. */
export const IMAGE_SUBTITLE_CODECS = new Set([
    'hdmv_pgs_subtitle',
    'pgssub',
    'dvd_subtitle',
    'dvdsub',
    'dvb_subtitle',
    'dvbsub',
    'dvb_teletext',
    'xsub',
]);

type SubtitleExt = 'srt' | 'ass' | 'ssa' | 'vtt';

/** Text codecs we extract, and the file type each one naturally becomes. */
const TEXT_SUBTITLE_CODECS: Record<string, SubtitleExt> = {
    subrip: 'srt',
    srt: 'srt',
    ass: 'ass',
    ssa: 'ssa',
    webvtt: 'vtt',
    mov_text: 'srt',
    text: 'srt',
};

/** Codecs whose packets can be stream-copied into their natural file type. */
const COPYABLE_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt']);

const ENCODER_FOR_EXT: Record<SubtitleExt, string> = { srt: 'srt', vtt: 'webvtt', ass: 'ass', ssa: 'ass' };

export type OutputFormat = 'native' | 'srt' | 'vtt' | 'ass';
const OUTPUT_FORMATS = new Set<OutputFormat>(['native', 'srt', 'vtt', 'ass']);

export const manifest: PluginManifest = {
    id: 'subtitle-extractor',
    name: 'Subtitle Extractor',
    version: '1.1.0',
    description: 'Extracts embedded text subtitles from video files and links them to the video',
    author: 'MetaMesh',
    // file-info gives `fileType`; ffmpeg gives the `stream` table.
    dependencies: ['file-info', 'ffmpeg'],
    priority: 50,
    color: '#FF5722',
    // One full read of the video per run. Never the fast queue.
    defaultQueue: 'background',
    timeout: 300000,
    schema: {
        subtitles: { label: 'Subtitles', type: 'json', readonly: true, hint: 'subtitles/<lang3>/<cid>' },
        extractedSubtitles: { label: 'Extracted Subtitles', type: 'json', readonly: true, hint: 'extractedSubtitles/<lang3>/<cid>' },
        subtitleLanguages: { label: 'Subtitle Languages', type: 'json', readonly: true, hint: 'subtitleLanguages/<lang3>' },
    },
    config: {
        forceRecompute: { type: 'boolean', label: 'Force Recompute', default: false },
        outputFormat: {
            type: 'select',
            label: 'Output Format (native keeps ASS styling; srt/vtt/ass convert)',
            default: 'native',
        },
        extractionTimeoutMs: {
            type: 'number',
            label: 'Extraction timeout (ms) for the single ffmpeg pass',
            default: 270000,
        },
    },
};

let forceRecompute = false;
let outputFormat: OutputFormat = 'native';
let extractionTimeoutMs = 270000;

export function configure(config: Record<string, unknown>): void {
    forceRecompute = config.forceRecompute === true;
    const format = String(config.outputFormat ?? 'native') as OutputFormat;
    outputFormat = OUTPUT_FORMATS.has(format) ? format : 'native';
    const timeout = config.extractionTimeoutMs === null || config.extractionTimeoutMs === undefined
        ? NaN
        : Number(config.extractionTimeoutMs);
    extractionTimeoutMs = Number.isFinite(timeout) && timeout > 0 ? timeout : 270000;
    console.log(`[subtitle-extractor] Config: forceRecompute=${forceRecompute}, outputFormat=${outputFormat}, extractionTimeoutMs=${extractionTimeoutMs}`);
}

/**
 * midhash256 CID of a buffer (matches meta-hash's computeMidHash256Sync):
 * sha256(size_u64_be ‖ middle 1 MiB), wrapped as CIDv1 multibase base32.
 */
export function computeMidHash256FromBuffer(data: Buffer): string {
    const SAMPLE_SIZE = 1024 * 1024;
    const MIDHASH_VARINT = Buffer.from([0x80, 0x20]);

    const fileSize = data.length;
    const sizeBuffer = Buffer.allocUnsafe(8);
    sizeBuffer.writeBigUInt64BE(BigInt(fileSize), 0);

    let sampleData: Buffer;
    if (fileSize <= SAMPLE_SIZE) {
        sampleData = data;
    } else {
        const middleOffset = Math.floor((fileSize - SAMPLE_SIZE) / 2);
        sampleData = data.subarray(middleOffset, middleOffset + SAMPLE_SIZE);
    }

    const hashBuffer = createHash('sha256').update(Buffer.concat([sizeBuffer, sampleData])).digest();
    const cidBytes = Buffer.concat([Buffer.from([0x01]), MIDHASH_VARINT, MIDHASH_VARINT, Buffer.from([0x20]), hashBuffer]);

    const base32Chars = 'abcdefghijklmnopqrstuvwxyz234567';
    let cid = 'b';
    let bits = 0;
    let value = 0;
    for (const byte of cidBytes) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            bits -= 5;
            cid += base32Chars[(value >> bits) & 0x1f];
        }
    }
    if (bits > 0) {
        cid += base32Chars[(value << (5 - bits)) & 0x1f];
    }
    return cid;
}

/** Strip characters that are hostile to paths or to the WebDAV URL. */
export function sanitizeFilename(name: string): string {
    return name
        .replace(/[<>:"/\\|?*#%\x00-\x1f]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// ----------------------------------------------------------------------------
// Stream table
// ----------------------------------------------------------------------------

function numericKeyOrder(a: string, b: string): number {
    return Number(a) - Number(b);
}

/**
 * The ffmpeg plugin's per-stream objects, in stream order, from any of the shapes
 * a record can arrive in:
 *   - nested array of JSON strings   stream: ["{...}", "{...}"]   (meta-sort /meta today)
 *   - nested array of objects        stream: [{...}, {...}]
 *   - nested object keyed by index   stream: {"0": "{...}", "1": ...}
 *   - JSON string of an array        stream: "[...]"
 *   - flat meta-core keys            "stream/0": "{...}", "stream/10": ...  (ordered numerically)
 */
export function readStreamEntries(existingMeta: Record<string, unknown> | undefined): Record<string, unknown>[] {
    if (!existingMeta) return [];
    const raw: unknown[] = [];

    const nested = existingMeta['stream'];
    if (nested !== undefined && nested !== null && nested !== '') {
        try {
            const parsed = typeof nested === 'string' ? JSON.parse(nested) : nested;
            if (Array.isArray(parsed)) {
                raw.push(...parsed);
            } else if (parsed && typeof parsed === 'object') {
                const obj = parsed as Record<string, unknown>;
                raw.push(...Object.keys(obj).sort(numericKeyOrder).map((k) => obj[k]));
            }
        } catch {
            // fall through to the flat form
        }
    }

    if (raw.length === 0) {
        const flat = Object.keys(existingMeta)
            .filter((k) => /^stream\/\d+$/.test(k))
            .sort((a, b) => numericKeyOrder(a.slice(7), b.slice(7)));
        raw.push(...flat.map((k) => existingMeta[k]));
    }

    const entries: Record<string, unknown>[] = [];
    for (const item of raw) {
        try {
            const obj = typeof item === 'string' ? JSON.parse(item) : item;
            if (obj && typeof obj === 'object' && !Array.isArray(obj)) entries.push(obj as Record<string, unknown>);
        } catch {
            // skip an unparseable entry, keep the rest
        }
    }
    return entries;
}

export interface SubtitleStream {
    /** Position among subtitle streams (ffmpeg `0:s:<ordinal>`). */
    ordinal: number;
    /** Global ffmpeg stream index (`0:<streamIndex>`), when the record has it. */
    streamIndex?: number;
    codec: string;
    /** ISO 639-2/B, `und` when undeclared. */
    lang3: string;
    title?: string;
    forced: boolean;
}

const isTrue = (v: unknown) => v === true || v === 'true';

/** Subtitle streams of a record, from the stream table or the legacy `subtitle_{i}_*` fields. */
export function parseSubtitleStreams(existingMeta: Record<string, unknown> | undefined): SubtitleStream[] {
    const streams: SubtitleStream[] = [];
    let ordinal = 0;
    for (const entry of readStreamEntries(existingMeta)) {
        if (entry.type !== 'subtitle') continue;
        const index = entry.index === undefined || entry.index === null ? NaN : Number(entry.index);
        streams.push({
            ordinal: ordinal++,
            streamIndex: Number.isInteger(index) && index >= 0 ? index : undefined,
            codec: String(entry.codec ?? 'unknown').toLowerCase(),
            lang3: toLang3(entry.language),
            title: typeof entry.title === 'string' ? entry.title : undefined,
            forced: isTrue(entry.forced),
        });
    }

    if (streams.length === 0 && existingMeta) {
        for (let i = 0; i < 20; i++) {
            const codec = existingMeta[`subtitle_${i}_codec`];
            if (!codec) continue;
            const title = existingMeta[`subtitle_${i}_title`];
            streams.push({
                ordinal: i,
                codec: String(codec).toLowerCase(),
                lang3: toLang3(existingMeta[`subtitle_${i}_language`]),
                title: typeof title === 'string' ? title : undefined,
                forced: false,
            });
        }
    }
    return streams;
}

/** File type and ffmpeg encoder for a codec under an output format; null when not a text codec. */
export function outputFor(codec: string, format: OutputFormat = outputFormat): { ext: SubtitleExt; encoder: string } | null {
    const nativeExt = TEXT_SUBTITLE_CODECS[codec];
    if (!nativeExt) return null;
    const ext: SubtitleExt = format === 'native' ? nativeExt : format;
    const encoder = ext === nativeExt && COPYABLE_CODECS.has(codec) ? 'copy' : ENCODER_FOR_EXT[ext];
    return { ext, encoder };
}

export type TextSubtitleStream = SubtitleStream & { ext: SubtitleExt; encoder: string };

export function classifySubtitleStreams(streams: SubtitleStream[], format: OutputFormat = outputFormat): {
    text: TextSubtitleStream[];
    image: SubtitleStream[];
    unsupported: SubtitleStream[];
} {
    const text: TextSubtitleStream[] = [];
    const image: SubtitleStream[] = [];
    const unsupported: SubtitleStream[] = [];
    for (const s of streams) {
        if (IMAGE_SUBTITLE_CODECS.has(s.codec)) {
            image.push(s);
            continue;
        }
        const out = outputFor(s.codec, format);
        if (out) text.push({ ...s, ...out });
        else unsupported.push(s);
    }
    return { text, image, unsupported };
}

const scalar = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');

/**
 * `Title (Year)[videoCid]_subtitle.s<streamIndex>.<lang3>[.forced].<ext>`.
 * The stream index keeps two tracks in one language (full + signs, es-ES +
 * es-419) from overwriting each other; the trailing `<lang3>` is what the
 * `subtitle` plugin reads back as the file's language.
 */
export function subtitleFilename(existingMeta: Record<string, unknown>, videoCid: string, stream: SubtitleStream, ext: string): string {
    const fileName = scalar(existingMeta.fileName);
    const rawTitle = scalar(existingMeta.originalTitle) || scalar(existingMeta.title) || (fileName ? path.parse(fileName).name : '');
    const safeTitle = sanitizeFilename(rawTitle).slice(0, 100) || 'video';
    const year = scalar(existingMeta.movieYear);
    const track = stream.streamIndex !== undefined ? `s${stream.streamIndex}` : `t${stream.ordinal}`;
    return `${safeTitle}${year ? ` (${year})` : ''}[${videoCid}]_subtitle.${track}.${stream.lang3}${stream.forced ? '.forced' : ''}.${ext}`;
}

// ----------------------------------------------------------------------------
// Extraction
// ----------------------------------------------------------------------------

export interface ExtractJob {
    stream: TextSubtitleStream;
    tempFile: string;
}

/** ONE ffmpeg invocation writing every job's track to its own output (one read of the input). */
export function buildExtractionArgs(input: string, jobs: ExtractJob[]): string[] {
    const args = ['-y', '-hide_banner', '-nostdin', '-loglevel', 'error', '-i', input];
    for (const job of jobs) {
        const map = job.stream.streamIndex !== undefined ? `0:${job.stream.streamIndex}` : `0:s:${job.stream.ordinal}`;
        args.push('-map', map, '-c:s', job.stream.encoder, job.tempFile);
    }
    return args;
}

/** Number of ffmpeg processes started — each one is a full read of the input. */
export const extractionStats = { ffmpegPasses: 0 };

function runFfmpeg(args: string[], timeoutMs: number): Promise<{ code: number | null; stderr: string; timedOut: boolean }> {
    extractionStats.ffmpegPasses++;
    return new Promise((resolve) => {
        const ffmpeg = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        let timedOut = false;
        let settled = false;
        const finish = (code: number | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ code, stderr, timedOut });
        };
        const timer = setTimeout(() => {
            timedOut = true;
            ffmpeg.kill('SIGKILL');
        }, timeoutMs);
        ffmpeg.stderr?.on('data', (d) => { if (stderr.length < 4000) stderr += d.toString(); });
        ffmpeg.on('close', (code) => finish(code));
        ffmpeg.on('error', (err) => { stderr += err.message; finish(-1); });
    });
}

/** Does an extracted file carry at least one cue (an ASS header alone does not count)? */
export function hasCues(data: Buffer, ext: string): boolean {
    const text = data.toString('utf8');
    if (ext === 'ass' || ext === 'ssa') return /^Dialogue:/m.test(text);
    return text.includes('-->');
}

function takeOutput(job: ExtractJob): Buffer | null {
    if (!existsSync(job.tempFile)) return null;
    const data = readFileSync(job.tempFile);
    try { unlinkSync(job.tempFile); } catch { /* ignore */ }
    return hasCues(data, job.stream.ext) ? data : null;
}

function discard(job: ExtractJob): void {
    try { if (existsSync(job.tempFile)) unlinkSync(job.tempFile); } catch { /* ignore */ }
}

export interface ExtractResult {
    outputs: Array<{ job: ExtractJob; data: Buffer | null }>;
    passes: number;
    timedOut: boolean;
    error?: string;
}

export async function extractTracks(input: string, jobs: ExtractJob[], timeoutMs: number = extractionTimeoutMs): Promise<ExtractResult> {
    const first = await runFfmpeg(buildExtractionArgs(input, jobs), timeoutMs);
    if (first.code === 0) {
        return { outputs: jobs.map((job) => ({ job, data: takeOutput(job) })), passes: 1, timedOut: false };
    }
    jobs.forEach(discard);
    const error = first.timedOut ? `ffmpeg timed out after ${timeoutMs} ms` : first.stderr.slice(0, 300) || `ffmpeg exited ${first.code}`;
    if (first.timedOut || jobs.length === 1) {
        return { outputs: jobs.map((job) => ({ job, data: null })), passes: 1, timedOut: first.timedOut, error };
    }

    // One broken track aborts every output of the shared pass. Salvage the rest
    // one track at a time — at the price of one more full read per track.
    console.warn(`[subtitle-extractor] single-pass extraction failed (${error}); retrying ${jobs.length} track(s) one by one`);
    const outputs: ExtractResult['outputs'] = [];
    let passes = 1;
    let timedOut = false;
    for (const job of jobs) {
        if (timedOut) {
            outputs.push({ job, data: null });
            continue;
        }
        const r = await runFfmpeg(buildExtractionArgs(input, [job]), timeoutMs);
        passes++;
        timedOut = r.timedOut;
        if (r.code === 0) {
            outputs.push({ job, data: takeOutput(job) });
        } else {
            discard(job);
            outputs.push({ job, data: null });
        }
    }
    return { outputs, passes, timedOut, error };
}

// ----------------------------------------------------------------------------
// Record keys
// ----------------------------------------------------------------------------

export interface ProducedSubtitle {
    subCid: string;
    lang3: string;
}

/** True when this record already carries the `extractedSubtitles` key-set (nested or flat). */
export function hasExtractedKeySet(existingMeta: Record<string, unknown> | undefined): boolean {
    if (!existingMeta) return false;
    const v = existingMeta['extractedSubtitles'];
    if (v && typeof v === 'object') return true;
    return Object.keys(existingMeta).some((k) => k.startsWith('extractedSubtitles/'));
}

/** Keys on the video record for a set of extracted files (METADATA_KEYS.md §8, §9). */
export function videoSubtitleKeys(produced: ProducedSubtitle[]): Record<string, string> {
    const keys: Record<string, string> = {};
    for (const { subCid, lang3 } of produced) {
        keys[`subtitles/${lang3}/${subCid}`] = 'true';
        keys[`extractedSubtitles/${lang3}/${subCid}`] = 'true';
        if (lang3 !== 'und') {
            keys[`subtitleLanguages/${lang3}`] = 'true';
            keys[`languages/${lang3}`] = 'true';
        }
    }
    return keys;
}

/**
 * Keys on the subtitle file's own record.
 *
 * `source/extract` (METADATA_KEYS.md §5) says the bytes came out of a video
 * container. The video record already implies it through `extractedSubtitles/`,
 * but that is the wrong side of the relation to store it on: a subtitle fetched
 * over the swarm by CID arrives WITHOUT its video record, so a reader holding
 * only the file would have no way to tell an extracted track from a sidecar
 * someone dropped next to the video.
 */
export function subtitleRecordKeys(videoCid: string, lang3: string): Record<string, string> {
    const keys: Record<string, string> = {
        [`videos/${videoCid}`]: 'true',
        'source/extract': 'true',
    };
    if (lang3 !== 'und') keys.subtitleLanguage = lang3;
    return keys;
}

/**
 * Legacy scalar csv-sets the old version of this plugin wrote (and the old
 * `subtitle` plugin's `subtitles`), turned into deletes plus the key-set leaves
 * that preserve what they said. `extractedSubtitles` members are dropped: this
 * run re-derives them with their language.
 */
export function legacySubtitleMigration(existingMeta: Record<string, unknown> | undefined): { deletes: string[]; sets: Record<string, string> } {
    const deletes: string[] = [];
    const sets: Record<string, string> = {};

    if (legacyCsvMembers(existingMeta, 'extractedSubtitles')) deletes.push('extractedSubtitles');

    const langs = legacyCsvMembers(existingMeta, 'subtitleLanguages');
    if (langs) {
        deletes.push('subtitleLanguages');
        for (const l of langs.map(toLang3)) {
            if (l === 'und') continue;
            sets[`subtitleLanguages/${l}`] = 'true';
            // …and the union (§9 rule #7). The live write path below already
            // does this; the migration path did not, so records that only ever
            // went through it were left half-written.
            sets[`languages/${l}`] = 'true';
        }
    }

    const subs = legacyCsvMembers(existingMeta, 'subtitles');
    if (subs) {
        deletes.push('subtitles');
        for (const cid of subs) sets[`subtitles/und/${cid}`] = 'true';
    }
    return { deletes, sets };
}

/** Write the links for `produced` onto the video and each subtitle record. False on any failed write. */
export async function linkSubtitles(
    metaCore: MetaCoreClient,
    videoCid: string,
    existingMeta: Record<string, unknown>,
    produced: ProducedSubtitle[],
): Promise<boolean> {
    const { deletes, sets } = legacySubtitleMigration(existingMeta);
    const flat = flattenMeta(existingMeta);
    for (const key of deletes) delete flat[key];

    for (const { subCid, lang3 } of produced) {
        deletes.push(
            ...staleLanguageLeaves(flat, 'subtitles', subCid, lang3),
            ...staleLanguageLeaves(flat, 'extractedSubtitles', subCid, lang3),
        );
    }
    for (const key of deletes) {
        if (!(await metaCore.deleteProperty(videoCid, key))) return false;
        delete flat[key];
    }

    const fresh = onlyNewKeys(flat, { ...sets, ...videoSubtitleKeys(produced) });
    if (Object.keys(fresh).length > 0 && !(await metaCore.mergeMetadata(videoCid, fresh))) return false;

    for (const { subCid, lang3 } of produced) {
        const current = await metaCore.getMetadata(subCid);
        const wanted = onlyNewKeys(flattenMeta(current), subtitleRecordKeys(videoCid, lang3));
        if (Object.keys(wanted).length > 0 && !(await metaCore.mergeMetadata(subCid, wanted))) return false;
    }
    return true;
}

// ----------------------------------------------------------------------------
// Task
// ----------------------------------------------------------------------------

export async function process(
    request: ProcessRequest,
    sendCallback: (payload: CallbackPayload) => Promise<void>
): Promise<void> {
    const startTime = Date.now();
    const { taskId, cid, filePath } = request;
    const existingMeta = (request.existingMeta ?? {}) as Record<string, unknown>;
    const metaCore = new MetaCoreClient(request.metaCoreUrl);

    const finish = (status: CallbackPayload['status'], extra: { reason?: string; error?: string } = {}) =>
        sendCallback({ taskId, status, duration: Date.now() - startTime, ...extra });
    const skip = (reason: string, quiet = false) => {
        if (!quiet) console.log(`[subtitle-extractor] ${filePath}: skipped — ${reason}`);
        return finish('skipped', { reason });
    };
    const fail = (error: string) => {
        console.error(`[subtitle-extractor] ${filePath}: failed — ${error}`);
        return finish('failed', { error });
    };

    try {
        if (existingMeta.fileType !== 'video') {
            await skip('Not a video file', true);
            return;
        }
        if (!forceRecompute && hasExtractedKeySet(existingMeta)) {
            await skip('Subtitles already extracted', true);
            return;
        }

        const streams = parseSubtitleStreams(existingMeta);
        if (streams.length === 0) {
            await skip('No subtitle streams found', true);
            return;
        }

        const { text, image, unsupported } = classifySubtitleStreams(streams);
        if (image.length > 0) {
            console.log(`[subtitle-extractor] ${filePath}: skipping ${image.length} image-based subtitle stream(s) (${[...new Set(image.map((s) => s.codec))].join(', ')})`);
        }
        if (unsupported.length > 0) {
            console.log(`[subtitle-extractor] ${filePath}: skipping ${unsupported.length} unsupported subtitle stream(s) (${[...new Set(unsupported.map((s) => s.codec))].join(', ')})`);
        }
        if (text.length === 0) {
            await skip(image.length > 0 ? 'Only image-based subtitles (cannot convert to text)' : 'No supported text subtitle streams');
            return;
        }

        const webdav = await getWebDAVClient(request.metaCoreUrl);
        if (!webdav) {
            await fail('No WebDAV endpoint available');
            return;
        }

        const produced: ProducedSubtitle[] = [];
        const pending: Array<ExtractJob & { webdavPath: string }> = [];
        const tmp = tempDir();
        mkdirSync(tmp, { recursive: true });
        const safeTask = taskId.replace(/[^A-Za-z0-9_-]/g, '_');

        for (const stream of text) {
            const webdavPath = `${PLUGIN_OUTPUT_WEBDAV_PATH}/${subtitleFilename(existingMeta, cid, stream, stream.ext)}`;
            if (!forceRecompute && await webdav.exists(webdavPath)) {
                try {
                    // A previous run already wrote this track — reuse it, no read of the video.
                    produced.push({ subCid: computeMidHash256FromBuffer(await webdav.readFile(webdavPath)), lang3: stream.lang3 });
                    continue;
                } catch (e) {
                    console.warn(`[subtitle-extractor] could not reuse ${webdavPath}: ${e instanceof Error ? e.message : String(e)}`);
                }
            }
            pending.push({ stream, webdavPath, tempFile: path.join(tmp, `${safeTask}-${stream.ordinal}.${stream.ext}`) });
        }

        let extraction: ExtractResult | undefined;
        if (pending.length > 0) {
            console.log(`[subtitle-extractor] ${filePath}: extracting ${pending.length} text track(s) in one pass`);
            extraction = await extractTracks(webdav.toWebDAVUrl(filePath), pending);
            for (const { job, data } of extraction.outputs) {
                if (!data) continue;
                const target = (job as ExtractJob & { webdavPath: string }).webdavPath;
                await webdav.writeFile(target, data);
                produced.push({ subCid: computeMidHash256FromBuffer(data), lang3: job.stream.lang3 });
            }
        }

        if (produced.length === 0) {
            if (extraction?.error) {
                await fail(extraction.error);
            } else {
                await skip('No text subtitle track produced any cues');
            }
            return;
        }

        if (!(await linkSubtitles(metaCore, cid, existingMeta, produced))) {
            await fail('meta-core write failed');
            return;
        }

        console.log(
            `[subtitle-extractor] ${filePath}: linked ${produced.length} subtitle(s) ` +
            `[${produced.map((p) => p.lang3).join(', ')}] in ${extraction?.passes ?? 0} ffmpeg pass(es)`
        );
        await finish('completed');
    } catch (error) {
        await fail(error instanceof Error ? error.message : String(error));
    }
}
