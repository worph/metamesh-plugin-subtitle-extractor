/**
 * Subtitle Extractor Plugin Tests
 *
 * Pure helpers run anywhere; extraction needs ffmpeg and the generated fixtures
 * (./test/fixtures/generate-test-fixtures.sh, run by ./test.sh).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
    manifest,
    configure,
    process as processFile,
    computeMidHash256FromBuffer,
    sanitizeFilename,
    readStreamEntries,
    parseSubtitleStreams,
    classifySubtitleStreams,
    outputFor,
    subtitleFilename,
    buildExtractionArgs,
    extractTracks,
    extractionStats,
    hasCues,
    hasExtractedKeySet,
    videoSubtitleKeys,
    subtitleRecordKeys,
    legacySubtitleMigration,
    linkSubtitles,
    type ExtractJob,
    type TextSubtitleStream,
} from '../src/plugin.js';
import { toLang3, languageToken } from '../src/langs.js';
import { flattenMeta, onlyNewKeys } from '../src/meta-shape.js';
import { MetaCoreClient } from '../src/meta-core-client.js';
import type { CallbackPayload } from '../src/types.js';
import { startFakeCore, writesTo, type FakeCore } from './fake-core.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures');
const TEMP = '/tmp/subtitle-extractor-test';

const fixture = (name: string) => path.join(FIXTURES, name);

function hasFfmpeg(): boolean {
    try {
        execSync('ffmpeg -version', { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}
const ffmpegReady = hasFfmpeg() && existsSync(fixture('with-subs.mkv')) && existsSync(fixture('mov-text.mp4'));

/** The nested `stream` array exactly as meta-sort's /meta serves it (JSON strings). */
function nestedStreamsFor(file: string): string[] {
    const probe = JSON.parse(
        execSync(`ffprobe -v quiet -print_format json -show_streams "${file}"`, { encoding: 'utf-8' })
    ) as { streams: Array<Record<string, any>> };
    return probe.streams.map((s) => {
        const entry: Record<string, unknown> = {
            type: s.codec_type,
            codec: s.codec_name,
            index: s.index,
            duration: 'N/A',
            forced: s.disposition?.forced === 1,
            default: s.disposition?.default === 1,
        };
        if (s.tags?.language) entry.language = s.tags.language;
        if (s.tags?.title) entry.title = s.tags.title;
        return JSON.stringify(entry);
    });
}

const SUB_ENG = { type: 'subtitle', codec: 'ass', index: 3, language: 'eng', title: 'English (Full)', forced: false };
const SUB_ENG_SIGNS = { type: 'subtitle', codec: 'ass', index: 4, language: 'eng', title: 'Signs', forced: true };
const SUB_FRE = { type: 'subtitle', codec: 'subrip', index: 10, language: 'fre' };
const VIDEO = { type: 'video', codec: 'av1', index: 0 };

beforeEach(() => configure({}));

describe('manifest', () => {
    it('declares dependencies, queue and the keys it writes', () => {
        expect(manifest.id).toBe('subtitle-extractor');
        expect(manifest.dependencies).toEqual(['file-info', 'ffmpeg']);
        expect(manifest.defaultQueue).toBe('background');
        expect(Object.keys(manifest.schema ?? {})).toEqual(['subtitles', 'extractedSubtitles', 'subtitleLanguages']);
    });
});

describe('computeMidHash256FromBuffer', () => {
    it('matches meta-hash for a known buffer', () => {
        expect(computeMidHash256FromBuffer(Buffer.from('metamesh-still-extractor-cid-vector')))
            .toBe('bagacbabaecybg7wcyxl7su3dvjleuwgwil5tgeoybrwc35jasqtywb6bnjzk4');
    });
});

describe('language normalisation (ISO 639-2/B, `und` when unknown)', () => {
    it('folds 639-1, 639-2/T and BCP-47 onto 639-2/B', () => {
        expect(toLang3('fr')).toBe('fre');
        expect(toLang3('fra')).toBe('fre');
        expect(toLang3('fre')).toBe('fre');
        expect(toLang3('deu')).toBe('ger');
        expect(toLang3('zho')).toBe('chi');
        expect(toLang3('pt-BR')).toBe('por');
        expect(toLang3('en')).toBe('eng');
        expect(toLang3('ENG')).toBe('eng');
        expect(toLang3('English')).toBe('eng');
    });

    it('maps every "no language" spelling, and junk, to und', () => {
        for (const v of [undefined, null, '', 'und', 'zxx', 'mis', 'xx', '12', 'toolong']) {
            expect(toLang3(v)).toBe('und');
        }
    });

    it('passes an unlisted but well-formed 3-letter code through', () => {
        expect(toLang3('tlh')).toBe('tlh');
    });

    it('is strict about filename tokens', () => {
        expect(languageToken('fr')).toBe('fre');
        expect(languageToken('S01')).toBeNull();
        expect(languageToken('x264')).toBeNull();
        expect(languageToken('Extended')).toBeNull();
    });
});

