// NAME: Spicy Lyrics AI Translator & Romaja
// AUTHOR: korelili (patched)
// VERSION: 34.1.0 (Whole-Song Context Engine + Reliable GTX Fallback)
//
// 34.1 ADDED, from real screenshot evidence of V33 output:
//  - "Lines that never show a translation even though they WERE translated":
//    renderSubtitles only displays the TR box when it differs from the raw
//    line. Gemini occasionally echoes an already-simple English line back
//    unchanged despite the explicit rule against it; that got cached as
//    "done" (so it was never retried) and simultaneously hidden (so it
//    never appeared) - permanently blank with no sign anything was wrong.
//    Now: if Gemini's translation normalizes identical to the source line,
//    it's treated as a miss and falls through to the GTX retry instead of
//    being cached.
//  - "Words glued together with no space" (seen in both romanization, e.g.
//    "hamkkelamyeonSayyeah", and occasionally the Turkish line itself, e.g.
//    "Müzik şovuŞimdi icat ediyorum", "Justdaily'dir"): added a client-side
//    safety net (fixGluedWords) that inserts a space wherever a lowercase
//    letter is directly followed by an uppercase one, on top of the prompt
//    rule already added for this in 34.0. Confirmed root cause of the worst
//    cases (e.g. "Igottate", "Bir kilo teventrytolie") was V33's GTX
//    single-line fallback joining multiple response segments with NO
//    separator (`.join('')`) - already structurally impossible in 34.0's
//    rewritten GTX path, which joins with a space.
//
// WHY THIS VERSION EXISTS - direct fixes for what was reported against V33:
//
// 1) "Şarkının büyük kısmı çevrilmiyor / satır atlıyor / satır kayıyor"
//    Root cause #1: V33 split a song into small 12-line chunks and sent each
//    to Gemini with NO knowledge of the rest of the song - so translations
//    were locally "correct" but tonally disconnected, and a line could be
//    silently dropped if Gemini reworded the SRC field even slightly (the
//    matcher then had nothing to anchor it to).
//    Root cause #2: the GTX fallback joined MANY lines into one translate
//    call with "\n" and split the result back by "\n" - Google Translate
//    does not guarantee it preserves your line breaks 1:1, so one merged
//    sentence anywhere in the block could shift every line after it.
//    FIX: Gemini now gets the WHOLE song as context in a single call. GTX
//    now translates one line at a time - each request/response pair is
//    tied to exactly one line, so misalignment is structurally impossible.
//
// 2) "Çeviri hep geç geliyor, şarkı bitmeden gelmiyor"
//    A full song used to cost 3-6+ sequential Gemini calls (one per 12-line
//    chunk). It's now ~1 call per song (raised the per-call line cap and
//    maxOutputTokens), so you get one round trip instead of several.
//
// 3) "Bağlamdan kopuk çeviriyor, on&on&on gibi yerler saçmalıyor"
//    The single whole-song call gives Gemini the full lyric sheet as
//    context with an explicit instruction to translate for overall song
//    meaning/tone, not line-in-isolation. The ad-lib/repeated-token rule is
//    kept and reinforced, and a new rule forbids run-together romanization
//    with no spaces (the "hamkkelamyeonSayyeah" problem).
//
// 4) "Hâlâ sizli bizli konuşuyor"
//    Expanded the SAFE regex net (forcePerfectTurkish) with more confirmed
//    formal patterns (locative/ablative/genitive possessives, "mu/mi"
//    question-particle forms, "Sizce"). This is still a best-effort patch
//    over an LLM's output - it can't be mechanically 100% guaranteed every
//    single time, but coverage is now meaningfully broader, and the prompt
//    repeats the "never siz" rule with concrete examples.
//
// 5) "Tayca romanjisi bazen yok, Çince/Japonca'da doğru mu bilmiyorum"
//    Romanization stays mandatory in the prompt (no "NONE" escape for
//    non-Latin lines), spacing is now explicitly required, and on the GTX
//    fallback path translation + romanization are fetched together in ONE
//    request per line instead of two separate calls - this removes the
//    "present on one song, missing on another" inconsistency that came
//    from two independent network calls where only one could silently fail.
//    HONESTY NOTE: this script cannot itself verify Chinese/Japanese
//    romanization is linguistically correct - it has no more Mandarin or
//    Japanese knowledge than the AI/Google Translate engine it calls. For
//    real verification you'd need a human reader of that language, or a
//    dedicated pinyin/furigana library instead of an LLM/GTX.
//
// 6) "10-15 şarkıdan sonra çeviri komple duruyor"
//    Most likely cause: a free Gemini API key has a hard daily/per-minute
//    cap set by Google - once it's hit, no code change makes more requests
//    succeed until the quota resets. V33 made this worse by also burning
//    through GTX's unofficial-endpoint rate limit fast (a SEPARATE GTX call
//    per non-Latin line's romanization, on top of the batch translate call -
//    for a 40-line Korean song that's ~40 extra calls the moment Gemini's
//    quota died). FIX: whole-song batching cuts Gemini calls per song from
//    ~4 to ~1 (quota lasts roughly 4x longer), the GTX path merges
//    translation+romanization into one call per line (half the GTX
//    traffic), both Gemini's and GTX's backoff are now exponential
//    (30s/1m -> 1m/2m -> 2m/5m -> 4m/10m -> 8m, capped) instead of
//    hammering a dead quota on a fixed timer forever, and the toggle button
//    now shows "AI!" with a warning color + tooltip when running in
//    GTX-only mode, so a quota outage is visible instead of looking like
//    silent breakage.
//    If you listen to a lot of music per day, the real fix is a paid
//    Gemini key or rotating a couple of free keys - this script can't
//    invent quota Google hasn't given it.
//
// Unchanged from V33: DOM styling, seek detection, songchange detection,
// localStorage persistent cache, the "never leave a line untranslated"
// rule, the ad-lib rule.

