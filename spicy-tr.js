// NAME: Spicy Lyrics AI Translator & Romaja
// AUTHOR: korelili
// VERSION: 33.6.0 (Instant Parallel Engine & Zero-Lag Anchor - Translation Quality + GTX Backoff Patch)
// 33.5.1 FIX: the romanization-style rule told the model to write NONE when it
// couldn't produce a "clean" simple version, which it started doing often for Thai
// specifically - causing romanization to vanish inconsistently (present on one Thai
// song, missing on another). Romanization for non-Latin script is now mandatory
// with no escape hatch; only its STYLE is constrained.
// 33.6.0 ADDED: a GTX backoff gate mirroring the existing Gemini one. After many
// songs in one sitting, translation was reported to stop completely with no
// recovery - the Gemini key's quota being exhausted (already handled by the earlier
// crash fix + Gemini backoff gate) was only half the picture: GTX itself also gets
// rate-limited under sustained heavy use, and with no backoff of its own, every new
// chunk kept re-triggering the same block instead of giving it time to clear. GTX
// now backs off for 3 minutes after 3 consecutive failures, then retries
// automatically, instead of hammering a blocked endpoint indefinitely.
// ADDED in 33.5: fixed several concrete mistranslation patterns confirmed with real
// screenshots across EXO/GOT7/JAY B/BamBam lyrics: (1) formal "siz" still leaking
// through in both Gemini and GTX output ("gevşetin", "Kalbinize", "düğmelerinizi",
// "Siz farkına bile varmadan", etc.) - added safe case-suffix-based regex fixes
// (only applied when a further case ending follows "-nİz-", which an imperative verb
// can never take, so it's unambiguously a noun possessive) plus exact-phrase fixes
// for the specific verbs observed, and gave the prompt concrete wrong/right examples
// pulled straight from the real output. (2) stylized repeated ad-libs like
// "On&on&on&on" being translated word-by-word into nonsense ("Açık&açık&açık") -
// prompt now explicitly forbids literal per-token translation of repeated vocal
// patterns. (3) lines that are already in English (like a song-title line) being
// silently left untranslated - prompt now requires every line to get a real Turkish
// translation regardless. (4) romanization for scripts like Thai coming back as
// unreadable academic transliteration full of stacked diacritics - prompt now asks
// for simple plain-Latin casual phonetic spelling only.
// Note: this is prompt + safe post-processing, not a grammar engine - it
// substantially reduces these patterns but can't mechanically guarantee zero
// mistranslations from an LLM in every language/context.
// ADDED in 33.4: fixed two embarrassing mistranslation bugs reported with real
// screenshots. (1) forcePerfectTurkish had two generic regexes meant to turn formal
// "-sınız/-niz" verb endings informal, but they also matched Turkish formal
// IMPERATIVES (e.g. "uyanınız" = "wake up!") and mangled them into a still-wrong
// informal command ("uyanın") instead of the narrative line the song needed.
// Removed those regexes - the explicit prompt instruction plus the safe exact
// whole-word replacements already handle this without risking broken grammar.
// (2) When a line fell back to the GTX (Google Translate) engine - most often
// because the Gemini key had hit its quota - common rap slang like "hoes"/"ho" was
// coming back as literal nonsense ("ayakkabılar"/shoes, "domuz"/pig), a known GTX
// quirk since it has no song context. A small slang-to-plain-English normalization
// now runs ONLY on the text sent to GTX (never touches what Gemini sees, never
// changes the cached/displayed original line) to avoid these specific failures.
// ADDED in 33.2: seek detection. Nothing fired a rescan specifically when the user
// dragged the seek bar to a new point in the song - it relied on the DOM mutation/
// scroll listeners happening to catch whatever Spicy Lyrics did internally, which
// wasn't reliable. Now Spicetify's "onprogress" event (current position in ms) is
// watched: a position jump of more than ~1.5s vs. normal playback progression means
// a seek happened, and it immediately forces a full rescan.
// ADDED in 33.3: fixed the actual cause of "translation just stops partway through
// a normal, un-seeked session and never comes back". When EVERY Gemini model ends
// up on cooldown at once (e.g. the free API key's quota got used up after a lot of
// listening), the per-chunk translator's `lastError` was left as `null` (the loop
// never entered a try/catch to set it), and then `throw lastError` threw `null`.
// The caller did `e.message` on that `null` in its catch block, which itself threw
// a brand new TypeError - BEFORE the code ever reached the GTX fallback call. So
// once the Gemini key was exhausted, every future chunk silently crashed and never
// even tried the free GTX engine as a backup: translation stopped dead for the rest
// of the session, exactly as reported, independent of seeking. Fixed by always
// throwing a real Error, handling it defensively either way, and - as a bonus -
// added a global 2-minute "Gemini is down" gate so once this is detected, new
// chunks skip straight to GTX instead of each one re-discovering the same outage,
// and it clears itself the moment a Gemini call succeeds again.
// DESCRIPTION: Same as v33.0.0, with two targeted fixes for "delay + skipped lines":
//   1) translateWithGTX used to fall back to `trLine = rawText` when no real
//      translation came back, and still cache.set() that dud entry. Since the line
//      was then "in cache", it was never retried again - one failed network call
//      permanently killed that line (and its romaji) for the rest of the session.
//      Now a genuine failure marks the line with a short cooldown instead of
//      caching garbage, so the next scan retries it automatically.
//   2) processQueue fired ALL chunks at once with no limit (Promise.all over every
//      chunk), and the GTX per-line fallback fired all its requests unthrottled
//      too. On a long song (many chunks) or after a Gemini failure cascading into
//      GTX, this burst tripped Google's rate limiting, which is what produced both
//      the extra delay (retries, dead model cooldowns) and the permanently-skipped
//      lines from fix #1. Chunk-level concurrency is now capped (4 at once - still
//      effectively "all at once" for a typical song with 3-5 chunks) and GTX's
//      per-line fallback requests are lightly queued instead of fired in one burst.
//   Nothing else was changed: same prompt, same models, same CHUNK_SIZE, same
//   multi-stage scan / songchange / scroll triggers, same getCleanText.

