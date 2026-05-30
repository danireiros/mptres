/**
 * Sincronización de letra: parsea LRC (incl. Suno denso) en segmentos estables.
 * Un segmento = bloque de texto que se muestra hasta el siguiente hueco >= GAP_BREAK.
 */
(function (global) {
    /** Segundos entre cues crudos para abrir un segmento nuevo */
    const GAP_BREAK_SEC = 1.0;
    const SAME_TIME_EPS = 0.05;

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

        lrcText.split('\n').forEach((rawLine) => {
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

        cues.sort((a, b) => a.start - b.start);
        return cues;
    }

    /**
     * Agrupa cues Suno (0,18 s) en segmentos de visualización.
     * @returns {{ segments: Array<{start,end,text,rawCount}>, rawCount: number }}
     */
    function buildSegments(rawCues, options = {}) {
        const gapBreak = options.gapBreak ?? GAP_BREAK_SEC;
        const sameEps = options.sameEps ?? SAME_TIME_EPS;

        if (!rawCues?.length) {
            return { segments: [], rawCount: 0 };
        }

        const segments = [];
        let clusterStart = rawCues[0].start;
        let parts = [rawCues[0].text];
        let rawCount = 1;

        for (let i = 1; i < rawCues.length; i++) {
            const cue = rawCues[i];
            const prev = rawCues[i - 1];
            const gap = cue.start - prev.start;
            const sameTime = Math.abs(cue.start - prev.start) <= sameEps;

            if (sameTime || gap < gapBreak) {
                parts.push(cue.text);
                rawCount += 1;
            } else {
                segments.push({
                    start: clusterStart,
                    text: parts.join('\n'),
                    rawCount,
                });
                clusterStart = cue.start;
                parts = [cue.text];
                rawCount = 1;
            }
        }

        segments.push({
            start: clusterStart,
            text: parts.join('\n'),
            rawCount,
        });

        for (let i = 0; i < segments.length; i++) {
            segments[i].end =
                i < segments.length - 1 ? segments[i + 1].start : Number.POSITIVE_INFINITY;
        }

        return { segments, rawCount: rawCues.length };
    }

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
            end:
                i < segments.length - 1
                    ? Math.min(seg.end, segments[i + 1].start)
                    : duration,
        }));
    }

    function parseLrcForPlayer(lrcText, options = {}) {
        const raw = parseRawCues(lrcText);
        if (!raw.length) return null;

        const { segments, rawCount } = buildSegments(raw, options);
        const shifted = applyTimeOffset(segments, options.offsetSec || 0);
        const final = finalizeEnds(shifted, options.duration);

        return {
            segments: final,
            rawCount,
            segmentCount: final.length,
        };
    }

    /** Índice del segmento activo en el instante t (intervalo [start, end)). */
    function findSegmentIndex(segments, t) {
        if (!segments?.length || t < 0) return -1;

        let lo = 0;
        let hi = segments.length - 1;
        let candidate = -1;

        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (segments[mid].start <= t + 1e-4) {
                candidate = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }

        if (candidate < 0) return -1;

        const seg = segments[candidate];
        if (t < seg.end) return candidate;

        if (candidate < segments.length - 1) {
            const next = segments[candidate + 1];
            if (t < next.start) return candidate;
        }

        return candidate;
    }

    /** Estima segmentos desde texto plano (sin LRC). */
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
                rawCount: 1,
            });
            time += slice;
        });

        if (segments.length) {
            segments[segments.length - 1].end = duration;
        }

        return { segments, rawCount: lines.length, segmentCount: segments.length };
    }

    global.LyricsSync = {
        GAP_BREAK_SEC,
        parseRawCues,
        buildSegments,
        parseLrcForPlayer,
        findSegmentIndex,
        segmentsFromPlainText,
        applyTimeOffset,
        finalizeEnds,
    };
})();
