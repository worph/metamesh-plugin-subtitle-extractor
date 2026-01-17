/**
 * Subtitle Extractor Plugin
 *
 * Extracts embedded subtitles from video files and saves them as text files.
 * Republishes extracted subtitles in the pipeline (similar to TMDB plugin with posters).
 *
 * ============================================================================
 * PLUGIN MOUNT ARCHITECTURE - DO NOT MODIFY WITHOUT AUTHORIZATION
 * ============================================================================
 *
 * Each plugin container has exactly 3 mounts:
 *
 *   1. /files              (READ-ONLY)  - Shared media files, read access only
 *   2. /cache              (READ-WRITE) - Plugin-specific cache folder
 *   3. /output             (READ-WRITE) - Plugin output folder for extracted subtitles
 *
 * SECURITY: Plugins must NEVER write to /files directly.
 * - Use /cache for temporary/cache data
 * - Use /output for output files (extracted subtitles)
 *
 * ============================================================================
 */

import { spawn } from 'child_process';
import { existsSync, mkdirSync, statSync, openSync, readSync, closeSync, unlinkSync } from 'fs';
import { createHash } from 'crypto';
import * as path from 'path';
import type { PluginManifest, ProcessRequest, CallbackPayload } from './types.js';
import { MetaCoreClient } from './meta-core-client.js';
import { createWebDAVClient, WebDAVClient } from './webdav-client.js';

// Initialize WebDAV client if WEBDAV_URL is set
const webdavClient = createWebDAVClient();
if (webdavClient) {
    console.log('[subtitle-extractor] Using WebDAV for file access');
} else {
    console.log('[subtitle-extractor] Using direct filesystem access');
}

// Output path for extracted subtitles
const PLUGIN_OUTPUT_PATH = '/output';

// Image-based subtitle codecs that cannot be converted to text
const UNSUPPORTED_SUBTITLE_CODECS = new Set([
    'hdmv_pgs_subtitle',
    'pgssub',
    'dvd_subtitle',
    'dvdsub',
    'dvb_subtitle',
    'dvbsub',
    'xsub',
]);

// Supported text-based subtitle codecs
const CODEC_EXTENSION_MAP: Record<string, string> = {
    'subrip': 'srt',
    'srt': 'srt',
    'ass': 'ass',
    'ssa': 'ssa',
    'webvtt': 'vtt',
    'mov_text': 'srt',
    'text': 'srt',
};

export const manifest: PluginManifest = {
    id: 'subtitle-extractor',
    name: 'Subtitle Extractor',
    version: '1.0.0',
    description: 'Extracts embedded subtitles from video files and saves them as text files',
    author: 'MetaMesh',
    dependencies: ['file-info', 'ffmpeg'],
    priority: 50,
    color: '#FF5722',
    defaultQueue: 'background',
    timeout: 300000, // 5 minutes for large files
    schema: {
        extractedSubtitles: { label: 'Extracted Subtitles', type: 'array', readonly: true },
        subtitleLanguages: { label: 'Subtitle Languages', type: 'array', readonly: true },
    },
    config: {
        forceRecompute: {
            type: 'boolean',
            label: 'Force Recompute',
            default: false,
        },
        outputFormat: {
            type: 'select',
            label: 'Output Format',
            default: 'srt',
        },
    },
};

// Configuration
let forceRecompute = false;
let outputFormat = 'srt';

export function configure(config: Record<string, unknown>): void {
    forceRecompute = config.forceRecompute === true;
    outputFormat = (config.outputFormat as string) || 'srt';
    console.log(`[subtitle-extractor] Config: forceRecompute=${forceRecompute}, outputFormat=${outputFormat}`);
}

/**
 * Compute midhash256 CID for a file (matches meta-hash algorithm)
 */