(function spicyTurkishProV33() {
  const DEBUG = true;
  const log = (...args) => { if (DEBUG) console.log('%c[SpicyTR V33]', 'color:#1db954;font-weight:bold', ...args); };
  const warn = (...args) => { if (DEBUG) console.warn('%c[SpicyTR V33]', 'color:#ffae00;font-weight:bold', ...args); };
  const err = (...args) => { if (DEBUG) console.error('%c[SpicyTR V33]', 'color:#ff4b4b;font-weight:bold', ...args); };

  [
    'spicy_tr_persistent_cache_v5', 'spicy_tr_persistent_cache_v12_final',
    'spicy_tr_marketplace_v19', 'spicy_tr_stable_v20', 'spicy_tr_ultimate_v21',
    'spicy_tr_unbreakable_v22', 'spicy_tr_godmode_v23', 'spicy_tr_godmode_v26',
    'spicy_tr_godmode_v27', 'spicy_tr_godmode_v28', 'spicy_tr_godmode_v29',
    'spicy_tr_godmode_v30', 'spicy_tr_godmode_v31', 'spicy_tr_godmode_v32'
  ].forEach(k => localStorage.removeItem(k));

  const STORAGE_CACHE_KEY = 'spicy_tr_godmode_v33';
  let savedCache = {};
  try {
    savedCache = JSON.parse(localStorage.getItem(STORAGE_CACHE_KEY) || '{}');
  } catch (e) {
    savedCache = {};
  }

  const cache = new Map(Object.entries(savedCache));
  const inFlight = new Set();
  const failedUntil = new Map(); // rawText -> timestamp; don't retry before this
  const FAILURE_COOLDOWN_MS = 12000;
  const deadModels = new Map();
  let geminiGloballyDownUntil = 0; // when ALL models failed at once, back off entirely for a bit
  let gtxGloballyDownUntil = 0; // same idea for the GTX engine when it's being rate-limited
  let gtxConsecutiveFailures = 0;
  let isEnabled = localStorage.getItem('spicy_tr_enabled') !== 'false';
  let geminiApiKey = localStorage.getItem('spicy_tr_gemini_key') || '';
  let batchTimer = null;

  const CHUNK_SIZE = 12;

  function markFailed(text) {
    failedUntil.set(text, Date.now() + FAILURE_COOLDOWN_MS);
  }

  // Small concurrency-limited queue so requests go out a few at a time instead of
  // all in one burst (which is what was tripping rate limiting).
  async function runThrottled(items, worker, { concurrency = 3, spacingMs = 120 } = {}) {
    let i = 0;
    async function lane() {
      while (i < items.length) {
        const idx = i++;
        try {
          await worker(items[idx], idx);
        } catch (e) {
          err('runThrottled worker error', e);
        }
        if (i < items.length) await new Promise(r => setTimeout(r, spacingMs));
      }
    }
    const lanes = Array.from({ length: Math.min(concurrency, items.length) }, lane);
    await Promise.all(lanes);
  }

  function saveCache() {
    try {
      const entries = Array.from(cache.entries())
        .filter(([, v]) => v && (v.tr || v.romaja))
        .slice(-6000);
      localStorage.setItem(STORAGE_CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
    } catch (e) {}
  }

  const style = document.createElement('style');
  style.id = 'spicy-tr-style';
  style.textContent = `
    #SpicyLyricsPage .line:not(.musical-line) {
      display: flex !important;
      flex-wrap: wrap !important;
      align-content: flex-start !important;
      --BlurAmount: 0px !important;
      filter: none !important;
      -webkit-filter: none !important;
    }
    #SpicyLyricsPage .spicy-tr-box, #SpicyLyricsPage .spicy-tr-box * {
      color: #ffffff !important;
      -webkit-text-fill-color: #ffffff !important;
      text-shadow: none !important;
      filter: none !important;
      -webkit-filter: none !important;
      backdrop-filter: none !important;
      mix-blend-mode: normal !important;
      background: transparent !important;
      -webkit-background-clip: border-box !important;
      background-clip: border-box !important;
      mask-image: none !important;
      -webkit-mask-image: none !important;
    }
    #SpicyLyricsPage .spicy-tr-box {
      flex-basis: 100% !important;
      width: 100% !important;
      margin-top: 6px !important;
      display: ${isEnabled ? 'flex' : 'none'} !important;
      flex-direction: column !important;
      gap: 3px !important;
      pointer-events: none !important;
      line-height: 1.35 !important;
      opacity: 1 !important;
    }
    #SpicyLyricsPage .spicy-tr-romaja {
      font-size: 0.46em !important;
      font-weight: 500 !important;
      color: rgba(255, 255, 255, 0.82) !important;
      -webkit-text-fill-color: rgba(255, 255, 255, 0.82) !important;
      opacity: 1 !important;
      word-spacing: 2px !important;
    }
    #SpicyLyricsPage .spicy-tr-turkish {
      font-size: 0.52em !important;
      font-weight: 700 !important;
      color: #ffffff !important;
      -webkit-text-fill-color: #ffffff !important;
      opacity: 1 !important;
    }
    #SpicyLyricsPage .line.NotSung, #SpicyLyricsPage .line.Sung { opacity: 0.78 !important; }
    #SpicyLyricsPage .line.Active { opacity: 1 !important; }
    #spicy-tr-toggle-btn {
      background: rgba(255, 255, 255, 0.15); color: #fff; border: 1px solid rgba(255, 255, 255, 0.3);
      border-radius: 50%; width: 32px; height: 32px; font-size: 10px; font-weight: 800; cursor: pointer;
      display: inline-flex; align-items: center; justify-content: center; margin-left: 6px; transition: all 0.2s ease;
    }
    #spicy-tr-toggle-btn.active { background: #1db954; border-color: #1db954; color: #000; }
    #spicy-tr-toggle-btn.ai-mode.active { background: linear-gradient(135deg, #1db954, #00d2ff); border-color: #00d2ff; color: #000; }
  `;
  document.getElementById('spicy-tr-style')?.remove();
  document.head.appendChild(style);

  let resizeTimer;
  function triggerRecalc() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { window.dispatchEvent(new Event('resize')); }, 100);
  }

  function isNonLatin(text) {
    return /[^\x00-\x7F\u00A0-\u024F\u1E00-\u1EFF\u2000-\u206F\u2E00-\u2E7F\s]/u.test(text);
  }

  function normalize(s) {
    return (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  function getCleanText(lineEl) {
    const clone = lineEl.cloneNode(true);
    clone.querySelectorAll('.spicy-tr-box').forEach(el => el.remove());
    return (clone.textContent || '').replace(/\s+/g, ' ').trim();
  }

  async function fetchRomajaLine(rawText) {
    if (!isNonLatin(rawText)) return '';
    try {
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=tr&dt=rm&q=${encodeURIComponent(rawText)}`;
      const res = await fetch(url);
      if (!res.ok) return '';
      const json = await res.json();
      let rom = '';
      if (Array.isArray(json[0])) {
        json[0].forEach(item => { if (item[3]) rom += (rom ? ' ' : '') + item[3]; });
      }
      return rom.trim();
    } catch (e) {
      return '';
    }
  }

  function forcePerfectTurkish(text) {
    if (!text) return '';
    let t = text.trim();
    t = t.replace(/\bVücudunuz\b/gi, 'Vücudun')
         .replace(/\bbelirtin\b/gi, 'söyle')
         .replace(/\bGözleriniz\b/gi, 'Gözlerin')
         .replace(/\bZihniniz\b/gi, 'Zihnin')
         .replace(/\bSizin\b/gi, 'Senin')
         .replace(/\bSize\b/gi, 'Sana')
         .replace(/\bSizi\b/gi, 'Seni')
         .replace(/\bSizde\b/gi, 'Sende')
         .replace(/\bSizden\b/gi, 'Senden');

    t = t.replace(/^Bebek$/gi, 'Bebeğim')
         .replace(/\bBebek\b/gi, 'Bebeğim')
         .replace(/Rap boku/gi, 'Rap');

    // Bare "Siz" as its own word (e.g. "Siz farkına bile varmadan") is unambiguous -
    // always safe to informalize.
    t = t.replace(/\bSiz\b/gi, 'Sen');

    // Possessive/case-marked NOUNS with a formal "-nİz-" plus a FURTHER case ending
    // (dative/accusative/locative) are safe to informalize: imperative VERBS never
    // take a further case suffix (an imperative is already the final word form), so
    // this shape can only be a noun possessive, e.g. "düğmelerinizi" -> "düğmelerini",
    // "Kalbinize" -> "Kalbine". The bare "-nİz" ending with NOTHING after it is left
    // alone on purpose (that's the ambiguous case that broke "uyanınız" before -
    // could be a noun or an imperative, can't tell safely with a regex).
    t = t.replace(/([a-zçğıöşüA-ZÇĞİÖŞÜ]+)inize\b/g, '$1ine')
         .replace(/([a-zçğıöşüA-ZÇĞİÖŞÜ]+)ınıza\b/g, '$1ına')
         .replace(/([a-zçğıöşüA-ZÇĞİÖŞÜ]+)ünüze\b/g, '$1üne')
         .replace(/([a-zçğıöşüA-ZÇĞİÖŞÜ]+)unuza\b/g, '$1una')
         .replace(/([a-zçğıöşüA-ZÇĞİÖŞÜ]+)inizi\b/g, '$1ini')
         .replace(/([a-zçğıöşüA-ZÇĞİÖŞÜ]+)ınızı\b/g, '$1ını')
         .replace(/([a-zçğıöşüA-ZÇĞİÖŞÜ]+)ünüzü\b/g, '$1ünü')
         .replace(/([a-zçğıöşüA-ZÇĞİÖŞÜ]+)unuzu\b/g, '$1unu');

    // A handful of exact formal phrases/words confirmed from real output (safe
    // because they're literal whole-word/phrase matches, not a broad heuristic).
    t = t.replace(/\bdevam edin\b/gi, 'devam et')
         .replace(/\bgevşetin\b/gi, 'gevşet')
         .replace(/\bkeşfedin\b/gi, 'keşfet')
         .replace(/\bçevirin\b/gi, 'çevir');

    t = t.replace(/[.?]+$/, '');
    if (t.length > 0) t = t.charAt(0).toUpperCase() + t.slice(1);
    return t;
  }

  function renderSubtitles(lineEl, data, rawText) {
    let box = lineEl.querySelector('.spicy-tr-box');
    if (box) box.remove();

    box = document.createElement('div');
    box.className = 'spicy-tr-box';

    if (data.romaja && isNonLatin(rawText)) {
      const romEl = document.createElement('div');
      romEl.className = 'spicy-tr-romaja';
      romEl.textContent = data.romaja;
      box.appendChild(romEl);
    }

    if (data.tr && data.tr.toLowerCase() !== rawText.toLowerCase()) {
      const trEl = document.createElement('div');
      trEl.className = 'spicy-tr-turkish';
      trEl.textContent = data.tr;
      box.appendChild(trEl);
    }

    if (box.children.length > 0) {
      lineEl.appendChild(box);
      triggerRecalc();
    }
  }

  function updateDOMWithCache() {
    const lines = document.querySelectorAll('#SpicyLyricsPage .line:not(.musical-line)');
    lines.forEach(el => {
      const text = getCleanText(el);
      if (cache.has(text)) {
        renderSubtitles(el, cache.get(text), text);
      }
    });
  }

  function parseAnchoredAiOutput(rawOutput) {
    const results = [];
    if (!rawOutput) return results;
    const cleaned = rawOutput.replace(/^```[a-z]*\s*/im, '').replace(/```\s*$/im, '');
    const blocks = cleaned.split(/\n\s*---\s*\n?/);
    const blockRegex = /SRC:\s*([\s\S]*?)\n\s*ROM:\s*([\s\S]*?)\n\s*TR:\s*([\s\S]*)/i;
    for (const block of blocks) {
      const m = block.match(blockRegex);
      if (!m) continue;
      const src = m[1].trim();
      let rom = m[2].trim();
      const tr = m[3].trim();
      if (/^none$/i.test(rom)) rom = '';
      if (src && tr) results.push({ src, rom, tr });
    }
    return results;
  }

  const GEMINI_MODELS = [
    'gemini-flash-latest',
    'gemini-3.1-flash-lite',
    'gemini-3-flash-preview',
    'gemini-2.5-flash'
  ];

  async function translateChunkWithGemini(chunkLines) {
    const songTitle = Spicetify?.Player?.data?.item?.name || 'Unknown Song';
    const artist = Spicetify?.Player?.data?.item?.artists?.[0]?.name || 'Unknown Artist';
    const inputLinesText = chunkLines.map(l => `- ${l}`).join('\n');

    const prompt = `You are Turkey's ultimate music translator localizing song lyrics into natural Turkish.
Song: "${songTitle}" by "${artist}"

CRITICAL RULES:
1. ALWAYS INFORMAL "SEN", NEVER FORMAL "SİZ" - no exceptions, in any language the source is in. This applies to every verb ending and every possessive, not just the pronoun itself.
   WRONG (formal - never output anything like this): "Ters çevirin", "gevşetin", "keşfedin", "devam edin", "Kalbinize", "düğmelerinizi", "yerlerinizi", "Siz farkına bile varmadan", "görüş alanınızdadır"
   RIGHT (informal - always output like this instead): "Ters çevir", "gevşet", "keşfet", "devam et", "Kalbine", "düğmelerini", "yerlerini", "Sen farkına bile varmadan", "görüş alanındadır"
2. NO LINE SKIP OR SHIFT: You MUST translate EVERY SINGLE line listed below into Turkish, with no exceptions - including lines that are already in English, already seem simple/understandable, or match the song's title. Never leave a line as-is just because it "already makes sense" - every line gets its own real Turkish translation.
3. REPEATED/STYLIZED AD-LIBS: if a line is a rhythmic ad-lib or vocalization using repetition (e.g. "On&on&on&on oh", "La la la la"), do NOT translate each repeated token as a separate literal word (never turn "On&on&on&on" into something like "Açık&açık&açık" by translating "on" as the on/off switch word) - treat the whole repeated pattern as one vocal/rhythmic unit and either keep it as a natural-sounding vocal ad-lib or give one single natural Turkish equivalent for the whole thing, never a word-by-word literal mess.
4. ROMANIZATION IS MANDATORY for every line not already in Latin script - NEVER write NONE for Korean, Japanese, Chinese, Thai, or any other non-Latin script, even when a perfectly clean version is hard to produce. Always give your best simple phonetic attempt instead of skipping it - an imperfect romanization is always better than none. (Only write NONE when the line is ALREADY in Latin script, e.g. English/Turkish - never as a way to avoid a hard case.)
   STYLE: keep it casual and readable, the way an ordinary person types out pronunciation online. Standard single accent marks from an established system are fine (e.g. Chinese Hanyu Pinyin tone marks like ā/í/ǒ/ù). AVOID heavy academic/IAST-style transliteration with multiple stacked diacritics per letter (underdots, combined circumflex+macron, breve+dot stacks, etc.) - this has specifically been a problem for Thai; simplify those down to plain, easy-to-read Latin spelling instead of a technically "precise" but unreadable version.
5. OUTPUT FORMAT: For EVERY line listed below, output exactly this format separated by ---:
SRC: <exact original line>
ROM: <simple plain-Latin phonetic romanization if non-Latin script, otherwise write NONE>
TR: <natural Turkish translation using informal 'sen', per rule 1>
---

Lines to translate:
${inputLinesText}`;

    let lastError = new Error('Tüm Gemini modelleri şu an soğuma süresinde veya kullanılamıyor');
    let anyModelAttempted = false;

    for (const model of GEMINI_MODELS) {
      if ((deadModels.get(model) || 0) > Date.now()) continue;
      anyModelAttempted = true;

      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey.trim()}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.2, maxOutputTokens: 4096 }
          })
        });

        if (!res.ok) {
          deadModels.set(model, Date.now() + 60000);
          throw new Error(`HTTP ${res.status}`);
        }

        const json = await res.json();
        const rawOutput = json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const parsed = parseAnchoredAiOutput(rawOutput);

        if (parsed.length === 0) throw new Error('Empty AI response');

        const normToRaw = new Map(chunkLines.map(l => [normalize(l), l]));
        const matched = new Set();

        parsed.forEach(({ src, rom, tr }) => {
          const key = normalize(src);
          let rawLine = normToRaw.get(key);
          if (!rawLine) {
            rawLine = chunkLines.find(l => !matched.has(l) && (normalize(l).includes(key) || key.includes(normalize(l))) && key.length > 2);
          }
          if (rawLine && !matched.has(rawLine)) {
            matched.add(rawLine);
            cache.set(rawLine, {
              tr: forcePerfectTurkish(tr),
              romaja: isNonLatin(rawLine) ? (rom || '') : ''
            });
          }
        });

        saveCache();
        updateDOMWithCache();

        geminiGloballyDownUntil = 0; // it just worked, so Gemini is clearly back

        const leftover = chunkLines.filter(l => !matched.has(l));
        return leftover;
      } catch (modelErr) {
        lastError = modelErr;
      }
    }

    // Every model was either on cooldown or just failed - no point hammering a
    // dead/quota-exhausted key on every single chunk. Back off globally for a bit
    // so new chunks go straight to the GTX fallback instead of each silently
    // wasting a cycle (and, previously, crashing before reaching GTX at all).
    if (!anyModelAttempted || GEMINI_MODELS.every(m => (deadModels.get(m) || 0) > Date.now())) {
      if (geminiGloballyDownUntil <= Date.now()) {
        warn('Tüm Gemini modelleri kullanılamıyor (kota/limit olabilir) - GTX motoruna geçiliyor, 2 dakika sonra Gemini tekrar denenecek');
      }
      geminiGloballyDownUntil = Date.now() + 120000;
    }

    throw lastError;
  }

  // GTX (Google Translate) has no song context and is known to badly mistranslate
  // a handful of very common rap/hip-hop slang words when they appear with no
  // surrounding context (e.g. "hoes" -> "shoes", "ho" -> literally "pig" in some
  // cases) - a well-known Google Translate quirk, not something we can prompt our
  // way out of since GTX isn't an LLM. Gemini already handles this correctly (it
  // has context + explicit instructions), so this normalization ONLY applies to
  // text sent to GTX, never to Gemini, and never changes what's cached/displayed
  // as the "original" line - only what's sent to the translate API.
  const GTX_SLANG_NORMALIZE = [
    [/\bhoes\b/gi, 'women'],
    [/\bhoe\b/gi, 'woman'],
    [/\bho\b/gi, 'woman'],
    [/\bthots?\b/gi, 'women']
  ];
  function normalizeForGTX(text) {
    let t = text;
    GTX_SLANG_NORMALIZE.forEach(([re, repl]) => { t = t.replace(re, repl); });
    return t;
  }

  // PATCHED: no more silent fallback to `trLine = rawText` (that's what was poisoning
  // the cache and permanently killing lines). A genuine failure now marks the line
  // for retry instead. Per-line requests are now lightly throttled instead of firing
  // in one unthrottled burst.
  async function translateWithGTX(linesToTranslate) {
    if (Date.now() < gtxGloballyDownUntil) {
      // GTX has failed repeatedly in a row recently (sustained rate-limiting) -
      // don't keep re-triggering the same block, just cool these lines down and
      // let them retry once the backoff window passes.
      linesToTranslate.forEach(t => markFailed(t));
      return;
    }

    const joinedBlock = linesToTranslate.map(normalizeForGTX).join('.\n');
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=tr&dt=t&dj=1&q=${encodeURIComponent(joinedBlock)}`;

    let splitLines = [];
    let batchOk = false;
    try {
      const res = await fetch(url);
      if (res.ok) {
        const json = await res.json();
        const fullText = (json.sentences || []).map(s => s.trans || '').join('');
        splitLines = fullText.split('\n').map(s => s.replace(/\.$/, '').trim());
        batchOk = true;
      } else {
        warn('GTX batch HTTP', res.status);
      }
    } catch (e) {
      err('GTX batch fetch failed:', e.message || e);
    }

    if (!batchOk) {
      gtxConsecutiveFailures++;
      if (gtxConsecutiveFailures >= 3 && gtxGloballyDownUntil <= Date.now()) {
        warn('GTX tekrar tekrar başarısız oluyor (muhtemelen rate-limit) - 3 dakikalığına devre dışı bırakılıyor, sonra otomatik tekrar denenecek');
        gtxGloballyDownUntil = Date.now() + 180000;
      }
      // Don't amplify a single failure into N parallel per-line requests - just
      // cool these lines down and let the next scan cycle retry them.
      linesToTranslate.forEach(t => markFailed(t));
      return;
    }
    gtxConsecutiveFailures = 0;
    gtxGloballyDownUntil = 0;

    await runThrottled(linesToTranslate, async (rawText, idx) => {
      let trLine = splitLines[idx] || '';
      let romaja = isNonLatin(rawText) ? await fetchRomajaLine(rawText) : '';

      if (!trLine) {
        try {
          const singleUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=tr&dt=t&q=${encodeURIComponent(normalizeForGTX(rawText))}`;
          const r = await fetch(singleUrl);
          if (r.ok) {
            const j = await r.json();
            if (Array.isArray(j[0])) {
              trLine = j[0].map(p => p[0] || '').join('').trim();
            }
          }
        } catch (e) {
          err('GTX single-line fallback failed for', rawText, e.message || e);
        }
      }

      if (trLine && normalize(trLine) !== normalize(rawText)) {
        cache.set(rawText, { tr: forcePerfectTurkish(trLine), romaja });
      } else {
        markFailed(rawText);
      }
    }, { concurrency: 2, spacingMs: 150 });

    saveCache();
    updateDOMWithCache();
  }

  // PATCHED: chunk requests now go through a concurrency cap (4 at once) instead of
  // an unlimited Promise.all, and missing-line selection now respects the failedUntil
  // cooldown so a just-failed line doesn't get re-queued on the very next mutation tick.
  async function processQueue(allVisibleLines) {
    const now = Date.now();
    const missing = allVisibleLines.filter(t =>
      !cache.has(t) && !inFlight.has(t) && (failedUntil.get(t) || 0) <= now
    );
    if (missing.length === 0) return;

    missing.forEach(t => inFlight.add(t));

    const chunks = [];
    for (let i = 0; i < missing.length; i += CHUNK_SIZE) {
      chunks.push(missing.slice(i, i + CHUNK_SIZE));
    }

    await runThrottled(chunks, async (chunk) => {
      try {
        let leftover = chunk;
        const geminiReady = geminiApiKey && geminiApiKey.trim().length > 10 && Date.now() >= geminiGloballyDownUntil;
        if (geminiReady) {
          try {
            leftover = await translateChunkWithGemini(chunk);
          } catch (e) {
            warn('Gemini chunk failed entirely, falling back to GTX:', (e && e.message) || e || 'unknown error');
            leftover = chunk;
          }
        }
        if (leftover && leftover.length > 0) {
          await translateWithGTX(leftover);
        }
      } finally {
        chunk.forEach(t => inFlight.delete(t));
      }
    }, { concurrency: 4, spacingMs: 80 });
  }

  function injectToggleButton() {
    const controls = document.querySelector('#SpicyLyricsPage .ViewControls');
    if (!controls || document.getElementById('spicy-tr-toggle-btn')) return;

    const btn = document.createElement('button');
    btn.id = 'spicy-tr-toggle-btn';
    const updateBtnVisual = () => {
      btn.className = `${isEnabled ? 'active' : ''} ${geminiApiKey ? 'ai-mode' : ''}`.trim();
      btn.textContent = geminiApiKey ? 'AI' : 'TR';
      btn.title = geminiApiKey ? 'God Mode V33' : 'API Anahtarı Gir';
    };
    updateBtnVisual();

    btn.onclick = () => {
      isEnabled = !isEnabled;
      localStorage.setItem('spicy_tr_enabled', isEnabled);
      updateBtnVisual();
      document.querySelectorAll('#SpicyLyricsPage .spicy-tr-box').forEach(b => {
        b.style.setProperty('display', isEnabled ? 'flex' : 'none', 'important');
      });
      triggerRecalc();
    };

    btn.oncontextmenu = (e) => {
      e.preventDefault();
      const input = prompt('🌟 Spicy Lyrics V33 🌟\nGemini API Anahtarınızı girin:', geminiApiKey);
      if (input !== null) {
        geminiApiKey = input.trim();
        localStorage.setItem('spicy_tr_gemini_key', geminiApiKey);
        cache.clear();
        failedUntil.clear();
        inFlight.clear();
        localStorage.removeItem(STORAGE_CACHE_KEY);
        document.querySelectorAll('#SpicyLyricsPage .spicy-tr-box').forEach(b => b.remove());
        updateBtnVisual();
        scanLines();
      }
    };
    controls.appendChild(btn);
  }

  function scanLines() {
    injectToggleButton();
    const lineEls = Array.from(document.querySelectorAll('#SpicyLyricsPage .line:not(.musical-line)'));
    const allVisibleTexts = [];
    let hasMissing = false;

    lineEls.forEach(lineEl => {
      const text = getCleanText(lineEl);
      if (!text || text === '•••') return;

      if (!allVisibleTexts.includes(text)) {
        allVisibleTexts.push(text);
      }

      if (cache.has(text)) {
        if (!lineEl.querySelector('.spicy-tr-box')) {
          renderSubtitles(lineEl, cache.get(text), text);
        }
      } else if (!inFlight.has(text) && (failedUntil.get(text) || 0) <= Date.now()) {
        hasMissing = true;
      }
    });

    if (hasMissing && allVisibleTexts.length > 0) {
      clearTimeout(batchTimer);
      batchTimer = setTimeout(() => {
        processQueue(allVisibleTexts);
      }, 50);
    }
  }

  function triggerMultiStageScan() {
    scanLines();
    setTimeout(scanLines, 100);
    setTimeout(scanLines, 300);
    setTimeout(scanLines, 600);
    setTimeout(scanLines, 1200);
  }

  if (window._spicyTrObserver) window._spicyTrObserver.disconnect();
  window._spicyTrObserver = new MutationObserver(() => scanLines());
  window._spicyTrObserver.observe(document.body, { childList: true, subtree: true });

  window.addEventListener('scroll', () => scanLines(), true);

  // Seek detection: compare each reported position against what normal playback
  // would predict since the last report. A big mismatch means the user scrubbed to
  // a new point - force a rescan immediately instead of waiting on DOM/scroll
  // listeners to maybe notice.
  let lastKnownPos = null;
  let lastKnownPosAt = null;
  const SEEK_JUMP_THRESHOLD_MS = 1500;

  function handleProgress(posMs) {
    if (typeof posMs !== 'number') return;
    const now = Date.now();
    if (lastKnownPos !== null && lastKnownPosAt !== null) {
      const expected = lastKnownPos + (now - lastKnownPosAt);
      const delta = Math.abs(posMs - expected);
      if (delta > SEEK_JUMP_THRESHOLD_MS) {
        log('seek detected (~' + Math.round(delta / 1000) + 's jump), forcing rescan');
        triggerMultiStageScan();
      }
    }
    lastKnownPos = posMs;
    lastKnownPosAt = now;
  }

  if (Spicetify?.Player) {
    Spicetify.Player.addEventListener("songchange", () => {
      lastKnownPos = null;
      lastKnownPosAt = null;
      setTimeout(triggerMultiStageScan, 50);
    });
    Spicetify.Player.addEventListener("onprogress", (event) => {
      handleProgress(event?.data);
    });
  }

  triggerMultiStageScan();
})();
