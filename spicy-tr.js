// NAME: Spicy Lyrics AI Translator & Romaja
// AUTHOR: korelili (patched)
// VERSION: 47.0.0 (Built on top of V46 — fixes why the extension looked
//           "dead" (falling back to ugly GTX/MyMemory output) after only
//           a couple of songs even with 4 Gemini API keys configured.)
//
// V47 - WHAT CHANGED AND WHY:
//
// THE ACTUAL BUG: every non-404 error from Gemini — including a 429
// "quota exceeded, retry in 8h4m" and a 400 "invalid argument" repeated
// byte-for-byte across all 4 keys — was being treated as a 45-SECOND
// transient hiccup (MODEL_DEAD_SHORT_MS) and retried on that short a
// timer forever. A daily quota error does not go away in 45 seconds,
// and a 400 that is identical across 4 different API keys for the same
// model is not a per-key fluke either — it means the request this
// script sends is malformed for that particular model id, and retrying
// it verbatim will fail every single time until the code changes.
// Because all 16 key/model combinations kept re-failing on a 45s loop,
// the "all combos currently dead" condition kept tripping almost
// immediately, which is what pushed Gemini into its escalating global
// backoff (30s -> 1m -> 2m -> 3m) after just a few scans — within a
// song or two, exactly as reported.
//
// 1) 429 (QUOTA EXCEEDED) NOW RESPECTS THE REAL RETRY TIME: Gemini's
//    own error response tells you exactly how long to wait (either a
//    structured RetryInfo.retryDelay, or text like "Please retry in
//    8h4m32s"). A new parseRetryDelayMs() reads that and the combo is
//    now put on cooldown for the ACTUAL remaining time (capped at
//    MODEL_DEAD_QUOTA_MAX_MS = 24h so a single bad parse can't wedge a
//    combo forever), falling back to a 30-minute default only if the
//    response genuinely doesn't say. This is the main fix: your 4 keys
//    now round-robin properly instead of every key hammering an
//    already-exhausted daily quota every 45 seconds.
//
// 2) 400 (INVALID ARGUMENT) IS NOW TREATED LIKE 404: a 400 is a
//    request-format problem, not a server hiccup — if it fails for one
//    key it will fail identically for all of them, so it's now marked
//    dead for MODEL_DEAD_LONG_MS (6h) instead of 45s, the same as an
//    unknown/retired model id. This stops the script from burning
//    through its request budget retrying a combination that can
//    mathematically never succeed without a code change. (If
//    gemini-3.5-flash-lite keeps doing this for you specifically, it's
//    worth double-checking that model id is actually valid/enabled for
//    your key's tier — a 400 that's identical across 4 separate keys
//    really does point at the model id, not your account.)
//
// 3) TIMEOUTS/NETWORK EXCEPTIONS NOW ALSO GET A SHORT COOLDOWN: a
//    combo that times out (10s, no response) or throws a network-level
//    error previously got NO cooldown at all, so the very next scan
//    cycle could immediately retry the exact same struggling
//    combination. It now gets the same MODEL_DEAD_SHORT_MS (45s)
//    treatment as a 5xx, so a flaky combo backs off briefly instead of
//    being hit again right away while other combos sit idle.
//
// None of this changes STORAGE_CACHE_KEY, your saved API keys, or when
// the cache gets wiped (still only via the "Kaydet ve Sıfırla" button)
// — this is purely about Gemini giving up on your keys too fast.
//
// V45 - WHAT CHANGED AND WHY (still included in this version):
//
// RIGHT-CLICK NOW OPENS A REAL VISIBLE PANEL: right-clicking the button
// now calls Spicetify.PopupModal.display() with a text box for your
// Gemini key(s), a warning about the cache wipe, and Cancel/Save
// buttons - this is Spicetify's own supported way to show UI, and it
// actually renders inside Spotify, unlike prompt()/confirm(). Saving
// still does everything V44's fix did (see below): applies the new
// keys, clears all cooldown/backoff state, and fully wipes the
// translation cache so every visible line gets a genuine retranslation.
//
// V44 - WHAT CHANGED AND WHY (still included in this version):
//
// 1) RIGHT-CLICK+OK IS NOW A REAL FULL RESET: previously it only reset
//    the Gemini/GTX/MyMemory cooldown timers and dead-model list. It
//    never touched `cache` itself, so a line that had already been
//    cached (even as broken GTX output like "Wayuphighlikemybilincim")
//    was considered "done" forever — scanLines() skips any line already
//    in cache, so adding API keys afterwards changed nothing for lines
//    that already had a (bad) cached entry. Now, submitting the dialog
//    clears the in-memory cache, wipes the cache entry in localStorage,
//    clears failedUntil/inFlight/needsRomajaRefetch, and re-scans — so
//    every visible line gets re-translated from scratch, this time with
//    your Gemini keys actually in play. A confirm() guards this since it
//    means every cached song gets re-translated (real API usage), so you
//    don't nuke a large cache by accident.
//
// 2) FIXED repairCache() CRASH: `reformalized` -> `reformalFixed` typo
//    fixed. This was throwing a ReferenceError and skipping saveCache()
//    on exactly the runs where only rule-3 (siz/size->sen/sana cleanup)
//    fixes were made, silently discarding those repairs every time.
//
// 3) GLUED-OUTPUT GUARD, BOTH DIRECTIONS: GTX/MyMemory output is now
//    rejected (not just "repaired") when it is obviously glued: if the
//    source line has 2+ words but the returned Turkish translation has
//    NO spaces at all and is long, or contains any single space-split
//    token over 22 characters, it's treated as a failed translation
//    instead of being cached and shown. This is what produced lines
//    like "Wayuphighlikemybilincim" and "Çünkühiçbirisenisikiyor" on
//    screen — GTX's own response had no word boundaries in it, and the
//    old fixGluedWords() only catches lowercase->uppercase transitions,
//    which a run of all-lowercase glued words never has. Gemini doesn't
//    have this failure mode (it's instructed explicitly on spacing), so
//    once Gemini keys are actually working again (fix #1), this path is
//    rarely hit going forward — this guard just stops already-bad GTX/
//    MyMemory output from being cached and shown while a line is still
//    on the Gemini->GTX->MyMemory fallback chain. repairCache() now also
//    purges any previously-cached entry that matches this same pattern,
//    so old glued lines get cleaned up on next load even without using
//    the reset button.
//
// UNCHANGED FROM V43: looksTurkish() skip, the stronger localization
// prompt (idioms/explicitness/nonsense-hook rules), defensive
// try/catch around the startup repairCache() call, the 45s short
// cooldown for transient Gemini errors, the Gemini model list, the
// MyMemory language-detect fix, romaja glomming repair, ad-lib fallback
// protection, persistent backoff state across reloads, single-source-
// of-truth styling, watchdog, singleton guard, idempotent rendering,
// persistent translation cache key (still spicy_tr_godmode_v35 —
// nobody's cache gets silently wiped just by installing this update;
// it's only cleared when you explicitly use the reset button).

