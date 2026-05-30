(function () {
    const PALETTE_VAR_KEYS = [
        ...Array.from({ length: 6 }, (_, i) => [`--blob-${i + 1}-core`, `--blob-${i + 1}-mid`]).flat(),
        '--accent-from',
        '--accent-mid',
        '--accent-to',
    ];

    const ROTATE_MS = 30000;
    const TRANSITION_MS = 5000;

    function varsFromBlobs(blobs) {
        const vars = {};
        blobs.forEach((b, i) => {
            const n = i + 1;
            vars[`--blob-${n}-core`] = `rgb(${b.core.join(', ')})`;
            vars[`--blob-${n}-mid`] = `rgb(${b.mid.join(', ')})`;
        });
        vars['--accent-from'] = `rgb(${blobs[0].core.join(', ')})`;
        vars['--accent-mid'] = `rgb(${blobs[2].core.join(', ')})`;
        vars['--accent-to'] = `rgb(${blobs[4].core.join(', ')})`;
        return vars;
    }

    const BLOB_PALETTES = [
        {
            id: 'warm',
            blobs: [
                { core: [220, 38, 38], mid: [248, 113, 113] },
                { core: [185, 28, 28], mid: [252, 165, 165] },
                { core: [255, 149, 0], mid: [251, 146, 60] },
                { core: [234, 88, 12], mid: [249, 115, 22] },
                { core: [234, 179, 8], mid: [250, 204, 21] },
                { core: [253, 224, 71], mid: [254, 240, 138] },
            ],
        },
        {
            id: 'sky',
            blobs: [
                { core: [37, 99, 235], mid: [96, 165, 250] },
                { core: [29, 78, 216], mid: [147, 197, 253] },
                { core: [124, 58, 237], mid: [167, 139, 250] },
                { core: [109, 40, 217], mid: [196, 181, 253] },
                { core: [14, 165, 233], mid: [125, 211, 252] },
                { core: [6, 182, 212], mid: [103, 232, 249] },
            ],
        },
        {
            id: 'forest',
            blobs: [
                { core: [34, 197, 94], mid: [134, 239, 172] },
                { core: [22, 163, 74], mid: [74, 222, 128] },
                { core: [132, 204, 22], mid: [190, 242, 100] },
                { core: [101, 163, 13], mid: [217, 249, 157] },
                { core: [22, 101, 52], mid: [52, 211, 153] },
                { core: [20, 83, 45], mid: [110, 231, 183] },
            ],
        },
        {
            id: 'bloom',
            blobs: [
                { core: [236, 72, 153], mid: [244, 114, 182] },
                { core: [219, 39, 119], mid: [251, 207, 232] },
                { core: [168, 85, 247], mid: [216, 180, 254] },
                { core: [147, 51, 234], mid: [233, 213, 255] },
                { core: [30, 58, 138], mid: [99, 102, 241] },
                { core: [30, 64, 175], mid: [129, 140, 248] },
            ],
        },
        {
            id: 'earth',
            blobs: [
                { core: [22, 163, 74], mid: [134, 239, 172] },
                { core: [21, 128, 61], mid: [74, 222, 128] },
                { core: [120, 53, 15], mid: [180, 83, 9] },
                { core: [146, 64, 14], mid: [217, 119, 6] },
                { core: [15, 118, 110], mid: [45, 212, 191] },
                { core: [19, 78, 74], mid: [94, 234, 212] },
            ],
        },
    ].map((palette) => ({ ...palette, vars: varsFromBlobs(palette.blobs) }));

    let currentPaletteId = 'warm';
    let activeColors = {};
    let rotateTimer = null;
    let animationFrame = null;

    function parseRgb(value) {
        const match = String(value).match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/);
        if (!match) return [0, 0, 0];
        return [Number(match[1]), Number(match[2]), Number(match[3])];
    }

    function rgbToCss(rgb) {
        return `rgb(${Math.round(rgb[0])}, ${Math.round(rgb[1])}, ${Math.round(rgb[2])})`;
    }

    function paletteToRgbMap(palette) {
        const map = {};
        PALETTE_VAR_KEYS.forEach((key) => {
            map[key] = parseRgb(palette.vars[key]);
        });
        return map;
    }

    function pickRandomPalette(excludeId) {
        const pool = excludeId
            ? BLOB_PALETTES.filter((p) => p.id !== excludeId)
            : BLOB_PALETTES;
        return pool[Math.floor(Math.random() * pool.length)];
    }

    function easeInOutCubic(t) {
        return t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2;
    }

    function readColorsFromDom() {
        const style = getComputedStyle(document.documentElement);
        const map = {};
        PALETTE_VAR_KEYS.forEach((key) => {
            map[key] = parseRgb(style.getPropertyValue(key).trim());
        });
        return map;
    }

    function writeColors(colors) {
        const root = document.documentElement;
        PALETTE_VAR_KEYS.forEach((key) => {
            root.style.setProperty(key, rgbToCss(colors[key]));
        });
        activeColors = { ...colors };
    }

    function cancelAnimation() {
        if (animationFrame !== null) {
            cancelAnimationFrame(animationFrame);
            animationFrame = null;
        }
    }

    function applyPalette(palette, options) {
        const instant = options && options.instant;
        currentPaletteId = palette.id;

        const canvas = document.getElementById('ambientCanvas');
        if (canvas) canvas.dataset.palette = palette.id;

        const target = paletteToRgbMap(palette);

        if (instant || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            cancelAnimation();
            writeColors(target);
            return;
        }

        cancelAnimation();

        const from = Object.keys(activeColors).length === PALETTE_VAR_KEYS.length
            ? { ...activeColors }
            : readColorsFromDom();

        const start = performance.now();

        function tick(now) {
            const progress = Math.min(1, (now - start) / TRANSITION_MS);
            const eased = easeInOutCubic(progress);
            const step = {};

            PALETTE_VAR_KEYS.forEach((key) => {
                const a = from[key];
                const b = target[key];
                step[key] = [
                    a[0] + (b[0] - a[0]) * eased,
                    a[1] + (b[1] - a[1]) * eased,
                    a[2] + (b[2] - a[2]) * eased,
                ];
            });

            writeColors(step);

            if (progress < 1) {
                animationFrame = requestAnimationFrame(tick);
            } else {
                writeColors(target);
                animationFrame = null;
            }
        }

        animationFrame = requestAnimationFrame(tick);
    }

    function init() {
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            return;
        }

        rotateTimer = window.setInterval(() => {
            applyPalette(pickRandomPalette(currentPaletteId));
        }, ROTATE_MS);
    }

    applyPalette(pickRandomPalette(), { instant: true });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
