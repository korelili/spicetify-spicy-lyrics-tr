// NAME: Spicy Lyrics AI Translator & Romaja
// AUTHOR: korelili (patched)
// VERSION: 36.0.0 (No More Cache Wipes + Multi-Key Rotation + 3rd Fallback Engine)
//
// PREVIOUS HISTORY (condensed): V20-V33 fixed CSS bleed-through, song-change
// and seek detection, persistent localStorage caching, and the core "never
// leave a line untranslated" + ad-lib rules. V34.x moved to whole-song
// batch translation with per-line GTX fallback and exponential backoff for
// both engines instead of hammering a dead quota. V35 replaced the fragile
// "SRC:/ROM:/TR:/---" text block + fuzzy text-matching with native JSON
// structured output mapped back to lines by position, turned off Gemini's
// default "thinking" (it was silently eating the output-token budget and
// could truncate long songs), raised the output cap to the models' real
// ceiling, and added gemini-2.5-flash-lite as a high-quota fallback model.
//
// V36 - WHAT CHANGED AND WHY (direct response to real-world reports):
//
// 1) STOPPED WIPING THE TRANSLATION CACHE ON VERSION/KEY CHANGES. V35
//    bumped the cache storage key (to avoid mixing old/new translation
//    style) and the "edit API key" button ALSO wiped the cache as part of
//    its "unstick everything" reset. In practice this meant: the first
//    time V35 loaded, every previously-cached line across every song
//    became a cache miss at once, and simply opening the key-edit prompt
//    to add a key did the same thing again - both cause a sudden burst of
//    API calls that can exhaust a free key's daily quota in minutes
//    instead of the hours it would normally take, which is almost
//    certainly why translation can appear to "just stop" right after
//    editing the key or updating the script. V36 keeps the SAME cache
//    storage key as V35 (do not bump this casually in a future patch -
//    see above) and the key-edit prompt no longer touches the cache at
//    all, only backoff timers get reset (cheap, no data loss). A full
//    cache wipe is still available on purpose (Shift+right-click) for
//    when one is actually needed.
//
// 2) MULTIPLE GEMINI API KEYS: the key-edit prompt now accepts several
//    comma-separated keys. Each free Google account/key has its own
//    separate daily quota, so two or three keys together are two or three
//    times the effective free-tier headroom. Tried best-model-first across
//    every key before ever dropping to a lower-tier model.
//
// 3) THIRD FALLBACK ENGINE: added MyMemory (api.mymemory.translated.net,
//    no key required, independent rate-limit pool from Google Translate)
//    behind GTX. It has no romanization output of its own, so it only
//    fills in the Turkish line, not the romaja line - but it's one more
//    independent chance at a result, and it means Gemini and GTX both
//    being rate-limited at the same moment no longer stops translation
//    outright.
//
// HONESTY NOTE: none of this invents quota Google/MyMemory haven't
// granted - it reduces how much of it the tool itself was burning
// needlessly, and spreads real usage across more independent pools. On a
// single free key with heavy same-session listening, you can still
// eventually hit a wall for the day; more keys and the 3rd engine push
// that wall a lot further out, they don't remove it.

