// NAME: Spicy Lyrics AI Translator & Romaja
// AUTHOR: korelili (patched)
// VERSION: 35.0.0 (Structured JSON Output + Smarter Model Fallback)
//
// PREVIOUS HISTORY (condensed): V20-V33 fixed CSS bleed-through on the
// lyrics page, song-change/seek detection, persistent localStorage
// caching, and the core "never leave a line untranslated" + ad-lib rules.
// V34.x fixed: whole-song batch translation replacing small blind chunks
// (so Gemini has real context and needs ~1 call/song instead of 3-6), a
// per-line GTX fallback so one misaligned GTX response can't shift every
// line after it, exponential backoff for both Gemini and GTX instead of
// hammering a dead quota on a fixed timer, several confirmed sizli/bizli
// (formal "siz") leaks in the regex net, a glued-words-with-no-space
// safety net, and a manual-reset button that could silently fail to
// rescan if Spicy Lyrics' own DOM hadn't finished swapping songs yet.
//
// V35 - WHAT CHANGED AND WHY:
//
// 1) ROOT-CAUSE FIX for "satır kayıyor / atlıyor / birbirine yapışıyor":
//    V34 asked Gemini for a custom "SRC:/ROM:/TR:/---" text block per line,
//    then had to fuzzy-match each returned SRC back to the original line
//    (exact match -> punctuation-insensitive match -> substring match) to
//    survive Gemini slightly rewording its own echo. That fuzzy matching
//    was itself a risk on songs with several short, near-identical lines.
//    V35 instead uses the API's native structured JSON output
//    (responseSchema: one {rom, tr} object per line, in the exact order
//    asked) and maps results back by POSITION, not by re-matching text. If
//    the array Gemini returns isn't exactly the right length, the whole
//    chunk is treated as a miss and falls straight through to the per-line
//    GTX fallback - no guessing, no partial/misaligned cache writes. This
//    deletes the old SRC-matching code entirely and is structurally immune
//    to the "glued/shifted/reworded SRC" failure class the old text-block
//    format kept needing new patches for.
//
// 2) TRUNCATION: "thinking" was never explicitly turned off, and Gemini
//    2.5/3.x Flash models think by default - those invisible reasoning
//    tokens count against the same output budget as the visible
//    translation, so on a long/dense song the real translation text could
//    get cut off before every line was written, with no obvious error (it
//    would just look like "half the song is missing", same symptom as the
//    34.2 bug but a different cause). V35 sets thinkingConfig.thinkingBudget
//    = 0 (this is a short translation task, not a reasoning task) and
//    raises the output cap from 8192 to the models' real 65536-token
//    ceiling, so the JSON array always has room to finish. This also makes
//    every call noticeably faster.
//
// 3) MODEL LIST: replaced the unversioned "gemini-flash-latest" alias
//    (unclear whether that alias still resolves the way it used to) with
//    Google's current, explicitly documented stable model IDs, and added
//    gemini-2.5-flash-lite, which currently carries by far the most
//    generous free-tier daily quota of the four. It's tried LAST, after
//    the higher-quality models, purely as the high-headroom safety net
//    that keeps translation alive once the others are rate-limited for
//    the day - the most direct lever available for "10-15 şarkıdan sonra
//    çeviri komple duruyor" on a free key.
//
// 4) DEAD-MODEL COOLDOWN: a model that returns 404 (wrong/retired model
//    id) used to get the same 60s cooldown as a transient rate-limit error
//    - meaning a single bad model id would get silently re-tried, and
//    silently fail, on every single song forever. A 404 now gets a 6-hour
//    cooldown instead, so a stale/invalid id stops wasting a slot in the
//    per-call fallback chain almost immediately.
//
// 5) PERFORMANCE: the MutationObserver has to watch the whole page body to
//    reliably catch Spicy Lyrics mounting/updating, which meant every
//    unrelated Spotify UI update (progress bar, hover states, queue
//    changes) was triggering an immediate full lyric-line rescan. Scans
//    triggered by the observer/scroll listener now collapse into one per
//    ~80ms instead of firing on every single mutation; the deliberate
//    multi-stage rescan after a song change or seek is untouched.
//
// HONESTY NOTES (still true, unchanged from V34): this script cannot
// itself verify that Chinese/Japanese/Thai romanization is linguistically
// correct - it knows no more about those languages than the engine it
// calls. And it cannot invent free quota Google hasn't granted the key -
// gemini-2.5-flash-lite's bigger allowance buys real extra headroom, but a
// listener doing many hours of song-switching on one free key can still
// eventually hit a wall for the day; a paid key removes that ceiling.