(function spicyTurkishProV47() {
  const DEBUG = true;
  const log = (...args) => { if (DEBUG) console.log('%c[SpicyTR V47]', 'color:#1db954;font-weight:bold', ...args); };
  const warn = (...args) => { if (DEBUG) console.warn('%c[SpicyTR V47]', 'color:#ffae00;font-weight:bold', ...args); };
  const err = (...args) => { if (DEBUG) console.error('%c[SpicyTR V47]', 'color:#ff4b4b;font-weight:bold', ...args); };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs || 10000);
    try {
      return await fetch(url, { ...(options || {}), signal: controller.signal });
    } finally {
      clearTimeout(id);
    }
  }

  let geminiLastError = '';
  let gtxLastError = '';
  let mmLastError = '';

  if (typeof window.__spicyTRCleanup === 'function') {
    try {
      window.__spicyTRCleanup();
      log('Önceki script örneği tespit edildi ve temizlendi.');
    } catch (e) {
      err('Önceki örnek temizlenirken hata (yine de devam ediliyor):', e);
    }
  }

  [
    'spicy_tr_persistent_cache_v5', 'spicy_tr_persistent_cache_v12_final',
    'spicy_tr_marketplace_v19', 'spicy_tr_stable_v20', 'spicy_tr_ultimate_v21',
    'spicy_tr_unbreakable_v22', 'spicy_tr_godmode_v23', 'spicy_tr_godmode_v26',
    'spicy_tr_godmode_v27', 'spicy_tr_godmode_v28', 'spicy_tr_godmode_v29',
    'spicy_tr_godmode_v30', 'spicy_tr_godmode_v31', 'spicy_tr_godmode_v32',
    'spicy_tr_godmode_v33', 'spicy_tr_godmode_v34'
    // 'spicy_tr_godmode_v35' deliberately stays as the live cache key below -
    // do not bump this just to "freshen" things, it wipes everyone's cache.
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
  const needsRomajaRefetch = new Set();
  const failedUntil = new Map();
  const FAILURE_COOLDOWN_MS = 12000;
  const deadModels = new Map();
  const MODEL_DEAD_SHORT_MS = 45000;
  const MODEL_DEAD_LONG_MS = 6 * 60 * 60 * 1000;  // 404/400 = wrong/retired model id or a request shape this model rejects outright - genuinely permanent until the model list or request shape changes
  const MODEL_DEAD_QUOTA_DEFAULT_MS = 30 * 60 * 1000;  // (V47) fallback cooldown for a 429 when we can't parse Gemini's own stated retry time
  const MODEL_DEAD_QUOTA_MAX_MS = 24 * 60 * 60 * 1000;  // (V47) sanity cap even if the parsed/implied wait is absurdly long

  const GEMINI_BACKOFF_STEPS_MS = [30000, 60000, 120000, 180000]; // 30s,1m,2m,3m
  let geminiGloballyDownUntil = 0;
  let geminiBackoffStage = 0;

  const GTX_BACKOFF_STEPS_MS = [30000, 60000, 120000, 240000, 480000, 900000, 1800000];
  const GTX_FAIL_THRESHOLD = 5;
  let gtxGloballyDownUntil = 0;
  let gtxBackoffStage = 0;
  let gtxConsecutiveFailures = 0;

  const MM_BACKOFF_STEPS_MS = [30000, 60000, 120000, 240000, 480000, 900000, 1800000];
  const MM_FAIL_THRESHOLD = 5;
  let mmGloballyDownUntil = 0;
  let mmBackoffStage = 0;
  let mmConsecutiveFailures = 0;

  const BACKOFF_STATE_KEY = 'spicy_tr_backoff_state_v1';
  function saveBackoffState() {
    try {
      const state = {
        geminiGloballyDownUntil, geminiBackoffStage,
        gtxGloballyDownUntil, gtxBackoffStage,
        mmGloballyDownUntil, mmBackoffStage,
        deadModels: Array.from(deadModels.entries())
      };
      localStorage.setItem(BACKOFF_STATE_KEY, JSON.stringify(state));
    } catch (e) {}
  }
  function loadBackoffState() {
    try {
      const raw = localStorage.getItem(BACKOFF_STATE_KEY);
      if (!raw) return;
      const state = JSON.parse(raw);
      const now = Date.now();
      if (state.geminiGloballyDownUntil > now) {
        geminiGloballyDownUntil = state.geminiGloballyDownUntil;
        geminiBackoffStage = state.geminiBackoffStage || 0;
      }
      if (state.gtxGloballyDownUntil > now) {
        gtxGloballyDownUntil = state.gtxGloballyDownUntil;
        gtxBackoffStage = state.gtxBackoffStage || 0;
      }
      if (state.mmGloballyDownUntil > now) {
        mmGloballyDownUntil = state.mmGloballyDownUntil;
        mmBackoffStage = state.mmBackoffStage || 0;
      }
      if (Array.isArray(state.deadModels)) {
        state.deadModels.forEach(([k, until]) => {
          if (until > now) deadModels.set(k, until);
        });
      }
      if (geminiGloballyDownUntil > now || gtxGloballyDownUntil > now || mmGloballyDownUntil > now || deadModels.size > 0) {
        log('Önceki oturumdan hâlâ geçerli olan bekleme süreleri geri yüklendi (gerçek limitler tekrar tetiklenmesin diye).');
      }
    } catch (e) {}
  }
  loadBackoffState();

  const GEMINI_MODELS = [
    'gemini-3.5-flash',
    'gemini-3-flash-preview',
    'gemini-3.1-flash-lite',
    'gemini-3.5-flash-lite'
  ];

  let isEnabled = localStorage.getItem('spicy_tr_enabled') !== 'false';
  let batchTimer = null;

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
  const legacyKey = localStorage.getItem('spicy_tr_gemini_key');
  if (legacyKey && legacyKey.trim().length > 10 && !geminiApiKeys.includes(legacyKey.trim())) {
    geminiApiKeys.push(legacyKey.trim());
    try { localStorage.setItem(GEMINI_KEYS_STORAGE, JSON.stringify(geminiApiKeys)); } catch (e) {}
  }
  localStorage.removeItem('spicy_tr_gemini_key');

  const MAX_LINES_PER_GEMINI_CALL = 50;
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

  const TURKISH_COMMON_WORDS = /\b(bir|bu|şu|ben|sen|biz|siz|değil|gibi|için|ama|çok|var|yok|ile|ne|nasıl|neden|her|daha|olan|oldu|olacak|sanki|kadar|benim|senin|onun|beni|seni|bana|sana|gel|gelse|değilsin|yine|hep|artık|belki|hiç)\b/i;
  function looksTurkish(text) {
    if (!text) return false;
    if (/[çÇğĞıİşŞöÖüÜ]/.test(text)) return true;
    const words = text.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return false;
    const matches = words.filter(w => TURKISH_COMMON_WORDS.test(w)).length;
    return matches >= 2 || (words.length <= 3 && matches >= 1);
  }

  // (V44) Detects translator output that is obviously glued together with
  // no word boundaries - the failure mode behind lines like
  // "Wayuphighlikemybilincim" or "Çünkühiçbirisenisikiyor". GTX/MyMemory
  // occasionally return a sentence with missing spaces, and the existing
  // fixGluedWords() can only repair a lowercase->uppercase transition, so
  // an all-lowercase glued run sails straight through untouched.
  function looksGluedTranslation(originalLine, translated) {
    if (!translated) return false;
    const srcTokens = (originalLine || '').trim().split(/\s+/).filter(Boolean);
    if (srcTokens.length < 2) return false;
    const trTokens = translated.trim().split(/\s+/).filter(Boolean);
    if (trTokens.length === 0) return false;
    if (trTokens.length === 1 && translated.length >= 10) return true;
    if (trTokens.some(t => t.replace(/[^a-zçğıöşüA-ZÇĞİÖŞÜ]/g, '').length > 22)) return true;
    return false;
  }

  function repairCache() {
    let fixed = 0, purged = 0, reformalFixed = 0, turkishPurged = 0, gluedPurged = 0;
    for (const [rawLine, data] of Array.from(cache.entries())) {
      if (!data) continue;

      if (looksTurkish(rawLine)) {
        cache.delete(rawLine);
        turkishPurged++;
        continue;
      }

      // (V44) Obviously glued-together output from an earlier bad
      // GTX/MyMemory response - purge so the line gets a real retry.
      if (data.tr && looksGluedTranslation(rawLine, data.tr)) {
        cache.delete(rawLine);
        gluedPurged++;
        continue;
      }

      let changed = false;

      if (data.romaja && !/\s/.test(data.romaja) && data.romaja.length >= 8) {
        const repaired = splitRepeatingUnit(data.romaja);
        if (repaired) {
          data.romaja = repaired;
          changed = true;
        } else if (looksGluedRomaja(rawLine, data.romaja)) {
          data.romaja = '';
          changed = true;
        }
        if (changed) fixed++;
      }

      if (isAdlibPattern(rawLine) && data.tr && data.tr.includes('&') && normalize(data.tr) !== normalize(rawLine)) {
        cache.delete(rawLine);
        purged++;
        continue;
      }

      if (data.tr && normalize(data.tr) !== normalize(rawLine)) {
        const reformalized = forcePerfectTurkish(data.tr);
        if (reformalized && reformalized !== data.tr && normalize(reformalized) !== normalize(rawLine)) {
          data.tr = reformalized;
          changed = true;
          reformalFixed++;
        }
      }

      if (changed) cache.set(rawLine, data);
    }
    // (V44) FIX: this used to reference an undefined `reformalized`
    // variable instead of `reformalFixed`, which threw and skipped
    // saveCache() below on any run where only rule-3 fixes happened.
    if (fixed || purged || reformalFixed || turkishPurged || gluedPurged) {
      saveCache();
      log(`Cache onarımı: ${fixed} satırın romanizasyonu düzeltildi, ${purged} hatalı ad-lib çevirisi silindi, ${reformalFixed} satırda resmi/"siz" kalıntısı temizlendi, ${turkishPurged} zaten-Türkçe satırın gereksiz çevirisi silindi, ${gluedPurged} bitişik/hatalı çeviri silindi.`);
    }
  }
  try {
    repairCache();
  } catch (e) {
    err('Cache onarımı sırasında beklenmeyen hata (cache onarımı atlandı, eklentinin geri kalanı normal şekilde devam ediyor):', e);
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
      display: flex !important;
      flex-direction: column !important;
      gap: 3px !important;
      pointer-events: none !important;
      line-height: 1.35 !important;
      opacity: 1 !important;
    }
    body.spicy-tr-off .spicy-tr-box {
      display: none !important;
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

  function applyEnabledClass() {
    document.body.classList.toggle('spicy-tr-off', !isEnabled);
  }
  applyEnabledClass();

  let resizeTimer;
  function triggerRecalc() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { window.dispatchEvent(new Event('resize')); }, 100);
  }

