(function () {
    const STORAGE_KEY = 'theme';
    const VOLUME_STORAGE_KEY = 'mptres-volume';
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
    const volumeRange = document.getElementById('volumeRange');
    const volumeValue = document.getElementById('volumeValue');
    const volumeIcon = document.getElementById('volumeIcon');
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
    const lyricsEpic = document.getElementById('lyricsEpic');
    const lyricsEpicStage = document.getElementById('lyricsEpicStage');
    const epicHint = document.getElementById('epicHint');
    const songLibrary = document.getElementById('songLibrary');
    const playerPrevBtn = document.getElementById('playerPrevBtn');
    const playerNextBtn = document.getElementById('playerNextBtn');

    const SONGS_BASE = 'songs/';

    let lyricsMode = 'epic';
    let songCatalog = [];
    let activeCatalogId = null;
    let lastVcLineIndex = -1;
    let lastEpicLineIndex = -1;
    let epicCurrentEl = null;
    let epicNextEl = null;
    let epicPrevEl = null;
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
    let trackMeta = { title: '', artist: '', album: '', duration: 0 };
    let currentAudioFile = null;

    /** Perfil adaptado desde config CAVA del usuario */
    const CAVA_CONFIG = {
        framerate: 100,
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
        updateEpicCoverBg();
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

    function parseLrcPack(lrcText, extraOffsetSec = 0) {
        if (typeof LyricsSync === 'undefined' || !lrcText?.trim()) return null;
        if (!looksLikeLrc(lrcText)) return null;
        return LyricsSync.parseLrcForPlayer(lrcText, {
            offsetSec: extraOffsetSec,
            duration: Number.isFinite(audio.duration) ? audio.duration : 0,
        });
    }

    /** Aplica el .lrc importado tal cual (solo [offset:] del propio archivo). */
    function applyExternalLrc() {
        if (!externalLrcText) return false;

        if (typeof LyricsSync === 'undefined') {
            setLyricsMessage('No se pudo cargar el sincronizador de letra (.lrc)');
            return false;
        }

        const pack = parseLrcPack(externalLrcText, 0);
        if (!pack?.segments?.length) {
            setLyricsMessage('Archivo .lrc no válido o sin tiempos reconocibles');
            return false;
        }

        renderLyricsPack(pack, 'Archivo · .lrc');
        return true;
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
        let span = el.querySelector('.lyrics-vc__text');
        if (!span) {
            span = document.createElement('span');
            span.className = 'lyrics-vc__text';
            el.appendChild(span);
        }
        const next = text || '…';
        if (span.textContent !== next) span.textContent = next;
    }

    function updateVideoclipDisplay(idx, t) {
        if (lyricsMode !== 'videoclip' || !lyricsSegments.length) return;

        if (idx < 0) {
            setVcLineText(vcCurrent, '');
            vcNext.hidden = true;
            return;
        }

        const safeIdx = Math.min(idx, lyricsSegments.length - 1);
        const current = lyricsSegments[safeIdx];
        const next = lyricsSegments[safeIdx + 1];
        const playbackT = t != null ? t : getLyricsPlaybackTime();

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

    /* ─── Modo Épico: lógica ─── */
    const EPIC_FONTS = ['epic-font-0', 'epic-font-1', 'epic-font-2', 'epic-font-3', 'epic-font-4', 'epic-font-5'];
    const EPIC_SIZES = ['epic-size-0', 'epic-size-1', 'epic-size-2', 'epic-size-3', 'epic-size-4'];
    const EPIC_ANIMS_IN = [
        'epic-anim-slam', 'epic-anim-slide-left', 'epic-anim-slide-right',
        'epic-anim-rise', 'epic-anim-drop', 'epic-anim-flip',
        'epic-anim-spin', 'epic-anim-zoom-blur', 'epic-anim-tilt-3d',
    ];
    const EPIC_ANIMS_OUT = [
        'epic-anim-exit-shrink', 'epic-anim-exit-left',
        'epic-anim-exit-right', 'epic-anim-exit-up',
    ];

    const EPIC_DRIFTS = [
        null,
        null,
        null,
        'epic-drift-sway-2d',
        'epic-drift-rock-y',
        'epic-drift-tilt-depth',
        'epic-drift-wobble',
        'epic-drift-float',
        'epic-drift-perspective-left',
        'epic-drift-perspective-right',
        'epic-drift-tilt-3d-deep',
    ];
    /* spin-slow quitado: 360° invierte el texto */
    const EPIC_VOLUMES = [null, null, 'epic-vol-emboss', 'epic-vol-extrude', 'epic-vol-deep'];
    let lastEpicFont = -1;
    let lastEpicSize = -1;
    let lastEpicAnim = -1;
    let lastEpicDrift = -1;
    let epicCoverBgEnabled = false;
    const EPIC_COVER_BG_KEY = 'epicCoverBg';
    let epicKaraokeEnabled = false;
    const EPIC_KARAOKE_KEY = 'epicKaraoke';
    let epicKaraokeWords = [];
    let epicKaraokeSegStart = 0;
    let epicKaraokeSegEnd = 0;
    let epicKaraokeRafId = null;

    function epicPickRandom(arr, lastIdx) {
        if (arr.length <= 1) return 0;
        let idx;
        do { idx = Math.floor(Math.random() * arr.length); } while (idx === lastIdx);
        return idx;
    }

    let lastEpicVol = -1;

    function epicCreateLine(text, className, segIdx) {
        const el = document.createElement('div');
        el.className = 'epic-line ' + className;

        const fi = epicPickRandom(EPIC_FONTS, lastEpicFont);
        lastEpicFont = fi;
        el.classList.add(EPIC_FONTS[fi]);

        const si = epicPickRandom(EPIC_SIZES, lastEpicSize);
        lastEpicSize = si;
        el.classList.add(EPIC_SIZES[si]);

        if (className === 'epic-line--current') {
            const vi = epicPickRandom(EPIC_VOLUMES, lastEpicVol);
            lastEpicVol = vi;
            if (EPIC_VOLUMES[vi]) el.classList.add(EPIC_VOLUMES[vi]);
        }

        const isCurrent = className === 'epic-line--current';
        const useKaraoke = isCurrent && epicKaraokeEnabled && text;

        if (useKaraoke) {
            const wrapper = document.createElement('span');
            wrapper.className = 'epic-line__text';
            const words = text.split(/(\s+)/);
            const wordEls = [];
            words.forEach((w) => {
                const wordSpan = document.createElement('span');
                if (/\S/.test(w)) {
                    wordSpan.className = 'epic-word is-unseen';
                    wordSpan.textContent = w;
                    wordEls.push(wordSpan);
                } else {
                    wordSpan.textContent = w;
                }
                wrapper.appendChild(wordSpan);
            });
            el.appendChild(wrapper);

            const seg = lyricsSegments[segIdx];
            const nextSeg = lyricsSegments[segIdx + 1];
            const segStart = seg?.start ?? 0;
            const segEnd = seg?.end ?? (nextSeg?.start ?? segStart + 3);
            epicKaraokeSetup(wordEls, segStart, segEnd);
        } else {
            const span = document.createElement('span');
            span.className = 'epic-line__text';
            span.textContent = text || '';
            el.appendChild(span);
            if (isCurrent) epicKaraokeStop();
        }

        return el;
    }

    function epicAnimateIn(el) {
        if (!el) return;
        const ai = epicPickRandom(EPIC_ANIMS_IN, lastEpicAnim);
        lastEpicAnim = ai;
        const entryClass = EPIC_ANIMS_IN[ai];
        el.classList.add(entryClass);

        const di = epicPickRandom(EPIC_DRIFTS, lastEpicDrift);
        lastEpicDrift = di;
        const drift = EPIC_DRIFTS[di];

        el.addEventListener('animationend', function onEntryEnd(e) {
            if (e.target !== el) return;
            el.removeEventListener('animationend', onEntryEnd);
            el.style.opacity = '1';
            el.style.transform = 'translate(-50%, -50%)';
            el.classList.remove(entryClass);
            if (drift) {
                requestAnimationFrame(() => {
                    el.classList.add(drift);
                });
            }
        });
    }

    function epicAnimateOut(el) {
        if (!el) return;
        EPIC_DRIFTS.forEach((d) => { if (d) el.classList.remove(d); });
        el.style.opacity = '1';
        el.style.transform = 'translate(-50%, -50%)';
        void el.offsetWidth;
        const cls = EPIC_ANIMS_OUT[Math.floor(Math.random() * EPIC_ANIMS_OUT.length)];
        el.classList.add(cls);
        el.addEventListener('animationend', () => el.remove(), { once: true });
        setTimeout(() => { if (el.parentNode) el.remove(); }, 500);
    }

    function updateEpicDisplay(idx) {
        if (lyricsMode !== 'epic' || !lyricsSegments.length) return;
        if (!lyricsEpicStage) return;

        if (idx < 0) {
            if (epicCurrentEl) { epicAnimateOut(epicCurrentEl); epicCurrentEl = null; }
            if (epicNextEl) { epicNextEl.remove(); epicNextEl = null; }
            if (epicPrevEl) { epicPrevEl.remove(); epicPrevEl = null; }
            return;
        }

        const safeIdx = Math.min(idx, lyricsSegments.length - 1);

        if (safeIdx === lastEpicLineIndex) return;
        lastEpicLineIndex = safeIdx;

        if (epicPrevEl && epicPrevEl.parentNode) epicPrevEl.remove();

        if (epicCurrentEl) {
            epicPrevEl = epicCurrentEl;
            epicAnimateOut(epicPrevEl);
        }

        if (epicNextEl) {
            epicNextEl.remove();
            epicNextEl = null;
        }

        const seg = lyricsSegments[safeIdx];
        epicCurrentEl = epicCreateLine(seg?.text || '', 'epic-line--current', safeIdx);
        lyricsEpicStage.appendChild(epicCurrentEl);
        epicAnimateIn(epicCurrentEl);

        const nextSeg = lyricsSegments[safeIdx + 1];
        if (nextSeg) {
            epicNextEl = epicCreateLine(nextSeg.text, 'epic-line--next', safeIdx + 1);
            epicNextEl.classList.add('epic-anim-next-in');
            epicNextEl.style.fontSize = 'clamp(0.85rem, 4cqi, 1.2rem)';
            lyricsEpicStage.appendChild(epicNextEl);
        }
    }

    let epicGlowSmooth = 0;

    function updateEpicBassShake() {
        if (lyricsMode !== 'epic' || !lyricsEpic || lyricsEpic.hidden || audio.paused) return;
        if (!lyricsEpicStage) return;

        const kickPower = detectKickHit();

        const glowTarget = Math.min(1, kickPower * 2.5);
        epicGlowSmooth = epicGlowSmooth * 0.6 + glowTarget * 0.4;
        const glowSize = (8 + epicGlowSmooth * 40).toFixed(1);
        const glowAlpha = Math.min(0.85, epicGlowSmooth * 0.9).toFixed(3);

        if (epicCurrentEl) {
            epicCurrentEl.style.setProperty('--epic-glow-size', `${glowSize}px`);
            epicCurrentEl.style.setProperty('--epic-glow-alpha', glowAlpha);
        }

        if (kickPower <= 0.08) return;

        const px = 1.2 + kickPower * 5;
        lyricsEpic.style.setProperty('--epic-shake-x', `${px.toFixed(2)}px`);
        lyricsEpic.style.setProperty('--epic-shake-y', `${(px * 0.7).toFixed(2)}px`);
        lyricsEpic.style.setProperty('--epic-shake-r', `${(0.15 + kickPower * 0.6).toFixed(2)}deg`);
        lyricsEpic.style.setProperty('--epic-shake-s', `${(kickPower * 0.025).toFixed(4)}`);
        lyricsEpicStage.classList.add('is-epic-kick');
        clearTimeout(lyricsEpicStage._epicKickTimer);
        lyricsEpicStage._epicKickTimer = setTimeout(() => {
            lyricsEpicStage.classList.remove('is-epic-kick');
        }, 140);
    }

    function epicKaraokeSetup(wordEls, start, end) {
        epicKaraokeWords = wordEls;
        epicKaraokeSegStart = start;
        epicKaraokeSegEnd = end;

        if (!epicKaraokeRafId) {
            epicKaraokeLoop();
        }
    }

    function epicKaraokeLoop() {
        if (!epicKaraokeWords.length || lyricsMode !== 'epic' || !epicKaraokeEnabled) {
            epicKaraokeRafId = null;
            return;
        }

        const t = audio.currentTime;
        const total = epicKaraokeSegEnd - epicKaraokeSegStart;
        const elapsed = t - epicKaraokeSegStart;
        const totalChars = epicKaraokeWords.reduce((s, w) => s + w.textContent.length, 0);

        if (total > 0 && totalChars > 0) {
            let charsSoFar = 0;
            for (let i = 0; i < epicKaraokeWords.length; i++) {
                const w = epicKaraokeWords[i];
                const wLen = w.textContent.length;
                const wordStart = (charsSoFar / totalChars) * total;
                const wordEnd = ((charsSoFar + wLen) / totalChars) * total;

                if (elapsed < wordStart) {
                    w.className = 'epic-word is-unseen';
                    w.style.removeProperty('--karaoke-progress');
                } else if (elapsed >= wordEnd) {
                    w.className = 'epic-word is-sung';
                    w.style.removeProperty('--karaoke-progress');
                } else {
                    const wordProgress = ((elapsed - wordStart) / (wordEnd - wordStart)) * 100;
                    w.className = 'epic-word is-singing';
                    w.style.setProperty('--karaoke-progress', `${Math.min(100, wordProgress).toFixed(1)}%`);
                }
                charsSoFar += wLen;
            }
        }

        if (!audio.paused) {
            epicKaraokeRafId = requestAnimationFrame(epicKaraokeLoop);
        } else {
            epicKaraokeRafId = null;
        }
    }

    function epicKaraokeStop() {
        epicKaraokeWords = [];
        if (epicKaraokeRafId) {
            cancelAnimationFrame(epicKaraokeRafId);
            epicKaraokeRafId = null;
        }
    }

    function toggleEpicKaraoke() {
        epicKaraokeEnabled = !epicKaraokeEnabled;
        try { localStorage.setItem(EPIC_KARAOKE_KEY, epicKaraokeEnabled ? '1' : ''); } catch {}
        const btn = document.getElementById('epicKaraokeToggle');
        if (btn) btn.classList.toggle('is-on', epicKaraokeEnabled);
        if (epicKaraokeEnabled && epicCurrentEl && lyricsSegments.length && lastEpicLineIndex >= 0) {
            const idx = lastEpicLineIndex;
            lastEpicLineIndex = -1;
            updateEpicDisplay(idx);
        } else if (!epicKaraokeEnabled) {
            epicKaraokeStop();
            if (epicCurrentEl && lyricsSegments.length && lastEpicLineIndex >= 0) {
                const idx = lastEpicLineIndex;
                lastEpicLineIndex = -1;
                updateEpicDisplay(idx);
            }
        }
    }

    function resetEpicMode() {
        lastEpicLineIndex = -1;
        epicCurrentEl = null;
        epicNextEl = null;
        epicPrevEl = null;
        epicGlowSmooth = 0;
        epicKaraokeStop();
        if (lyricsEpicStage) lyricsEpicStage.innerHTML = '';
    }

    function getLyricsPanelBody() {
        return document.querySelector('.lyrics-panel__body');
    }

    function updateEpicCoverBg() {
        const bg = document.getElementById('epicCoverBg');
        if (!bg) return;

        if (!epicCoverBgEnabled) {
            bg.style.backgroundImage = '';
            return;
        }

        const src = coverArt && !coverArt.hidden ? coverArt.src : null;
        if (src) {
            bg.style.backgroundImage = `url('${src}')`;
        } else {
            bg.style.backgroundImage = '';
        }
    }

    function toggleEpicCoverBg() {
        epicCoverBgEnabled = !epicCoverBgEnabled;
        try { localStorage.setItem(EPIC_COVER_BG_KEY, epicCoverBgEnabled ? '1' : ''); } catch {}
        const body = getLyricsPanelBody();
        if (body) body.classList.toggle('has-cover-bg', epicCoverBgEnabled);
        const btn = document.getElementById('epicCoverToggle');
        if (btn) btn.classList.toggle('is-on', epicCoverBgEnabled);
        updateEpicCoverBg();
    }

    function initEpicCoverBg() {
        try { epicCoverBgEnabled = localStorage.getItem(EPIC_COVER_BG_KEY) === '1'; } catch {}
        const body = getLyricsPanelBody();
        if (body && epicCoverBgEnabled) body.classList.add('has-cover-bg');
        const btn = document.getElementById('epicCoverToggle');
        if (btn) {
            btn.addEventListener('click', toggleEpicCoverBg);
            if (epicCoverBgEnabled) btn.classList.add('is-on');
        }
    }

    function initEpicKaraoke() {
        try { epicKaraokeEnabled = localStorage.getItem(EPIC_KARAOKE_KEY) === '1'; } catch {}
        const btn = document.getElementById('epicKaraokeToggle');
        if (btn) {
            btn.addEventListener('click', toggleEpicKaraoke);
            if (epicKaraokeEnabled) btn.classList.add('is-on');
        }
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
        if (lyricsEpic) lyricsEpic.hidden = true;
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
        lyricsPanel.classList.toggle('is-epic-mode', mode === 'epic');

        if (mode === 'videoclip') {
            lyricsScroll.hidden = true;
            lyricsPlain.hidden = true;
            if (lyricsEpic) lyricsEpic.hidden = true;

            if (!lyricsStatus.hidden) {
                lyricsVideoclip.hidden = true;
                return;
            }

            lyricsVideoclip.hidden = false;

            if (!lyricsSegments.length && pendingPlainText) {
                loadPlainLyricSegments(pendingPlainText, audio.duration);
            }

            if (!lyricsSegments.length) {
                lyricsVcStage.hidden = true;
                vcHint.hidden = false;
                return;
            }

            lyricsVcStage.hidden = false;
            vcHint.hidden = true;
            lastVcLineIndex = -1;
            updateVideoclipDisplay(
                LyricsSync.findSegmentIndex(lyricsSegments, getLyricsPlaybackTime()),
                getLyricsPlaybackTime()
            );
        } else if (mode === 'epic') {
            lyricsScroll.hidden = true;
            lyricsPlain.hidden = true;
            lyricsVideoclip.hidden = true;

            if (!lyricsStatus.hidden) {
                if (lyricsEpic) lyricsEpic.hidden = true;
                return;
            }

            if (lyricsEpic) lyricsEpic.hidden = false;

            if (!lyricsSegments.length && pendingPlainText) {
                loadPlainLyricSegments(pendingPlainText, audio.duration);
            }

            if (!lyricsSegments.length) {
                if (lyricsEpicStage) lyricsEpicStage.hidden = true;
                if (epicHint) epicHint.hidden = false;
                return;
            }

            if (lyricsEpicStage) lyricsEpicStage.hidden = false;
            if (epicHint) epicHint.hidden = true;
            resetEpicMode();
            updateEpicDisplay(
                LyricsSync.findSegmentIndex(lyricsSegments, getLyricsPlaybackTime())
            );
        } else {
            refreshListLyricsVisibility();
            if (lyricsSynced) {
                paintLyricsStage(activeSegmentIndex);
            }
        }
    }

    function syncLyricsModeInputs() {
        lyricsModeInputs.forEach((input) => {
            input.checked = input.value === lyricsMode;
        });
    }

    function clearLyricsSegments() {
        lyricsSegments = [];
        lyricsSynced = false;
        activeSegmentIndex = -1;
        if (lyricsNow) lyricsNow.textContent = '';
        resetEpicMode();
    }

    function setLyricsLoading() {
        lyricsScroll.hidden = true;
        lyricsStage.hidden = true;
        lyricsPlain.hidden = true;
        lyricsVideoclip.hidden = true;
        if (lyricsEpic) lyricsEpic.hidden = true;
        lyricsStatus.hidden = false;
        lyricsStatus.className = 'lyrics-panel__status is-loading';
        lyricsStatus.textContent = 'Buscando letra…';
        clearLyricsSegments();
    }

    function setLyricsMessage(msg) {
        lyricsScroll.hidden = true;
        lyricsStage.hidden = true;
        lyricsPlain.hidden = true;
        lyricsVideoclip.hidden = true;
        if (lyricsEpic) lyricsEpic.hidden = true;
        lyricsStatus.hidden = false;
        lyricsStatus.className = 'lyrics-panel__status';
        lyricsStatus.textContent = msg;
        clearLyricsSegments();
    }

    function formatLyricsBadge(sourceLabel, pack) {
        if (!pack) return sourceLabel || '';
        const extra = `${pack.segmentCount} líneas`;
        return sourceLabel ? `${sourceLabel} · ${extra}` : extra;
    }

    function renderLyricsPack(pack, sourceLabel) {
        lyricsSegments = pack.segments;
        lyricsSynced = true;
        pendingPlainText = null;
        activeSegmentIndex = -1;
        lyricsStatus.hidden = true;
        lyricsPlain.hidden = true;
        lyricsScroll.hidden = false;
        lyricsScroll.classList.add('is-synced');
        lyricsStage.hidden = false;

        if (lyricsStageBadge) {
            lyricsStageBadge.textContent = formatLyricsBadge(sourceLabel, pack);
            lyricsStageBadge.hidden = !lyricsStageBadge.textContent;
        }

        if (lyricsNow && !lyricsNow.dataset.boundSeek) {
            lyricsNow.dataset.boundSeek = '1';
            lyricsNow.addEventListener('click', () => {
                const idx = activeSegmentIndex >= 0 ? activeSegmentIndex : 0;
                const seg = lyricsSegments[idx];
                if (seg?.start != null) {
                    audio.currentTime = Math.max(0, seg.start);
                    syncLyricsAtTime(getLyricsPlaybackTime());
                }
            });
        }

        lastVcLineIndex = -1;
        refreshLyricsSegmentEnds();
        applyLyricsMode(lyricsMode);
        syncLyricsAtTime(getLyricsPlaybackTime());
    }

    function paintLyricsStage(idx) {
        if (!lyricsNow) return;
        if (idx < 0 || !lyricsSegments.length) {
            lyricsNow.textContent = '';
            return;
        }
        const seg = lyricsSegments[idx];
        if (!seg) return;
        if (lyricsNow.textContent !== seg.text) {
            lyricsNow.textContent = seg.text;
        }
    }

    function syncLyricsAtTime(t) {
        if (!lyricsSegments.length || typeof LyricsSync === 'undefined') return;

        const idx = LyricsSync.findSegmentIndex(lyricsSegments, t);
        if (idx === activeSegmentIndex) return;

        activeSegmentIndex = idx;

        if (lyricsMode === 'videoclip') {
            updateVideoclipDisplay(idx, t);
            return;
        }

        if (lyricsMode === 'epic') {
            updateEpicDisplay(idx);
            return;
        }

        if (lyricsSynced) {
            paintLyricsStage(idx);
        }
    }

    function renderPlainLyrics(text, options) {
        const isSuno = options?.isSuno === true;
        activeSegmentIndex = -1;
        pendingPlainText = text;
        pendingPlainIsSuno = isSuno;
        loadPlainLyricSegments(text, audio.duration);
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

    function startLyricsLoop() {
        syncLyricsAtTime(getLyricsPlaybackTime());
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
            if (fetchId !== lyricsFetchId) return;
            if (applyExternalLrc()) return;
        }

        if (file && typeof LyricsId3 !== 'undefined') {
            try {
                const id3Lyrics = await LyricsId3.extractLyricsFromMp3(file);
                if (fetchId !== lyricsFetchId) return;

                if (id3Lyrics?.type === 'synced' && id3Lyrics.lines?.length) {
                    const raw = id3Lyrics.lines.map((l) => ({ start: l.start, text: l.text }));
                    const built = LyricsSync.buildSegments(raw);
                    const shifted = LyricsSync.applyTimeOffset(built.segments, lyricsTimingOffset);
                    const final = LyricsSync.finalizeEnds(shifted, audio.duration);
                    if (fetchId !== lyricsFetchId) return;
                    renderLyricsPack(
                        {
                            segments: final,
                            rawCount: built.rawCount,
                            segmentCount: final.length,
                        },
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
            const pack = parseLrcPack(plainFromFile);
            if (pack?.segments?.length) {
                if (fetchId !== lyricsFetchId) return;
                renderLyricsPack(pack, 'Archivo · LRC');
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
            const pack = parseLrcPack(lrcData.syncedLyrics, lyricsTimingOffset);
            if (pack?.segments?.length) {
                renderLyricsPack(pack, 'LRCLIB · sincronizada');
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

    function getActiveCatalogSong() {
        if (!activeCatalogId) return null;
        return songCatalog.find((s) => s.id === activeCatalogId) || null;
    }

    function onMetadataReady(file, tags, embeddedLyrics) {
        const fromFile = parseArtistTitleFromFilename(file.name);
        const catalogSong = getActiveCatalogSong();
        const title =
            catalogSong?.title || tags.title || fromFile.title || titleFromFilename(file.name);
        const artist = catalogSong?.artist || tags.artist || fromFile.artist || '';

        trackTitle.textContent = title;
        trackMeta = {
            title,
            artist,
            album: tags.album || '',
            duration: Number.isFinite(audio.duration) ? audio.duration : 0,
        };

        const fetchId = ++lyricsFetchId;
        setLyricsLoading();
        resolveLyrics(trackMeta, embeddedLyrics, fetchId, currentAudioFile);
    }

    function readMetadata(file) {
        const fallback = parseArtistTitleFromFilename(file.name);
        const catalogSong = getActiveCatalogSong();
        const initialTitle = catalogSong?.title || fallback.title;
        const initialArtist = catalogSong?.artist || fallback.artist;

        trackTitle.textContent = initialTitle;
        trackMeta = { title: initialTitle, artist: initialArtist, album: '', duration: 0 };
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
                const catalogSong = getActiveCatalogSong();
                if (catalogSong?.title) {
                    trackTitle.textContent = catalogSong.title;
                } else if (tags.title) {
                    trackTitle.textContent = tags.title;
                }
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
                const catalogSong = getActiveCatalogSong();
                trackMeta = {
                    title: catalogSong?.title || fallback.title,
                    artist: catalogSong?.artist || fallback.artist,
                    album: '',
                    duration: 0,
                };
                trackTitle.textContent = trackMeta.title;
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

    /** Cada barra = mismo ancho de banda (log entre lower/higher cutoff), izquierda → graves, derecha → agudos. */
    function buildBarSpectrumMap(bufferLength) {
        barSpectrumMap = [];
        const maxBin = bufferLength - 1;
        const sampleRate = audioCtx?.sampleRate || 48000;
        const fftSize = analyser?.fftSize || 2048;
        const logMin = Math.log10(CAVA_CONFIG.lowerCutoffFreq);
        const logMax = Math.log10(CAVA_CONFIG.higherCutoffFreq);

        for (let i = 0; i < BAR_COUNT; i++) {
            const t0 = i / BAR_COUNT;
            const t1 = (i + 1) / BAR_COUNT;
            const f0 = Math.pow(10, logMin + t0 * (logMax - logMin));
            const f1 = Math.pow(10, logMin + t1 * (logMax - logMin));
            const binStart = freqToBin(f0, sampleRate, fftSize, maxBin);
            const binEnd = Math.max(binStart, freqToBin(f1, sampleRate, fftSize, maxBin));

            const blendBins = [];
            for (let b = binStart; b <= binEnd; b++) {
                blendBins.push(b);
            }
            if (!blendBins.length) {
                blendBins.push(Math.min(maxBin, binStart));
            }

            barSpectrumMap.push({
                blendBins,
            });
        }
    }

    const VISUALIZER_GAIN = (CAVA_CONFIG.sensitivity / 100) * 0.4 * (CAVA_CONFIG.autosens / 2);
    const VISUALIZER_MAX_SCALE = 1;

    /** Leve atenuación en graves (izquierda); mismas bandas, menos pegar al techo. */
    function lowFreqAttenuation(barIndex) {
        const t = barIndex / (BAR_COUNT - 1);
        return 0.76 + 0.24 * Math.pow(t, 0.6);
    }

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
        buildBarSpectrumMap(freqData.length);
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
            buildBarSpectrumMap(freqData.length);
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
            visualizerSensFloor * 1.8,
            visualizerPeakHold * 1.02,
            0.13
        );

        for (let i = 0; i < BAR_COUNT; i++) {
            const relative = (raw[i] / normalizeBase) * lowFreqAttenuation(i);
            const target = Math.max(0.08, Math.min(VISUALIZER_MAX_SCALE, relative * VISUALIZER_MAX_SCALE));
            const prev = barSmoothLevels[i];
            const smooth = target > prev ? 0.34 : 0.18;
            const scale = prev + (target - prev) * smooth;
            barSmoothLevels[i] = scale;
            barFills[i].style.transform = `scaleY(${scale})`;
        }

        updateVideoclipBassShake();
        updateEpicBassShake();
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
        currentAudioFile = null;
        lyricsTimingOffset = 0;
        lyricsFetchId++;
        setLyricsMessage('Sube una canción para ver la letra');
    }

    function isAudioFile(file) {
        if (!file) return false;
        if (file.type && file.type.startsWith('audio/')) return true;
        return /\.(mp3|wav|ogg|m4a|flac|aac|webm)$/i.test(file.name || '');
    }

    function loadFile(file, options) {
        if (!isAudioFile(file)) return;

        revokeObjectUrl();
        resetPlayerUi();
        setLyricsLoading();
        currentAudioFile = file;

        if (options?.catalogId) {
            activeCatalogId = options.catalogId;
        } else {
            activeCatalogId = null;
        }

        if (options?.lrcText) {
            externalLrcText = options.lrcText;
        } else if (!options?.keepExternalLrc) {
            externalLrcText = null;
        }

        objectUrl = URL.createObjectURL(file);
        audio.src = objectUrl;
        setPlayerReady();
        updateLibraryActiveState();
        readMetadata(file);

        if (options?.autoplay) {
            const onCanPlay = () => {
                audio.removeEventListener('canplay', onCanPlay);
                audio.play().catch(() => {});
            };
            audio.addEventListener('canplay', onCanPlay);
        }
    }

    function isLibraryTrackPlaying(songId) {
        return (
            songId === activeCatalogId &&
            audio.src &&
            playerEl.classList.contains('has-track') &&
            !audio.paused
        );
    }

    function updateLibraryPlayIcons() {
        if (!songLibrary) return;
        songLibrary.querySelectorAll('.library__play').forEach((btn) => {
            const item = btn.closest('.library__item');
            const songId = item?.dataset.songId;
            const icon = btn.querySelector('i');
            const isPlaying = isLibraryTrackPlaying(songId);

            if (icon) {
                icon.className = isPlaying ? 'fas fa-pause' : 'fas fa-play';
            }
            btn.setAttribute('aria-label', isPlaying ? 'Pausar' : 'Reproducir');
            btn.classList.toggle('is-playing', isPlaying);
        });
    }

    function getCatalogSongIndex(songId) {
        return songCatalog.findIndex((s) => s.id === songId);
    }

    function updatePlayerNav() {
        const hasCatalogTrack =
            activeCatalogId && audio.src && playerEl.classList.contains('has-track');
        const idx = hasCatalogTrack ? getCatalogSongIndex(activeCatalogId) : -1;
        const isPlaying = hasCatalogTrack && !audio.paused;

        if (playerPrevBtn) {
            const hasPrev = idx > 0;
            playerPrevBtn.classList.toggle('is-unavailable', !hasPrev);
            playerPrevBtn.disabled = !hasPrev;
            playerPrevBtn.setAttribute('aria-label', hasPrev ? `Anterior: ${songCatalog[idx - 1].title}` : 'Anterior');
            playerPrevBtn.classList.toggle('is-playing', isPlaying && hasPrev);
        }

        if (playerNextBtn) {
            const hasNext = idx >= 0 && idx < songCatalog.length - 1;
            playerNextBtn.classList.toggle('is-unavailable', !hasNext);
            playerNextBtn.disabled = !hasNext;
            playerNextBtn.setAttribute(
                'aria-label',
                hasNext ? `Siguiente: ${songCatalog[idx + 1].title}` : 'Siguiente'
            );
            playerNextBtn.classList.toggle('is-playing', isPlaying && hasNext);
        }
    }

    function updateLibraryActiveState() {
        if (!songLibrary) return;
        songLibrary.querySelectorAll('.library__item[data-song-id]').forEach((item) => {
            const songId = item.dataset.songId;
            const isActive =
                songId === activeCatalogId && audio.src && playerEl.classList.contains('has-track');
            item.classList.toggle('is-active', isActive);
            item.classList.toggle('is-playing', isLibraryTrackPlaying(songId));
        });
        updateLibraryPlayIcons();
        updatePlayerNav();
    }

    function handleLibraryPlay(song) {
        if (!song?.id) return;

        const isCurrentTrack =
            activeCatalogId === song.id && audio.src && playerEl.classList.contains('has-track');

        if (isCurrentTrack) {
            if (audio.paused) {
                audio.play().catch(() => {});
            } else {
                audio.pause();
            }
            return;
        }

        loadCatalogSong(song, { autoplay: true });
    }

    function renderSongLibrary() {
        if (!songLibrary) return;

        songLibrary.innerHTML = '';

        if (!songCatalog.length) {
            const empty = document.createElement('li');
            empty.className = 'library__empty';
            empty.textContent = 'No hay canciones en la biblioteca';
            songLibrary.appendChild(empty);
            return;
        }

        songCatalog.forEach((song) => {
            const item = document.createElement('li');
            item.className = 'library__item';
            item.dataset.songId = song.id;

            const row = document.createElement('div');
            row.className = 'library__row';

            const controls = document.createElement('div');
            controls.className = 'library__controls';

            const play = document.createElement('button');
            play.type = 'button';
            play.className = 'library__play liquid-glass glass-white';
            play.setAttribute('aria-label', `Reproducir ${song.title}`);
            play.innerHTML = '<i class="fas fa-play" aria-hidden="true"></i>';
            play.addEventListener('click', (e) => {
                e.stopPropagation();
                handleLibraryPlay(song);
            });
            controls.appendChild(play);

            const main = document.createElement('button');
            main.type = 'button';
            main.className = 'library__main';
            main.setAttribute('aria-label', `Seleccionar ${song.title}`);

            const info = document.createElement('span');
            info.className = 'library__info';

            const infoLine = document.createElement('span');
            infoLine.className = 'library__info-line';

            const wave = document.createElement('span');
            wave.className = 'library__wave';
            wave.setAttribute('aria-hidden', 'true');
            wave.innerHTML = '<span></span><span></span><span></span><span></span>';

            const title = document.createElement('span');
            title.className = 'library__title';
            title.textContent = song.title;

            infoLine.appendChild(wave);
            infoLine.appendChild(title);
            info.appendChild(infoLine);

            if (song.artist) {
                const artist = document.createElement('span');
                artist.className = 'library__artist';
                artist.textContent = song.artist;
                info.appendChild(artist);
            }

            main.addEventListener('click', () => {
                if (activeCatalogId === song.id && audio.src) return;
                loadCatalogSong(song);
            });

            main.appendChild(info);
            row.appendChild(controls);
            row.appendChild(main);
            item.appendChild(row);
            songLibrary.appendChild(item);
        });

        updateLibraryActiveState();
    }

    async function loadCatalogSong(song, options) {
        if (!song?.audio) return;

        try {
            const [audioRes, lrcRes] = await Promise.all([
                fetch(`${SONGS_BASE}${song.audio}`),
                song.lrc ? fetch(`${SONGS_BASE}${song.lrc}`) : Promise.resolve(null),
            ]);

            if (!audioRes.ok) throw new Error('audio');

            const audioBlob = await audioRes.blob();
            const audioFile = new File(
                [audioBlob],
                song.audio,
                { type: audioBlob.type || 'audio/mpeg' }
            );

            let lrcText = null;
            if (lrcRes?.ok) {
                lrcText = (await lrcRes.text()).trim();
            }

            loadFile(audioFile, {
                catalogId: song.id,
                lrcText,
                autoplay: Boolean(options?.autoplay),
            });
        } catch {
            setLyricsMessage('No se pudo cargar la canción de la biblioteca');
        }
    }

    async function initSongLibrary() {
        if (!songLibrary) return;

        try {
            const res = await fetch(`${SONGS_BASE}catalog.json`);
            if (!res.ok) throw new Error('catalog');
            const data = await res.json();
            songCatalog = Array.isArray(data?.songs) ? data.songs : [];
        } catch {
            songCatalog = [];
        }

        renderSongLibrary();
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

    if (playerPrevBtn) {
        playerPrevBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = getCatalogSongIndex(activeCatalogId);
            if (idx > 0) loadCatalogSong(songCatalog[idx - 1], { autoplay: true });
        });
    }

    if (playerNextBtn) {
        playerNextBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = getCatalogSongIndex(activeCatalogId);
            if (idx >= 0 && idx < songCatalog.length - 1) {
                loadCatalogSong(songCatalog[idx + 1], { autoplay: true });
            }
        });
    }

    function updatePlayIcon() {
        playIcon.className = audio.paused ? 'fas fa-play' : 'fas fa-pause';
        playBtn.setAttribute('aria-label', audio.paused ? 'Reproducir' : 'Pausar');
        updateLibraryPlayIcons();
        updatePlayerNav();
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
        if (epicKaraokeEnabled && epicKaraokeWords.length && !epicKaraokeRafId) {
            epicKaraokeLoop();
        }
    });

    audio.addEventListener('pause', () => {
        updatePlayIcon();
        stopLyricsLoop();
        syncLyricsAtTime(getLyricsPlaybackTime());
        stopVisualizer();
        updateVisualizer();
    });

    audio.addEventListener('loadedmetadata', () => {
        durationEl.textContent = formatTime(audio.duration);
        progressRange.max = String(audio.duration || 100);
        if (trackMeta) trackMeta.duration = audio.duration;

        if (externalLrcText) {
            applyExternalLrc();
            syncLyricsAtTime(getLyricsPlaybackTime());
        }

        if (pendingPlainText && audio.duration > 0) {
            const fetchId = lyricsFetchId;
            if (!lyricsSynced && tryApproximateSync(pendingPlainText, audio.duration, fetchId, pendingPlainIsSuno)) {
                return;
            }
            refreshLyricsSegmentEnds();
            if (lyricsMode === 'videoclip' && lyricsSegments.length) {
                if (pendingPlainText) loadPlainLyricSegments(pendingPlainText, audio.duration);
                syncLyricsAtTime(getLyricsPlaybackTime());
            }
        }
    });

    audio.addEventListener('timeupdate', () => {
        const t = audio.currentTime;
        if (!isSeeking) {
            progressRange.value = String(t);
            currentTimeEl.textContent = formatTime(t);
        }
        if (lyricsSegments.length) {
            syncLyricsAtTime(t);
        }
    });

    audio.addEventListener('ended', () => {
        updatePlayIcon();
        progressRange.value = '0';
        currentTimeEl.textContent = '0:00';
        stopLyricsLoop();
        stopVisualizer();
        syncLyricsAtTime(0);
    });

    progressRange.addEventListener('input', () => {
        isSeeking = true;
        const t = Number(progressRange.value);
        currentTimeEl.textContent = formatTime(t);
        syncLyricsAtTime(getLyricsPlaybackTime(Number(progressRange.value)));
    });

    progressRange.addEventListener('change', () => {
        audio.currentTime = Number(progressRange.value);
        isSeeking = false;
        syncLyricsAtTime(getLyricsPlaybackTime());
    });

    progressRange.addEventListener('pointerdown', () => { isSeeking = true; });
    progressRange.addEventListener('pointerup', () => { isSeeking = false; });

    function updateVolumeIcon(level) {
        if (!volumeIcon) return;
        volumeIcon.className = 'fas';
        if (level <= 0) {
            volumeIcon.classList.add('fa-volume-xmark');
        } else if (level < 35) {
            volumeIcon.classList.add('fa-volume-off');
        } else if (level < 70) {
            volumeIcon.classList.add('fa-volume-low');
        } else {
            volumeIcon.classList.add('fa-volume-high');
        }
    }

    function applyVolume(level) {
        const v = Math.min(100, Math.max(0, Math.round(level)));
        audio.volume = v / 100;
        if (volumeRange) volumeRange.value = String(v);
        if (volumeValue) volumeValue.textContent = `${v}%`;
        updateVolumeIcon(v);
    }

    function initVolume() {
        if (!volumeRange) return;

        let stored = 100;
        try {
            const raw = localStorage.getItem(VOLUME_STORAGE_KEY);
            if (raw != null && raw !== '') {
                const n = Number(raw);
                if (Number.isFinite(n)) stored = Math.min(100, Math.max(0, n));
            }
        } catch (e) {}

        applyVolume(stored);

        volumeRange.addEventListener('input', () => {
            applyVolume(Number(volumeRange.value));
        });

        volumeRange.addEventListener('change', () => {
            try {
                localStorage.setItem(VOLUME_STORAGE_KEY, volumeRange.value);
            } catch (e) {}
        });
    }

    initVolume();

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

                if (!applyExternalLrc()) return;

                if (audio.src && currentAudioFile) {
                    syncLyricsAtTime(getLyricsPlaybackTime());
                }
            };
            reader.onerror = () => {
                setLyricsMessage('No se pudo leer el archivo .lrc');
            };
            reader.readAsText(file, 'UTF-8');
        });
    }

    try {
        const storedMode = localStorage.getItem(LYRICS_MODE_KEY);
        if (storedMode === 'videoclip' || storedMode === 'list' || storedMode === 'epic') {
            lyricsMode = storedMode;
        }
    } catch (e) {}

    syncLyricsModeInputs();
    applyLyricsMode(lyricsMode);

    initVisualizerBars();
    visualizerEl.classList.add('is-live');
    paintIdleVisualizerWave();
    initSongLibrary();
    initEpicCoverBg();
    initEpicKaraoke();
})();