(function spicyTurkishProV35() {
  const DEBUG = true;
  const log = (...args) => { if (DEBUG) console.log('%c[SpicyTR V35]', 'color:#1db954;font-weight:bold', ...args); };
  const warn = (...args) => { if (DEBUG) console.warn('%c[SpicyTR V35]', 'color:#ffae00;font-weight:bold', ...args); };
  const err = (...args) => { if (DEBUG) console.error('%c[SpicyTR V35]', 'color:#ff4b4b;font-weight:bold', ...args); };

  [
    'spicy_tr_persistent_cache_v5', 'spicy_tr_persistent_cache_v12_final',
    'spicy_tr_marketplace_v19', 'spicy_tr_stable_v20', 'spicy_tr_ultimate_v21',
    'spicy_tr_unbreakable_v22', 'spicy_tr_godmode_v23', 'spicy_tr_godmode_v26',
    'spicy_tr_godmode_v27', 'spicy_tr_godmode_v28', 'spicy_tr_godmode_v29',
    'spicy_tr_godmode_v30', 'spicy_tr_godmode_v31', 'spicy_tr_godmode_v32',
    'spicy_tr_godmode_v33', 'spicy_tr_godmode_v34', 'spicy_tr_godmode_v34_1'
  ].forEach(k => localStorage.removeItem(k));

  // Bumped from v34_1: translation quality/shape changed enough (structured
  // JSON output, thinking off) that old cached lines are worth refreshing
  // rather than mixing old and new style translations in the same song.
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
  const deadModels = new Map();
  const MODEL_DEAD_SHORT_MS = 60000;          // transient error (rate limit, 5xx)
  const MODEL_DEAD_LONG_MS = 6 * 60 * 60 * 1000; // 404 = wrong/retired model id

  // Exponential backoff state for Gemini (resets to stage 0 on any success)
  const GEMINI_BACKOFF_STEPS_MS = [60000, 120000, 300000, 600000]; // 1m,2m,5m,10m
  let geminiGloballyDownUntil = 0;
  let geminiBackoffStage = 0;

  // Exponential backoff state for GTX (resets to stage 0 on any success)
  const GTX_BACKOFF_STEPS_MS = [30000, 60000, 120000, 240000, 480000]; // 30s..8m
  let gtxGloballyDownUntil = 0;
  let gtxBackoffStage = 0;
  let gtxConsecutiveFailures = 0;

  let isEnabled = localStorage.getItem('spicy_tr_enabled') !== 'false';
  let geminiApiKey = localStorage.getItem('spicy_tr_gemini_key') || '';
  let batchTimer = null;

  // A whole typical song (verses+chorus+bridge, de-duplicated) almost always
  // fits under this in one Gemini call. If a song has more unique lines than
  // this, it's split into sequential (not parallel) groups, each still
  // carrying the full song as context, so quota usage stays bounded even on
  // unusually long songs.
  const MAX_LINES_PER_GEMINI_CALL = 50;
  // Real ceiling for all four models below is 65536 output tokens. With
  // thinking turned off (see GEMINI_MODELS call site), every one of those
  // tokens goes to the actual JSON translation instead of invisible
  // reasoning, so this is comfortably more than even a 50-line/call batch
  // needs - the goal here is "never truncate", not "always use this much".
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
  // real output (romanization AND, occasionally, the Turkish line itself -
  // e.g. "hamkkelamyeonSayyeah", "Justdaily'dir", "şovuŞimdi"). The prompt
  // demands spacing and JSON output removes one whole class of join-related
  // glue bugs, but a single string field can still come back glued if the
  // model itself drops a space - this catches that regardless of source.
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

    // Simple whole-word formal -> informal swaps confirmed from real output.
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

    // Bare "Siz" as its own word is unambiguous - always safe to informalize.
    t = t.replace(/\bSiz\b/gi, 'Sen');

    // Possessive/case-marked NOUNS with a formal "-nİz-" plus a FURTHER case
    // ending are safe to informalize: an imperative VERB never takes a
    // further case suffix (the imperative is already the final word form),
    // so this shape can only be a noun possessive, e.g. "düğmelerinizi" ->
    // "düğmelerini", "Kalbinize" -> "Kalbine". The bare "-nİz" ending with
    // NOTHING after it is left alone on purpose (that's the ambiguous case -
    // could be a noun or an imperative, can't tell safely with a regex).
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

    // Question-particle forms: unambiguous, never a noun or a bare
    // imperative - safe. "biliyor musunuz" -> "biliyor musun"
    t = t.replace(/\bmusunuz\b/gi, 'musun')
         .replace(/\bmüsünüz\b/gi, 'müsün')
         .replace(/\bmısınız\b/gi, 'mısın')
         .replace(/\bmisiniz\b/gi, 'misin');

    // A handful of exact formal verb phrases confirmed from real output.
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
    // Defensive only: responseMimeType forces raw JSON, but strip a stray
    // ```json fence just in case a model wraps it anyway.
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
  // the first choice for quality. "gemini-flash-latest" (an unversioned
  // alias) was dropped in favor of these explicit, currently-documented
  // model IDs so a single ambiguous alias can't quietly dead-end a call.
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
3. REPEATED/STYLIZED AD-LIBS: if a line is a rhythmic ad-lib or vocalization using repetition (e.g. "On&on&on&on oh", "La la la la"), do NOT translate each repeated token as a separate literal word (never turn "On&on&on&on" into something like "Açık&açık&açık" by translating "on" as the on/off switch word) - treat the whole repeated pattern as one vocal/rhythmic unit and either keep it as a natural-sounding vocal ad-lib or give one single natural Turkish equivalent for the whole thing, never a word-by-word literal mess.
3b. FEELING OVER LITERAL WORDS: you are localizing a song for a Turkish listener to FEEL, not producing a dictionary crib. Prefer the natural way a Turkish songwriter/poet would phrase the same image over a flat word-for-word rendering - e.g. for an intensified color/quality, prefer Turkish's own reduplicated intensifiers where they fit naturally ("masmavi" rather than "çok mavi" for a vivid blue sky, "bembeyaz" rather than "çok beyaz", "güpegündüz" for broad daylight), and generally favor an evocative, idiomatic phrase over a technically-accurate-but-stiff one, as long as the core meaning is preserved.
3c. TITLE / HOOK LINES: a line that IS or closely matches the song's own title (given above as "Song:"), or a repeated stylized hook built from mixed fragments (e.g. a line like "Fly By Day Viva California Time" that isn't really one grammatical sentence), will not translate sensibly word-for-word. For these, don't force a literal clause-by-clause translation - give a short, natural-sounding Turkish phrase that captures the vibe/mood of the hook instead, the way a Turkish cover or localized title would read, even if it's a looser rendering than a normal lyric line would get.
4. ROMANIZATION IS MANDATORY for every line not already in Latin script - NEVER leave "rom" empty for Korean, Japanese, Chinese, Thai, or any other non-Latin script, even when a perfectly clean version is hard to produce. Always give your best simple phonetic attempt instead of skipping it - an imperfect romanization is always better than none. (Only use an empty string for "rom" when the line is ALREADY in Latin script, e.g. English/Turkish - never as a way to avoid a hard case.)
   STYLE: keep it casual and readable, the way an ordinary person types out pronunciation online. Standard single accent marks from an established system are fine (e.g. Chinese Hanyu Pinyin tone marks like ā/í/ǒ/ù). AVOID heavy academic/IAST-style transliteration with multiple stacked diacritics per letter - simplify to plain, easy-to-read Latin spelling instead.
   SPACING IS MANDATORY: always put a space between romanized WORDS exactly the way the original line's words are separated - never concatenate several words into one unbroken string. Example: for a line meaning "together, say yeah", write "hamkke hamyeon say yeah", NEVER "hamkkehamyeonsayyeah".
5. OUTPUT FORMAT: respond with ONLY a JSON array matching the given schema - exactly ${chunkLines.length} objects, in the same order as the numbered lines above. Each object has "rom" (romanization, or "" if the line is already Latin script) and "tr" (the natural Turkish translation using informal "sen", per rule 1). No extra text, no markdown, no numbering in the output - just the array.`;

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
            generationConfig: {
              temperature: 0.2,
              maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS,
              // Pure translation doesn't need multi-step reasoning, and
              // leaving thinking on silently eats into the same output
              // budget as the visible JSON answer (see V35 changelog #2).
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
            deadModels.set(model, Date.now() + MODEL_DEAD_LONG_MS);
            warn(`Model "${model}" bulunamadı (404) - muhtemelen kaldırılmış/geçersiz model id, 6 saatliğine devre dışı bırakıldı`);
          } else {
            deadModels.set(model, Date.now() + MODEL_DEAD_SHORT_MS);
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
          if (!trRaw) return; // left unmatched -> falls through to GTX below

          const cleanTr = fixGluedWords(forcePerfectTurkish(trRaw));

          // If Gemini just echoed the line back untranslated (happens
          // occasionally on simple/already-English lines despite the
          // explicit rule against it), DON'T cache it - that would mark
          // the line "done" forever while rendering nothing (renderSubtitles
          // hides a translation identical to the source), permanently
          // hiding it. Leave it unmatched so it falls through to the GTX
          // retry below, which usually succeeds with a real translation.
          if (normalize(cleanTr) === normalize(rawLine)) return;

          const cleanRom = isNonLatin(rawLine) ? fixGluedWords((item.rom || '').trim()) : '';
          cache.set(rawLine, { tr: cleanTr, romaja: cleanRom });
        });

        saveCache();
        updateDOMWithCache();

        geminiGloballyDownUntil = 0; // it just worked, so Gemini is clearly back
        geminiBackoffStage = 0;

        // Any line Gemini didn't give us a confident result for falls
        // straight through to the GTX fallback in processQueue - same
        // cycle, not after a stall.
        const leftover = chunkLines.filter(l => {
          const c = cache.get(l);
          return !c || !c.tr;
        });
        return leftover;
      } catch (modelErr) {
        lastError = modelErr;
      }
    }

    // Every model was either on cooldown or just failed - back off with
    // growing delays instead of hammering a dead/quota-exhausted key every
    // fixed interval.
    if (!anyModelAttempted || GEMINI_MODELS.every(m => (deadModels.get(m) || 0) > Date.now())) {
      const waitMs = GEMINI_BACKOFF_STEPS_MS[Math.min(geminiBackoffStage, GEMINI_BACKOFF_STEPS_MS.length - 1)];
      if (geminiGloballyDownUntil <= Date.now()) {
        warn(`Tüm Gemini modelleri kullanılamıyor (kota/limit olabilir) - GTX motoruna geçiliyor, ${Math.round(waitMs / 1000)}sn sonra Gemini tekrar denenecek`);
      }
      geminiGloballyDownUntil = Date.now() + waitMs;
      geminiBackoffStage++;
    }

    throw lastError;
  }

  // GTX (Google Translate) has no song context and is known to badly
  // mistranslate a handful of very common rap/hip-hop slang words when they
  // appear with no surrounding context - a well-known Google Translate
  // quirk, not something we can prompt our way out of since GTX isn't an
  // LLM. Gemini already handles this correctly (context + instructions), so
  // this normalization ONLY applies to text sent to GTX, never to Gemini,
  // and never changes what's cached/displayed as the "original" line.
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

  // Global concurrency gate for GTX, shared across EVERY call site in the
  // whole extension. This is what actually stops bursts from stacking when
  // several scan triggers overlap (songchange + scroll + mutation, for
  // example).
  const GTX_CONCURRENCY = 2;
  const GTX_SPACING_MS = 220;
  let gtxActive = 0;
  const gtxWaiters = [];
  function gtxAcquire() {
    return new Promise(resolve => {
      const tryAcquire = () => {
        if (gtxActive < GTX_CONCURRENCY) {
          gtxActive++;
          resolve();
        } else {
          gtxWaiters.push(tryAcquire);
        }
      };
      tryAcquire();
    });
  }
  function gtxRelease() {
    gtxActive--;
    const next = gtxWaiters.shift();
    if (next) setTimeout(next, GTX_SPACING_MS);
  }

  // One request per line, translation + romanization TOGETHER (dt=t&dt=rm)
  // instead of two separate calls - halves GTX traffic compared to a
  // two-call-per-line approach and makes romanization presence/absence
  // depend on exactly one network call instead of two.
  async function translateWithGTXPerLine(linesToTranslate) {
    if (Date.now() < gtxGloballyDownUntil) {
      // Don't use the normal short 12s cooldown here - that made it look
      // like translation was "about to retry any second" when it was
      // actually stuck behind a multi-minute global backoff, burning scan
      // cycles for nothing the whole time. Align the local cooldown to the
      // real remaining wait (capped at 60s so we still periodically recheck
      // rather than sleeping through the full 8-minute worst case).
      const remaining = Math.min(gtxGloballyDownUntil - Date.now(), 60000);
      linesToTranslate.forEach(t => markFailed(t, remaining));
      return;
    }

    await Promise.all(linesToTranslate.map(async (rawText) => {
      await gtxAcquire();
      try {
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=tr&dt=t&dt=rm&q=${encodeURIComponent(normalizeForGTX(rawText))}`;
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
          warn(`GTX tekrar tekrar başarısız oluyor (muhtemelen rate-limit) - ${Math.round(waitMs / 1000)}sn bekleniyor, sonra otomatik tekrar denenecek`);
          gtxGloballyDownUntil = Date.now() + waitMs;
          gtxBackoffStage++;
        }
        markFailed(rawText);
      } finally {
        gtxRelease();
      }
    }));

    saveCache();
    updateDOMWithCache();
  }

  // Groups are processed SEQUENTIALLY (not in parallel) so a song never
  // fires more than one Gemini call at a time - this is what makes the
  // free-tier quota last roughly 4x longer than a per-chunk approach. In
  // the overwhelming majority of songs there is exactly one group.
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
        const geminiReady = geminiApiKey && geminiApiKey.trim().length > 10 && Date.now() >= geminiGloballyDownUntil;

        if (geminiReady) {
          try {
            leftover = await translateChunkWithGemini(group, allVisibleLines);
          } catch (e) {
            warn('Gemini bu grup için tamamen başarısız oldu, GTX\'e düşülüyor:', (e && e.message) || e || 'bilinmeyen hata');
            leftover = group;
          }
        }

        if (leftover && leftover.length > 0) {
          await translateWithGTXPerLine(leftover);
        }
      }
    } finally {
      missing.forEach(t => inFlight.delete(t));
    }
  }

  function refreshToggleButtonVisual(btn) {
    const now = Date.now();
    const geminiDown = !!geminiApiKey && now < geminiGloballyDownUntil;
    const gtxDown = now < gtxGloballyDownUntil;
    const bothDown = geminiDown && gtxDown;
    const anyWarn = geminiDown || gtxDown;

    btn.className = `${isEnabled ? 'active' : ''} ${geminiApiKey ? 'ai-mode' : ''} ${anyWarn ? 'quota-warn' : ''}`.trim();
    btn.textContent = bothDown ? '!!' : (geminiApiKey ? (anyWarn ? 'AI!' : 'AI') : (gtxDown ? 'TR!' : 'TR'));

    if (bothDown) {
      const waitSec = Math.max(0, Math.round((Math.max(geminiGloballyDownUntil, gtxGloballyDownUntil) - now) / 1000));
      btn.title = `Hem Gemini hem Google Translate şu anda geçici olarak kullanılamıyor (muhtemelen rate-limit) - yaklaşık ${waitSec}sn sonra otomatik tekrar denenecek`;
    } else if (gtxDown) {
      const waitSec = Math.max(0, Math.round((gtxGloballyDownUntil - now) / 1000));
      btn.title = `Ücretsiz Google Translate motoru şu anda geçici olarak kullanılamıyor (rate-limit) - yaklaşık ${waitSec}sn sonra otomatik tekrar denenecek`;
    } else if (geminiDown) {
      btn.title = 'Gemini kotası şu anda dolu - geçici olarak sadece ücretsiz Google Translate kullanılıyor';
    } else {
      btn.title = geminiApiKey
        ? 'God Mode V35 (sağ tık: API anahtarını değiştir)'
        : 'Sağ tık: Gemini API anahtarı gir (isteğe bağlı, daha iyi çeviri için)';
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
      const input = prompt('🌟 Spicy Lyrics V35 🌟\nGemini API Anahtarınızı girin:', geminiApiKey);
      if (input !== null) {
        geminiApiKey = input.trim();
        localStorage.setItem('spicy_tr_gemini_key', geminiApiKey);
        // Full reset, not just the API key: clears BOTH engines' backoff
        // state, every dead-model cooldown, the whole cache, and every
        // pending failure cooldown, then rescans repeatedly over the next
        // ~1.2s instead of once - this is the manual "unstick everything
        // right now" escape hatch, so it needs to keep trying in case Spicy
        // Lyrics' own lyrics DOM hasn't finished loading/swapping to the
        // current song at the exact instant you click OK.
        geminiGloballyDownUntil = 0;
        geminiBackoffStage = 0;
        gtxGloballyDownUntil = 0;
        gtxBackoffStage = 0;
        gtxConsecutiveFailures = 0;
        deadModels.clear();
        cache.clear();
        failedUntil.clear();
        inFlight.clear();
        localStorage.removeItem(STORAGE_CACHE_KEY);
        document.querySelectorAll('#SpicyLyricsPage .spicy-tr-box').forEach(b => b.remove());
        refreshToggleButtonVisual(btn);
        triggerMultiStageScan();
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

  // Lightweight debounce specifically for scan triggers that fire on their
  // own schedule and can arrive in bursts (DOM mutations anywhere on the
  // page, scroll events) - collapses a burst into a single scanLines()
  // call instead of one per event. triggerMultiStageScan() below calls
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
