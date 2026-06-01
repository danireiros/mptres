/**
 * LRC estándar: una línea del archivo = un segmento. Sin fusionar ni omitir.
 * Línea activa mientras t está en [start[i], start[i+1]).
 */
(function (global) {
    function parseTimestamp(min, sec, frac) {
        const base = Number(min) * 60 + Number(sec);
        if (frac == null || frac === '') return base;
        const f = String(frac);
        if (f.length <= 2) return base + Number(f) / 100;
        if (f.length === 3) return base + Number(f) / 1000;
        return base + Number(f) / Math.pow(10, f.length);
    }

    function parseRawCues(lrcText) {
        const cues = [];
        const timeRe = /\[(\d+):(\d{2})(?:[.:](\d{2,3}))?\]/g;
        let offsetSec = 0;

        const offsetMatch = lrcText.match(/\[offset:\s*([+-]?\d+)\]/i);
        if (offsetMatch) offsetSec = Number(offsetMatch[1]) / 1000;

        lrcText.split(/\r?\n/).forEach((rawLine) => {
            const line = rawLine.trim();
            if (!line || /^\[(ar|ti|al|by|offset):/i.test(line)) return;

            const stamps = [];
            let match;
            timeRe.lastIndex = 0;
            while ((match = timeRe.exec(line)) !== null) {
                stamps.push(Math.max(0, parseTimestamp(match[1], match[2], match[3]) + offsetSec));
            }

            const text = line.replace(/\[\d+:\d{2}(?:[.:]\d{2,3})?\]/g, '').trim();
            if (!text) return;

            stamps.forEach((start) => cues.push({ start, text }));
        });

        cues.sort((a, b) => a.start - b.start || 0);
        return cues;
    }

    function cuesToSegments(cues) {
        return cues.map((cue, i) => ({
            start: cue.start,
            text: cue.text,
            end: i < cues.length - 1 ? cues[i + 1].start : Number.POSITIVE_INFINITY,
        }));
    }

    /** Solo para LRCLIB u otras fuentes que traen desfase aparte del [offset:] del archivo. */
    function applyTimeOffset(segments, offsetSec) {
        if (!offsetSec) return segments;
        return segments.map((seg) => ({
            ...seg,
            start: Math.max(0, seg.start + offsetSec),
            end: seg.end === Number.POSITIVE_INFINITY ? seg.end : Math.max(0, seg.end + offsetSec),
        }));
    }

    function finalizeEnds(segments, duration) {
        if (!Number.isFinite(duration) || duration <= 0) return segments;
        return segments.map((seg, i) => ({
            ...seg,
            end: i < segments.length - 1 ? segments[i + 1].start : duration,
        }));
    }

    function parseLrcForPlayer(lrcText, options = {}) {
        const raw = parseRawCues(lrcText);
        if (!raw.length) return null;

        let segments = cuesToSegments(raw);
        if (options.offsetSec) {
            segments = applyTimeOffset(segments, options.offsetSec);
        }
        segments = finalizeEnds(segments, options.duration);

        return {
            segments,
            rawCount: raw.length,
            segmentCount: segments.length,
        };
    }

    /** Línea activa: la última con start <= t (cada línea dura hasta la siguiente). */
    function findSegmentIndex(segments, t) {
        if (!segments?.length || t < 0) return -1;
        if (t < segments[0].start) return -1;

        let lo = 0;
        let hi = segments.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (segments[mid].start <= t) lo = mid + 1;
            else hi = mid;
        }
        return lo - 1;
    }

    function segmentsFromPlainText(text, duration) {
        if (!text || !Number.isFinite(duration) || duration <= 0) return null;

        const lines = text
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => {
                if (!l) return false;
                if (/^\[(?:ar|ti|al|by|offset):/i.test(l)) return false;
                return !(/^\[[^\]]+\]$/.test(l) && !/\[\d+:\d{2}(?:[.:]\d{2,3})?\]/.test(l));
            });

        if (!lines.length) return null;

        const weights = lines.map((l) => Math.max(2, l.replace(/[^\p{L}\p{N}]/gu, '').length || 2));
        const totalW = weights.reduce((a, b) => a + b, 0);
        const intro = Math.min(4, duration * 0.04);
        const usable = Math.max(1, duration - intro);
        let time = intro;
        const segments = [];

        lines.forEach((lineText, i) => {
            const slice = (weights[i] / totalW) * usable;
            segments.push({
                start: time,
                end: time + slice,
                text: lineText,
            });
            time += slice;
        });

        if (segments.length) {
            segments[segments.length - 1].end = duration;
        }

        return {
            segments,
            rawCount: lines.length,
            segmentCount: segments.length,
        };
    }

    function buildSegments(rawCues) {
        return {
            segments: cuesToSegments(rawCues),
            rawCount: rawCues.length,
        };
    }

    const root = global || (typeof window !== 'undefined' ? window : globalThis);
    root.LyricsSync = {
        parseRawCues,
        buildSegments,
        parseLrcForPlayer,
        findSegmentIndex,
        segmentsFromPlainText,
        applyTimeOffset,
        finalizeEnds,
    };
})(typeof window !== 'undefined' ? window : globalThis);