function computeMidHash256Sync(filePath: string): string {
    const SAMPLE_SIZE = 1024 * 1024; // 1MB
    const MIDHASH_VARINT = Buffer.from([0x80, 0x20]);

    const stats = statSync(filePath);
    const fileSize = stats.size;

    const sizeBuffer = Buffer.allocUnsafe(8);
    sizeBuffer.writeBigUInt64BE(BigInt(fileSize), 0);

    let sampleData: Buffer;
    if (fileSize <= SAMPLE_SIZE) {
        const fd = openSync(filePath, 'r');
        sampleData = Buffer.allocUnsafe(fileSize);
        readSync(fd, sampleData, 0, fileSize, 0);
        closeSync(fd);
    } else {
        const middleOffset = Math.floor((fileSize - SAMPLE_SIZE) / 2);
        const fd = openSync(filePath, 'r');
        sampleData = Buffer.allocUnsafe(SAMPLE_SIZE);
        readSync(fd, sampleData, 0, SAMPLE_SIZE, middleOffset);
        closeSync(fd);
    }

    const hashInput = Buffer.concat([sizeBuffer, sampleData]);
    const hashBuffer = createHash('sha256').update(hashInput).digest();

    const cidBytes = Buffer.concat([
        Buffer.from([0x01]),
        MIDHASH_VARINT,
        MIDHASH_VARINT,
        Buffer.from([0x20]),
        hashBuffer
    ]);

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

/**
 * Sanitize filename by removing invalid characters
 */
function sanitizeFilename(name: string): string {
    return name
        .replace(/[<>:"/\\|?*]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Parse subtitle streams from ffmpeg plugin metadata
 */
interface SubtitleStream {
    index: number;
    codec: string;
    language?: string;
    title?: string;
}

function parseSubtitleStreams(existingMeta: Record<string, string>): SubtitleStream[] {
    const streams: SubtitleStream[] = [];

    // ffmpeg plugin stores streams as JSON in 'streams' field
    // or as individual fields like 'subtitle_0_codec', 'subtitle_0_language', etc.
    const streamsJson = existingMeta['streams'];
    if (streamsJson) {
        try {
            const allStreams = JSON.parse(streamsJson) as Array<{
                codec_type?: string;
                codec_name?: string;
                index?: number;
                tags?: { language?: string; title?: string };
            }>;
            let subtitleIndex = 0;
            for (const stream of allStreams) {
                if (stream.codec_type === 'subtitle') {
                    streams.push({
                        index: subtitleIndex,
                        codec: stream.codec_name || 'unknown',
                        language: stream.tags?.language,
                        title: stream.tags?.title,
                    });
                    subtitleIndex++;
                }
            }
        } catch {
            // Fall through to individual field parsing
        }
    }

    // Fallback: parse individual fields
    if (streams.length === 0) {
        for (let i = 0; i < 20; i++) {
            const codec = existingMeta[`subtitle_${i}_codec`];
            if (codec) {
                streams.push({
                    index: i,
                    codec,
                    language: existingMeta[`subtitle_${i}_language`],
                    title: existingMeta[`subtitle_${i}_title`],
                });
            }
        }
    }

    return streams;
}

/**
 * Extract a subtitle track using ffmpeg
 */
async function extractSubtitle(
    inputPath: string,
    outputPath: string,
    subtitleIndex: number,
    codec: string
): Promise<boolean> {
    return new Promise((resolve) => {
        // Determine output codec based on format
        let outputCodec = 'srt';
        if (outputFormat === 'vtt') {
            outputCodec = 'webvtt';
        } else if (outputFormat === 'ass') {
            outputCodec = 'ass';
        }

        const args = [
            '-y',
            '-hide_banner',
            '-loglevel', 'error',
            '-probesize', '1M',
            '-analyzeduration', '1M',
            '-i', inputPath,
            '-map', `0:s:${subtitleIndex}`,
            '-c:s', outputCodec,
            outputPath
        ];

        console.log(`[subtitle-extractor] Running ffmpeg for subtitle ${subtitleIndex}`);

        const ffmpeg = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

        let stderr = '';
        ffmpeg.stderr?.on('data', (data) => {
            stderr += data.toString();
        });

        ffmpeg.on('close', (code) => {
            if (code === 0 && existsSync(outputPath)) {
                const size = statSync(outputPath).size;
                if (size > 10) {
                    console.log(`[subtitle-extractor] Extracted subtitle ${subtitleIndex} (${size} bytes)`);
                    resolve(true);
                } else {
                    console.log(`[subtitle-extractor] Subtitle ${subtitleIndex} extraction produced empty file`);
                    try { unlinkSync(outputPath); } catch {}
                    resolve(false);
                }
            } else {
                console.log(`[subtitle-extractor] Failed to extract subtitle ${subtitleIndex}: ${stderr.slice(0, 200)}`);
                resolve(false);
            }
        });

        ffmpeg.on('error', (err) => {
            console.log(`[subtitle-extractor] ffmpeg error: ${err.message}`);
            resolve(false);
        });

        // Timeout after 2 minutes per subtitle
        setTimeout(() => {
            ffmpeg.kill('SIGKILL');
            resolve(false);
        }, 120000);
    });
}

export async function process(
    request: ProcessRequest,
    sendCallback: (payload: CallbackPayload) => Promise<void>
): Promise<void> {
    const startTime = Date.now();
    const metaCore = new MetaCoreClient(request.metaCoreUrl);

    try {
        const { cid, filePath, existingMeta } = request;

        // Only process video files
        if (existingMeta?.fileType !== 'video') {
            await sendCallback({
                taskId: request.taskId,
                status: 'skipped',
                duration: Date.now() - startTime,
                reason: 'Not a video file',
            });
            return;
        }

        // Skip if already extracted (unless forceRecompute)
        if (existingMeta?.extractedSubtitles && !forceRecompute) {
            await sendCallback({
                taskId: request.taskId,
                status: 'skipped',
                duration: Date.now() - startTime,
                reason: 'Subtitles already extracted',
            });
            return;
        }

        // Parse subtitle streams from ffmpeg metadata
        const subtitleStreams = parseSubtitleStreams(existingMeta || {});

        if (subtitleStreams.length === 0) {
            await sendCallback({
                taskId: request.taskId,
                status: 'skipped',
                duration: Date.now() - startTime,
                reason: 'No subtitle streams found',
            });
            return;
        }

        // Filter out unsupported (image-based) codecs
        const textSubtitles = subtitleStreams.filter(s => !UNSUPPORTED_SUBTITLE_CODECS.has(s.codec));

        if (textSubtitles.length === 0) {
            console.log(`[subtitle-extractor] All ${subtitleStreams.length} subtitles are image-based, skipping`);
            await sendCallback({
                taskId: request.taskId,
                status: 'skipped',
                duration: Date.now() - startTime,
                reason: 'Only image-based subtitles (cannot convert to text)',
            });
            return;
        }

        console.log(`[subtitle-extractor] Found ${textSubtitles.length} text-based subtitle(s) in ${filePath}`);

        // Get input path (WebDAV URL or filesystem path)
        let inputPath = filePath;
        if (webdavClient) {
            inputPath = webdavClient.toWebDAVUrl(filePath);
            console.log(`[subtitle-extractor] Using WebDAV input: ${inputPath}`);
        }

        // Ensure output directory exists
        if (!existsSync(PLUGIN_OUTPUT_PATH)) {
            mkdirSync(PLUGIN_OUTPUT_PATH, { recursive: true });
        }

        // Get video title for output filename
        const title = existingMeta?.originalTitle || existingMeta?.title || existingMeta?.fileName || 'video';
        const safeTitle = sanitizeFilename(title);
        const year = existingMeta?.movieYear;
        const yearStr = year ? ` (${year})` : '';

        const extractedCids: string[] = [];
        const extractedLanguages: string[] = [];

        // Extract each subtitle
        for (const sub of textSubtitles) {
            const langCode = sub.language || 'und';
            const langSuffix = sub.language ? `.${sub.language}` : `.${sub.index}`;
            const ext = outputFormat;

            // Build output filename: Title (Year)[videoCID]_subtitle.lang.srt
            const outputFilename = `${safeTitle}${yearStr}[${cid}]_subtitle${langSuffix}.${ext}`;
            const outputPath = path.join(PLUGIN_OUTPUT_PATH, outputFilename);

            // Check if already extracted
            if (existsSync(outputPath) && !forceRecompute) {
                console.log(`[subtitle-extractor] Subtitle already exists: ${outputFilename}`);
                try {
                    const subtitleCid = computeMidHash256Sync(outputPath);
                    extractedCids.push(subtitleCid);
                    if (sub.language && !extractedLanguages.includes(sub.language)) {
                        extractedLanguages.push(sub.language);
                    }
                } catch (e) {
                    console.error(`[subtitle-extractor] Failed to compute CID: ${e}`);
                }
                continue;
            }

            // Extract subtitle
            const extracted = await extractSubtitle(inputPath, outputPath, sub.index, sub.codec);

            if (extracted) {
                try {
                    // Compute CID for the extracted subtitle file
                    const subtitleCid = computeMidHash256Sync(outputPath);
                    console.log(`[subtitle-extractor] Subtitle CID: ${subtitleCid}`);

                    extractedCids.push(subtitleCid);
                    if (sub.language && !extractedLanguages.includes(sub.language)) {
                        extractedLanguages.push(sub.language);
                    }

                    // Store subtitle CID as metadata on the video
                    await metaCore.addToSet(cid, 'extractedSubtitles', subtitleCid);

                    // Store language if available
                    if (sub.language) {
                        await metaCore.addToSet(cid, 'subtitleLanguages', sub.language);
                    }
                } catch (e) {
                    console.error(`[subtitle-extractor] Failed to process extracted subtitle: ${e}`);
                }
            }
        }

        if (extractedCids.length > 0) {
            console.log(`[subtitle-extractor] Extracted ${extractedCids.length} subtitle(s) from ${filePath}`);
        } else {
            console.log(`[subtitle-extractor] No subtitles could be extracted from ${filePath}`);
        }

        await sendCallback({
            taskId: request.taskId,
            status: 'completed',
            duration: Date.now() - startTime,
        });
    } catch (error) {
        console.error(`[subtitle-extractor] Error:`, error);
        await sendCallback({
            taskId: request.taskId,
            status: 'failed',
            duration: Date.now() - startTime,
            error: error instanceof Error ? error.message : String(error),
        });
    }
}
