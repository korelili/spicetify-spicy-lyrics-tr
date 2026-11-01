// NAME: Spicy Lyrics AI Translator & Romaja
// AUTHOR: korelili (patched)
// VERSION: 39.0.0 (Glued-romaja repair + ad-lib fallback protection +
//           cache repair pass + persistent backoff + real quota detection)
//
// V39 - WHAT CHANGED AND WHY (direct response to screenshots showing two
// real, confirmed bugs plus a plausible explanation for "dies after ~3
// songs"):
//
// BUG 1 - GLUED ROMANIZATION ("amugeogjeongmamamamamama"):
// Gemini sometimes ignores the "always space romanized words" rule and
// returns the "rom" field as one unbroken lowercase block, especially for
// lines with repeated ad-lib tokens. The old fixGluedWords() only inserted
// a space at a lowercase->UPPERCASE boundary, which never fires on
// all-lowercase romanized Korean, so the bug went straight through to the
// screen. FIX: every "rom" is now validated. A clean whole-string repeat
// ("mamamamamama") is deterministically re-spaced ("ma ma ma ma ma ma").
// Anything else that looks glued (no whitespace, 8+ chars, but the source
// line clearly has 2+ separate words) is DISCARDED instead of cached, and
// the line is queued for a dedicated GTX dt=rm-only re-fetch - that
// endpoint is a straight transliteration call with no "creative ad-lib"
// step, so it doesn't share this failure mode.
//
// BUG 2 - LITERAL AD-LIB MISTRANSLATION ("On&on&on&on yeah" ->
// "Açık&açık&açık evet"): the ad-lib rule ("don't translate a repeated
// vocalization word-by-word") only ever lived in the GEMINI prompt. GTX
// and MyMemory have zero awareness of it, so once Gemini fails for a
// chunk (rate limit, quota, whatever) and a line falls through to them,
// a repeated token gets translated literally and comes out as nonsense.
// FIX: repeated-token/ad-lib lines are now detected before ever being
// sent to GTX/MyMemory for literal translation. Romanization is
// unaffected (transliteration doesn't have this failure mode) - only the
// garbage "tr" output is suppressed.
//
// CACHE REPAIR: both bugs above, once triggered under V33-V38, got cached
// PERMANENTLY (the old code never re-validated a cache hit). V39 runs a
// repair pass over the existing cache on load - and now also on every
// plain right-click + OK - that fixes glued romaja in place and purges
// mistranslated ad-lib entries so they get a clean retranslate. Your
// existing cache isn't thrown away, just corrected.
//
// SHIFT+RIGHT-CLICK REMOVED (per request): plain right-click + OK now
// always does the full reset (clears all cooldown/backoff state) AND runs
// the cache repair pass above. There's no separate "nuclear wipe" option
// anymore - the repair pass fixes corruption without needing to lose the
// whole cache.
//
// REAL QUOTA vs TRANSIENT RATE LIMIT: a Gemini 429 whose error body
// actually says "quota" (a real daily/account limit) now gets a ~3 hour
// cooldown for that key+model instead of the old 60s - retrying a truly
// exhausted quota every minute just burns more of it for nothing. If
// every key dies from a quota error at the same moment, a console note
// suggests checking whether they're all under the same Google account
// (quota is pooled per account, not per key string - only keys from
// genuinely different accounts are independent).
//
// PERSISTENT BACKOFF STATE: cooldown state (which key/model/engine is
// currently "resting") used to live only in memory, so reloading the
// script - which happens on every version swap, like the v36/v37/v38
// testing you were doing - forgot any still-active real rate limit and
// immediately hammered it again. V39 persists this state to localStorage
// (refreshed every watchdog tick) and restores any cooldown that hasn't
// actually expired yet on load.
//
// UNCHANGED from V38 (confirmed not the problem): the single-source-of-
// truth enabled/disabled styling, the watchdog, the singleton guard, the
// idempotent rendering, the persistent translation cache key/contents,
// and the fact that it already only scans/translates while the lyrics
// panel (#SpicyLyricsPage) is actually open.