(function spicyTurkishProV34() {
  const DEBUG = true;
  const log = (...args) => { if (DEBUG) console.log('%c[SpicyTR V34]', 'color:#1db954;font-weight:bold', ...args); };
  const warn = (...args) => { if (DEBUG) console.warn('%c[SpicyTR V34]', 'color:#ffae00;font-weight:bold', ...args); };
  const err = (...args) => { if (DEBUG) console.error('%c[SpicyTR V34]', 'color:#ff4b4b;font-weight:bold', ...args); };

  [
    'spicy_tr_persistent_cache_v5', 'spicy_tr_persistent_cache_v12_final',
    'spicy_tr_marketplace_v19', 'spicy_tr_stable_v20', 'spicy_tr_ultimate_v21',
    'spicy_tr_unbreakable_v22', 'spicy_tr_godmode_v23', 'spicy_tr_godmode_v26',
    'spicy_tr_godmode_v27', 'spicy_tr_godmode_v28', 'spicy_tr_godmode_v29',
    'spicy_tr_godmode_v30', 'spicy_tr_godmode_v31', 'spicy_tr_godmode_v32',
    'spicy_tr_godmode_v33', 'spicy_tr_godmode_v34'
  ].forEach(k => localStorage.removeItem(k));

  const STORAGE_CACHE_KEY = 'spicy_tr_godmode_v34_1';
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
  const GEMINI_MAX_OUTPUT_TOKENS = 8192;

  function markFailed(text) {
    failedUntil.set(text, Date.now() + FAILURE_COOLDOWN_MS);
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

  // Loose variant used only as a last-resort fallback match, so a line
  // isn't dropped just because Gemini's SRC echo changed a comma or dash.
  function normalizeLoose(s) {
    return normalize(s).replace(/[.,!?;:'"()\-–—_]/g, '').replace(/\s+/g, ' ').trim();
  }

  // Safety net for the "words glued together with no space" pattern seen in
  // real output (romanization AND, occasionally, the Turkish line itself -
  // e.g. "hamkkelamyeonSayyeah", "Justdaily'dir", "şovuŞimdi"). The prompt
  // already demands spacing, but that's not mechanically guaranteed, so this
  // inserts a space wherever a lowercase letter is immediately followed by
  // an uppercase one - the exact shape of every glued example observed.
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
    // Dative / accusative (existing from V33):
    t = t.replace(/([a-zçğıöşüA-ZÇĞİÖŞÜ]+)inize\b/g, '$1ine')
         .replace(/([a-zçğıöşüA-ZÇĞİÖŞÜ]+)ınıza\b/g, '$1ına')
         .replace(/([a-zçğıöşüA-ZÇĞİÖŞÜ]+)ünüze\b/g, '$1üne')
         .replace(/([a-zçğıöşüA-ZÇĞİÖŞÜ]+)unuza\b/g, '$1una')
         .replace(/([a-zçğıöşüA-ZÇĞİÖŞÜ]+)inizi\b/g, '$1ini')
         .replace(/([a-zçğıöşüA-ZÇĞİÖŞÜ]+)ınızı\b/g, '$1ını')
         .replace(/([a-zçğıöşüA-ZÇĞİÖŞÜ]+)ünüzü\b/g, '$1ünü')
         .replace(/([a-zçğıöşüA-ZÇĞİÖŞÜ]+)unuzu\b/g, '$1unu')
    // Locative (new in V34): "evinizde" -> "evinde"
         .replace(/([a-zçğıöşüA-ZÇĞİÖŞÜ]+)inizde\b/g, '$1inde')
         .replace(/([a-zçğıöşüA-ZÇĞİÖŞÜ]+)ınızda\b/g, '$1ında')
         .replace(/([a-zçğıöşüA-ZÇĞİÖŞÜ]+)ünüzde\b/g, '$1ünde')
         .replace(/([a-zçğıöşüA-ZÇĞİÖŞÜ]+)unuzda\b/g, '$1unda')
    // Ablative (new in V34): "evinizden" -> "evinden"
         .replace(/([a-zçğıöşüA-ZÇĞİÖŞÜ]+)inizden\b/g, '$1inden')
         .replace(/([a-zçğıöşüA-ZÇĞİÖŞÜ]+)ınızdan\b/g, '$1ından')
         .replace(/([a-zçğıöşüA-ZÇĞİÖŞÜ]+)ünüzden\b/g, '$1ünden')
         .replace(/([a-zçğıöşüA-ZÇĞİÖŞÜ]+)unuzdan\b/g, '$1undan')
    // Genitive (new in V34): "evinizin" -> "evinin"
         .replace(/([a-zçğıöşüA-ZÇĞİÖŞÜ]+)inizin\b/g, '$1inin')
         .replace(/([a-zçğıöşüA-ZÇĞİÖŞÜ]+)ınızın\b/g, '$1ının')
         .replace(/([a-zçğıöşüA-ZÇĞİÖŞÜ]+)ünüzün\b/g, '$1ünün')
         .replace(/([a-zçğıöşüA-ZÇĞİÖŞÜ]+)unuzun\b/g, '$1unun');

    // Question-particle forms (new in V34): unambiguous, never a noun or a
    // bare imperative - safe. "biliyor musunuz" -> "biliyor musun"
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
         .replace(/\bhatırlayın\b/gi, 'hatırla');

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

  // chunkLines: the lines that still need a translation.
  // allSongLines: every line currently known for this song (cached or not) -
  // sent purely as context so the translation of chunkLines stays coherent
  // with the whole song's meaning/tone, never output back.
  async function translateChunkWithGemini(chunkLines, allSongLines) {
    const songTitle = Spicetify?.Player?.data?.item?.name || 'Unknown Song';
    const artist = Spicetify?.Player?.data?.item?.artists?.[0]?.name || 'Unknown Artist';
    const contextLinesText = allSongLines.map(l => `- ${l}`).join('\n');
    const targetLinesText = chunkLines.map(l => `- ${l}`).join('\n');

    const prompt = `You are Turkey's ultimate music translator localizing song lyrics into natural Turkish.
Song: "${songTitle}" by "${artist}"

FULL LYRICS OF THIS SONG, for context only (story, tone, emotional arc, who's speaking to whom). Do NOT output a translation block for these - they exist only so your translation of the lines below stays consistent with the whole song's meaning:
${contextLinesText}

Now translate ONLY the following lines. Output one SRC/ROM/TR block for EACH line below, in the exact order given, and nothing else:
${targetLinesText}

CRITICAL RULES:
1. ALWAYS INFORMAL "SEN", NEVER FORMAL "SİZ" - no exceptions, in any language the source is in. This applies to every verb ending and every possessive, not just the pronoun itself.
   WRONG (formal - never output anything like this): "Ters çevirin", "gevşetin", "keşfedin", "devam edin", "Kalbinize", "düğmelerinizi", "yerlerinizi", "Siz farkına bile varmadan", "görüş alanınızdadır"
   RIGHT (informal - always output like this instead): "Ters çevir", "gevşet", "keşfet", "devam et", "Kalbine", "düğmelerini", "yerlerini", "Sen farkına bile varmadan", "görüş alanındadır"
2. NO LINE SKIP OR SHIFT: You MUST translate EVERY SINGLE line listed under "Now translate ONLY the following lines" - no exceptions, including lines that are already in English, already seem simple/understandable, or match the song's title. Never leave a line as-is just because it "already makes sense" - every line gets its own real Turkish translation.
3. REPEATED/STYLIZED AD-LIBS: if a line is a rhythmic ad-lib or vocalization using repetition (e.g. "On&on&on&on oh", "La la la la"), do NOT translate each repeated token as a separate literal word (never turn "On&on&on&on" into something like "Açık&açık&açık" by translating "on" as the on/off switch word) - treat the whole repeated pattern as one vocal/rhythmic unit and either keep it as a natural-sounding vocal ad-lib or give one single natural Turkish equivalent for the whole thing, never a word-by-word literal mess.
4. ROMANIZATION IS MANDATORY for every line not already in Latin script - NEVER write NONE for Korean, Japanese, Chinese, Thai, or any other non-Latin script, even when a perfectly clean version is hard to produce. Always give your best simple phonetic attempt instead of skipping it - an imperfect romanization is always better than none. (Only write NONE when the line is ALREADY in Latin script, e.g. English/Turkish - never as a way to avoid a hard case.)
   STYLE: keep it casual and readable, the way an ordinary person types out pronunciation online. Standard single accent marks from an established system are fine (e.g. Chinese Hanyu Pinyin tone marks like ā/í/ǒ/ù). AVOID heavy academic/IAST-style transliteration with multiple stacked diacritics per letter - simplify to plain, easy-to-read Latin spelling instead.
   SPACING IS MANDATORY: always put a space between romanized WORDS exactly the way the original line's words are separated - never concatenate several words into one unbroken string. Example: for a line meaning "together, say yeah", write "hamkke hamyeon say yeah", NEVER "hamkkehamyeonsayyeah".
5. OUTPUT FORMAT: For EVERY line you are asked to translate, output exactly this format separated by ---:
SRC: <exact original line>
ROM: <simple plain-Latin phonetic romanization if non-Latin script, otherwise write NONE>
TR: <natural Turkish translation using informal 'sen', per rule 1>
---`;

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
            generationConfig: { temperature: 0.2, maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS }
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

          // Fallback 1: punctuation-insensitive exact match (handles Gemini
          // dropping/adding a comma, dash, or quote in its SRC echo).
          if (!rawLine) {
            const looseKey = normalizeLoose(src);
            rawLine = chunkLines.find(l => !matched.has(l) && normalizeLoose(l) === looseKey);
          }

          // Fallback 2: substring containment, same as V33.
          if (!rawLine) {
            rawLine = chunkLines.find(l => !matched.has(l) && (normalize(l).includes(key) || key.includes(normalize(l))) && key.length > 2);
          }

          if (rawLine && !matched.has(rawLine)) {
            const cleanTr = fixGluedWords(forcePerfectTurkish(tr));
            const cleanRom = isNonLatin(rawLine) ? fixGluedWords(rom || '') : '';

            // If Gemini just echoed the line back untranslated (happens
            // occasionally on simple/already-English lines despite the
            // explicit rule against it), DON'T cache it - that would mark
            // the line "done" forever while rendering nothing (renderSubtitles
            // hides a translation identical to the source), permanently
            // hiding it. Leave it unmatched so it falls through to the GTX
            // retry below, which usually succeeds with a real translation.
            if (normalize(cleanTr) === normalize(rawLine)) {
              return;
            }

            matched.add(rawLine);
            cache.set(rawLine, { tr: cleanTr, romaja: cleanRom });
          }
        });

        saveCache();
        updateDOMWithCache();

        geminiGloballyDownUntil = 0; // it just worked, so Gemini is clearly back
        geminiBackoffStage = 0;

        // Any line Gemini didn't give us a confident match for falls straight
        // through to the GTX fallback in processQueue - same cycle, not
        // after a stall.
        const leftover = chunkLines.filter(l => !matched.has(l));
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
  // whole extension (not just within one translateWithGTX invocation like
  // in V33). This is what actually stops bursts from stacking when several
  // scan triggers overlap (songchange + scroll + mutation, for example).
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
  // instead of two separate calls. This halves GTX traffic compared to V33
  // or earlier (where the batch translate call and each line's romaja fetch
  // were two independent requests) and makes romanization presence/absence
  // depend on exactly one network call instead of two, removing the
  // "present on one Thai song, missing on another" inconsistency.
  async function translateWithGTXPerLine(linesToTranslate) {
    if (Date.now() < gtxGloballyDownUntil) {
      linesToTranslate.forEach(t => markFailed(t));
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
  // free-tier quota last roughly 4x longer than V33's per-chunk approach.
  // In the overwhelming majority of songs there is exactly one group.
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
    const geminiDown = !!geminiApiKey && Date.now() < geminiGloballyDownUntil;
    btn.className = `${isEnabled ? 'active' : ''} ${geminiApiKey ? 'ai-mode' : ''} ${geminiDown ? 'quota-warn' : ''}`.trim();
    btn.textContent = geminiApiKey ? (geminiDown ? 'AI!' : 'AI') : 'TR';
    btn.title = geminiApiKey
      ? (geminiDown ? 'Gemini kotası şu anda dolu - geçici olarak sadece ücretsiz Google Translate kullanılıyor' : 'God Mode V34 (sağ tık: API anahtarını değiştir)')
      : 'Sağ tık: Gemini API anahtarı gir (isteğe bağlı, daha iyi çeviri için)';
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
      const input = prompt('🌟 Spicy Lyrics V34 🌟\nGemini API Anahtarınızı girin:', geminiApiKey);
      if (input !== null) {
        geminiApiKey = input.trim();
        localStorage.setItem('spicy_tr_gemini_key', geminiApiKey);
        geminiGloballyDownUntil = 0;
        geminiBackoffStage = 0;
        cache.clear();
        failedUntil.clear();
        inFlight.clear();
        localStorage.removeItem(STORAGE_CACHE_KEY);
        document.querySelectorAll('#SpicyLyricsPage .spicy-tr-box').forEach(b => b.remove());
        refreshToggleButtonVisual(btn);
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