(function spicyTurkishProV36() {
  const DEBUG = true;
  const log = (...args) => { if (DEBUG) console.log('%c[SpicyTR V36]', 'color:#1db954;font-weight:bold', ...args); };
  const warn = (...args) => { if (DEBUG) console.warn('%c[SpicyTR V36]', 'color:#ffae00;font-weight:bold', ...args); };
  const err = (...args) => { if (DEBUG) console.error('%c[SpicyTR V36]', 'color:#ff4b4b;font-weight:bold', ...args); };

  [
    'spicy_tr_persistent_cache_v5', 'spicy_tr_persistent_cache_v12_final',
    'spicy_tr_marketplace_v19', 'spicy_tr_stable_v20', 'spicy_tr_ultimate_v21',
    'spicy_tr_unbreakable_v22', 'spicy_tr_godmode_v23', 'spicy_tr_godmode_v26',
    'spicy_tr_godmode_v27', 'spicy_tr_godmode_v28', 'spicy_tr_godmode_v29',
    'spicy_tr_godmode_v30', 'spicy_tr_godmode_v31', 'spicy_tr_godmode_v32',
    'spicy_tr_godmode_v33', 'spicy_tr_godmode_v34'
    // NOTE: 'spicy_tr_godmode_v34_1' and 'spicy_tr_godmode_v35' are
    // deliberately NOT in this list. V35 already consumed v34_1 once; V36
    // intentionally keeps reading/writing the SAME key V35 used
    // (STORAGE_CACHE_KEY below) instead of rotating to a new one, so nobody
    // loses a cache again just from updating the script. Only bump this key
    // if the cached DATA SHAPE itself changes, never just to "freshen" it.
  ].forEach(k => localStorage.removeItem(k));

  const STORAGE_CACHE_KEY = 'spicy_tr_godmode_v35';
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
  const deadModels = new Map(); // "<keyFingerprint>::<model>" -> cooldown timestamp
  const MODEL_DEAD_SHORT_MS = 60000;            // transient error (rate limit, 5xx)
  const MODEL_DEAD_LONG_MS = 6 * 60 * 60 * 1000; // 404 = wrong/retired model id

  // Exponential backoff state for Gemini as a whole (resets on any success)
  const GEMINI_BACKOFF_STEPS_MS = [60000, 120000, 300000, 600000]; // 1m,2m,5m,10m
  let geminiGloballyDownUntil = 0;
  let geminiBackoffStage = 0;

  // Exponential backoff state for GTX (resets to stage 0 on any success)
  const GTX_BACKOFF_STEPS_MS = [30000, 60000, 120000, 240000, 480000]; // 30s..8m
  let gtxGloballyDownUntil = 0;
  let gtxBackoffStage = 0;
  let gtxConsecutiveFailures = 0;

  // Exponential backoff state for MyMemory (same shape as GTX, independent)
  const MM_BACKOFF_STEPS_MS = [30000, 60000, 120000, 240000, 480000];
  let mmGloballyDownUntil = 0;
  let mmBackoffStage = 0;
  let mmConsecutiveFailures = 0;

  let isEnabled = localStorage.getItem('spicy_tr_enabled') !== 'false';
  let batchTimer = null;

  // --- Gemini API keys: supports one or many, comma/newline separated ---
  const GEMINI_KEYS_STORAGE = 'spicy_tr_gemini_keys';
  function keyFp(key) {
    return (key || '').trim().slice(-6);
  }
  let geminiApiKeys = [];
  try {
    const storedKeys = JSON.parse(localStorage.getItem(GEMINI_KEYS_STORAGE) || '[]');
    if (Array.isArray(storedKeys)) {
      geminiApiKeys = storedKeys.filter(k => typeof k === 'string' && k.trim().length > 10);
    }
  } catch (e) {}
  // One-time migration from the old single-key format (pre-V36).
  const legacyKey = localStorage.getItem('spicy_tr_gemini_key');
  if (legacyKey && legacyKey.trim().length > 10 && !geminiApiKeys.includes(legacyKey.trim())) {
    geminiApiKeys.push(legacyKey.trim());
    try { localStorage.setItem(GEMINI_KEYS_STORAGE, JSON.stringify(geminiApiKeys)); } catch (e) {}
  }
  localStorage.removeItem('spicy_tr_gemini_key');

  // A whole typical song (verses+chorus+bridge, de-duplicated) almost always
  // fits under this in one Gemini call. If a song has more unique lines than
  // this, it's split into sequential (not parallel) groups, each still
  // carrying the full song as context, so quota usage stays bounded even on
  // unusually long songs.
  const MAX_LINES_PER_GEMINI_CALL = 50;
  // Real ceiling for all four models below is 65536 output tokens. With
  // thinking turned off, every one of those tokens goes to the actual JSON
  // translation instead of invisible reasoning, so this is comfortably more
  // than even a 50-line/call batch needs - the goal is "never truncate".
  const GEMINI_MAX_OUTPUT_TOKENS = 65536;

  function markFailed(text, cooldownMs) {
    failedUntil.set(text, Date.now() + (cooldownMs || FAILURE_COOLDOWN_MS));
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
    #spicy-tr-toggle-btn.quota-warn { background: linear-gradient(135deg, #ffae00, #ff4b4b) !important; border-color: #ffae00 !important; color: #000; font-size: 8px; }
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

  // Safety net for the "words glued together with no space" pattern seen in
  // real output (romanization AND, occasionally, the Turkish line itself).
  // JSON output removed one whole class of join-related glue bugs, but a
  // single string field can still come back glued if the model itself drops
  // a space - this catches that regardless of source.
  function fixGluedWords(s) {
    if (!s) return s;
    return s.replace(/([a-zçğıöşü0-9])([A-ZÇĞİÖŞÜ])/g, '$1 $2');
  }

  function getCleanText(lineEl) {
    const clone = lineEl.cloneNode(true);
    clone.querySelectorAll('.spicy-tr-box').forEach(el => el.remove());
    return (clone.textContent || '').replace(/\s+/g, ' ').trim();
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
         .replace(/\bSizden\b/gi, 'Senden')
         .replace(/\bSizce\b/gi, 'Sence');

    t = t.replace(/^Bebek$/gi, 'Bebeğim')
         .replace(/\bBebek\b/gi, 'Bebeğim')
         .replace(/Rap boku/gi, 'Rap');

    t = t.replace(/\bSiz\b/gi, 'Sen');

    t = t.replace(/([a-zçğıöşüA-ZÇĞİÖŞÜ]+)inize\b/g, '$1ine')
         .replace(/([a-zçğıöşüA-ZÇĞİÖŞÜ]+)ınıza\b/g, '$1ına')
         .replace(/([a-zçğıöşüA-ZÇĞİÖŞÜ]+)ünüze\b/g, '$1üne')
         .replace(/([a-zçğıöşüA-ZÇĞİÖŞÜ]+)unuza\b/g, '$1una')
         .replace(/([a-zçğıöşüA-ZÇĞİÖŞÜ]+)inizi\b/g, '$1ini')
         .replace(/([a-zçğıöşüA-ZÇĞİÖŞÜ]+)ınızı\b/g, '$1ını')
         .replace(/([a-zçğıöşüA-ZÇĞİÖŞÜ]+)ünüzü\b/g, '$1ünü')
         .replace(/([a-zçğıöşüA-ZÇĞİÖŞÜ]+)unuzu\b/g, '$1unu')
         .replace(/([a-zçğıöşüA-ZÇĞİÖŞÜ]+)inizde\b/g, '$1inde')
         .replace(/([a-zçğıöşüA-ZÇĞİÖŞÜ]+)ınızda\b/g, '$1ında')
         .replace(/([a-zçğıöşüA-ZÇĞİÖŞÜ]+)ünüzde\b/g, '$1ünde')
         .replace(/([a-zçğıöşüA-ZÇĞİÖŞÜ]+)unuzda\b/g, '$1unda')
         .replace(/([a-zçğıöşüA-ZÇĞİÖŞÜ]+)inizden\b/g, '$1inden')
         .replace(/([a-zçğıöşüA-ZÇĞİÖŞÜ]+)ınızdan\b/g, '$1ından')
         .replace(/([a-zçğıöşüA-ZÇĞİÖŞÜ]+)ünüzden\b/g, '$1ünden')
         .replace(/([a-zçğıöşüA-ZÇĞİÖŞÜ]+)unuzdan\b/g, '$1undan')
         .replace(/([a-zçğıöşüA-ZÇĞİÖŞÜ]+)inizin\b/g, '$1inin')
         .replace(/([a-zçğıöşüA-ZÇĞİÖŞÜ]+)ınızın\b/g, '$1ının')
         .replace(/([a-zçğıöşüA-ZÇĞİÖŞÜ]+)ünüzün\b/g, '$1ünün')
         .replace(/([a-zçğıöşüA-ZÇĞİÖŞÜ]+)unuzun\b/g, '$1unun')
         .replace(/([a-zçğıöşüA-ZÇĞİÖŞÜ]+)inizle\b/g, '$1inle')
         .replace(/([a-zçğıöşüA-ZÇĞİÖŞÜ]+)ınızla\b/g, '$1ınla')
         .replace(/([a-zçğıöşüA-ZÇĞİÖŞÜ]+)ünüzle\b/g, '$1ünle')
         .replace(/([a-zçğıöşüA-ZÇĞİÖŞÜ]+)unuzla\b/g, '$1unla');

    t = t.replace(/\bmusunuz\b/gi, 'musun')
         .replace(/\bmüsünüz\b/gi, 'müsün')
         .replace(/\bmısınız\b/gi, 'mısın')
         .replace(/\bmisiniz\b/gi, 'misin');

    t = t.replace(/\bdevam edin\b/gi, 'devam et')
         .replace(/\bgevşetin\b/gi, 'gevşet')
         .replace(/\bkeşfedin\b/gi, 'keşfet')
         .replace(/\bçevirin\b/gi, 'çevir')
         .replace(/\bbırakın\b/gi, 'bırak')
         .replace(/\bunutmayın\b/gi, 'unutma')
         .replace(/\bhissedin\b/gi, 'hisset')
         .replace(/\bizleyin\b/gi, 'izle')
         .replace(/\bdinleyin\b/gi, 'dinle')
         .replace(/\bhatırlayın\b/gi, 'hatırla')
         .replace(/\btutun\b/gi, 'tut');

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

  // Parses the JSON array Gemini is asked to return (one {rom, tr} object
  // per requested line, in order). Returns null on anything that isn't
  // EXACTLY an array of the expected length - the caller treats null as a
  // full miss for the whole chunk rather than trying to salvage a partial
  // result, which is what makes this immune to the old "misaligned SRC
  // match" failure class: there is nothing left to misalign.
  function parseGeminiJsonArray(rawOutput, expectedCount) {
    if (!rawOutput) return null;
    const cleaned = rawOutput.trim().replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/i, '');
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      return null;
    }
    if (!Array.isArray(parsed) || parsed.length !== expectedCount) return null;
    return parsed;
  }

  // Ordered best-quality-first, except gemini-2.5-flash-lite which is kept
  // LAST on purpose: it currently has the most generous free-tier daily
  // quota of the four, so it's the high-headroom fallback that keeps
  // translation alive once the others are rate-limited for the day, not
  // the first choice for quality.
  const GEMINI_MODELS = [
    'gemini-2.5-flash',
    'gemini-3-flash-preview',
    'gemini-3.1-flash-lite',
    'gemini-2.5-flash-lite'
  ];

  // chunkLines: the lines that still need a translation.
  // allSongLines: every line currently known for this song (cached or not) -
  // sent purely as context so the translation of chunkLines stays coherent
  // with the whole song's meaning/tone, never output back.
  async function translateChunkWithGemini(chunkLines, allSongLines) {
    const songTitle = Spicetify?.Player?.data?.item?.name || 'Unknown Song';
    const artist = Spicetify?.Player?.data?.item?.artists?.[0]?.name || 'Unknown Artist';
    const contextLinesText = allSongLines.map(l => `- ${l}`).join('\n');
    const targetLinesText = chunkLines.map((l, i) => `${i + 1}. ${l}`).join('\n');

    const prompt = `You are Turkey's ultimate music translator localizing song lyrics into natural Turkish.
Song: "${songTitle}" by "${artist}"

FULL LYRICS OF THIS SONG, for context only (story, tone, emotional arc, who's speaking to whom). Do NOT output anything for these lines - they exist only so your translation of the numbered lines below stays consistent with the whole song's meaning:
${contextLinesText}

Now translate the following ${chunkLines.length} numbered lines, in order:
${targetLinesText}

CRITICAL RULES:
1. ALWAYS INFORMAL "SEN", NEVER FORMAL "SİZ" - no exceptions, in any language the source is in. This applies to every verb ending and every possessive, not just the pronoun itself.
   WRONG (formal - never output anything like this): "Ters çevirin", "gevşetin", "keşfedin", "devam edin", "Kalbinize", "düğmelerinizi", "yerlerinizi", "Siz farkına bile varmadan", "görüş alanınızdadır"
   RIGHT (informal - always output like this instead): "Ters çevir", "gevşet", "keşfet", "devam et", "Kalbine", "düğmelerini", "yerlerini", "Sen farkına bile varmadan", "görüş alanındadır"
2. NO LINE SKIP OR SHIFT: your JSON array MUST contain exactly ${chunkLines.length} objects, one per numbered line above, in the exact same order - including lines that are already in English, already seem simple/understandable, or match the song's title. Never leave a line as-is just because it "already makes sense" - every line gets its own real Turkish translation.
3. REPEATED/STYLIZED AD-LIBS: if a line is a rhythmic ad-lib or vocalization using repetition (e.g. "On&on&on&on oh", "La la la la"), do NOT translate each repeated token as a separate literal word - treat the whole repeated pattern as one vocal/rhythmic unit and either keep it as a natural-sounding vocal ad-lib or give one single natural Turkish equivalent for the whole thing, never a word-by-word literal mess.
3b. FEELING OVER LITERAL WORDS: you are localizing a song for a Turkish listener to FEEL, not producing a dictionary crib. Prefer the natural way a Turkish songwriter/poet would phrase the same image over a flat word-for-word rendering - e.g. for an intensified color/quality, prefer Turkish's own reduplicated intensifiers where they fit naturally ("masmavi" rather than "çok mavi", "bembeyaz" rather than "çok beyaz", "güpegündüz" for broad daylight), and generally favor an evocative, idiomatic phrase over a technically-accurate-but-stiff one, as long as the core meaning is preserved.
3c. TITLE / HOOK LINES: a line that IS or closely matches the song's own title (given above as "Song:"), or a repeated stylized hook built from mixed fragments, will not translate sensibly word-for-word. For these, give a short, natural-sounding Turkish phrase that captures the vibe/mood of the hook instead, the way a Turkish cover or localized title would read.
4. ROMANIZATION IS MANDATORY for every line not already in Latin script - NEVER leave "rom" empty for Korean, Japanese, Chinese, Thai, or any other non-Latin script, even when a perfectly clean version is hard to produce. Always give your best simple phonetic attempt instead of skipping it. (Only use an empty string for "rom" when the line is ALREADY in Latin script.)
   STYLE: keep it casual and readable, the way an ordinary person types out pronunciation online. Standard single accent marks from an established system are fine. AVOID heavy academic/IAST-style transliteration with multiple stacked diacritics per letter.
   SPACING IS MANDATORY: always put a space between romanized WORDS exactly the way the original line's words are separated - never concatenate several words into one unbroken string.
5. OUTPUT FORMAT: respond with ONLY a JSON array matching the given schema - exactly ${chunkLines.length} objects, in the same order as the numbered lines above. Each object has "rom" (romanization, or "" if the line is already Latin script) and "tr" (the natural Turkish translation using informal "sen", per rule 1). No extra text, no markdown, no numbering in the output - just the array.`;

    let lastError = new Error('Tüm Gemini anahtar/model kombinasyonları şu an soğuma süresinde veya kullanılamıyor');

    // Model-outer, key-inner: tries the best model across every configured
    // key before ever dropping to a lower-tier model. This both reaches a
    // working combo faster when one key is simply exhausted for the day,
    // and keeps translation quality as high as possible for as long as
    // possible across however many keys are configured.
    for (const model of GEMINI_MODELS) {
      for (const apiKey of geminiApiKeys) {
        const comboKey = `${keyFp(apiKey)}::${model}`;
        if ((deadModels.get(comboKey) || 0) > Date.now()) continue;

        try {
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey.trim()}`;
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: {
                temperature: 0.2,
                maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS,
                thinkingConfig: { thinkingBudget: 0 },
                responseMimeType: 'application/json',
                responseSchema: {
                  type: 'ARRAY',
                  items: {
                    type: 'OBJECT',
                    properties: {
                      rom: { type: 'STRING' },
                      tr: { type: 'STRING' }
                    },
                    required: ['tr']
                  }
                }
              }
            })
          });

          if (!res.ok) {
            if (res.status === 404) {
              deadModels.set(comboKey, Date.now() + MODEL_DEAD_LONG_MS);
              warn(`Model "${model}" bulunamadı (404, anahtar ...${keyFp(apiKey)}) - muhtemelen kaldırılmış/geçersiz model id, 6 saatliğine devre dışı bırakıldı`);
            } else {
              deadModels.set(comboKey, Date.now() + MODEL_DEAD_SHORT_MS);
            }
            throw new Error(`HTTP ${res.status}`);
          }

          const json = await res.json();
          const rawOutput = json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
          const parsed = parseGeminiJsonArray(rawOutput, chunkLines.length);

          if (!parsed) throw new Error('JSON eksik/satır sayısı uyuşmuyor');

          chunkLines.forEach((rawLine, i) => {
            const item = parsed[i] || {};
            const trRaw = (item.tr || '').trim();
            if (!trRaw) return; // left unmatched -> falls through to GTX/MyMemory

            const cleanTr = fixGluedWords(forcePerfectTurkish(trRaw));

            // If Gemini just echoed the line back untranslated, DON'T cache
            // it - that would mark the line "done" forever while rendering
            // nothing, permanently hiding it. Leave it unmatched so it
            // falls through to the fallback engines below.
            if (normalize(cleanTr) === normalize(rawLine)) return;

            const cleanRom = isNonLatin(rawLine) ? fixGluedWords((item.rom || '').trim()) : '';
            cache.set(rawLine, { tr: cleanTr, romaja: cleanRom });
          });

          saveCache();
          updateDOMWithCache();

          geminiGloballyDownUntil = 0; // it just worked, so Gemini is clearly back
          geminiBackoffStage = 0;

          const leftover = chunkLines.filter(l => {
            const c = cache.get(l);
            return !c || !c.tr;
          });
          return leftover;
        } catch (modelErr) {
          lastError = modelErr;
        }
      }
    }

    // Every key x model combo was either on cooldown or just failed - back
    // off with growing delays instead of hammering dead/quota-exhausted
    // keys every fixed interval.
    const allCombosDead = geminiApiKeys.length === 0 ||
      GEMINI_MODELS.every(model => geminiApiKeys.every(apiKey => (deadModels.get(`${keyFp(apiKey)}::${model}`) || 0) > Date.now()));

    if (allCombosDead) {
      const waitMs = GEMINI_BACKOFF_STEPS_MS[Math.min(geminiBackoffStage, GEMINI_BACKOFF_STEPS_MS.length - 1)];
      if (geminiGloballyDownUntil <= Date.now()) {
        warn(`Tüm Gemini anahtar/model kombinasyonları kullanılamıyor (kota/limit olabilir) - yedek motorlara geçiliyor, ${Math.round(waitMs / 1000)}sn sonra Gemini tekrar denenecek`);
      }
      geminiGloballyDownUntil = Date.now() + waitMs;
      geminiBackoffStage++;
    }

    throw lastError;
  }

  // GTX (Google Translate) has no song context and is known to badly
  // mistranslate a handful of very common rap/hip-hop slang words when they
  // appear with no surrounding context. Gemini already handles this
  // correctly (context + instructions), so this normalization ONLY applies
  // to text sent to GTX/MyMemory, never to Gemini, and never changes what's
  // cached/displayed as the "original" line.
  const SLANG_NORMALIZE = [
    [/\bhoes\b/gi, 'women'],
    [/\bhoe\b/gi, 'woman'],
    [/\bho\b/gi, 'woman'],
    [/\bthots?\b/gi, 'women']
  ];
  function normalizeForDumbEngines(text) {
    let t = text;
    SLANG_NORMALIZE.forEach(([re, repl]) => { t = t.replace(re, repl); });
    return t;
  }

  // Generic concurrency gate factory - used separately for GTX and MyMemory
  // so a burst on one engine can never starve the other's slots.
  function makeConcurrencyGate(limit, spacingMs) {
    let active = 0;
    const waiters = [];
    return {
      acquire() {
        return new Promise(resolve => {
          const tryAcquire = () => {
            if (active < limit) { active++; resolve(); }
            else { waiters.push(tryAcquire); }
          };
          tryAcquire();
        });
      },
      release() {
        active--;
        const next = waiters.shift();
        if (next) setTimeout(next, spacingMs);
      }
    };
  }
  const gtxGate = makeConcurrencyGate(2, 220);
  const mmGate = makeConcurrencyGate(2, 250);

  // One request per line, translation + romanization TOGETHER (dt=t&dt=rm)
  // instead of two separate calls.
  async function translateWithGTXPerLine(linesToTranslate) {
    if (Date.now() < gtxGloballyDownUntil) {
      const remaining = Math.min(gtxGloballyDownUntil - Date.now(), 60000);
      linesToTranslate.forEach(t => markFailed(t, remaining));
      return;
    }

    await Promise.all(linesToTranslate.map(async (rawText) => {
      await gtxGate.acquire();
      try {
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=tr&dt=t&dt=rm&q=${encodeURIComponent(normalizeForDumbEngines(rawText))}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();

        let trLine = '';
        let romaja = '';
        if (Array.isArray(json[0])) {
          json[0].forEach(item => {
            if (item[0]) trLine += (trLine ? ' ' : '') + item[0];
            if (item[3]) romaja += (romaja ? ' ' : '') + item[3];
          });
        }
        trLine = trLine.trim();
        romaja = romaja.trim();

        if (trLine && normalize(trLine) !== normalize(rawText)) {
          gtxConsecutiveFailures = 0;
          gtxGloballyDownUntil = 0;
          gtxBackoffStage = 0;
          cache.set(rawText, {
            tr: fixGluedWords(forcePerfectTurkish(trLine)),
            romaja: isNonLatin(rawText) ? fixGluedWords(romaja) : ''
          });
        } else {
          markFailed(rawText);
        }
      } catch (e) {
        gtxConsecutiveFailures++;
        if (gtxConsecutiveFailures >= 3 && gtxGloballyDownUntil <= Date.now()) {
          const waitMs = GTX_BACKOFF_STEPS_MS[Math.min(gtxBackoffStage, GTX_BACKOFF_STEPS_MS.length - 1)];
          warn(`GTX tekrar tekrar başarısız oluyor (muhtemelen rate-limit) - ${Math.round(waitMs / 1000)}sn bekleniyor`);
          gtxGloballyDownUntil = Date.now() + waitMs;
          gtxBackoffStage++;
        }
        markFailed(rawText);
      } finally {
        gtxGate.release();
      }
    }));

    saveCache();
    updateDOMWithCache();
  }

  // Third, independent engine - no API key, own rate-limit pool, used only
  // for whatever Gemini AND GTX both failed to produce. MyMemory doesn't
  // return romanization, so this only ever fills "tr", never "romaja" -
  // better to show the Turkish line with no pronunciation hint than to
  // show nothing at all. Its free tier signals "out of quota" as an HTTP
  // 200 with responseStatus !== 200 inside the JSON body, not as an HTTP
  // error - so that field is what's actually checked, not the HTTP status.
  async function translateWithMyMemoryPerLine(linesToTranslate) {
    if (Date.now() < mmGloballyDownUntil) {
      const remaining = Math.min(mmGloballyDownUntil - Date.now(), 60000);
      linesToTranslate.forEach(t => markFailed(t, remaining));
      return;
    }

    await Promise.all(linesToTranslate.map(async (rawText) => {
      await mmGate.acquire();
      try {
        const q = normalizeForDumbEngines(rawText).slice(0, 480); // API caps q at 500 bytes
        const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(q)}&langpair=auto|tr`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();

        if (Number(json?.responseStatus) !== 200) {
          throw new Error(json?.responseDetails || 'MyMemory kota/limit');
        }

        const trLine = (json?.responseData?.translatedText || '').trim();

        if (trLine && normalize(trLine) !== normalize(rawText)) {
          mmConsecutiveFailures = 0;
          mmGloballyDownUntil = 0;
          mmBackoffStage = 0;
          const existing = cache.get(rawText) || {};
          cache.set(rawText, {
            tr: fixGluedWords(forcePerfectTurkish(trLine)),
            romaja: existing.romaja || ''
          });
        } else {
          markFailed(rawText);
        }
      } catch (e) {
        mmConsecutiveFailures++;
        if (mmConsecutiveFailures >= 3 && mmGloballyDownUntil <= Date.now()) {
          const waitMs = MM_BACKOFF_STEPS_MS[Math.min(mmBackoffStage, MM_BACKOFF_STEPS_MS.length - 1)];
          warn(`MyMemory tekrar tekrar başarısız oluyor (muhtemelen rate-limit) - ${Math.round(waitMs / 1000)}sn bekleniyor`);
          mmGloballyDownUntil = Date.now() + waitMs;
          mmBackoffStage++;
        }
        markFailed(rawText);
      } finally {
        mmGate.release();
      }
    }));

    saveCache();
    updateDOMWithCache();
  }

  // Groups are processed SEQUENTIALLY (not in parallel) so a song never
  // fires more than one Gemini call at a time. In the overwhelming majority
  // of songs there is exactly one group. Each group cascades through all
  // three engines before a line is left to wait for the next scan cycle.
  async function processQueue(allVisibleLines) {
    const now = Date.now();
    const missing = allVisibleLines.filter(t =>
      !cache.has(t) && !inFlight.has(t) && (failedUntil.get(t) || 0) <= now
    );
    if (missing.length === 0) return;

    missing.forEach(t => inFlight.add(t));

    try {
      const groups = [];
      for (let i = 0; i < missing.length; i += MAX_LINES_PER_GEMINI_CALL) {
        groups.push(missing.slice(i, i + MAX_LINES_PER_GEMINI_CALL));
      }

      for (const group of groups) {
        let leftover = group;
        const geminiReady = geminiApiKeys.length > 0 && Date.now() >= geminiGloballyDownUntil;

        if (geminiReady) {
          try {
            leftover = await translateChunkWithGemini(group, allVisibleLines);
          } catch (e) {
            warn('Gemini bu grup için tamamen başarısız oldu, yedek motorlara düşülüyor:', (e && e.message) || e || 'bilinmeyen hata');
            leftover = group;
          }
        }

        if (leftover && leftover.length > 0 && Date.now() >= gtxGloballyDownUntil) {
          await translateWithGTXPerLine(leftover);
        }

        const stillMissing = group.filter(l => {
          const c = cache.get(l);
          return !c || !c.tr;
        });
        if (stillMissing.length > 0 && Date.now() >= mmGloballyDownUntil) {
          await translateWithMyMemoryPerLine(stillMissing);
        }
      }
    } finally {
      missing.forEach(t => inFlight.delete(t));
    }
  }

  function refreshToggleButtonVisual(btn) {
    const now = Date.now();
    const hasKeys = geminiApiKeys.length > 0;
    const geminiDown = hasKeys && now < geminiGloballyDownUntil;
    const gtxDown = now < gtxGloballyDownUntil;
    const mmDown = now < mmGloballyDownUntil;
    const allDown = (!hasKeys || geminiDown) && gtxDown && mmDown;
    const anyWarn = geminiDown || gtxDown || mmDown;

    btn.className = `${isEnabled ? 'active' : ''} ${hasKeys ? 'ai-mode' : ''} ${anyWarn ? 'quota-warn' : ''}`.trim();
    btn.textContent = allDown ? '!!' : (hasKeys ? (anyWarn ? 'AI!' : 'AI') : (anyWarn ? 'TR!' : 'TR'));

    if (allDown) {
      const waitSec = Math.max(0, Math.round((Math.max(geminiGloballyDownUntil, gtxGloballyDownUntil, mmGloballyDownUntil) - now) / 1000));
      btn.title = `Tüm çeviri motorları (Gemini + Google Translate + MyMemory) şu anda geçici olarak kullanılamıyor (muhtemelen rate-limit) - yaklaşık ${waitSec}sn sonra otomatik tekrar denenecek`;
    } else if (geminiDown && (gtxDown || mmDown)) {
      btn.title = 'Gemini anahtarlarının tamamı şu anda kota/limit sınırında, kalan yedek motorla devam ediliyor';
    } else if (geminiDown) {
      btn.title = 'Gemini anahtarlarının tamamı şu anda kota/limit sınırında - geçici olarak sadece yedek (ücretsiz) motorlar kullanılıyor';
    } else if (gtxDown || mmDown) {
      btn.title = `${gtxDown ? 'Google Translate' : 'MyMemory'} şu anda geçici olarak kullanılamıyor (rate-limit) - diğer motorlar devrede`;
    } else {
      btn.title = hasKeys
        ? `God Mode V36 (${geminiApiKeys.length} Gemini anahtarı tanımlı - sağ tık: düzenle, Shift+sağ tık: cache'i de sıfırla)`
        : 'Sağ tık: Gemini API anahtarı/anahtarları gir (isteğe bağlı, daha iyi çeviri için)';
    }
  }

  function injectToggleButton() {
    const controls = document.querySelector('#SpicyLyricsPage .ViewControls');
    if (!controls) return;

    let btn = document.getElementById('spicy-tr-toggle-btn');
    if (btn) {
      refreshToggleButtonVisual(btn);
      return;
    }

    btn = document.createElement('button');
    btn.id = 'spicy-tr-toggle-btn';
    refreshToggleButtonVisual(btn);

    btn.onclick = () => {
      isEnabled = !isEnabled;
      localStorage.setItem('spicy_tr_enabled', isEnabled);
      refreshToggleButtonVisual(btn);
      document.querySelectorAll('#SpicyLyricsPage .spicy-tr-box').forEach(b => {
        b.style.setProperty('display', isEnabled ? 'flex' : 'none', 'important');
      });
      triggerRecalc();
    };

    btn.oncontextmenu = (e) => {
      e.preventDefault();
      const currentValue = geminiApiKeys.join(', ');
      const input = prompt('🌟 Spicy Lyrics V36 🌟\nGemini API anahtarınızı/anahtarlarınızı girin (birden fazlaysa virgülle ayırın - her anahtarın kendi günlük kotası var, 2-3 anahtar = 2-3x kota):', currentValue);
      if (input === null) return;

      geminiApiKeys = Array.from(new Set(
        input.split(/[,\n]+/).map(k => k.trim()).filter(k => k.length > 10)
      ));
      try { localStorage.setItem(GEMINI_KEYS_STORAGE, JSON.stringify(geminiApiKeys)); } catch (e2) {}

      // Reset backoff/cooldown state so the new/edited key(s) get tried
      // right away - cheap to reset, no data loss. The translation CACHE
      // is deliberately left untouched here: wiping it on every key edit
      // was exactly what caused a mass-retranslation burst in V35.
      geminiGloballyDownUntil = 0; geminiBackoffStage = 0;
      gtxGloballyDownUntil = 0; gtxBackoffStage = 0; gtxConsecutiveFailures = 0;
      mmGloballyDownUntil = 0; mmBackoffStage = 0; mmConsecutiveFailures = 0;
      deadModels.clear();
      failedUntil.clear();

      // Shift+right-click = also wipe the translation cache on purpose
      // (full nuclear reset, for when something actually looks corrupted
      // or stuck). A plain right-click never touches cached translations.
      if (e.shiftKey) {
        cache.clear();
        localStorage.removeItem(STORAGE_CACHE_KEY);
        document.querySelectorAll('#SpicyLyricsPage .spicy-tr-box').forEach(b => b.remove());
        log("Shift+sağ tık: cache de tamamen temizlendi");
      }

      refreshToggleButtonVisual(btn);
      triggerMultiStageScan();
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

  // Lightweight debounce specifically for scan triggers that fire on their
  // own schedule and can arrive in bursts (DOM mutations anywhere on the
  // page, scroll events) - collapses a burst into a single scanLines() call
  // instead of one per event. triggerMultiStageScan() below calls
  // scanLines() directly and is NOT routed through this, since its timing
  // after a song change/seek is already deliberately staggered.
  let scanScheduled = false;
  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    setTimeout(() => {
      scanScheduled = false;
      scanLines();
    }, 80);
  }

  function triggerMultiStageScan() {
    scanLines();
    setTimeout(scanLines, 100);
    setTimeout(scanLines, 300);
    setTimeout(scanLines, 600);
    setTimeout(scanLines, 1200);
  }

  if (window._spicyTrObserver) window._spicyTrObserver.disconnect();
  window._spicyTrObserver = new MutationObserver(() => scheduleScan());
  window._spicyTrObserver.observe(document.body, { childList: true, subtree: true });

  window.addEventListener('scroll', () => scheduleScan(), true);

  // Seek detection: compare each reported position against what normal
  // playback would predict since the last report. A big mismatch means the
  // user scrubbed to a new point - force a rescan immediately.
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