(function spicyTurkishProV39() {
  const DEBUG = true;
  const log = (...args) => { if (DEBUG) console.log('%c[SpicyTR V39]', 'color:#1db954;font-weight:bold', ...args); };
  const warn = (...args) => { if (DEBUG) console.warn('%c[SpicyTR V39]', 'color:#ffae00;font-weight:bold', ...args); };
  const err = (...args) => { if (DEBUG) console.error('%c[SpicyTR V39]', 'color:#ff4b4b;font-weight:bold', ...args); };
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
  const MODEL_DEAD_SHORT_MS = 60000;              // transient error (rate limit, 5xx)
  const MODEL_DEAD_LONG_MS = 6 * 60 * 60 * 1000;  // 404 = wrong/retired model id
  const MODEL_DEAD_QUOTA_MS = 3 * 60 * 60 * 1000; // real "quota exceeded" 429 - not worth retrying every minute

  const GEMINI_BACKOFF_STEPS_MS = [60000, 120000, 300000, 600000];
  let geminiGloballyDownUntil = 0;
  let geminiBackoffStage = 0;

  const GTX_BACKOFF_STEPS_MS = [30000, 60000, 120000, 240000, 480000, 900000];
  const GTX_FAIL_THRESHOLD = 5;
  let gtxGloballyDownUntil = 0;
  let gtxBackoffStage = 0;
  let gtxConsecutiveFailures = 0;

  const MM_BACKOFF_STEPS_MS = [30000, 60000, 120000, 240000, 480000, 900000];
  const MM_FAIL_THRESHOLD = 5;
  let mmGloballyDownUntil = 0;
  let mmBackoffStage = 0;
  let mmConsecutiveFailures = 0;

  // --- Persist cooldown/backoff state across script reloads. Without
  // this, re-installing/testing a new version (or Spotify restarting)
  // forgets a real, still-active rate limit and immediately re-triggers
  // it - very likely part of why things looked worse the longer a test
  // session went on. Refreshed periodically by the watchdog; restored
  // here on load, but only if it hasn't actually expired yet. ---
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

  // Repairs data corrupted by the two bugs described in the header
  // comment. Both got cached permanently under pre-V39 code since nothing
  // ever re-validated a cache hit. This fixes what it safely can in place
  // and purges what it can't, so those specific lines get a clean
  // retranslate next time they're seen. Runs once on load, and again any
  // time you right-click the toggle + OK.
  function repairCache() {
    let fixed = 0, purged = 0;
    for (const [rawLine, data] of Array.from(cache.entries())) {
      if (!data) continue;
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

      if (changed) cache.set(rawLine, data);
    }
    if (fixed || purged) {
      saveCache();
      log(`Cache onarımı: ${fixed} satırın romanizasyonu düzeltildi, ${purged} hatalı ad-lib çevirisi silindi (yeniden çevrilecek).`);
    }
  }
  repairCache(); // helper functions below are hoisted, safe to call here

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
    return /[^\x00-\x7F\u00A0-\u024F\u1E00-\u1EFF\u2000-\u206F\u2E00-\u2E7F\s]/u.test(text);
  }

  function normalize(s) {
    return (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  // Detects a string with NO whitespace that is a clean repetition of one
  // short unit (e.g. "mamamamamama" -> "ma" x6) and reconstructs it with
  // spaces between each repeat. Returns null for anything that isn't a
  // pure, confident repeat - ordinary glued text is left to
  // looksGluedRomaja()/the discard-and-refetch path instead of being
  // guessed at here.
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

  // A "rom" output is suspicious when it has NO internal whitespace at
  // all but the source line clearly has multiple separate words/syllable
  // blocks - a correct romanization of a multi-word line should also
  // have multiple words.
  function looksGluedRomaja(originalLine, rom) {
    if (!rom || /\s/.test(rom)) return false;
    if (rom.length < 8) return false;
    const tokens = originalLine.trim().split(/\s+/).filter(Boolean);
    return tokens.length >= 2;
  }

  // A line is a "repeated ad-lib" when most of its space/&-separated
  // tokens are the same word repeated (e.g. "마 마 마 마 마 마",
  // "On&on&on&on yeah"). These should never be sent through a literal
  // word-by-word translator (GTX/MyMemory have no concept of "treat this
  // as one vocal unit" - only Gemini's prompt does).
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

  // Safety net for ordinary glued output from the dumb engines (GTX used
  // to only fix case-transition boundaries). Now also tries the
  // repeating-unit repair first, which is the more common real-world case.
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

  const GEMINI_MODELS = [
    'gemini-2.5-flash',
    'gemini-3-flash-preview',
    'gemini-3.1-flash-lite',
    'gemini-2.5-flash-lite'
  ];

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
3. REPEATED/STYLIZED AD-LIBS: if a line is a rhythmic ad-lib or vocalization using repetition (e.g. "On&on&on&on oh", "La la la la"), do NOT translate each repeated token as a separate literal word for the "tr" field - treat the whole repeated pattern as one vocal/rhythmic unit and either keep it as a natural-sounding vocal ad-lib or give one single natural Turkish equivalent for the whole thing, never a word-by-word literal mess.
3b. FEELING OVER LITERAL WORDS: you are localizing a song for a Turkish listener to FEEL, not producing a dictionary crib. Prefer the natural way a Turkish songwriter/poet would phrase the same image over a flat word-for-word rendering - e.g. for an intensified color/quality, prefer Turkish's own reduplicated intensifiers where they fit naturally ("masmavi" rather than "çok mavi", "bembeyaz" rather than "çok beyaz", "güpegündüz" for broad daylight), and generally favor an evocative, idiomatic phrase over a technically-accurate-but-stiff one, as long as the core meaning is preserved.
3c. TITLE / HOOK LINES: a line that IS or closely matches the song's own title (given above as "Song:"), or a repeated stylized hook built from mixed fragments, will not translate sensibly word-for-word. For these, give a short, natural-sounding Turkish phrase that captures the vibe/mood of the hook instead, the way a Turkish cover or localized title would read.
4. ROMANIZATION IS MANDATORY for every line not already in Latin script - NEVER leave "rom" empty for Korean, Japanese, Chinese, Thai, or any other non-Latin script, even when a perfectly clean version is hard to produce. Always give your best simple phonetic attempt instead of skipping it. (Only use an empty string for "rom" when the line is ALREADY in Latin script.)
   STYLE: keep it casual and readable, the way an ordinary person types out pronunciation online. Standard single accent marks from an established system are fine. AVOID heavy academic/IAST-style transliteration with multiple stacked diacritics per letter.
   SPACING IS MANDATORY AND NON-NEGOTIABLE, EVEN FOR AD-LIBS: always put a space between EVERY romanized word exactly the way the original line's words/tokens are separated - this applies even when rule 3 tells you to compress a repeated ad-lib into one natural phrase for "tr". The "rom" field must still spell out each repeated unit separated by spaces (e.g. source "마 마 마 마 마 마" -> rom "ma ma ma ma ma ma", never "mamamamamama"). NEVER concatenate several words or repeated units into one unbroken string under any circumstance.
5. OUTPUT FORMAT: respond with ONLY a JSON array matching the given schema - exactly ${chunkLines.length} objects, in the same order as the numbered lines above. Each object has "rom" (romanization, or "" if the line is already Latin script) and "tr" (the natural Turkish translation using informal "sen", per rule 1). No extra text, no markdown, no numbering in the output - just the array.`;

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
            try {
              const errJson = await res.clone().json();
              bodyMsg = errJson?.error?.message || '';
            } catch (parseErr) {}
            geminiLastError = `[${model} ...${keyFp(apiKey)}] HTTP ${res.status}${bodyMsg ? ' - ' + bodyMsg : ''}`;

            const isRealQuotaError = res.status === 429 && /quota/i.test(bodyMsg);

            if (res.status === 404) {
              deadModels.set(comboKey, Date.now() + MODEL_DEAD_LONG_MS);
              warn(`Model "${model}" bulunamadı (404, anahtar ...${keyFp(apiKey)}) - muhtemelen kaldırılmış/geçersiz model id, 6 saatliğine devre dışı bırakıldı`);
            } else if (isRealQuotaError) {
              deadModels.set(comboKey, Date.now() + MODEL_DEAD_QUOTA_MS);
              warn(`[${model} ...${keyFp(apiKey)}] Gerçek kota hatası (daily quota) - ${Math.round(MODEL_DEAD_QUOTA_MS / 3600000)} saat boyunca bu kombinasyon denenmeyecek`);
            } else {
              deadModels.set(comboKey, Date.now() + MODEL_DEAD_SHORT_MS);
              warn(`Gemini hatası: ${geminiLastError}`);
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
        }
      }
    }

    const allCombosDead = geminiApiKeys.length === 0 ||
      GEMINI_MODELS.every(model => geminiApiKeys.every(apiKey => (deadModels.get(`${keyFp(apiKey)}::${model}`) || 0) > Date.now()));

    if (allCombosDead) {
      const waitMs = GEMINI_BACKOFF_STEPS_MS[Math.min(geminiBackoffStage, GEMINI_BACKOFF_STEPS_MS.length - 1)];
      if (geminiGloballyDownUntil <= Date.now()) {
        warn(`Tüm Gemini anahtar/model kombinasyonları kullanılamıyor (kota/limit olabilir) - yedek motorlara geçiliyor, ${Math.round(waitMs / 1000)}sn sonra Gemini tekrar denenecek`);
        if (geminiApiKeys.length > 1) {
          warn('Not: birden fazla anahtarın hepsi AYNI ANDA tükendiyse, bunlar muhtemelen aynı Google hesabına ait farklı API anahtarlarıdır (kota hesap bazlı paylaşılıyor olabilir). Gerçekten bağımsız kota için her anahtarın FARKLI bir Google hesabından alınması gerekir.');
        }
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
          // GTX has zero awareness of the ad-lib rule and will mistranslate
          // a repeated token literally (e.g. "On&on&on&on yeah" ->
          // "Açık&açık&açık evet"). Never use its "tr" output for a line
          // matching a repeated ad-lib pattern - romanization is fine
          // (transliteration, not translation, so it's unaffected).
          const useTr = !adlib && trLine && normalize(trLine) !== normalize(rawText);
          const gotSomethingNew = useTr || (cleanRomaja && !existing.romaja);

          if (gotSomethingNew) {
            gtxConsecutiveFailures = 0;
            gtxGloballyDownUntil = 0;
            gtxBackoffStage = 0;
            cache.set(rawText, {
              tr: useTr ? fixGluedWords(forcePerfectTurkish(trLine)) : (existing.tr || rawText),
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

  // Dedicated romanization-only backfill, used when Gemini's "rom" output
  // for a line was rejected as suspiciously glued. GTX's dt=rm is a
  // straight transliteration call with no "creative ad-lib compression"
  // step, so it's the most reliable single source for "just give me the
  // romanization" specifically.
  async function translateRomajaOnlyWithGTX(lines) {
    if (!lines || lines.length === 0) return;
    if (Date.now() < gtxGloballyDownUntil) return; // retried on a later scan

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
          // silent - the line still shows its Turkish translation, it just
          // stays without pronunciation help until a later scan retries
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
        // MyMemory never returns romanization, so for a repeated ad-lib
        // line it can only ever offer a literal (near-certainly wrong)
        // "tr" - not worth the request.
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
          const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(q)}&langpair=auto|tr`;
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
      btn.title = `Gemini şu an kullanılamıyor (${geminiLastError || 'kota/limit'}), kalan yedek motorla devam ediliyor`;
    } else if (geminiDown) {
      btn.title = `Gemini şu an kullanılamıyor (${geminiLastError || 'kota/limit'}) - geçici olarak sadece yedek (ücretsiz) motorlar kullanılıyor`;
    } else if (gtxDown || mmDown) {
      const which = gtxDown ? 'Google Translate' : 'MyMemory';
      const reason = gtxDown ? gtxLastError : mmLastError;
      btn.title = `${which} şu anda geçici olarak kullanılamıyor (${reason || 'rate-limit'}) - diğer motorlar devrede`;
    } else {
      btn.title = hasKeys
        ? `God Mode V39 (${geminiApiKeys.length} Gemini anahtarı tanımlı - sağ tık + OK: anahtarları düzenle, hataları sıfırla ve cache'i onar)`
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

    // Plain right-click + OK now always does a full reset AND repairs the
    // cache - no Shift needed anymore (per request). There's no separate
    // "nuclear wipe" option: the repair pass fixes corruption in place.
    btn.oncontextmenu = (e) => {
      e.preventDefault();
      try {
        const currentValue = geminiApiKeys.join(', ');
        const input = prompt('🌟 Spicy Lyrics V39 🌟\nGemini API anahtarınızı/anahtarlarınızı girin (birden fazlaysa virgülle ayırın - her anahtarın kendi günlük kotası var, AMA SADECE farklı Google hesaplarındansa):', currentValue);
        if (input === null) return;

        geminiApiKeys = Array.from(new Set(
          input.split(/[,\n]+/).map(k => k.trim()).filter(k => k.length > 10)
        ));
        try { localStorage.setItem(GEMINI_KEYS_STORAGE, JSON.stringify(geminiApiKeys)); } catch (e2) {}

        geminiGloballyDownUntil = 0; geminiBackoffStage = 0; geminiLastError = '';
        gtxGloballyDownUntil = 0; gtxBackoffStage = 0; gtxConsecutiveFailures = 0; gtxLastError = '';
        mmGloballyDownUntil = 0; mmBackoffStage = 0; mmConsecutiveFailures = 0; mmLastError = '';
        deadModels.clear();
        failedUntil.clear();
        saveBackoffState();

        repairCache();
        updateDOMWithCache();

        refreshToggleButtonVisual(btn);
        triggerMultiStageScan();
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

  // Watchdog: independent safety net, every 1.5s. Also where backoff state
  // gets persisted periodically (cheap, "good enough" - worst case loses
  // up to 1.5s of state on an abrupt reload).
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
