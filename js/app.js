(function () {
    const STORAGE_KEY = 'theme';
    const LYRICS_MODE_KEY = 'lyricsMode';
    const themeInputs = document.querySelectorAll('#themeSwitcher .theme-switcher__input');

    const fileInput = document.getElementById('fileInput');
    const coverUpload = document.getElementById('coverUpload');
    const playerEl = document.getElementById('player');
    const audio = document.getElementById('audio');
    const coverArt = document.getElementById('coverArt');
    const coverFallback = document.getElementById('coverFallback');
    const trackTitle = document.getElementById('trackTitle');
    const playBtn = document.getElementById('playBtn');
    const playIcon = document.getElementById('playIcon');
    const progressRange = document.getElementById('progressRange');
    const currentTimeEl = document.getElementById('currentTime');
    const durationEl = document.getElementById('duration');

    const lyricsPanel = document.getElementById('lyricsPanel');
    const lyricsStatus = document.getElementById('lyricsStatus');
    const lyricsScroll = document.getElementById('lyricsScroll');
    const lyricsStage = document.getElementById('lyricsStage');
    const lyricsNow = document.getElementById('lyricsNow');
    const lyricsStageBadge = document.getElementById('lyricsStageBadge');
    const lyricsPlain = document.getElementById('lyricsPlain');
    const lyricsVideoclip = document.getElementById('lyricsVideoclip');
    const lyricsVcStage = document.getElementById('lyricsVcStage');
    const vcCurrent = document.getElementById('vcCurrent');
    const vcNext = document.getElementById('vcNext');
    const vcHint = document.getElementById('vcHint');
    const lyricsModeInputs = document.querySelectorAll('#lyricsModeSwitcher .theme-switcher__input');
    const lrcInput = document.getElementById('lrcInput');

    let lyricsMode = 'list';
    let lastVcLineIndex = -1;
    let bassEnvelope = 0;

    let objectUrl = null;
    let isSeeking = false;
    let lyricsFetchId = 0;
    let lyricsSegments = [];
    let lyricsSynced = false;
    let activeSegmentIndex = -1;
    let pendingPlainText = null;
    let pendingPlainIsSuno = false;
    let externalLrcText = null;
    let lyricsTimingOffset = 0;
    let lyricsSyncPending = false;
    let trackMeta = { title: '', artist: '', album: '', duration: 0 };
    let currentAudioFile = null;

    /** Perfil adaptado desde config CAVA del usuario */
    const CAVA_CONFIG = {
        framerate: 50,
        bars: 112,
        barSpacing: 0,
        autosens: 2,
        overshoot: 3,
        sensitivity: 80,
        lowerCutoffFreq: 40,
        higherCutoffFreq: 17500,
    };

    const BAR_COUNT = CAVA_CONFIG.bars;

    const visualizerEl = document.getElementById('visualizer');
    const visualizerBars = document.getElementById('visualizerBars');
    const barFills = [];
    const barSmoothLevels = [];
    let barSpectrumMap = [];
    let visualizerSensFloor = 0.06;
    let visualizerPeakHold = 0.14;
    let lastVisualizerFrame = 0;

    let audioCtx = null;
    let analyser = null;
    let audioSource = null;
    let visualizerAnimId = null;
    let freqData = null;

    function applyTheme(value) {
        document.documentElement.setAttribute('data-theme', value);
        localStorage.setItem(STORAGE_KEY, value);
    }

    function syncThemeInputs() {
        const current = document.documentElement.getAttribute('data-theme') || 'light';
        themeInputs.forEach((input) => {
            input.checked = input.value === current;
        });
    }

    themeInputs.forEach((input) => {
        input.addEventListener('change', () => {
            if (input.checked) applyTheme(input.value);
        });
    });
    syncThemeInputs();

    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        window.addEventListener('mousemove', (e) => {
            const x = (e.clientX / window.innerWidth - 0.5) * 40;
            const y = (e.clientY / window.innerHeight - 0.5) * 40;
            document.documentElement.style.setProperty('--tx', x + 'px');
            document.documentElement.style.setProperty('--ty', y + 'px');
        }, { passive: true });
    }

    function formatTime(seconds) {
        if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return `${m}:${String(s).padStart(2, '0')}`;
    }

    function revokeObjectUrl() {
        if (objectUrl) {
            URL.revokeObjectURL(objectUrl);
            objectUrl = null;
        }
    }

    function setCoverFromDataUrl(dataUrl) {
        coverArt.src = dataUrl;
        coverArt.hidden = false;
        coverFallback.hidden = true;
    }

    function resetCover() {
        coverArt.removeAttribute('src');
        coverArt.hidden = true;
        if (playerEl.classList.contains('has-track')) {
            coverFallback.hidden = false;
        } else {
            coverFallback.hidden = true;
        }
    }

    function setPlayerEmpty() {
        playerEl.classList.add('is-empty');
        playerEl.classList.remove('has-track');
        coverArt.hidden = true;
        coverFallback.hidden = true;
        playBtn.disabled = true;
        progressRange.disabled = true;
        trackTitle.textContent = 'Sube una canción';
    }

    function setPlayerReady() {
        playerEl.classList.remove('is-empty');
        playerEl.classList.add('has-track');
        playBtn.disabled = false;
        progressRange.disabled = false;
        enableVisualizerPanel();
    }

    function paintIdleVisualizerWave() {
        if (!barFills.length) return;
        barFills.forEach((fill, i) => {
            const h = 0.22 + Math.abs(Math.sin(i * 0.35)) * 0.38;
            barSmoothLevels[i] = h;
            fill.style.transform = `scaleY(${h})`;
        });
    }

    function enableVisualizerPanel() {
        ensureAudioContext();
        visualizerEl.classList.add('is-live');
        if (!barFills.length) initVisualizerBars();
        paintIdleVisualizerWave();
        if (!audio.paused && audio.src) updateVisualizer();
    }

    function stopVisualizerAnimation() {
        if (visualizerAnimId) {
            cancelAnimationFrame(visualizerAnimId);
            visualizerAnimId = null;
            lastVisualizerFrame = 0;
        }
        lyricsVcStage.classList.remove('is-kick-pulse');
        bassEnvelope = 0;
    }

    function resetVisualizer() {
        stopVisualizerAnimation();
        visualizerEl.classList.add('is-live');
        paintIdleVisualizerWave();
    }

    function titleFromFilename(name) {
        return name.replace(/\.[^/.]+$/, '').replace(/[_-]+/g, ' ').trim() || 'Sin título';
    }

    function parseArtistTitleFromFilename(name) {
        const base = titleFromFilename(name);
        const parts = base.split(/\s*[-–—]\s*/);
        if (parts.length >= 2) {
            return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() };
        }
        return { artist: '', title: base };
    }

    function extractLyricsText(tags) {
        if (!tags || !tags.lyrics) return '';
        const raw = tags.lyrics;
        if (typeof raw === 'string') return raw.trim();
        if (raw.lyrics) return String(raw.lyrics).trim();
        if (raw.text) return String(raw.text).trim();
        return '';
    }

    function lrcTimestampToSeconds(min, sec, frac) {
        const base = Number(min) * 60 + Number(sec);
        if (frac == null || frac === '') return base;
        const f = String(frac);
        if (f.length <= 2) return base + Number(f) / 100;
        return base + Number(f) / 1000;
    }

    function parseLrcPack(lrcText) {
        if (typeof LyricsSync === 'undefined') return null;
        return LyricsSync.parseLrcForPlayer(lrcText, {
            offsetSec: lyricsTimingOffset,
            duration: audio.duration,
        });
    }

    function refreshLyricsSegmentEnds() {
        if (!lyricsSegments.length || typeof LyricsSync === 'undefined') return;
        if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
        lyricsSegments = LyricsSync.finalizeEnds(lyricsSegments, audio.duration);
    }

    function getLyricsPlaybackTime(overrideTime) {
        const t = overrideTime != null ? overrideTime : audio.currentTime;
        return Math.max(0, t);
    }

    function looksLikeLrc(text) {
        return /\[\d+:\d{2}(?:[.:]\d{2,3})?\]/.test(text);
    }

    function splitPlainLyricLines(text) {
        if (!text) return [];
        return text
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => {
                if (!l) return false;
                if (/^\[(?:ar|ti|al|by|offset):/i.test(l)) return false;
                return !(/^\[[^\]]+\]$/.test(l) && !/\[\d+:\d{2}(?:[.:]\d{2,3})?\]/.test(l));
            });
    }

    /** Segmentos estimados para videoclip / texto plano. */
    function loadPlainLyricSegments(text, duration) {
        if (typeof LyricsSync === 'undefined' || !text) return false;
        const pack = LyricsSync.segmentsFromPlainText(text, duration);
        if (!pack?.segments?.length) return false;
        lyricsSegments = pack.segments;
        lyricsSynced = true;
        return true;
    }

    function tryApproximateSync(text, duration, fetchId, isSuno) {
        if (!text || !Number.isFinite(duration) || duration <= 0) return false;
        const estimate = typeof LyricsId3 !== 'undefined' && LyricsId3.plainTextToEstimatedLines
            ? LyricsId3.plainTextToEstimatedLines(text, duration)
            : null;
        if (!estimate?.length) return false;
        if (fetchId !== lyricsFetchId) return true;
        const label = isSuno
            ? 'Suno · estimada (el MP3 no trae SYLT; el vídeo usa la API de suno.com)'
            : 'Sincronización estimada';
        const pack =
            typeof LyricsSync !== 'undefined'
                ? LyricsSync.segmentsFromPlainText(text, duration)
                : null;
        if (pack?.segments?.length) {
            renderLyricsPack(pack, label);
        }
        pendingPlainText = null;
        pendingPlainIsSuno = false;
        return true;
    }

    function pseudoRandom(seed, n) {
        const x = Math.sin(seed * 127.1 + n * 311.7) * 43758.5453;
        return x - Math.floor(x);
    }

    function applyVcPerspective(lineIndex) {
        const rx = (pseudoRandom(lineIndex, 1) - 0.5) * 14;
        const ry = (pseudoRandom(lineIndex, 2) - 0.5) * 18;
        const rz = (pseudoRandom(lineIndex, 3) - 0.5) * 8;
        const z = 28 + pseudoRandom(lineIndex, 4) * 48;

        vcCurrent.style.setProperty('--vc-rx', `${rx.toFixed(2)}deg`);
        vcCurrent.style.setProperty('--vc-ry', `${ry.toFixed(2)}deg`);
        vcCurrent.style.setProperty('--vc-rz', `${rz.toFixed(2)}deg`);
        vcCurrent.style.setProperty('--vc-z', `${z.toFixed(0)}px`);

        const ni = lineIndex + 1;
        vcNext.style.setProperty('--vc-next-rx', `${((pseudoRandom(ni, 5) - 0.5) * 10).toFixed(2)}deg`);
        vcNext.style.setProperty('--vc-next-ry', `${((pseudoRandom(ni, 6) - 0.5) * 14).toFixed(2)}deg`);
        vcNext.style.setProperty('--vc-next-rz', `${((pseudoRandom(ni, 7) - 0.5) * 6).toFixed(2)}deg`);
    }

    function setVcLineText(el, text) {
        el.textContent = '';
        const span = document.createElement('span');
        span.className = 'lyrics-vc__text';
        span.textContent = text || '…';
        el.appendChild(span);
    }

    function updateVideoclipDisplay(idx) {
        if (lyricsMode !== 'videoclip' || !lyricsSegments.length) return;

        const safeIdx = Math.max(0, Math.min(idx, lyricsSegments.length - 1));
        const current = lyricsSegments[safeIdx];
        const next = lyricsSegments[safeIdx + 1];

        setVcLineText(vcCurrent, current ? current.text : '');
        if (next) {
            setVcLineText(vcNext, next.text);
            vcNext.hidden = false;
        } else {
            vcNext.hidden = true;
        }

        if (safeIdx !== lastVcLineIndex) {
            lastVcLineIndex = safeIdx;
            applyVcPerspective(safeIdx);
        }
    }

    function getSubBassLevel() {
        if (!freqData) return 0;
        let peak = 0;
        let sum = 0;
        for (let b = 0; b <= 16; b++) {
            const v = freqData[b] / 255;
            peak = Math.max(peak, v);
            sum += v;
        }
        return peak * 0.65 + (sum / 17) * 0.35;
    }

    function detectKickHit() {
        if (!freqData) return 0;

        const kick = getSubBassLevel();
        const rise = kick - bassEnvelope;
        bassEnvelope = bassEnvelope * 0.78 + kick * 0.22;

        let power = 0;

        if (rise > 0.028 && kick > 0.28) {
            power = Math.max(power, Math.min(1, rise * 9 + 0.25));
        }
        if (kick > 0.34 && rise > 0.012) {
            power = Math.max(power, (kick - 0.3) * 2.5);
        }
        if (kick > bassEnvelope * 1.05 && kick > 0.36) {
            power = Math.max(power, kick * 0.9);
        }

        return Math.min(1, power);
    }

    function updateVideoclipBassShake() {
        if (lyricsMode !== 'videoclip' || lyricsVideoclip.hidden || audio.paused) return;

        const kickPower = detectKickHit();
        if (kickPower <= 0.08) return;

        const px = 0.9 + kickPower * 3.8;
        lyricsVideoclip.style.setProperty('--shake-x', `${px.toFixed(2)}px`);
        lyricsVideoclip.style.setProperty('--shake-y', `${(px * 0.6).toFixed(2)}px`);
        lyricsVideoclip.style.setProperty('--shake-r', `${(0.12 + kickPower * 0.5).toFixed(2)}deg`);
        lyricsVcStage.classList.add('is-kick-pulse');
        clearTimeout(lyricsVcStage._kickTimer);
        lyricsVcStage._kickTimer = setTimeout(() => {
            lyricsVcStage.classList.remove('is-kick-pulse');
        }, 160);
    }

    function refreshListLyricsVisibility() {
        lyricsVideoclip.hidden = true;
        vcHint.hidden = true;
        lyricsVcStage.hidden = false;

        if (!lyricsStatus.hidden) {
            lyricsScroll.hidden = true;
            lyricsPlain.hidden = true;
            return;
        }

        if (lyricsSynced) {
            lyricsScroll.hidden = false;
            lyricsStage.hidden = false;
            lyricsPlain.hidden = true;
        } else {
            lyricsScroll.hidden = true;
            lyricsStage.hidden = true;
            lyricsPlain.hidden = false;
        }
    }

    function applyLyricsMode(mode) {
        lyricsMode = mode;
        localStorage.setItem(LYRICS_MODE_KEY, mode);
        lyricsPanel.classList.toggle('is-videoclip-mode', mode === 'videoclip');

        if (mode === 'videoclip') {
            lyricsScroll.hidden = true;
            lyricsPlain.hidden = true;

            if (!lyricsStatus.hidden) {
                lyricsVideoclip.hidden = true;
                return;
            }

            lyricsVideoclip.hidden = false;

            if (!syncedLines.length && pendingPlainText) {
                activateVideoclipLines(pendingPlainText, audio.duration);
            }

            if (!syncedLines.length) {
                lyricsVcStage.hidden = true;
                vcHint.hidden = false;
                return;
            }

            lyricsVcStage.hidden = false;
            vcHint.hidden = true;
            const idx = activeLineIndex >= 0 ? activeLineIndex : 0;
            lastVcLineIndex = -1;
            updateVideoclipDisplay(idx);
        } else {
            refreshListLyricsVisibility();
            if (lyricsSynced && activeLineIndex >= 0) {
                updateKaraokeDisplay(activeLineIndex);
            }
        }
    }

    function syncLyricsModeInputs() {
        lyricsModeInputs.forEach((input) => {
            input.checked = input.value === lyricsMode;
        });
    }

    function setLyricsLoading() {
        lyricsScroll.hidden = true;
        lyricsKaraoke.hidden = true;
        lyricsPlain.hidden = true;
        lyricsVideoclip.hidden = true;
        lyricsStatus.hidden = false;
        lyricsStatus.className = 'lyrics-panel__status is-loading';
        lyricsStatus.textContent = 'Buscando letra…';
        syncedLines = [];
        lyricsSynced = false;
        activeLineIndex = -1;
        lyricsCueStarts = [];
        resetKaraokeView();
    }

    function setLyricsMessage(msg) {
        lyricsScroll.hidden = true;
        lyricsKaraoke.hidden = true;
        lyricsPlain.hidden = true;
        lyricsVideoclip.hidden = true;
        lyricsStatus.hidden = false;
        lyricsStatus.className = 'lyrics-panel__status';
        lyricsStatus.textContent = msg;
        syncedLines = [];
        lyricsSynced = false;
        activeLineIndex = -1;
        lyricsCueStarts = [];
        resetKaraokeView();
    }

    function resetKaraokeView() {
        if (lyricsKaraokePrev) lyricsKaraokePrev.textContent = '';
        if (lyricsKaraokeCurrent) lyricsKaraokeCurrent.textContent = '';
        if (lyricsKaraokeNext) lyricsKaraokeNext.textContent = '';
        if (lyricsKaraokeBadge) {
            lyricsKaraokeBadge.hidden = true;
            lyricsKaraokeBadge.textContent = '';
        }
    }

    function updateKaraokeDisplay(idx) {
        if (!lyricsKaraoke || !lyricsKaraokeCurrent) return;

        if (idx < 0 || !syncedLines.length) {
            resetKaraokeView();
            return;
        }

        const prev = syncedLines[idx - 1];
        const cur = syncedLines[idx];
        const next = syncedLines[idx + 1];

        lyricsKaraokePrev.textContent = prev ? prev.text : '';
        lyricsKaraokeCurrent.textContent = cur ? cur.text : '';
        lyricsKaraokeNext.textContent = next ? next.text : '';
        lyricsKaraokePrev.hidden = !prev;
        lyricsKaraokeNext.hidden = !next;
    }

    function renderSyncedLines(lines, sourceLabel) {
        syncedLines = lines;
        lyricsCueStarts = lines.map((l) => l.start);
        lyricsSynced = true;
        pendingPlainText = null;
        activeLineIndex = -1;
        lyricsStatus.hidden = true;
        lyricsPlain.hidden = true;
        lyricsScroll.hidden = false;
        lyricsScroll.classList.add('is-synced');
        lyricsKaraoke.hidden = false;
        lyricsList.hidden = true;

        if (sourceLabel && lyricsKaraokeBadge) {
            lyricsKaraokeBadge.textContent = sourceLabel;
            lyricsKaraokeBadge.hidden = false;
        } else if (lyricsKaraokeBadge) {
            lyricsKaraokeBadge.hidden = true;
        }

        if (!lyricsKaraokeCurrent.dataset.boundSeek) {
            lyricsKaraokeCurrent.dataset.boundSeek = '1';
            lyricsKaraokeCurrent.addEventListener('click', () => {
                const idx = activeLineIndex >= 0 ? activeLineIndex : 0;
                const cue = syncedLines[idx];
                if (cue && cue.start != null) {
                    audio.currentTime = Math.max(0, cue.start);
                    updateLyricsHighlight(getLyricsPlaybackTime());
                }
            });
        }

        lastVcLineIndex = -1;
        activeLineIndex = -1;
        resetKaraokeView();
        applyLyricsMode(lyricsMode);
        updateLyricsHighlight(getLyricsPlaybackTime());
    }

    function renderPlainLyrics(text, options) {
        const isSuno = options?.isSuno === true;
        activeLineIndex = -1;
        pendingPlainText = text;
        pendingPlainIsSuno = isSuno;
        activateVideoclipLines(text, audio.duration);
        lyricsStatus.hidden = true;
        lyricsScroll.hidden = true;
        lyricsPlain.hidden = false;
        lyricsPlain.className = 'lyrics-panel__plain is-unsynced';
        lyricsPlain.textContent = text;
        const note = document.createElement('p');
        note.className = 'lyrics-panel__badge';
        note.textContent = isSuno
            ? 'Suno · sin LRC (videoclip usa tiempos estimados al reproducir)'
            : 'Sin LRC · videoclip estima tiempos al reproducir';
        lyricsPlain.appendChild(document.createElement('br'));
        lyricsPlain.appendChild(note);
        applyLyricsMode(lyricsMode);
    }

    function getActiveLineIndex(t) {
        if (!syncedLines.length) return -1;

        if (syncedLines[0].start == null) {
            const dur = audio.duration;
            if (!Number.isFinite(dur) || dur <= 0) return 0;
            const slot = dur / syncedLines.length;
            return Math.min(syncedLines.length - 1, Math.max(0, Math.floor(t / slot)));
        }

        const starts = lyricsCueStarts;
        if (!starts.length) return -1;

        let lo = 0;
        let hi = starts.length - 1;
        let idx = -1;

        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (starts[mid] <= t) {
                idx = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }

        return idx;
    }

    function updateLyricsHighlight(t) {
        if (!syncedLines.length) return;

        const idx = getActiveLineIndex(t);
        if (idx === activeLineIndex) return;

        activeLineIndex = idx;

        if (lyricsMode === 'videoclip') {
            updateVideoclipDisplay(idx >= 0 ? idx : 0);
            return;
        }

        if (lyricsSynced) {
            updateKaraokeDisplay(idx);
        }
    }

    function startLyricsLoop() {
        updateLyricsHighlight(getLyricsPlaybackTime());
    }

    function stopLyricsLoop() {}

    async function fetchFromLrclib(meta) {
        if (!meta.title) return null;

        const params = new URLSearchParams({
            track_name: meta.title,
            artist_name: meta.artist || '',
        });
        if (meta.album) params.set('album_name', meta.album);
        if (meta.duration > 0) params.set('duration', String(Math.round(meta.duration)));

        const res = await fetch(`https://lrclib.net/api/get?${params}`);
        if (res.status === 404) return null;
        if (!res.ok) throw new Error('lrclib');
        return res.json();
    }

    async function resolveLyrics(meta, embeddedText, fetchId, file) {
        lyricsTimingOffset = 0;
        let plainFromFile = embeddedText || '';
        let plainIsSuno = false;

        if (externalLrcText) {
            const parsed = parseLrc(externalLrcText);
            if (parsed?.length) {
                if (fetchId !== lyricsFetchId) return;
                renderSyncedLines(parsed, 'Archivo · .lrc');
                return;
            }
        }

        if (file && typeof LyricsId3 !== 'undefined') {
            try {
                const id3Lyrics = await LyricsId3.extractLyricsFromMp3(file);
                if (fetchId !== lyricsFetchId) return;

                if (id3Lyrics?.type === 'synced' && id3Lyrics.lines?.length) {
                    renderSyncedLines(
                        applyLyricsTimingAdjust(id3Lyrics.lines),
                        id3Lyrics.source || 'Archivo · sincronizada'
                    );
                    return;
                }

                if (id3Lyrics?.type === 'plain' && id3Lyrics.text) {
                    plainFromFile = plainFromFile || id3Lyrics.text;
                    plainIsSuno = Boolean(id3Lyrics.isSuno);
                }
            } catch {
                /* seguir con jsmediatags / LRCLIB */
            }
        }

        if (plainFromFile && looksLikeLrc(plainFromFile)) {
            const parsed = parseLrc(plainFromFile);
            if (parsed && parsed.length) {
                if (fetchId !== lyricsFetchId) return;
                renderSyncedLines(parsed, 'Archivo · LRC');
                return;
            }
        }

        let lrcData = null;
        try {
            lrcData = await fetchFromLrclib(meta);
        } catch {
            if (fetchId !== lyricsFetchId) return;
        }

        if (fetchId !== lyricsFetchId) return;

        if (lrcData && lrcData.syncedLyrics) {
            lyricsTimingOffset = 0;
            if (typeof lrcData.instrumentalOffset === 'number') {
                lyricsTimingOffset = lrcData.instrumentalOffset / 1000;
            }
            const parsed = parseLrc(lrcData.syncedLyrics);
            if (parsed && parsed.length) {
                renderSyncedLines(parsed, 'LRCLIB · sincronizada');
                return;
            }
        }

        const duration = meta.duration || audio.duration;

        if (plainFromFile && !looksLikeLrc(plainFromFile)) {
            if (tryApproximateSync(plainFromFile, duration, fetchId, plainIsSuno)) return;
            if (fetchId !== lyricsFetchId) return;
            renderPlainLyrics(plainFromFile, { isSuno: plainIsSuno });
            return;
        }

        if (lrcData && lrcData.plainLyrics) {
            const plain = lrcData.plainLyrics.trim();
            if (tryApproximateSync(plain, duration, fetchId, false)) return;
            if (fetchId !== lyricsFetchId) return;
            renderPlainLyrics(plain);
            return;
        }

        setLyricsMessage('No se encontró letra para esta canción');
    }

    function onMetadataReady(file, tags, embeddedLyrics) {
        const fromFile = parseArtistTitleFromFilename(file.name);
        trackMeta = {
            title: tags.title || fromFile.title || titleFromFilename(file.name),
            artist: tags.artist || fromFile.artist || '',
            album: tags.album || '',
            duration: Number.isFinite(audio.duration) ? audio.duration : 0,
        };

        const fetchId = ++lyricsFetchId;
        setLyricsLoading();
        resolveLyrics(trackMeta, embeddedLyrics, fetchId, currentAudioFile);
    }

    function readMetadata(file) {
        const fallback = parseArtistTitleFromFilename(file.name);
        trackTitle.textContent = fallback.title;
        trackMeta = { title: fallback.title, artist: fallback.artist, album: '', duration: 0 };
        resetCover();
        setLyricsMessage('Sube una canción para ver la letra');

        if (typeof jsmediatags === 'undefined') {
            setLyricsLoading();
            const fetchId = ++lyricsFetchId;
            audio.addEventListener('loadedmetadata', function once() {
                trackMeta.duration = audio.duration;
                resolveLyrics(trackMeta, '', fetchId, file);
                audio.removeEventListener('loadedmetadata', once);
            }, { once: true });
            return;
        }

        jsmediatags.read(file, {
            onSuccess(tag) {
                const tags = tag.tags || {};
                if (tags.title) trackTitle.textContent = tags.title;
                if (tags.picture && tags.picture.data) {
                    const blob = new Blob([new Uint8Array(tags.picture.data)], {
                        type: tags.picture.format || 'image/jpeg',
                    });
                    const reader = new FileReader();
                    reader.onload = (ev) => setCoverFromDataUrl(ev.target.result);
                    reader.readAsDataURL(blob);
                }

                const embeddedLyrics = extractLyricsText(tags);

                if (Number.isFinite(audio.duration) && audio.duration > 0) {
                    onMetadataReady(file, tags, embeddedLyrics);
                } else {
                    audio.addEventListener('loadedmetadata', function once() {
                        onMetadataReady(file, tags, embeddedLyrics);
                        audio.removeEventListener('loadedmetadata', once);
                    }, { once: true });
                }
            },
            onError() {
                const fetchId = ++lyricsFetchId;
                setLyricsLoading();
                trackMeta = {
                    title: fallback.title,
                    artist: fallback.artist,
                    album: '',
                    duration: 0,
                };
                audio.addEventListener('loadedmetadata', function once() {
                    trackMeta.duration = audio.duration;
                    resolveLyrics(trackMeta, '', fetchId, file);
                    audio.removeEventListener('loadedmetadata', once);
                }, { once: true });
            },
        });
    }

    function freqToBin(freq, sampleRate, fftSize, maxBin) {
        return Math.min(maxBin, Math.max(0, Math.round((freq * fftSize) / sampleRate)));
    }

    /** Simétrico: centro = graves (40 Hz), extremos = agudos (17.5 kHz), escala log. */
    function buildSymmetricSpectrumMap(bufferLength) {
        barSpectrumMap = [];
        const maxBin = bufferLength - 1;
        const center = (BAR_COUNT - 1) / 2;
        const sampleRate = audioCtx?.sampleRate || 48000;
        const fftSize = analyser?.fftSize || 2048;
        const logMin = Math.log10(CAVA_CONFIG.lowerCutoffFreq);
        const logMax = Math.log10(CAVA_CONFIG.higherCutoffFreq);

        for (let i = 0; i < BAR_COUNT; i++) {
            const sideNorm = Math.abs(i - center) / center;
            const freq = Math.pow(10, logMin + sideNorm * (logMax - logMin));
            const bin = freqToBin(freq, sampleRate, fftSize, maxBin);
            const blendBins = [bin];
            if (sideNorm > 0.04 && sideNorm < 0.98) {
                blendBins.push(Math.max(0, bin - 1), Math.min(maxBin, bin + 1));
            }

            barSpectrumMap.push({
                bin,
                blendBins: [...new Set(blendBins)],
            });
        }
    }

    const VISUALIZER_GAIN = (CAVA_CONFIG.sensitivity / 100) * 0.44 * (CAVA_CONFIG.autosens / 2);
    const VISUALIZER_MAX_SCALE = 0.68;

    function initVisualizerBars() {
        visualizerBars.innerHTML = '';
        visualizerBars.style.gridTemplateColumns = `repeat(${BAR_COUNT}, minmax(0, 1fr))`;
        visualizerBars.style.gap = `${CAVA_CONFIG.barSpacing}px`;
        barFills.length = 0;
        barSmoothLevels.length = 0;
        for (let i = 0; i < BAR_COUNT; i++) {
            const bar = document.createElement('div');
            bar.className = 'visualizer__bar';
            const fill = document.createElement('div');
            fill.className = 'visualizer__bar-fill';
            bar.appendChild(fill);
            visualizerBars.appendChild(bar);
            barFills.push(fill);
            barSmoothLevels.push(0.22);
        }
    }

    function ensureAudioContext() {
        if (audioCtx) return;
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0.48;
        analyser.minDecibels = -90;
        analyser.maxDecibels = -5;
        audioSource = audioCtx.createMediaElementSource(audio);
        audioSource.connect(analyser);
        analyser.connect(audioCtx.destination);
        freqData = new Uint8Array(analyser.frequencyBinCount);
        buildSymmetricSpectrumMap(freqData.length);
    }

    function sampleSpectrumBar(map, data) {
        const { blendBins } = map;
        let sum = 0;
        let peak = 0;

        blendBins.forEach((b) => {
            const v = data[b] / 255;
            sum += v;
            peak = Math.max(peak, v);
        });

        const avg = sum / blendBins.length;
        return Math.pow(avg * 0.55 + peak * 0.45, 0.88) * VISUALIZER_GAIN;
    }

    function setBarScales(scale) {
        const idle = scale <= 0.08 ? 0.22 : scale;
        barFills.forEach((fill, i) => {
            barSmoothLevels[i] = idle;
            fill.style.transform = `scaleY(${idle})`;
        });
        visualizerSensFloor = 0.06;
        visualizerPeakHold = 0.14;
    }

    function updateVisualizer() {
        if (!analyser || !freqData) {
            paintIdleVisualizerWave();
            return;
        }

        analyser.getByteFrequencyData(freqData);

        if (barSpectrumMap.length !== BAR_COUNT) {
            buildSymmetricSpectrumMap(freqData.length);
        }

        const raw = [];
        for (let i = 0; i < BAR_COUNT; i++) {
            const map = barSpectrumMap[i];
            raw.push(map ? sampleSpectrumBar(map, freqData) : 0);
        }

        const framePeak = Math.max(...raw, 0.08);
        const frameMin = Math.min(...raw);
        const autosensRate = CAVA_CONFIG.autosens * 0.011;

        visualizerSensFloor = visualizerSensFloor * (1 - autosensRate) + frameMin * autosensRate;
        visualizerPeakHold = Math.max(
            framePeak,
            visualizerPeakHold * (1 - autosensRate * 1.4)
        );

        const normalizeBase = Math.max(
            visualizerSensFloor * 1.75,
            visualizerPeakHold * 0.96,
            0.12
        );

        for (let i = 0; i < BAR_COUNT; i++) {
            const relative = raw[i] / normalizeBase;
            const target = Math.max(0.1, Math.min(VISUALIZER_MAX_SCALE, relative * VISUALIZER_MAX_SCALE));
            const prev = barSmoothLevels[i];
            const smooth = target > prev ? 0.34 : 0.18;
            const scale = prev + (target - prev) * smooth;
            barSmoothLevels[i] = scale;
            barFills[i].style.transform = `scaleY(${scale})`;
        }

        updateVideoclipBassShake();
    }

    function visualizerTick(timestamp) {
        if (!lastVisualizerFrame) lastVisualizerFrame = timestamp;
        const frameInterval = 1000 / CAVA_CONFIG.framerate;

        if (timestamp - lastVisualizerFrame >= frameInterval) {
            lastVisualizerFrame = timestamp;
            updateVisualizer();
        }

        if (!audio.paused && !audio.ended) {
            visualizerAnimId = requestAnimationFrame(visualizerTick);
        } else {
            visualizerAnimId = null;
            lastVisualizerFrame = 0;
        }
    }

    function startVisualizer() {
        enableVisualizerPanel();
        if (audioCtx && audioCtx.state === 'suspended') {
            audioCtx.resume().catch(() => {});
        }
        if (!visualizerAnimId) visualizerTick();
    }

    function stopVisualizer() {
        stopVisualizerAnimation();
        paintIdleVisualizerWave();
    }

    function resetPlayerUi() {
        audio.removeAttribute('src');
        audio.pause();
        setPlayerEmpty();
        playIcon.className = 'fas fa-play';
        progressRange.value = '0';
        currentTimeEl.textContent = '0:00';
        durationEl.textContent = '0:00';
        resetCover();
        stopLyricsLoop();
        resetVisualizer();
        pendingPlainText = null;
        pendingPlainIsSuno = false;
        externalLrcText = null;
        currentAudioFile = null;
        lyricsTimingOffset = 0;
        lyricsFetchId++;
        setLyricsMessage('Sube una canción para ver la letra');
    }

    function loadFile(file) {
        if (!file || !file.type.startsWith('audio/')) return;

        revokeObjectUrl();
        resetPlayerUi();
        setLyricsLoading();
        currentAudioFile = file;

        objectUrl = URL.createObjectURL(file);
        audio.src = objectUrl;
        setPlayerReady();
        readMetadata(file);
    }

    fileInput.addEventListener('change', () => {
        const file = fileInput.files && fileInput.files[0];
        if (file) loadFile(file);
        fileInput.value = '';
    });

    coverUpload.addEventListener('dragover', (e) => {
        e.preventDefault();
        coverUpload.classList.add('is-dragover');
    });

    coverUpload.addEventListener('dragleave', () => {
        coverUpload.classList.remove('is-dragover');
    });

    coverUpload.addEventListener('drop', (e) => {
        e.preventDefault();
        coverUpload.classList.remove('is-dragover');
        const file = e.dataTransfer.files && e.dataTransfer.files[0];
        if (file) loadFile(file);
    });

    coverUpload.addEventListener('click', (e) => {
        if (!playerEl.classList.contains('has-track')) return;
        if (e.target.closest('label[for="fileInput"]')) return;
        fileInput.click();
    });

    function updatePlayIcon() {
        playIcon.className = audio.paused ? 'fas fa-play' : 'fas fa-pause';
        playBtn.setAttribute('aria-label', audio.paused ? 'Reproducir' : 'Pausar');
    }

    playBtn.addEventListener('click', () => {
        if (!audio.src) return;
        if (audio.paused) {
            audio.play().catch(() => {});
        } else {
            audio.pause();
        }
    });

    audio.addEventListener('play', () => {
        updatePlayIcon();
        ensureAudioContext();
        if (audioCtx && audioCtx.state === 'suspended') {
            audioCtx.resume().catch(() => {});
        }
        startLyricsLoop();
        startVisualizer();
    });

    audio.addEventListener('pause', () => {
        updatePlayIcon();
        stopLyricsLoop();
        updateLyricsHighlight(getLyricsPlaybackTime());
        stopVisualizer();
        updateVisualizer();
    });

    audio.addEventListener('loadedmetadata', () => {
        durationEl.textContent = formatTime(audio.duration);
        progressRange.max = String(audio.duration || 100);
        if (trackMeta) trackMeta.duration = audio.duration;

        if (pendingPlainText && audio.duration > 0) {
            const fetchId = lyricsFetchId;
            if (!lyricsSynced && tryApproximateSync(pendingPlainText, audio.duration, fetchId, pendingPlainIsSuno)) {
                return;
            }
            if (lyricsMode === 'videoclip' && syncedLines.length) {
                activateVideoclipLines(pendingPlainText, audio.duration);
                updateVideoclipDisplay(getActiveLineIndex(getLyricsPlaybackTime()));
            }
        }
    });

    audio.addEventListener('timeupdate', () => {
        const t = audio.currentTime;
        if (!isSeeking) {
            progressRange.value = String(t);
            currentTimeEl.textContent = formatTime(t);
        }
        if (!audio.paused && !audio.ended && syncedLines.length) {
            updateLyricsHighlight(t);
        }
    });

    audio.addEventListener('ended', () => {
        updatePlayIcon();
        progressRange.value = '0';
        currentTimeEl.textContent = '0:00';
        stopLyricsLoop();
        stopVisualizer();
        updateLyricsHighlight(0);
    });

    progressRange.addEventListener('input', () => {
        isSeeking = true;
        const t = Number(progressRange.value);
        currentTimeEl.textContent = formatTime(t);
        updateLyricsHighlight(getLyricsPlaybackTime(Number(progressRange.value)));
    });

    progressRange.addEventListener('change', () => {
        audio.currentTime = Number(progressRange.value);
        isSeeking = false;
        updateLyricsHighlight(getLyricsPlaybackTime());
    });

    progressRange.addEventListener('pointerdown', () => { isSeeking = true; });
    progressRange.addEventListener('pointerup', () => { isSeeking = false; });

    lyricsModeInputs.forEach((input) => {
        input.addEventListener('change', () => {
            if (input.checked) applyLyricsMode(input.value);
        });
    });

    if (lrcInput) {
        lrcInput.addEventListener('change', () => {
            const file = lrcInput.files && lrcInput.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
                externalLrcText = String(reader.result || '').trim();
                lrcInput.value = '';
                if (!currentAudioFile && !audio.src) return;
                const fetchId = ++lyricsFetchId;
                setLyricsLoading();
                resolveLyrics(trackMeta, pendingPlainText || '', fetchId, currentAudioFile);
            };
            reader.readAsText(file);
        });
    }

    try {
        const storedMode = localStorage.getItem(LYRICS_MODE_KEY);
        if (storedMode === 'videoclip' || storedMode === 'list') {
            lyricsMode = storedMode;
        }
    } catch (e) {}

    syncLyricsModeInputs();
    applyLyricsMode(lyricsMode);

    initVisualizerBars();
    visualizerEl.classList.add('is-live');
    paintIdleVisualizerWave();
})();