describe('readStreamEntries — every payload shape', () => {
    const expectOrder = (meta: Record<string, unknown>) =>
        expect(readStreamEntries(meta).map((s) => s.index)).toEqual([0, 3, 10]);

    it('nested array of JSON strings (meta-sort /meta)', () => {
        expectOrder({ stream: [VIDEO, SUB_ENG, SUB_FRE].map((s) => JSON.stringify(s)) });
    });

    it('nested array of objects', () => {
        expectOrder({ stream: [VIDEO, SUB_ENG, SUB_FRE] });
    });

    it('nested object keyed by index, ordered numerically', () => {
        expectOrder({ stream: { '10': JSON.stringify(SUB_FRE), '0': JSON.stringify(VIDEO), '2': JSON.stringify(SUB_ENG) } });
    });

    it('a JSON string of the array', () => {
        expectOrder({ stream: JSON.stringify([VIDEO, SUB_ENG, SUB_FRE].map((s) => JSON.stringify(s))) });
    });

    it('flat meta-core `stream/{n}` keys, stream/10 after stream/2', () => {
        expectOrder({
            'stream/10': JSON.stringify(SUB_FRE),
            'stream/2': JSON.stringify(SUB_ENG),
            'stream/0': JSON.stringify(VIDEO),
        });
    });

    it('skips an unparseable entry and keeps the rest', () => {
        expect(readStreamEntries({ stream: ['not json', JSON.stringify(SUB_FRE)] }).length).toBe(1);
        expect(readStreamEntries(undefined)).toEqual([]);
    });
});

describe('parseSubtitleStreams', () => {
    it('keeps the global index, per-type ordinal, lang3 and forced flag', () => {
        const streams = parseSubtitleStreams({ stream: [VIDEO, SUB_ENG, SUB_ENG_SIGNS, { ...SUB_FRE, language: 'fra' }] });
        expect(streams.map((s) => [s.ordinal, s.streamIndex, s.lang3, s.forced])).toEqual([
            [0, 3, 'eng', false],
            [1, 4, 'eng', true],
            [2, 10, 'fre', false],
        ]);
    });

    it('uses und when a stream declares no language', () => {
        expect(parseSubtitleStreams({ 'stream/0': JSON.stringify({ type: 'subtitle', codec: 'subrip', index: 0 }) })[0].lang3).toBe('und');
    });

    it('falls back to the legacy subtitle_{i}_* fields', () => {
        const streams = parseSubtitleStreams({ subtitle_0_codec: 'subrip', subtitle_0_language: 'ger' });
        expect(streams).toHaveLength(1);
        expect(streams[0].lang3).toBe('ger');
        expect(streams[0].streamIndex).toBeUndefined();
    });
});

