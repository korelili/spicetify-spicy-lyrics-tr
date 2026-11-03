# Spicy Lyrics AI Translator & Romaja — v49.0.0

A Turkish lyrics and romanization extension for [Spicy Lyrics](https://spicylyrics.org/) in Spotify Desktop / Spicetify.

![Preview](marketplace-icon.png)

## What's changed in V49

- **Gemini translation requests:** 30 → 8 lines per request, shorter context-aware translation instructions, 30-second request timeout, 3-attempt budget per group, less aggressive output token cap. This reduces the risk of repeated timeouts, but cannot override API quotas or guarantee speed.
- **More natural Turkish:** lyric-localization prompt emphasizes speaker, idiom, tone, semantic meaning and context rather than literal word-for-word translation.
- **Quality-first mode (default with a Gemini key):** When Gemini is unavailable, the extension hides low-confidence Google Translate / MyMemory Turkish subtitle text instead of showing it as a reliable translation. **Romanization stays visible** when available. A handful of common, unambiguous colloquial phrases may still be shown as verified short translations.
- **Toggle quality mode:** Right-click the `AI` button to find the quality-mode checkbox. Turn it **off** if you prefer to see all fallback translations while Gemini is unavailable. Saving currently resets the cache, as it did in V48.
- **Stale cache handling:** Old entries with unknown translation origin are not assumed to be AI quality. In AI mode, weak fallback Turkish output isn't saved permanently; existing fallback rows can be upgraded later when Gemini is available. Gemini results and usable romanization remain cached.
- **Romanization and UI:** Original on-screen lyrics, Hangul / Kana / Han / Thai romanization, on/off control, API key settings and other original features are retained.
- **No risky Turkish suffix rewriting:** The previous broad regex substitutions could silently damage valid sentence endings. V49 leaves grammar choices to the translator.
- **Status and version:** Hover over the `AI` / `TR` button; the tooltip begins with `[SpicyTR V49...]`. Note: `AI` means a Gemini key is configured, **not** that the latest subtitle came from Gemini.

### Marketplace installation (repository maintainer)

This ZIP contains `spicy-tr.js`, `manifest.json`, `marketplace-icon.png`, and `README.md`. Replace those four files **in your repository's main branch**, commit, then let Spicetify Marketplace detect the new manifest version **49.0.0**. Do not forget `manifest.json` (the public repo previously reported `46.0.0` even when the JS reported `48.0.0`).

The repository's original installation instructions are otherwise unchanged. Do not enable both a manually installed extension and the Marketplace copy simultaneously; duplicate installations can lead to confusing behavior.

### Manual installation

Replace `spicy-tr.js` in your Spicetify extensions directory, then run `spicetify apply` and restart Spotify:

- Windows: `%appdata%\spicetify\Extensions`
- macOS/Linux: `~/.config/spicetify/Extensions`

If not already enabled: `spicetify config extensions spicy-tr.js` followed by `spicetify apply`.

### How to use

- Turn **OFF** Spicy Lyrics' own `A` romanization toggle, to keep the original characters on-screen.
- Left-click the `TR` / `AI` control to show/hide overlays.
- Right-click the `TR` / `AI` control for Gemini keys, strict quality mode and Save & Reset.
- Your existing `spicy_tr_gemini_keys` API keys are preserved locally. **Never send them to bug reports or screenshots.**
- With **no configured API key**, standard GTX / MyMemory fallback still displays Turkish translations, although their quality is not guaranteed.
- With a configured key and **quality mode ON** (default), missing Turkish lines during an API outage are expected; the extension prefers no translation over a clearly wrong one. Disable strict quality mode in settings to display approximate machine translations again.
- Existing bad Gemini translations are not guaranteed to be automatically corrected. After verifying V49 is running, a **single Save & Reset** can clear those old rows, but it consumes fresh API quota.

### Diagnostics

1. Hover the extension button: verify `[SpicyTR V49]` or `[SpicyTR V49 · kalite modu açık]` in the tooltip.
2. Watch whether the button shows `AI!` (a temporary service warning).
3. For console diagnostics, in Spotify DevTools enter `localStorage.setItem('spicy_tr_debug','true')` and restart Spotify. Do **not** share full console messages containing secrets.
4. If the tooltip still says `10sn içinde cevap gelmedi`, you are probably running an older build: V49 uses a 30-second Gemini timeout and does not emit that wording itself.
5. Ensure the API key actually has access/quota for the selected model. Different API keys in the **same Google project** do not get independent quotas.

### Test limitations

V49 was checked with Node.js JavaScript syntax validation and simulated tests for cache migration, Gemini success, 400 schema recovery, 429 quotas, idiom fixes, overlay filtering and romanization persistence. It was **not tested live inside your Spotify account** or against your private Google Gemini API keys. Some lyrics still need human review and no machine translation system can promise perfect lines.

Report issues: <https://github.com/korelili/spicetify-spicy-lyrics-tr/issues>

Made by [@korelili](https://github.com/korelili).
