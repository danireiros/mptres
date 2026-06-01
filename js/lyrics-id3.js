/**
 * Extracción de letra embebida en MP3 (USLT, SYLT, LRC en texto).
 * Suno / suno-cli suelen usar SYLT (milisegundos) o LRC en el tag.
 */
(function (global) {
    const TAG_SCAN_BYTES = 384 * 1024;

    function readSynchsafeInt(bytes, offset) {
        return ((bytes[offset] & 0x7f) << 21)
            | ((bytes[offset + 1] & 0x7f) << 14)
            | ((bytes[offset + 2] & 0x7f) << 7)
            | (bytes[offset + 3] & 0x7f);
    }

    function readInt32(bytes, offset) {
        return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
    }

    function decodeText(bytes, encoding) {
        if (!bytes.length) return '';
        if (encoding === 0 || encoding === 1) {
            const bom = bytes[0] === 0xff && bytes[1] === 0xfe;
            const start = bom ? 2 : 0;
            const little = encoding === 0 || bom;
            let out = '';
            for (let i = start; i < bytes.length - 1; i += 2) {
                const code = little
                    ? bytes[i] | (bytes[i + 1] << 8)
                    : (bytes[i] << 8) | bytes[i + 1];
                if (code === 0) break;
                out += String.fromCharCode(code);
            }
            return out;
        }
        let end = bytes.indexOf(0);
        if (end < 0) end = bytes.length;
        return new TextDecoder('utf-8').decode(bytes.subarray(0, end));
    }

    function readNullTerminated(bytes, offset, encoding) {
        let end = offset;
        if (encoding === 0 || encoding === 1) {
            while (end < bytes.length - 1) {
                if (bytes[end] === 0 && bytes[end + 1] === 0) break;
                end += 2;
            }
            end += 2;
        } else {
            while (end < bytes.length && bytes[end] !== 0) end++;
            end += 1;
        }
        const text = decodeText(bytes.subarray(offset, end), encoding);
        return { text, next: end };
    }

    function parseSyltFrame(data) {
        if (data.length < 8) return null;

        const encoding = data[0];
        const timeFormat = data[4];
        const isMs = timeFormat === 2;

        let offset = 6;
        const descriptor = readNullTerminated(data, offset, encoding);
        offset = descriptor.next;

        const entries = [];
        while (offset + 5 < data.length) {
            const chunk = readNullTerminated(data, offset, encoding);
            if (chunk.next >= data.length - 4) break;
            offset = chunk.next;
            const ts = readInt32(data, offset);
            offset += 4;
            const piece = chunk.text.replace(/\s+/g, ' ').trim();
            if (!piece) continue;
            entries.push({ start: isMs ? ts / 1000 : ts, text: piece });
        }

        if (!entries.length) return null;
        return groupSyltIntoLines(entries);
    }

    function groupSyltIntoLines(entries) {
        entries.sort((a, b) => a.start - b.start);
        const lines = [];
        let current = null;
        const gapThreshold = 0.9;

        entries.forEach((entry) => {
            if (!current || entry.start - current.start > gapThreshold) {
                if (current) lines.push(current);
                current = { start: entry.start, text: entry.text };
            } else {
                const needsSpace = current.text.length > 0 && !current.text.endsWith(' ') && entry.text.length > 1;
                current.text += (needsSpace ? ' ' : '') + entry.text;
            }
        });
        if (current) lines.push(current);

        lines.forEach((line, i) => {
            line.end = i < lines.length - 1 ? lines[i + 1].start : null;
        });
        return lines;
    }

    function parseId3v2(buffer) {
        const bytes = new Uint8Array(buffer);
        if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) {
            return null;
        }

        const version = bytes[3];
        const size = version === 4 ? readSynchsafeInt(bytes, 6) : readInt32(bytes, 6) >>> 0;
        let offset = 10;
        const end = Math.min(bytes.length, 10 + size);
        const results = { sylt: null, uslt: null, lrcText: null, sunoClipId: null, woasUrl: null };

        while (offset + 10 < end) {
            const id = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
            const frameSize = version === 4
                ? readSynchsafeInt(bytes, offset + 4)
                : readInt32(bytes, offset + 4) >>> 0;
            const headerSize = 10;
            if (frameSize <= 0 || offset + headerSize + frameSize > end) break;

            const frameData = bytes.subarray(offset + headerSize, offset + headerSize + frameSize);

            if (id === 'SYLT') {
                results.sylt = parseSyltFrame(frameData);
            } else if (id === 'USLT' || id === 'ULT') {
                const enc = frameData[0];
                let o = 4;
                const desc = readNullTerminated(frameData, o, enc);
                o = desc.next;
                const lyrics = readNullTerminated(frameData, o, enc);
                if (lyrics.text.trim()) results.uslt = lyrics.text.trim();
            } else if (id === 'WOAS') {
                let url = new TextDecoder('utf-8').decode(frameData).replace(/\0/g, '').trim();
                if (!url.startsWith('http') && frameData[0] <= 3) {
                    url = decodeText(frameData, frameData[0]).trim();
                }
                if (url.startsWith('http')) results.woasUrl = url;
            } else if (id === 'TXXX' || id === 'COMM') {
                const enc = frameData[0];
                const first = readNullTerminated(frameData, 1, enc);
                const rest = decodeText(frameData.subarray(first.next), enc);
                const combined = `${first.text}\n${rest}`.trim();
                if (/\[\d+:\d{2}(?:[.:]\d{2,3})?\]/.test(combined)) results.lrcText = combined;
                const idMatch = combined.match(/\bid=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i);
                if (idMatch) results.sunoClipId = idMatch[1];
            }

            offset += headerSize + frameSize;
        }

        return results;
    }

    function lrcTimestampToSeconds(min, sec, frac) {
        const base = Number(min) * 60 + Number(sec);
        if (frac == null || frac === '') return base;
        const f = String(frac);
        if (f.length === 2) return base + Number(f) / 100;
        if (f.length === 3) return base + Number(f) / 1000;
        return base + Number(f) / Math.pow(10, f.length);
    }

    function parseLrcText(lrcText) {
        const lines = [];
        const timeRe = /\[(\d+):(\d{2})(?:[.:](\d{2,3}))?\]/g;
        let lrcOffsetSec = 0;

        const offsetMatch = lrcText.match(/\[offset:\s*([+-]?\d+)\]/i);
        if (offsetMatch) lrcOffsetSec = Number(offsetMatch[1]) / 1000;

        lrcText.split('\n').forEach((rawLine) => {
            const line = rawLine.trim();
            if (!line || /^\[(ar|ti|al|by|offset):/i.test(line)) return;

            const stamps = [];
            let match;
            timeRe.lastIndex = 0;
            while ((match = timeRe.exec(line)) !== null) {
                stamps.push(Math.max(0, lrcTimestampToSeconds(match[1], match[2], match[3]) + lrcOffsetSec));
            }

            const text = line.replace(/\[\d+:\d{2}(?:[.:]\d{2,3})?\]/g, '').trim();
            if (!text) return;

            stamps.forEach((start) => lines.push({ start, text }));
        });

        const timed = lines.filter((l) => l.start != null);
        if (!timed.length) return null;

        timed.sort((a, b) => a.start - b.start);
        if (typeof global.LyricsSync !== 'undefined') {
            return LyricsSync.buildSegments(timed).segments;
        }
        return timed;
    }

    /**
     * Convierte LRC crudo (Suno: muchas líneas cada ~0,18 s) en bloques de visualización.
     * Nueva pausa solo si el hueco con la línea anterior es >= minBreak (p. ej. 0,92 s).
     */
    function buildDisplayCues(timed, options = {}) {
        if (!timed?.length) return timed;

        const minBreak = options.minBreak ?? 0.92;
        const sameTsEps = options.sameTsEps ?? 0.05;

        const merged = [];
        let groupStart = null;
        let parts = [];

        function flush() {
            if (!parts.length || groupStart == null) return;
            merged.push({ start: groupStart, text: parts.join('\n') });
            parts = [];
            groupStart = null;
        }

        for (let i = 0; i < timed.length; i++) {
            const line = timed[i];
            const text = String(line.text || '').trim();
            if (!text) continue;

            if (groupStart == null) {
                groupStart = line.start;
                parts.push(text);
                continue;
            }

            const prev = timed[i - 1];
            const gap = line.start - prev.start;
            const sameInstant = Math.abs(line.start - prev.start) <= sameTsEps;

            if (sameInstant || gap < minBreak) {
                parts.push(text);
            } else {
                flush();
                groupStart = line.start;
                parts = [text];
            }
        }

        flush();

        merged.forEach((cue, i) => {
            cue.end = i < merged.length - 1 ? merged[i + 1].start : null;
        });
        return merged;
    }

    function consolidateLrcLines(timed, options = {}) {
        return buildDisplayCues(timed, options);
    }

    function isLyricsSectionTag(line) {
        return /^\[[^\]]+\]$/.test(line) && !/\[\d+:\d{2}(?:[.:]\d{2,3})?\]/.test(line);
    }

    function plainTextToEstimatedLines(text, duration) {
        if (!text || !Number.isFinite(duration) || duration <= 0) return null;

        const lines = text
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l && !isLyricsSectionTag(l) && !/^\[(?:ar|ti|al|by|offset):/i.test(l));

        if (!lines.length) return null;

        const weights = lines.map((l) => Math.max(2, l.replace(/[^\p{L}\p{N}]/gu, '').length || 2));
        const totalW = weights.reduce((a, b) => a + b, 0);
        const intro = Math.min(4, duration * 0.04);
        const usable = Math.max(1, duration - intro);
        let t = intro;
        const out = [];

        lines.forEach((lineText, i) => {
            const slice = (weights[i] / totalW) * usable;
            out.push({ start: t, text: lineText, end: null });
            t += slice;
        });

        out.forEach((line, i) => {
            line.end = i < out.length - 1 ? out[i + 1].start : duration;
        });
        return out;
    }

    function alignedWordsToLines(payload) {
        const words = payload?.aligned_words
            || payload?.alignedWords
            || payload?.words
            || (Array.isArray(payload) ? payload : null);
        if (!words?.length) return null;

        const entries = [];
        words.forEach((w) => {
            if (w.success === false) return;
            const text = String(w.word ?? w.text ?? '').trim();
            if (!text) return;
            entries.push({ start: Number(w.start_s ?? w.startS ?? w.start ?? 0), text });
        });

        if (!entries.length) return null;
        return groupSyltIntoLines(entries);
    }

    function extractSunoClipId(id3) {
        if (id3.sunoClipId) return id3.sunoClipId;
        if (id3.woasUrl) {
            const m = id3.woasUrl.match(/\/song\/([0-9a-f-]{36})/i);
            if (m) return m[1];
        }
        return null;
    }

    async function readTagBuffers(file) {
        const head = await file.slice(0, Math.min(file.size, TAG_SCAN_BYTES)).arrayBuffer();
        let tail = null;
        if (file.size > TAG_SCAN_BYTES) {
            tail = await file.slice(file.size - TAG_SCAN_BYTES).arrayBuffer();
        }
        return { head, tail };
    }

    async function extractLyricsFromMp3(file) {
        const { head, tail } = await readTagBuffers(file);
        let id3 = parseId3v2(head) || {};

        if (tail) {
            const tailTags = parseId3v2(tail);
            if (tailTags) {
                id3 = {
                    sylt: id3.sylt || tailTags.sylt,
                    uslt: id3.uslt || tailTags.uslt,
                    lrcText: id3.lrcText || tailTags.lrcText,
                    sunoClipId: id3.sunoClipId || tailTags.sunoClipId,
                    woasUrl: id3.woasUrl || tailTags.woasUrl,
                };
            }
        }

        const sunoClipId = extractSunoClipId(id3);

        if (id3.sylt?.length) {
            return { type: 'synced', lines: id3.sylt, source: 'Archivo · SYLT', sunoClipId };
        }

        const lrcCandidate = id3.lrcText || id3.uslt || '';
        if (lrcCandidate && /\[\d+:\d{2}(?:[.:]\d{2,3})?\]/.test(lrcCandidate)) {
            const parsed = parseLrcText(lrcCandidate);
            if (parsed?.length) {
                return { type: 'synced', lines: parsed, source: 'Archivo · LRC embebido', sunoClipId };
            }
        }

        if (lrcCandidate.trim()) {
            return {
                type: 'plain',
                text: lrcCandidate.trim(),
                sunoClipId,
                isSuno: Boolean(sunoClipId) || /suno\.com/i.test(id3.woasUrl || ''),
            };
        }

        return sunoClipId ? { type: 'none', sunoClipId, isSuno: true } : null;
    }

    const root = global || (typeof window !== 'undefined' ? window : globalThis);
    root.LyricsId3 = {
        extractLyricsFromMp3,
        parseLrcText,
        buildDisplayCues,
        consolidateLrcLines,
        plainTextToEstimatedLines,
        alignedWordsToLines,
    };
})(typeof window !== 'undefined' ? window : globalThis);