describe('classifySubtitleStreams / outputFor', () => {
    const s = (codec: string, i: number) => ({ ordinal: i, streamIndex: i, codec, lang3: 'eng', forced: false });

    it('skips image codecs explicitly and keeps unknown ones apart', () => {
        const { text, image, unsupported } = classifySubtitleStreams(
            [s('hdmv_pgs_subtitle', 0), s('dvd_subtitle', 1), s('dvb_subtitle', 2), s('ass', 3), s('eia_608', 4)],
            'native',
        );
        expect(image.map((x) => x.codec)).toEqual(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle']);
        expect(text.map((x) => x.codec)).toEqual(['ass']);
        expect(unsupported.map((x) => x.codec)).toEqual(['eia_608']);
    });

    it('native keeps ASS as ASS by stream copy, converts mov_text to SRT', () => {
        expect(outputFor('ass', 'native')).toEqual({ ext: 'ass', encoder: 'copy' });
        expect(outputFor('subrip', 'native')).toEqual({ ext: 'srt', encoder: 'copy' });
        expect(outputFor('webvtt', 'native')).toEqual({ ext: 'vtt', encoder: 'copy' });
        expect(outputFor('mov_text', 'native')).toEqual({ ext: 'srt', encoder: 'srt' });
    });

    it('an explicit format converts', () => {
        expect(outputFor('ass', 'srt')).toEqual({ ext: 'srt', encoder: 'srt' });
        expect(outputFor('subrip', 'vtt')).toEqual({ ext: 'vtt', encoder: 'webvtt' });
        expect(outputFor('hdmv_pgs_subtitle', 'srt')).toBeNull();
    });

    it('configure rejects an unknown outputFormat', () => {
        configure({ outputFormat: 'pgs' });
        expect(classifySubtitleStreams([s('ass', 0)]).text[0].ext).toBe('ass');
    });
});

describe('subtitleFilename', () => {
    const meta = { title: 'Dead Dead Demons', movieYear: 2024 };
    const stream = (streamIndex: number, lang3: string, forced = false) => ({ ordinal: 0, streamIndex, codec: 'ass', lang3, forced });

    it('two tracks in one language never share a file', () => {
        const a = subtitleFilename(meta, 'bagvideo', stream(3, 'eng'), 'ass');
        const b = subtitleFilename(meta, 'bagvideo', stream(4, 'eng', true), 'ass');
        expect(a).not.toBe(b);
        expect(a).toBe('Dead Dead Demons (2024)[bagvideo]_subtitle.s3.eng.ass');
        expect(b).toBe('Dead Dead Demons (2024)[bagvideo]_subtitle.s4.eng.forced.ass');
    });

    it('falls back to the file name and strips URL-hostile characters', () => {
        expect(subtitleFilename({ fileName: 'Show #1 100%?.mkv' }, 'c', stream(2, 'und'), 'srt'))
            .toBe('Show 1 100[c]_subtitle.s2.und.srt');
        expect(sanitizeFilename('a/b:c*d?e#f%g')).toBe('abcdefg');
    });
});

describe('buildExtractionArgs', () => {
    it('is ONE ffmpeg invocation with one -map/output per track', () => {
        const jobs = [3, 4, 10].map((i) => ({
            stream: { ordinal: i, streamIndex: i, codec: 'ass', lang3: 'eng', forced: false, ext: 'ass', encoder: 'copy' } as TextSubtitleStream,
            tempFile: `/tmp/t-${i}.ass`,
        }));
        const args = buildExtractionArgs('http://core/webdav/watch/a.mkv', jobs);
        expect(args.filter((a) => a === '-i')).toHaveLength(1);
        expect(args.filter((a) => a === '-map')).toHaveLength(3);
        expect(args.join(' ')).toContain('-map 0:3 -c:s copy /tmp/t-3.ass -map 0:4 -c:s copy /tmp/t-4.ass -map 0:10 -c:s copy /tmp/t-10.ass');
    });

    it('maps by subtitle ordinal when the global index is unknown', () => {
        const args = buildExtractionArgs('in.mkv', [{
            stream: { ordinal: 1, codec: 'subrip', lang3: 'ger', forced: false, ext: 'srt', encoder: 'copy' } as TextSubtitleStream,
            tempFile: 'out.srt',
        }]);
        expect(args).toContain('0:s:1');
    });
});

describe('hasCues', () => {
    it('does not count a header-only ASS file', () => {
        expect(hasCues(Buffer.from('[Script Info]\nTitle: x\n[Events]\n'), 'ass')).toBe(false);
        expect(hasCues(Buffer.from('[Events]\nDialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,Hi'), 'ass')).toBe(true);
        expect(hasCues(Buffer.from('1\n00:00:00,000 --> 00:00:01,000\nHi\n'), 'srt')).toBe(true);
        expect(hasCues(Buffer.from(''), 'srt')).toBe(false);
    });
});

describe('record keys (METADATA_KEYS.md §8)', () => {
    it('writes subtitles/<lang3>/<cid> and extractedSubtitles/<lang3>/<cid> leaves', () => {
        expect(videoSubtitleKeys([{ subCid: 'bagsubfre', lang3: 'fre' }, { subCid: 'bagsubund', lang3: 'und' }])).toEqual({
            'subtitles/fre/bagsubfre': 'true',
            'extractedSubtitles/fre/bagsubfre': 'true',
            'subtitleLanguages/fre': 'true',
            'languages/fre': 'true',
            'subtitles/und/bagsubund': 'true',
            'extractedSubtitles/und/bagsubund': 'true',
        });
    });

    it('never writes a bare subtitles/<lang3> node or an und facet', () => {
        const keys = Object.keys(videoSubtitleKeys([{ subCid: 'c', lang3: 'und' }]));
        expect(keys.every((k) => k.split('/').length === 3)).toBe(true);
    });

    it('subtitle record carries the back-pointer and a determined language only', () => {
        expect(subtitleRecordKeys('bagvideo', 'fre')).toEqual({ 'videos/bagvideo': 'true', subtitleLanguage: 'fre' });
        expect(subtitleRecordKeys('bagvideo', 'und')).toEqual({ 'videos/bagvideo': 'true' });
    });
});

describe('hasExtractedKeySet', () => {
    it('recognises the key-set in both payload forms', () => {
        expect(hasExtractedKeySet({ extractedSubtitles: { fre: { c: true } } })).toBe(true);
        expect(hasExtractedKeySet({ 'extractedSubtitles/fre/c': 'true' })).toBe(true);
    });

    it('does not treat the legacy csv scalar as done — that record needs migrating', () => {
        expect(hasExtractedKeySet({ extractedSubtitles: 'cidA,cidB' })).toBe(false);
        expect(hasExtractedKeySet({})).toBe(false);
    });
});

describe('legacySubtitleMigration', () => {
    it('deletes legacy scalars and keeps what they said as key-set leaves', () => {
        expect(legacySubtitleMigration({
            extractedSubtitles: 'cidA,cidB',
            subtitleLanguages: 'eng,fra',
            subtitles: 'cidS',
        })).toEqual({
            deletes: ['extractedSubtitles', 'subtitleLanguages', 'subtitles'],
            sets: { 'subtitleLanguages/eng': 'true', 'subtitleLanguages/fre': 'true', 'subtitles/und/cidS': 'true' },
        });
    });

    it('leaves key-sets alone', () => {
        expect(legacySubtitleMigration({ subtitles: { fre: { c: true } }, subtitleLanguages: { fre: true } }))
            .toEqual({ deletes: [], sets: {} });
    });
});

describe('meta-shape helpers', () => {
    it('flattens the nested document to the same keys meta-core stores', () => {
        const nested = { fileType: 'video', fileinfo: { duration: 1433.089 }, subtitles: { fre: { bagsub: true } }, stream: ['{"a":1}'] };
        expect(flattenMeta(nested)).toEqual({
            fileType: 'video',
            'fileinfo/duration': '1433.089',
            'subtitles/fre/bagsub': 'true',
            'stream/0': '{"a":1}',
        });
    });

    it('onlyNewKeys drops what the record already holds', () => {
        expect(onlyNewKeys({ 'a/b': 'true', c: 'x' }, { 'a/b': 'true', c: 'y', d: 'true' })).toEqual({ c: 'y', d: 'true' });
    });
});

describe('process — skip logic (no I/O)', () => {
    const collect = () => {
        const seen: CallbackPayload[] = [];
        return { seen, cb: async (p: CallbackPayload) => { seen.push(p); } };
    };
    const req = (existingMeta: Record<string, unknown>) => ({
        taskId: 't1',
        cid: 'bagvideo',
        filePath: '/files/watch/test.mkv',
        callbackUrl: 'http://localhost/callback',
        metaCoreUrl: 'http://127.0.0.1:9', // unreachable: every case must bail first
        existingMeta,
    });

    it('skips non-video files', async () => {
        const { seen, cb } = collect();
        await processFile(req({ fileType: 'subtitle' }), cb);
        expect(seen[0]).toMatchObject({ status: 'skipped', reason: 'Not a video file' });
    });

    it('skips a record whose extractedSubtitles key-set is already there (nested form)', async () => {
        const { seen, cb } = collect();
        await processFile(req({ fileType: 'video', extractedSubtitles: { eng: { c: true } }, stream: [JSON.stringify(SUB_ENG)] }), cb);
        expect(seen[0]).toMatchObject({ status: 'skipped', reason: 'Subtitles already extracted' });
    });

    it('skips a video with no subtitle streams', async () => {
        const { seen, cb } = collect();
        await processFile(req({ fileType: 'video', stream: [JSON.stringify(VIDEO)] }), cb);
        expect(seen[0]).toMatchObject({ status: 'skipped', reason: 'No subtitle streams found' });
    });

    it('skips a video whose only subtitles are image-based', async () => {
        const { seen, cb } = collect();
        await processFile(req({
            fileType: 'video',
            stream: [VIDEO, { type: 'subtitle', codec: 'hdmv_pgs_subtitle', index: 1, language: 'eng' }].map((s) => JSON.stringify(s)),
        }), cb);
        expect(seen[0]).toMatchObject({ status: 'skipped', reason: 'Only image-based subtitles (cannot convert to text)' });
    });
});

describe.skipIf(!ffmpegReady)('extractTracks (ffmpeg)', () => {
    beforeAll(() => mkdirSync(TEMP, { recursive: true }));

    const jobsFor = (file: string, tag: string): ExtractJob[] =>
        classifySubtitleStreams(parseSubtitleStreams({ stream: nestedStreamsFor(file) }), 'native').text
            .map((stream) => ({ stream, tempFile: path.join(TEMP, `${tag}-${stream.ordinal}.${stream.ext}`) }));

    it('extracts every text track of the MKV in a single pass', async () => {
        const jobs = jobsFor(fixture('with-subs.mkv'), 'single');
        expect(jobs.map((j) => [j.stream.lang3, j.stream.ext, j.stream.forced])).toEqual([
            ['eng', 'srt', false],
            ['fre', 'ass', true],
            ['und', 'srt', false],
        ]);
        const before = extractionStats.ffmpegPasses;
        const result = await extractTracks(fixture('with-subs.mkv'), jobs, 60000);
        expect(extractionStats.ffmpegPasses - before).toBe(1);
        expect(result.passes).toBe(1);
        const [eng, fre, und] = result.outputs.map((o) => o.data?.toString('utf8') ?? '');
        expect(eng).toContain('quick brown fox');
        expect(fre).toContain('[Script Info]');
        expect(fre).toMatch(/^Dialogue:.*renard brun/m);
        expect(und).toContain('-->');
    });

    it('converts mov_text to SRT', async () => {
        const jobs = jobsFor(fixture('mov-text.mp4'), 'movtext');
        expect(jobs.map((j) => [j.stream.lang3, j.stream.ext, j.stream.encoder])).toEqual([['ger', 'srt', 'srt']]);
        const result = await extractTracks(fixture('mov-text.mp4'), jobs, 60000);
        expect(result.outputs[0].data?.toString('utf8')).toContain('schnelle braune Fuchs');
    });

    it('salvages good tracks one by one when the shared pass fails', async () => {
        const jobs = jobsFor(fixture('with-subs.mkv'), 'salvage');
        const broken: ExtractJob = { ...jobs[0], stream: { ...jobs[0].stream, streamIndex: 42 }, tempFile: path.join(TEMP, 'salvage-broken.srt') };
        const result = await extractTracks(fixture('with-subs.mkv'), [jobs[0], broken, jobs[1]], 60000);
        expect(result.passes).toBe(4);
        expect(result.outputs.map((o) => o.data !== null)).toEqual([true, false, true]);
    });
});

describe.skipIf(!ffmpegReady)('process — end to end against a fake core', () => {
    let core: FakeCore;
    const VIDEO_CID = 'bagacbabaevideo';
    const videoPath = '/files/watch/show/with-subs.mkv';
    let nestedMeta: Record<string, unknown>;

    beforeAll(async () => {
        core = await startFakeCore();
        core.files.set('/watch/show/with-subs.mkv', readFileSync(fixture('with-subs.mkv')));
        process.env.WEBDAV_URL = core.webdavUrl;
        process.env.CACHE_PATH = TEMP;
        nestedMeta = {
            fileType: 'video',
            title: 'Test Show',
            fileName: 'with-subs.mkv',
            fileinfo: { duration: 3, formatName: 'matroska,webm' },
            stream: nestedStreamsFor(fixture('with-subs.mkv')),
            // Legacy scalars from the `_add` era, which must not survive next to key-sets.
            extractedSubtitles: 'bagold1,bagold2',
            subtitleLanguages: 'eng',
        };
        core.records.set(VIDEO_CID, flattenMeta(nestedMeta));
    });

    afterAll(async () => {
        delete process.env.WEBDAV_URL;
        await core.close();
    });

    const run = async (existingMeta: Record<string, unknown>) => {
        const seen: CallbackPayload[] = [];
        await processFile({
            taskId: 'task-e2e',
            cid: VIDEO_CID,
            filePath: videoPath,
            callbackUrl: 'http://unused',
            metaCoreUrl: core.url,
            existingMeta,
        }, async (p) => { seen.push(p); });
        return seen[0];
    };

    it('extracts in one pass, uploads, and links subtitles/<lang3>/<cid>', async () => {
        const passes = extractionStats.ffmpegPasses;
        const result = await run(nestedMeta);
        expect(result.status).toBe('completed');
        expect(extractionStats.ffmpegPasses - passes).toBe(1);

        const uploads = [...core.files.keys()].filter((p) => p.startsWith('/plugin/subtitle-extractor/')).sort();
        expect(uploads).toEqual([
            '/plugin/subtitle-extractor/Test Show[bagacbabaevideo]_subtitle.s1.eng.srt',
            '/plugin/subtitle-extractor/Test Show[bagacbabaevideo]_subtitle.s2.fre.forced.ass',
            '/plugin/subtitle-extractor/Test Show[bagacbabaevideo]_subtitle.s3.und.srt',
        ]);
        const cidOf = (suffix: string) => computeMidHash256FromBuffer(core.files.get(uploads.find((u) => u.endsWith(suffix))!)!);
        const eng = cidOf('eng.srt');
        const fre = cidOf('fre.forced.ass');
        const und = cidOf('und.srt');

        const video = core.records.get(VIDEO_CID)!;
        expect(video).toMatchObject({
            [`subtitles/eng/${eng}`]: 'true',
            [`subtitles/fre/${fre}`]: 'true',
            [`subtitles/und/${und}`]: 'true',
            [`extractedSubtitles/eng/${eng}`]: 'true',
            [`extractedSubtitles/fre/${fre}`]: 'true',
            [`extractedSubtitles/und/${und}`]: 'true',
            'subtitleLanguages/eng': 'true',
            'subtitleLanguages/fre': 'true',
            'languages/eng': 'true',
            'languages/fre': 'true',
        });
        expect(video.extractedSubtitles).toBeUndefined();
        expect(video.subtitleLanguages).toBeUndefined();
        expect(video['subtitleLanguages/und']).toBeUndefined();

        expect(core.records.get(fre)).toEqual({ [`videos/${VIDEO_CID}`]: 'true', subtitleLanguage: 'fre' });
        expect(core.records.get(und)).toEqual({ [`videos/${VIDEO_CID}`]: 'true' });

        // The video PATCH carried only new keys — nothing the record already had.
        const patch = writesTo(core, VIDEO_CID).find((c) => c.method === 'PATCH')!;
        expect(Object.keys(patch.body as object).some((k) => ['fileType', 'title', 'stream/0'].includes(k))).toBe(false);
    });

    it('skips once the key-set is on the record', async () => {
        const result = await run(core.records.get(VIDEO_CID)!);
        expect(result).toMatchObject({ status: 'skipped', reason: 'Subtitles already extracted' });
    });

    it('re-links from existing outputs without reading the video again', async () => {
        // Metadata lost, output files still there.
        const bare = flattenMeta({ ...nestedMeta, extractedSubtitles: undefined, subtitleLanguages: undefined });
        const passes = extractionStats.ffmpegPasses;
        const gets = core.fileGets.get('/watch/show/with-subs.mkv');
        const result = await run(bare);
        expect(result.status).toBe('completed');
        expect(extractionStats.ffmpegPasses).toBe(passes);
        expect(core.fileGets.get('/watch/show/with-subs.mkv')).toBe(gets);
    });

    it('a second link over an up-to-date record writes nothing', async () => {
        const before = core.calls.length;
        const video = core.records.get(VIDEO_CID)!;
        const produced = Object.keys(video)
            .filter((k) => k.startsWith('subtitles/'))
            .map((k) => ({ lang3: k.split('/')[1], subCid: k.split('/')[2] }));
        expect(await linkSubtitles(new MetaCoreClient(core.url), VIDEO_CID, video, produced)).toBe(true);
        expect(core.calls.length).toBe(before);
    });

    it('fails the task when meta-core rejects the write', async () => {
        core.failPatch = true;
        try {
            const result = await run(flattenMeta({ fileType: 'video', title: 'Test Show', stream: nestedStreamsFor(fixture('with-subs.mkv')) }));
            expect(result).toMatchObject({ status: 'failed', error: 'meta-core write failed' });
        } finally {
            core.failPatch = false;
        }
    });
});