function isNonLatin(text) {
    // (V46) Artık "hangi scriptler non-Latin sayılır" listesi açıkça
    // yazılıyor (Hangul, Hiragana/Katakana, CJK Han, Thai, Cyrillic,
    // Arabic, Devanagari...) - eski ters-mantık regex yanlışlıkla Tay
    // alfabesinin tamamını "zaten Latin" sanıyordu, bu yüzden Tayca
    // satırlarda romaja kutusu hiç çizilmiyordu.
    return /[\u0400-\u04FF\u0600-\u06FF\u0900-\u097F\u0E00-\u0E7F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7A3\uF900-\uFAFF\uFF66-\uFF9F]/u.test(text);
  }

  function normalize(s) {
    return (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  function splitRepeatingUnit(s) {
    if (!s || /\s/.test(s)) return null;
    const n = s.length;
    if (n < 6) return null;
    for (let unitLen = 1; unitLen <= Math.floor(n / 3); unitLen++) {
      if (n % unitLen !== 0) continue;
      const unit = s.slice(0, unitLen);
      let ok = true;
      for (let i = unitLen; i < n; i += unitLen) {
        if (s.slice(i, i + unitLen) !== unit) { ok = false; break; }
      }
      if (ok) {
        const repeats = n / unitLen;
        if (repeats < 3) continue;
        return Array(repeats).fill(unit).join(' ');
      }
    }
    return null;
  }

 function countNonLatinWords(line) {
    return line.trim().split(/\s+/).filter(Boolean).filter(w => isNonLatin(w)).length;
  }

  function looksGluedRomaja(originalLine, rom) {
    if (!rom || /\s/.test(rom)) return false;
    if (rom.length < 8) return false;
    // (V46) Artık TÜM kelime sayısına değil, satırdaki non-Latin (örn.
    // Korece) kelime sayısına bakıyor - "Korece kelime + İngilizce cümle"
    // gibi karışık satırlarda tek Korece kelimenin tek parça (boşluksuz)
    // romanizasyonu artık yanlışlıkla "bitişik/bozuk" sayılıp silinmiyor.
    return countNonLatinWords(originalLine) >= 2;
  }

  function isAdlibPattern(line) {
    const tokens = line.split(/[\s&]+/).filter(Boolean);
    if (tokens.length < 3) return false;
    const counts = {};
    tokens.forEach(t => {
      const key = t.toLowerCase();
      counts[key] = (counts[key] || 0) + 1;
    });
    const maxCount = Math.max(...Object.values(counts));
    return maxCount / tokens.length >= 0.6;
  }

  function detectSourceLangForMyMemory(text) {
    if (/[가-힣ᄀ-ᇿ㄰-㆏]/.test(text)) return 'ko';
    if (/[぀-ヿ]/.test(text)) return 'ja';
    if (/[฀-๿]/.test(text)) return 'th';
    if (/[一-鿿]/.test(text)) return 'zh-CN';
    return 'en';
  }

  function fixGluedWords(s) {
    if (!s) return s;
    const repeated = splitRepeatingUnit(s);
    if (repeated) return repeated;
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

  // (V47) Reads Gemini's own stated quota-reset time out of a 429 response
  // instead of guessing - either the structured RetryInfo.retryDelay field
  // (e.g. "28952.5s") or the human-readable "...Please retry in 8h4m32s..."
  // text Google also includes in error.message. Returns milliseconds, or
  // null if neither form is present/parseable, so the caller can fall back
  // to a sane default instead of a bare 45-second retry.
  function parseRetryDelayMs(errJson, bodyMsg) {
    try {
      const details = errJson?.error?.details;
      if (Array.isArray(details)) {
        for (const d of details) {
          if (d && typeof d.retryDelay === 'string') {
            const m = /^([\d.]+)s$/.exec(d.retryDelay.trim());
            if (m) return Math.ceil(parseFloat(m[1]) * 1000);
          }
        }
      }
    } catch (e) {}

    if (bodyMsg) {
      const m = /retry in\s+(?:([\d.]+)\s*h)?\s*(?:([\d.]+)\s*m)?\s*(?:([\d.]+)\s*s)?/i.exec(bodyMsg);
      if (m && (m[1] || m[2] || m[3])) {
        const h = parseFloat(m[1] || '0');
        const min = parseFloat(m[2] || '0');
        const s = parseFloat(m[3] || '0');
        const ms = Math.ceil((h * 3600 + min * 60 + s) * 1000);
        if (ms > 0) return ms;
      }
    }
    return null;
  }

  function formatDuration(ms) {
    const totalSec = Math.round(ms / 1000);
    if (totalSec < 60) return `${totalSec}sn`;
    const totalMin = Math.round(totalSec / 60);
    if (totalMin < 60) return `${totalMin}dk`;
    const h = Math.floor(totalMin / 60);
    const min = totalMin % 60;
    return min > 0 ? `${h}sa ${min}dk` : `${h}sa`;
  }

  function renderSubtitles(lineEl, data, rawText) {
    const marker = `${data.tr || ''}\u0000${data.romaja || ''}`;
    let box = lineEl.querySelector('.spicy-tr-box');
    if (box && box.dataset.marker === marker) return;
    if (box) box.remove();

    box = document.createElement('div');
    box.className = 'spicy-tr-box';
    box.dataset.marker = marker;

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
   WRONG (formal - never output anything like this): "Ters çevirin", "gevşetin", "keşfedin", "devam edin", "Kalbinize", "düğmelerinizi", "yerlerinizi", "Siz farkına bile varmadan", "görüş alanınızdadır", "sabahınızı"
   RIGHT (informal - always output like this instead): "Ters çevir", "gevşet", "keşfet", "devam et", "Kalbine", "düğmelerini", "yerlerini", "Sen farkına bile varmadan", "görüş alanındadır", "sabahını"
2. NO LINE SKIP OR SHIFT: your JSON array MUST contain exactly ${chunkLines.length} objects, one per numbered line above, in the exact same order - including lines that are already in English, already seem simple/understandable, or match the song's title. Never leave a line as-is just because it "already makes sense" - every line gets its own real Turkish translation.
3. REPEATED/STYLIZED AD-LIBS: if a line is a rhythmic ad-lib or vocalization using repetition (e.g. "On&on&on&on oh", "La la la la"), do NOT translate each repeated token as a separate literal word for the "tr" field - treat the whole repeated pattern as one vocal/rhythmic unit and either keep it as a natural-sounding vocal ad-lib or give one single natural Turkish equivalent for the whole thing, never a word-by-word literal mess.
3b. FULL CONTEXTUAL LOCALIZATION, NOT LITERAL TRANSLATION: you are localizing, not translating word-by-word. Read each line in light of the whole song's story/mood (given above) and render what it MEANS and FEELS like in natural, idiomatic Turkish - never a stiff, dictionary-literal rendering that reads like a translation. Specifically:
   - IDIOMS: translate the idiom's actual function/meaning, never word-for-word. "Hold your horses" means "wait/slow down, be patient" - find the Turkish expression that does that job ("acele etme", "sakin ol"), not a literal horse reference.
   - EXPLICITNESS AND REGISTER MUST MATCH EXACTLY, WITH TODAY'S SLANG: if the source line is vulgar, crude, or sexually explicit, your Turkish must be equally direct and explicit, using the actual CONTEMPORARY Turkish word/slang for it - never an outdated, euphemistic, or softened stand-in just because the word is crude. A toned-down or old-fashioned translation of an explicit line is a WRONG translation, not a safer one.
     WRONG (dated, softened euphemism): "Çünkü kimse seni benim gibi beceremez" for "'cause no one fucks you like I do"
     RIGHT (direct, current, matches the source's register): "Çünkü kimse seni benim gibi sikemez"
     This isn't about this one example - it's the general rule: always reach for the real, current Turkish word for whatever's explicit in the source, never a stiffer or quainter stand-in. Match playful lines playfully, intimate lines intimately, aggressive lines aggressively.
   - NONSENSE / INVENTED HOOK PHRASES: pop lyrics sometimes use made-up or sound-driven phrases with no literal real-world meaning (a title hook built from onomatopoeia or wordplay, e.g. "Bubble pop electric"). Do NOT attempt a literal word-for-word unpacking of these - it produces nonsense, not a translation.
     WRONG (literal, reads as a mistranslation): "Elektrikli baloncuk patlaması" for "Bubble pop electric"
     RIGHT: a short, natural-sounding Turkish phrase that captures the ENERGY/VIBE of the hook, or - when no Turkish rewrite actually improves on it - keep the stylized English phrase as-is, the way Turkish listeners already hear it.
   - Prefer Turkish's own reduplicated intensifiers where they fit naturally ("masmavi" rather than "çok mavi", "bembeyaz" rather than "çok beyaz", "güpegündüz" for broad daylight), and generally favor an evocative, idiomatic phrase over a technically-accurate-but-stiff one, as long as the core meaning is preserved.
3c. TITLE / HOOK LINES: a line that IS or closely matches the song's own title (given above as "Song:"), or a repeated stylized hook built from mixed fragments, will not translate sensibly word-for-word - see the nonsense/hook guidance in rule 3b above. For these, give a short, natural-sounding Turkish phrase that captures the vibe/mood of the hook instead, the way a Turkish cover or localized title would read.
4. ROMANIZATION IS MANDATORY for every line not already in Latin script - NEVER leave "rom" empty for Korean, Japanese, Chinese, Thai, or any other non-Latin script, even when a perfectly clean version is hard to produce. Always give your best simple phonetic attempt instead of skipping it. (Only use an empty string for "rom" when the line is ALREADY in Latin script.)
   STYLE: keep it casual and readable, the way an ordinary person types out pronunciation online. Standard single accent marks from an established system are fine. AVOID heavy academic/IAST-style transliteration with multiple stacked diacritics per letter.
   SPACING IS MANDATORY AND NON-NEGOTIABLE, EVEN FOR AD-LIBS: always put a space between EVERY romanized word exactly the way the original line's words/tokens are separated - this applies even when rule 3 tells you to compress a repeated ad-lib into one natural phrase for "tr". The "rom" field must still spell out each repeated unit separated by spaces (e.g. source "마 마 마 마 마 마" -> rom "ma ma ma ma ma ma", never "mamamamamama"). NEVER concatenate several words or repeated units into one unbroken string under any circumstance.
5. COMPLETE, PROPERLY CONJUGATED SENTENCES: every translated line must read as a natural, grammatically complete Turkish sentence or fragment with a correctly conjugated verb matching who is actually speaking or being addressed in that line. NEVER end a line on a bare infinitive ("-mak/-mek" as the line's main verb) when it needs to be a finite verb, and NEVER use a bare imperative when the source line is a first-person statement, not a command.
   WRONG: "...telefonunu aramak" (bare infinitive used as if it were the whole sentence) for a line that means "I'm calling your phone" -> RIGHT: "...telefonunu arıyorum"
   WRONG: "Ama iyiymişim gibi davran" (imperative "act!", addressed to someone else) for a line that means "I act like I'm fine" -> RIGHT: "Ama iyiymişim gibi davranıyorum"
   Only use an imperative form when the source line is itself genuinely phrased as a command/instruction.
6. OUTPUT FORMAT: respond with ONLY a JSON array matching the given schema - exactly ${chunkLines.length} objects, in the same order as the numbered lines above. Each object has "rom" (romanization, or "" if the line is already Latin script) and "tr" (the natural Turkish translation using informal "sen", per rule 1). No extra text, no markdown, no numbering in the output - just the array.`;

    let lastError = new Error('Tüm Gemini anahtar/model kombinasyonları şu an soğuma süresinde veya kullanılamıyor');

    for (const model of GEMINI_MODELS) {
      for (const apiKey of geminiApiKeys) {
        const comboKey = `${keyFp(apiKey)}::${model}`;
        if ((deadModels.get(comboKey) || 0) > Date.now()) continue;

        try {
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey.trim()}`;
          const res = await fetchWithTimeout(url, {
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
            let bodyMsg = '';
            let errJson = null;
            try {
              errJson = await res.clone().json();
              bodyMsg = errJson?.error?.message || '';
            } catch (parseErr) {}
            geminiLastError = `[${model} ...${keyFp(apiKey)}] HTTP ${res.status}${bodyMsg ? ' - ' + bodyMsg : ''}`;

            if (res.status === 404) {
              deadModels.set(comboKey, Date.now() + MODEL_DEAD_LONG_MS);
              warn(`Model "${model}" bulunamadı (404, anahtar ...${keyFp(apiKey)}) - muhtemelen kaldırılmış/geçersiz model id, 6 saatliğine devre dışı bırakıldı`);
            } else if (res.status === 400) {
              // (V47) A 400 that repeats identically across every key for this
              // model is a request-format problem, not a per-key fluke -
              // retrying the exact same body on a 45s timer can never succeed,
              // so treat it like a dead model id instead of a transient error.
              deadModels.set(comboKey, Date.now() + MODEL_DEAD_LONG_MS);
              warn(`Model "${model}" geçersiz istek döndürdü (400, anahtar ...${keyFp(apiKey)}) - istek bu model için hatalı biçimlenmiş olmalı, 6 saatliğine devre dışı bırakıldı: ${bodyMsg || '(sebep belirtilmedi)'}`);
            } else if (res.status === 429) {
              // (V47) Respect Gemini's own stated quota-reset time instead of
              // retrying an exhausted daily quota every 45 seconds - this was
              // the main reason 4 configured keys still looked "dead" within
              // just a couple of songs.
              const retryMs = parseRetryDelayMs(errJson, bodyMsg);
              const waitMs = Math.min(retryMs || MODEL_DEAD_QUOTA_DEFAULT_MS, MODEL_DEAD_QUOTA_MAX_MS);
              deadModels.set(comboKey, Date.now() + waitMs);
              warn(`[${model} ...${keyFp(apiKey)}] kota doldu (429) - ${formatDuration(waitMs)} sonra bu kombinasyon tekrar denenecek${bodyMsg ? ': ' + bodyMsg : ''}`);
            } else {
              deadModels.set(comboKey, Date.now() + MODEL_DEAD_SHORT_MS);
              warn(`[${model} ...${keyFp(apiKey)}] geçici hata (HTTP ${res.status}) - ~${Math.round(MODEL_DEAD_SHORT_MS / 1000)}sn sonra bu kombinasyon tekrar denenecek${bodyMsg ? ': ' + bodyMsg : ''}`);
            }
            saveBackoffState();
            throw new Error(geminiLastError);
          }

          const json = await res.json();
          const rawOutput = json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
          const parsed = parseGeminiJsonArray(rawOutput, chunkLines.length);

          if (!parsed) throw new Error('JSON eksik/satır sayısı uyuşmuyor');

          chunkLines.forEach((rawLine, i) => {
            const item = parsed[i] || {};
            const trRaw = (item.tr || '').trim();
            if (!trRaw) return;

            const cleanTr = fixGluedWords(forcePerfectTurkish(trRaw));
            if (normalize(cleanTr) === normalize(rawLine)) return;
            if (looksGluedTranslation(rawLine, cleanTr)) return; // (V44) reject obviously glued output instead of caching it

            let cleanRom = '';
            if (isNonLatin(rawLine)) {
              const romRaw = (item.rom || '').trim();
              if (looksGluedRomaja(rawLine, romRaw)) {
                const repaired = splitRepeatingUnit(romRaw);
                if (repaired) {
                  cleanRom = repaired;
                } else {
                  cleanRom = '';
                  needsRomajaRefetch.add(rawLine);
                }
              } else {
                cleanRom = fixGluedWords(romRaw);
              }
            }

            cache.set(rawLine, { tr: cleanTr, romaja: cleanRom });
          });

          saveCache();
          updateDOMWithCache();

          geminiGloballyDownUntil = 0;
          geminiBackoffStage = 0;
          saveBackoffState();

          const leftover = chunkLines.filter(l => {
            const c = cache.get(l);
            return !c || !c.tr;
          });
          return leftover;
        } catch (modelErr) {
          lastError = modelErr;
          if (modelErr?.name === 'AbortError') {
            geminiLastError = `[${model} ...${keyFp(apiKey)}] zaman aşımı (10sn içinde cevap gelmedi)`;
          } else if (!geminiLastError || !geminiLastError.includes(model)) {
            geminiLastError = `[${model} ...${keyFp(apiKey)}] ${modelErr?.message || modelErr}`;
          }
          // (V47) A timeout/network-level failure previously got NO cooldown
          // at all, so the very next scan could immediately retry the exact
          // same struggling combo. Only set this if the !res.ok branch above
          // didn't already set a more specific one (that branch sets its own
          // cooldown before throwing, so blindly overwriting here would
          // shorten a real 429/400 cooldown back down to 45s).
          if ((deadModels.get(comboKey) || 0) <= Date.now()) {
            deadModels.set(comboKey, Date.now() + MODEL_DEAD_SHORT_MS);
            saveBackoffState();
          }
        }
      }
    }

    const allCombosDead = geminiApiKeys.length === 0 ||
      GEMINI_MODELS.every(model => geminiApiKeys.every(apiKey => (deadModels.get(`${keyFp(apiKey)}::${model}`) || 0) > Date.now()));

    if (allCombosDead) {
      const waitMs = GEMINI_BACKOFF_STEPS_MS[Math.min(geminiBackoffStage, GEMINI_BACKOFF_STEPS_MS.length - 1)];
      if (geminiGloballyDownUntil <= Date.now()) {
        warn(`Tüm Gemini anahtar/model kombinasyonları şu an soğumada (geçici) - yedek motorlara geçiliyor, ${Math.round(waitMs / 1000)}sn sonra Gemini tekrar denenecek`);
      }
      geminiGloballyDownUntil = Date.now() + waitMs;
      geminiBackoffStage++;
      saveBackoffState();
    }

    throw lastError;
  }

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
  const mmGate = makeConcurrencyGate(1, 300);

  const GTX_CHUNK_SIZE = 4;
  const GTX_CHUNK_PAUSE_MS = 650;
  const MM_CHUNK_SIZE = 3;
  const MM_CHUNK_PAUSE_MS = 1100;

  function chunkArray(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  async function translateWithGTXPerLine(linesToTranslate) {
    if (Date.now() < gtxGloballyDownUntil) {
      const remaining = Math.min(gtxGloballyDownUntil - Date.now(), 60000);
      linesToTranslate.forEach(t => markFailed(t, remaining));
      return;
    }

    const chunks = chunkArray(linesToTranslate, GTX_CHUNK_SIZE);

    for (let ci = 0; ci < chunks.length; ci++) {
      if (Date.now() < gtxGloballyDownUntil) {
        const remaining = Math.min(gtxGloballyDownUntil - Date.now(), 60000);
        chunks.slice(ci).flat().forEach(t => markFailed(t, remaining));
        break;
      }

      await Promise.all(chunks[ci].map(async (rawText) => {
        await gtxGate.acquire();
        try {
          const adlib = isAdlibPattern(rawText);
          const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=tr&dt=t&dt=rm&q=${encodeURIComponent(normalizeForDumbEngines(rawText))}`;
          const res = await fetchWithTimeout(url, {}, 10000);
          if (!res.ok) {
            gtxLastError = `HTTP ${res.status}`;
            throw new Error(gtxLastError);
          }
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

          const existing = cache.get(rawText) || {};
          const cleanRomaja = isNonLatin(rawText) ? fixGluedWords(romaja) : '';
          const fixedTr = fixGluedWords(forcePerfectTurkish(trLine));
          // (V44) reject obviously glued GTX output instead of caching/showing it
          const useTr = !adlib && trLine && normalize(trLine) !== normalize(rawText) && !looksGluedTranslation(rawText, fixedTr);
          const gotSomethingNew = useTr || (cleanRomaja && !existing.romaja);

          if (gotSomethingNew) {
            gtxConsecutiveFailures = 0;
            gtxGloballyDownUntil = 0;
            gtxBackoffStage = 0;
            cache.set(rawText, {
              tr: useTr ? fixedTr : (existing.tr || rawText),
              romaja: cleanRomaja || existing.romaja || ''
            });
          } else {
            markFailed(rawText);
          }
        } catch (e) {
          gtxLastError = e?.name === 'AbortError' ? 'zaman aşımı (10sn)' : (e?.message || String(e));
          gtxConsecutiveFailures++;
          if (gtxConsecutiveFailures >= GTX_FAIL_THRESHOLD && gtxGloballyDownUntil <= Date.now()) {
            const waitMs = GTX_BACKOFF_STEPS_MS[Math.min(gtxBackoffStage, GTX_BACKOFF_STEPS_MS.length - 1)];
            warn(`GTX tekrar tekrar başarısız oluyor (${gtxLastError}) - ${Math.round(waitMs / 1000)}sn bekleniyor`);
            gtxGloballyDownUntil = Date.now() + waitMs;
            gtxBackoffStage++;
            saveBackoffState();
          }
          markFailed(rawText);
        } finally {
          gtxGate.release();
        }
      }));

      saveCache();
      updateDOMWithCache();

      if (ci < chunks.length - 1) await sleep(GTX_CHUNK_PAUSE_MS);
    }
  }

  async function translateRomajaOnlyWithGTX(lines) {
    if (!lines || lines.length === 0) return;
    if (Date.now() < gtxGloballyDownUntil) return;

    const chunks = chunkArray(lines, GTX_CHUNK_SIZE);
    for (let ci = 0; ci < chunks.length; ci++) {
      if (Date.now() < gtxGloballyDownUntil) break;

      await Promise.all(chunks[ci].map(async (rawText) => {
        const existing = cache.get(rawText);
        if (!existing || existing.romaja) return;

        await gtxGate.acquire();
        try {
          const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=tr&dt=rm&q=${encodeURIComponent(rawText)}`;
          const res = await fetchWithTimeout(url, {}, 10000);
          if (!res.ok) return;
          const json = await res.json();
          let romaja = '';
          if (Array.isArray(json[0])) {
            json[0].forEach(item => { if (item[3]) romaja += (romaja ? ' ' : '') + item[3]; });
          }
          romaja = romaja.trim();
          if (romaja) {
            const current = cache.get(rawText) || existing;
            cache.set(rawText, { tr: current.tr, romaja: fixGluedWords(romaja) });
          }
        } catch (e) {
          // silent - retried on a later scan
        } finally {
          gtxGate.release();
        }
      }));

      saveCache();
      updateDOMWithCache();
      if (ci < chunks.length - 1) await sleep(GTX_CHUNK_PAUSE_MS);
    }
  }

  async function translateWithMyMemoryPerLine(linesToTranslate) {
    if (Date.now() < mmGloballyDownUntil) {
      const remaining = Math.min(mmGloballyDownUntil - Date.now(), 60000);
      linesToTranslate.forEach(t => markFailed(t, remaining));
      return;
    }

    const chunks = chunkArray(linesToTranslate, MM_CHUNK_SIZE);

    for (let ci = 0; ci < chunks.length; ci++) {
      if (Date.now() < mmGloballyDownUntil) {
        const remaining = Math.min(mmGloballyDownUntil - Date.now(), 60000);
        chunks.slice(ci).flat().forEach(t => markFailed(t, remaining));
        break;
      }

      await Promise.all(chunks[ci].map(async (rawText) => {
        if (isAdlibPattern(rawText)) {
          const existing = cache.get(rawText) || {};
          if (!existing.tr) {
            cache.set(rawText, { tr: rawText, romaja: existing.romaja || '' });
          }
          return;
        }

        await mmGate.acquire();
        try {
          const q = normalizeForDumbEngines(rawText).slice(0, 480);
          const srcLang = detectSourceLangForMyMemory(rawText);
          const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(q)}&langpair=${srcLang}|tr`;
          const res = await fetchWithTimeout(url, {}, 10000);
          if (!res.ok) {
            mmLastError = `HTTP ${res.status}`;
            throw new Error(mmLastError);
          }
          const json = await res.json();

          if (Number(json?.responseStatus) !== 200) {
            mmLastError = json?.responseDetails || 'MyMemory kota/limit';
            throw new Error(mmLastError);
          }

          const trLine = (json?.responseData?.translatedText || '').trim();
          const fixedTr = fixGluedWords(forcePerfectTurkish(trLine));

          // (V44) reject obviously glued MyMemory output instead of caching/showing it
          if (trLine && normalize(trLine) !== normalize(rawText) && !looksGluedTranslation(rawText, fixedTr)) {
            mmConsecutiveFailures = 0;
            mmGloballyDownUntil = 0;
            mmBackoffStage = 0;
            const existing = cache.get(rawText) || {};
            cache.set(rawText, {
              tr: fixedTr,
              romaja: existing.romaja || ''
            });
          } else {
            markFailed(rawText);
          }
        } catch (e) {
          mmLastError = e?.name === 'AbortError' ? 'zaman aşımı (10sn)' : (mmLastError || e?.message || String(e));
          mmConsecutiveFailures++;
          if (mmConsecutiveFailures >= MM_FAIL_THRESHOLD && mmGloballyDownUntil <= Date.now()) {
            const waitMs = MM_BACKOFF_STEPS_MS[Math.min(mmBackoffStage, MM_BACKOFF_STEPS_MS.length - 1)];
            warn(`MyMemory tekrar tekrar başarısız oluyor (${mmLastError}) - ${Math.round(waitMs / 1000)}sn bekleniyor`);
            mmGloballyDownUntil = Date.now() + waitMs;
            mmBackoffStage++;
            saveBackoffState();
          }
          markFailed(rawText);
        } finally {
          mmGate.release();
        }
      }));

      saveCache();
      updateDOMWithCache();

      if (ci < chunks.length - 1) await sleep(MM_CHUNK_PAUSE_MS);
    }
  }

  function prioritizeByActive(lines, allOrdered, activeText) {
    if (!activeText) return lines;
    const activeIdx = allOrdered.indexOf(activeText);
    if (activeIdx === -1) return lines;
    const ahead = [];
    const behind = [];
    lines.forEach(l => {
      const idx = allOrdered.indexOf(l);
      if (idx === -1 || idx >= activeIdx) ahead.push(l); else behind.push(l);
    });
    return ahead.concat(behind);
  }

  async function processQueue(allVisibleLines, activeText) {
    const now = Date.now();
    let missing = allVisibleLines.filter(t =>
      !cache.has(t) && !inFlight.has(t) && (failedUntil.get(t) || 0) <= now
    );
    if (missing.length === 0) return;

    missing = prioritizeByActive(missing, allVisibleLines, activeText);
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
          await translateWithGTXPerLine(prioritizeByActive(leftover, allVisibleLines, activeText));
        }

        let stillMissing = group.filter(l => {
          const c = cache.get(l);
          return !c || !c.tr;
        });
        stillMissing = prioritizeByActive(stillMissing, allVisibleLines, activeText);
        if (stillMissing.length > 0 && Date.now() >= mmGloballyDownUntil) {
          await translateWithMyMemoryPerLine(stillMissing);
        }
      }

      if (needsRomajaRefetch.size > 0 && Date.now() >= gtxGloballyDownUntil) {
        const toFetch = Array.from(needsRomajaRefetch).filter(l => {
          const c = cache.get(l);
          return c && !c.romaja;
        });
        needsRomajaRefetch.clear();
        if (toFetch.length > 0) {
          await translateRomajaOnlyWithGTX(toFetch);
        }
      }
    } catch (e) {
      err('processQueue beklenmedik hata:', e);
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
      const reasons = [
        hasKeys && geminiLastError ? `Gemini: ${geminiLastError}` : null,
        gtxLastError ? `Translate: ${gtxLastError}` : null,
        mmLastError ? `MyMemory: ${mmLastError}` : null
      ].filter(Boolean).join(' | ');
      btn.title = `Tüm çeviri motorları şu anda kullanılamıyor - ${reasons || 'sebep henüz kaydedilmedi'} - yaklaşık ${waitSec}sn sonra otomatik tekrar denenecek`;
    } else if (geminiDown && (gtxDown || mmDown)) {
      btn.title = `Gemini şu an kullanılamıyor (${geminiLastError || 'geçici'}), kalan yedek motorla devam ediliyor`;
    } else if (geminiDown) {
      btn.title = `Gemini şu an kullanılamıyor (${geminiLastError || 'geçici'}) - geçici olarak sadece yedek (ücretsiz) motorlar kullanılıyor`;
    } else if (gtxDown || mmDown) {
      const which = gtxDown ? 'Google Translate' : 'MyMemory';
      const reason = gtxDown ? gtxLastError : mmLastError;
      btn.title = `${which} şu anda geçici olarak kullanılamıyor (${reason || 'rate-limit'}) - diğer motorlar devrede`;
    } else {
      btn.title = hasKeys
        ? `God Mode V47 (${geminiApiKeys.length} Gemini anahtarı tanımlı - sağ tık + OK: anahtarları düzenle VE TÜM ÇEVİRİLERİ SIFIRLA)`
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
      try {
        isEnabled = !isEnabled;
        localStorage.setItem('spicy_tr_enabled', isEnabled);
        applyEnabledClass();
        refreshToggleButtonVisual(btn);
        triggerRecalc();
      } catch (e) {
        err('Toggle butonu hata verdi:', e);
      }
    };

    // (V45) CRITICAL FIX: window.prompt()/confirm() DO NOT WORK inside
    // Spotify's CEF (Chromium Embedded Framework) runtime - calling them
    // does not show any dialog at all, they just silently do nothing /
    // return immediately. This is why right-click+OK looked like it did
    // literally nothing: the prompt() call for entering keys never
    // produced a visible box to type into in the first place, on ANY
    // version of this script, including V44 and everything before it.
    // Fixed by building a real on-screen panel with Spicetify.PopupModal
    // (Spicetify's own supported modal API) instead of prompt()/confirm().
    function applyNewKeysAndFullReset(rawInput) {
      geminiApiKeys = Array.from(new Set(
        rawInput.split(/[,\n]+/).map(k => k.trim()).filter(k => k.length > 10)
      ));
      try { localStorage.setItem(GEMINI_KEYS_STORAGE, JSON.stringify(geminiApiKeys)); } catch (e2) {}

      geminiGloballyDownUntil = 0; geminiBackoffStage = 0; geminiLastError = '';
      gtxGloballyDownUntil = 0; gtxBackoffStage = 0; gtxConsecutiveFailures = 0; gtxLastError = '';
      mmGloballyDownUntil = 0; mmBackoffStage = 0; mmConsecutiveFailures = 0; mmLastError = '';
      deadModels.clear();
      failedUntil.clear();
      inFlight.clear();
      needsRomajaRefetch.clear();
      saveBackoffState();

      // THE ACTUAL CACHE FIX (from V44): wipe the translation cache so
      // nothing stale survives the reset.
      cache.clear();
      try { localStorage.removeItem(STORAGE_CACHE_KEY); } catch (e4) {}
      saveCache();

      document.querySelectorAll('#SpicyLyricsPage .spicy-tr-box').forEach(el => el.remove());
      refreshToggleButtonVisual(btn);
      triggerMultiStageScan();
      try { Spicetify.showNotification?.('Anahtarlar kaydedildi, önbellek temizlendi - yeniden çevriliyor...'); } catch (e5) {}
    }

    function openKeySettingsModal() {
      if (!Spicetify?.PopupModal?.display) {
        // Extremely old/unsupported Spicetify build without PopupModal -
        // last-resort fallback (may not show anything, but at least we tried).
        try {
          const fallbackInput = prompt('Gemini API anahtarlarınızı girin (virgülle ayırın):', geminiApiKeys.join(', '));
          if (fallbackInput !== null) applyNewKeysAndFullReset(fallbackInput);
        } catch (eFallback) {
          err('PopupModal yok ve prompt() de çalışmadı, anahtar girişi yapılamıyor:', eFallback);
        }
        return;
      }

      const wrap = document.createElement('div');
      wrap.style.display = 'flex';
      wrap.style.flexDirection = 'column';
      wrap.style.gap = '12px';
      wrap.style.minWidth = '360px';

      const label = document.createElement('div');
      label.textContent = 'Gemini API anahtarınızı/anahtarlarınızı girin (birden fazlaysa virgülle ayırın - her anahtarın kendi günlük kotası var, AMA SADECE farklı Google hesaplarındansa):';
      label.style.fontSize = '13px';
      label.style.lineHeight = '1.4';
      wrap.appendChild(label);

      const textarea = document.createElement('textarea');
      textarea.value = geminiApiKeys.join(', ');
      textarea.placeholder = 'AIzaSy... , AIzaSy... , ...';
      textarea.style.width = '100%';
      textarea.style.minHeight = '70px';
      textarea.style.boxSizing = 'border-box';
      textarea.style.background = 'rgba(255,255,255,0.08)';
      textarea.style.color = '#fff';
      textarea.style.border = '1px solid rgba(255,255,255,0.25)';
      textarea.style.borderRadius = '4px';
      textarea.style.padding = '8px';
      textarea.style.fontFamily = 'monospace';
      textarea.style.fontSize = '12px';
      wrap.appendChild(textarea);

      const warnText = document.createElement('div');
      warnText.style.fontSize = '12px';
      warnText.style.opacity = '0.75';
      warnText.textContent = cache.size > 0
        ? `Kaydet'e bastığınızda önbellekteki ${cache.size} satırlık çeviri TAMAMEN SİLİNİR ve görünen şarkılar yeniden çevrilir (gerçek API/istek kullanımı demektir).`
        : `Önbellek şu an boş - kaydettiğinizde yeni anahtarlarla direkt çeviriye başlanacak.`;
      wrap.appendChild(warnText);

      const btnRow = document.createElement('div');
      btnRow.style.display = 'flex';
      btnRow.style.gap = '8px';
      btnRow.style.justifyContent = 'flex-end';
      btnRow.style.marginTop = '4px';

      const mkBtn = (text, primary) => {
        const b = document.createElement('button');
        b.textContent = text;
        b.style.padding = '8px 16px';
        b.style.borderRadius = '500px';
        b.style.border = 'none';
        b.style.cursor = 'pointer';
        b.style.fontWeight = '700';
        b.style.fontSize = '13px';
        b.style.background = primary ? '#1db954' : 'rgba(255,255,255,0.1)';
        b.style.color = primary ? '#000' : '#fff';
        return b;
      };

      const cancelBtn = mkBtn('İptal', false);
      cancelBtn.onclick = () => Spicetify.PopupModal.hide();

      const saveBtn = mkBtn('Kaydet ve Sıfırla', true);
      saveBtn.onclick = () => {
        try {
          applyNewKeysAndFullReset(textarea.value);
        } catch (eSave) {
          err('Anahtar kaydetme/sıfırlama hata verdi:', eSave);
        } finally {
          Spicetify.PopupModal.hide();
        }
      };

      btnRow.appendChild(cancelBtn);
      btnRow.appendChild(saveBtn);
      wrap.appendChild(btnRow);

      Spicetify.PopupModal.display({
        title: 'Spicy Lyrics - Gemini API Anahtarları',
        content: wrap
      });
    }

    btn.oncontextmenu = (e) => {
      e.preventDefault();
      try {
        openKeySettingsModal();
      } catch (err2) {
        err('Sağ tık menüsü hata verdi:', err2);
      }
    };
    controls.appendChild(btn);
  }

  function scanLines() {
    applyEnabledClass();
    injectToggleButton();
    const lineEls = Array.from(document.querySelectorAll('#SpicyLyricsPage .line:not(.musical-line)'));
    const allVisibleTexts = [];
    let hasMissing = false;
    let activeText = null;

    lineEls.forEach(lineEl => {
      const text = getCleanText(lineEl);
      if (!text || text === '•••') return;
      if (looksTurkish(text)) return; // zaten Türkçe - çeviriye hiç gerek yok

      if (!allVisibleTexts.includes(text)) {
        allVisibleTexts.push(text);
      }

      if (lineEl.classList.contains('Active') && !activeText) {
        activeText = text;
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
        processQueue(allVisibleTexts, activeText);
      }, 50);
    }
  }
  function safeScanLines() {
    try { scanLines(); } catch (e) { err('scanLines hata verdi:', e); }
  }

  let scanScheduled = false;
  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    setTimeout(() => {
      scanScheduled = false;
      safeScanLines();
    }, 80);
  }

  function triggerMultiStageScan() {
    safeScanLines();
    setTimeout(safeScanLines, 100);
    setTimeout(safeScanLines, 300);
    setTimeout(safeScanLines, 600);
    setTimeout(safeScanLines, 1200);
  }

  if (window._spicyTrObserver) window._spicyTrObserver.disconnect();
  const observer = new MutationObserver(() => {
    try { scheduleScan(); } catch (e) { err('MutationObserver hata verdi:', e); }
  });
  window._spicyTrObserver = observer;
  observer.observe(document.body, { childList: true, subtree: true });

  const scrollHandler = () => scheduleScan();
  window.addEventListener('scroll', scrollHandler, true);

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

  const songChangeHandler = () => {
    try {
      lastKnownPos = null;
      lastKnownPosAt = null;
      setTimeout(triggerMultiStageScan, 50);
    } catch (e) { err('songchange handler hata verdi:', e); }
  };
  const progressHandler = (event) => {
    try { handleProgress(event?.data); } catch (e) { err('progress handler hata verdi:', e); }
  };

  if (Spicetify?.Player) {
    Spicetify.Player.addEventListener('songchange', songChangeHandler);
    Spicetify.Player.addEventListener('onprogress', progressHandler);
  }

  const watchdogInterval = setInterval(() => {
    try {
      applyEnabledClass();
      if (!document.getElementById('spicy-tr-style')) {
        document.head.appendChild(style);
        log('Stil etiketi kayboldu, yeniden eklendi.');
      }
      saveBackoffState();
      scanLines();
    } catch (e) {
      err('Watchdog turu hata verdi:', e);
    }
  }, 1500);

  window.__spicyTRCleanup = function () {
    try { observer.disconnect(); } catch (e) {}
    try { clearInterval(watchdogInterval); } catch (e) {}
    try { clearTimeout(batchTimer); } catch (e) {}
    try { window.removeEventListener('scroll', scrollHandler, true); } catch (e) {}
    try {
      if (Spicetify?.Player) {
        Spicetify.Player.removeEventListener('songchange', songChangeHandler);
        Spicetify.Player.removeEventListener('onprogress', progressHandler);
      }
    } catch (e) {}
    try { saveBackoffState(); } catch (e) {}
    try { document.getElementById('spicy-tr-style')?.remove(); } catch (e) {}
    try { document.getElementById('spicy-tr-toggle-btn')?.remove(); } catch (e) {}
  };

  triggerMultiStageScan();
})();
