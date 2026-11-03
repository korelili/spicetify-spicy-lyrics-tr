// NAME: Spicy Lyrics AI Translator & Romaja
// AUTHOR: korelili
// VERSION: 49.0.0
// Quality-first lyrics: smaller Gemini requests, lyric context, short-phrase safeguards,
// trustworthy AI-mode display, self-healing fallback cache and honest version diagnostics.
// Preserves saved API keys, translation cache key and existing Spicy Lyrics UI.
// Note: Google Gemini quotas are per project, not per API key.

(function spicyTurkishProV49() {
  const DEBUG = localStorage.getItem('spicy_tr_debug') === 'true'; // Enable in DevTools for diagnosis
  const log = (...args) => { if (DEBUG) console.log('%c[SpicyTR V49]', 'color:#1db954;font-weight:bold', ...args); };
  const warn = (...args) => { if (DEBUG) console.warn('%c[SpicyTR V49]', 'color:#ffae00;font-weight:bold', ...args); };
  const err = (...args) => { if (DEBUG) console.error('%c[SpicyTR V49]', 'color:#ff4b4b;font-weight:bold', ...args); };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  let generationId = 0;
  const activeRequestControllers = new Set();
  function abortOngoingWork() {
    generationId++;
    for (const controller of activeRequestControllers) controller.abort();
    activeRequestControllers.clear();
  }


  async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    activeRequestControllers.add(controller);
    const id = setTimeout(() => controller.abort(), timeoutMs || 10000);
    try {
      return await fetch(url, { ...(options || {}), signal: controller.signal });
    } finally {
      clearTimeout(id);
      activeRequestControllers.delete(controller);
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
  const MODEL_DEAD_LONG_MS = 6 * 60 * 60 * 1000;
  const MODEL_DEAD_QUOTA_DEFAULT_MS = 30 * 60 * 1000;
  const MODEL_DEAD_QUOTA_MAX_MS = 24 * 60 * 60 * 1000;
  const MODEL_CONFIG_COOLDOWN_MS = 10 * 60 * 1000;
  const GEMINI_TIMEOUT_MS = 30000;
  const GEMINI_ATTEMPTS_PER_BATCH = 3; // Avoid 16 failed API calls per lyric batch.
  const GEMINI_BATCH_TIME_BUDGET_MS = 58000; // Do not stall an entire song on timeouts.
  const FALLBACK_UPGRADE_INTERVAL_MS = 3 * 60 * 1000;
  const modelCooldowns = new Map(); // 400 after safe retry: affects model/config, not each key.
  const keyCooldowns = new Map();   // 401/403: affects key, not all models.
  const simpleModels = new Set();   // Models that need a simpler response config.
  let geminiKeyCursor = 0;
  const GEMINI_BACKOFF_STEPS_MS = [30000, 60000, 120000, 180000]; // kept for state compatibility
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
        deadModels: Array.from(deadModels.entries()),
        modelCooldowns: Array.from(modelCooldowns.entries()),
        keyCooldowns: Array.from(keyCooldowns.entries()),
        simpleModels: Array.from(simpleModels)
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
          if (Number.isFinite(until) && until > now) deadModels.set(k, until);
        });
      }
      if (Array.isArray(state.modelCooldowns)) {
        state.modelCooldowns.forEach(([k, until]) => {
          if (Number.isFinite(until) && until > now) modelCooldowns.set(k, until);
        });
      }
      if (Array.isArray(state.keyCooldowns)) {
        state.keyCooldowns.forEach(([k, until]) => {
          if (Number.isFinite(until) && until > now) keyCooldowns.set(k, until);
        });
      }
      if (Array.isArray(state.simpleModels)) {
        state.simpleModels.filter(x => typeof x === 'string').forEach(x => simpleModels.add(x));
      }
      if (geminiGloballyDownUntil > now || gtxGloballyDownUntil > now || mmGloballyDownUntil > now || deadModels.size > 0) {
        log('Önceki oturumdan hâlâ geçerli olan bekleme süreleri geri yüklendi (gerçek limitler tekrar tetiklenmesin diye).');
      }
    } catch (e) {}
  }
  loadBackoffState();

  // Current stable Gemini text models; prefer efficient Flash-Lite for lyrics.
  const GEMINI_MODELS = [
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite',
    'gemini-3.6-flash',
    'gemini-3.8-flash'
  ];

  let isEnabled = localStorage.getItem('spicy_tr_enabled') !== 'false';
  // An accurate but temporarily missing lyric is better than a misleading mistranslation.
  // Applies when Gemini keys exist. Users may opt into GTX/MyMemory in settings.
  const QUALITY_MODE_KEY = 'spicy_tr_quality_first_v49';
  let qualityMode = localStorage.getItem(QUALITY_MODE_KEY) !== 'false';
  let batchTimer = null;

  const GEMINI_KEYS_STORAGE = 'spicy_tr_gemini_keys';
  function keyFp(key) {
    return (key || '').trim().slice(-6);
  }
  let geminiApiKeys = [];
  try {
    const storedKeys = JSON.parse(localStorage.getItem(GEMINI_KEYS_STORAGE) || '[]');
    if (Array.isArray(storedKeys)) {
      geminiApiKeys = Array.from(new Set(storedKeys.filter(k => typeof k === 'string' && k.trim().length > 10).map(k => k.trim())));
    }
  } catch (e) {}
  const legacyKey = localStorage.getItem('spicy_tr_gemini_key');
  if (legacyKey && legacyKey.trim().length > 10 && !geminiApiKeys.includes(legacyKey.trim())) {
    geminiApiKeys.push(legacyKey.trim());
    try { localStorage.setItem(GEMINI_KEYS_STORAGE, JSON.stringify(geminiApiKeys)); } catch (e) {}
  }
  localStorage.removeItem('spicy_tr_gemini_key');

  const MAX_LINES_PER_GEMINI_CALL = 8;
  const GEMINI_MAX_OUTPUT_TOKENS = 4096;

  // No raw API keys, even a short hash, are persisted in cache/backoff keys.
  // A stable (non-cryptographic) fingerprint avoids last-six-character collisions.
  function comboId(apiKey, model) {
    let h = 2166136261;
    for (const ch of apiKey) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
    return `${h >>> 0}::${model}`;
  }
  function keyId(apiKey) { return comboId(apiKey, 'key'); }
  // Migrate active V47 cooldown entries without changing users' saved keys.
  for (const model of GEMINI_MODELS) for (const key of geminiApiKeys) {
    const oldId = `${keyFp(key)}::${model}`;
    const until = deadModels.get(oldId) || 0;
    if (until > Date.now()) {
      const newId = comboId(key, model);
      deadModels.set(newId, Math.max(deadModels.get(newId) || 0, until));
    }
    deadModels.delete(oldId);
  }
  function isGeminiComboReady(key, model, now = Date.now()) {
    return (deadModels.get(comboId(key, model)) || 0) <= now &&
      (keyCooldowns.get(keyId(key)) || 0) <= now &&
      (modelCooldowns.get(model) || 0) <= now;
  }
  function nextGeminiAvailableAt() {
    if (geminiApiKeys.length === 0) return 0;
    const now = Date.now();
    let earliest = Infinity;
    for (const model of GEMINI_MODELS) for (const key of geminiApiKeys) {
      const next = Math.max(deadModels.get(comboId(key, model)) || 0,
        keyCooldowns.get(keyId(key)) || 0, modelCooldowns.get(model) || 0);
      if (next <= now) return now;
      earliest = Math.min(earliest, next);
    }
    return earliest === Infinity ? 0 : earliest;
  }
  function syncGeminiCooldown() {
    // V47 stored artificial global backoff; do not let it outlive real cooldowns.
    const next = nextGeminiAvailableAt();
    geminiGloballyDownUntil = next > Date.now() ? next : 0;
    geminiBackoffStage = 0;
    return geminiGloballyDownUntil;
  }
  function canUpgradeFallback(text, now = Date.now()) {
    const item = cache.get(text);
    return geminiApiKeys.length > 0 && item &&
      (!item.tr || ['gtx', 'mymemory', 'legacy', 'glossary'].includes(item.source)) &&
      (item.nextGeminiAt || 0) <= now && nextGeminiAvailableAt() <= now;
  }

  function markFailed(text, cooldownMs) {
    failedUntil.set(text, Date.now() + (cooldownMs || FAILURE_COOLDOWN_MS));
  }

  function saveCache() {
    try {
      // In AI mode, never persist an untrusted machine translation as if it were final.
      // Keep romanization, Gemini lyrics and curated idioms across launches.
      const entries = Array.from(cache.entries()).map(([k, v]) => {
        if (!v || (!v.tr && !v.romaja)) return null;
        if (geminiApiKeys.length && !['gemini', 'glossary'].includes(v.source)) {
          return v.romaja ? [k, { romaja: v.romaja, tr: '', source: 'romanization' }] : null;
        }
        return [k, v];
      }).filter(Boolean).slice(-6000);
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
    if (trTokens.some(t => t.replace(/[^a-zçğıöşüA-ZÇĞİÖŞÜ]/g, '').length > 22)) return true;
    return false;
  }

  function repairCache() {
    let fixed = 0, purged = 0, reformalFixed = 0, turkishPurged = 0, gluedPurged = 0;
    for (const [rawLine, data] of Array.from(cache.entries())) {
      if (!data) continue;
      if (data.tr && !data.source) {
        data.source = 'legacy';
        data.nextGeminiAt = 0;
        cache.set(rawLine, data);
        reformalFixed++;
      }

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

  // V49: Never rewrite suffixes with blanket regexes; they mutated valid Turkish
  // nouns/verbs and silently degraded both AI and fallback translations.
  function forcePerfectTurkish(text) {
    if (!text) return '';
    const t = String(text).replace(/\s+/g, ' ').trim();
    return t ? t[0].toLocaleUpperCase('tr-TR') + t.slice(1) : '';
  }

  // Very small, language-generic colloquial safeguard for recurring short lyrics.
  // This is NOT a whole-song hardcoded translation database. Gemini supersedes it.
  const SAFE_COLLOQUIAL_PHRASES = new Map([
    ['talk to me', 'Benimle konuş'],
    ['tell me', 'Söyle bana'],
    ['tell me whats on your mind', 'Aklından geçenleri söyle bana'],
    ['whats on your mind', 'Aklından ne geçiyor'],
    ['here i am baby', 'İşte buradayım, bebeğim'],
    ['well here i am baby', 'İşte buradayım, bebeğim'],
    ['if you want it', 'İstersen']
  ]);
  function cleanPhrase(s) {
    return String(s || '').toLowerCase().replace(/['’‘]/g, '')
      .replace(/[.,!?;:()"'\-]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function getSafeColloquialTranslation(rawLine) {
    const phrases = String(rawLine || '').split(/\s*,\s*/).map(cleanPhrase);
    if (!phrases.length || phrases.some(p => !SAFE_COLLOQUIAL_PHRASES.has(p))) return '';
    // A very long repeated ad-lib is intentionally not forced into a fixed phrase.
    if (phrases.length > 5) return '';
    return phrases.map(p => SAFE_COLLOQUIAL_PHRASES.get(p)).join(', ');
  }
  function isUsableTranslation(original, translated) {
    if (!translated || normalize(original) === normalize(translated)) return false;
    if (looksGluedTranslation(original, translated)) return false;
    if (/<[^>]*>|&(?:#\d+|[a-z]+);/i.test(translated)) return false;
    if (cleanPhrase(original).includes('talk to me') && /konuşma cihaz/i.test(translated)) return false;
    return true;
  }

  // Google quota errors provide RetryInfo.retryDelay (seconds) and/or a
  // human-readable retry interval. Respect the real duration, if available.
  function parseRetryDelayMs(errJson, bodyMsg, retryAfter) {
    const details = errJson?.error?.details;
    if (Array.isArray(details)) {
      for (const d of details) {
        const raw = d?.retryDelay;
        if (typeof raw === 'string' && /^\d+(?:\.\d+)?s$/.test(raw.trim())) {
          const ms = Math.ceil(Number.parseFloat(raw) * 1000);
          if (Number.isFinite(ms) && ms > 0) return ms;
        }
      }
    }
    if (typeof retryAfter === 'string' && retryAfter.trim()) {
      const numeric = Number(retryAfter);
      if (Number.isFinite(numeric) && numeric > 0) return Math.ceil(numeric * 1000);
      const timestamp = Date.parse(retryAfter);
      if (Number.isFinite(timestamp) && timestamp > Date.now()) return timestamp - Date.now();
    }
    const m = /retry in\s+(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+(?:\.\d+)?)\s*m)?\s*(?:(\d+(?:\.\d+)?)\s*s)?/i.exec(bodyMsg || '');
    if (m && (m[1] || m[2] || m[3])) {
      const ms = Math.ceil((Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0)) * 1000);
      if (Number.isFinite(ms) && ms > 0) return ms;
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
    const marker = `${data.tr || ''}\u0000${data.romaja || ''}\u0000${data.source || ''}\u0000${qualityMode ? 'strict' : 'all'}`;
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

    const isTrusted = data.source === 'gemini' || data.source === 'glossary';
    const showTr = !qualityMode || geminiApiKeys.length === 0 || isTrusted;
    if (showTr && data.tr && data.tr.toLowerCase() !== rawText.toLowerCase()) {
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
    if (!Array.isArray(parsed) || parsed.length !== expectedCount ||
        !parsed.every(v => v && typeof v === 'object' && typeof v.tr === 'string')) return null;
    return parsed;
  }

  async function translateChunkWithGemini(chunkLines, allSongLines, epoch) {
    const songTitle = Spicetify?.Player?.data?.item?.name || 'Unknown Song';
    const artist = Spicetify?.Player?.data?.item?.artists?.[0]?.name || 'Unknown Artist';
    // Keep context small to avoid 30-line requests timing out, but include surrounding lyrics.
    const firstIndex = Math.max(0, allSongLines.indexOf(chunkLines[0]));
    const endIndex = Math.max(firstIndex, allSongLines.indexOf(chunkLines[chunkLines.length - 1]));
    const contextLinesText = allSongLines.slice(Math.max(0, firstIndex - 5), endIndex + 6)
      .map(l => `- ${l}`).join('\n').slice(0, 3500);
    const targetLinesText = chunkLines.map((l, i) => `${i + 1}. ${l}`).join('\n');
    const prompt = `You are a professional English/Korean/Japanese/Chinese/Thai to Turkish song lyric localizer.
Song: ${songTitle} — ${artist}

Surrounding lyrics (context only; do not translate these as extra lines):
${contextLinesText}

Translate EXACTLY these ${chunkLines.length} numbered lines, preserving their order:
${targetLinesText}

Translate the meaning, not individual dictionary words. Write natural, colloquial, idiomatic,
flowing Turkish as in a professionally localized song. Address the listener using informal "sen",
never formal "siz". Infer the speaker, addressee, tense, implied verbs and line fragments from
context. Preserve metaphors, sexual implications, humor, slang and intensity without sanitizing.
Avoid stiff literalism and nonsensical sound-alikes. For example:
"Talk to me" means "Benimle konuş", NEVER "Konuşma cihazı".
"Tell me what's on your mind" means "Aklından geçenleri söyle bana".
"You say you want a good time" means "Güzel vakit geçirmek istediğini söylüyorsun".
"That's what I like" means "Benim sevdiğim şey de bu" (not an awkward dictionary phrase).
"Silk sheets and diamonds, all white" means both sheets and diamonds are white; keep the imagery.
If a line is grammatically incomplete, translate it naturally as part of its context.
Don't insert new details or reverse the meaning. Never replace explicit speech with euphemisms.
For Hangul/Kanji/Hiragana/Katakana/Thai/Cyrillic etc, also supply readable, space-separated
Latin romanization in "rom". For Latin-script lines, "rom" must be "".
Only return a JSON array of EXACTLY ${chunkLines.length} objects; each {"tr":"...","rom":"..."},
in the same order. No markdown, explanations or extra objects.`;

    let lastError = new Error('Gemini kombinasyonları şu an kullanılamıyor');
    const keyCount = geminiApiKeys.length;
    if (keyCount === 0) throw lastError;
    // Rotate starting key between batches. Model order is cost-conscious.
    const startKey = geminiKeyCursor++ % keyCount;
    const batchStarted = Date.now();
    let attempted = 0;
    const requestBody = (simple) => ({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        // No temperature override: current Gemini 3.x guidance prefers model defaults.
        maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS,
        responseMimeType: 'application/json',
        ...(!simple ? { responseSchema: {
          type: 'ARRAY',
          items: { type: 'OBJECT', properties: {
            rom: { type: 'STRING' }, tr: { type: 'STRING' }
          }, required: ['rom', 'tr'] }
        }} : {})
      }
    });

    for (const model of GEMINI_MODELS) {
      for (let j = 0; j < keyCount; j++) {
        if (epoch !== generationId || !isEnabled) throw new Error('İstek iptal edildi');
        if (attempted >= GEMINI_ATTEMPTS_PER_BATCH ||
            Date.now() - batchStarted >= GEMINI_BATCH_TIME_BUDGET_MS) break;
        const apiKey = geminiApiKeys[(startKey + j) % keyCount];
        const id = comboId(apiKey, model);
        if (!isGeminiComboReady(apiKey, model)) continue;
        attempted++;
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
        let simple = simpleModels.has(model);
        try {
          let response;
          let errJson = null;
          let bodyMsg = '';
          let usedSimpleRetry = false;
          for (;;) {
            response = await fetchWithTimeout(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey.trim() },
              body: JSON.stringify(requestBody(simple))
            }, GEMINI_TIMEOUT_MS);
            if (epoch !== generationId) throw new Error('İstek iptal edildi');
            if (response.ok) break;
            errJson = null; bodyMsg = '';
            try {
              errJson = await response.json();
              bodyMsg = String(errJson?.error?.message || '').slice(0, 500);
            } catch (e) { /* keep HTTP status even if error body isn't JSON */ }
            // If the schema/parameters are unsupported, retry ONCE without
            // schema/thinking config. Do not waste all keys on the same 400.
            if (response.status === 400 && !simple && !usedSimpleRetry) {
              simple = true;
              usedSimpleRetry = true;
              warn(`${model}: şemalı istek 400 döndürdü; sade JSON isteği bir kez deneniyor.`);
              continue;
            }
            break;
          }
          if (!response.ok) {
            const status = response.status;
            geminiLastError = `${model} (...${keyFp(apiKey)}): HTTP ${status} ${bodyMsg}`;
            const now = Date.now();
            if (status === 429) {
              const retryMs = parseRetryDelayMs(errJson, bodyMsg, response.headers?.get?.('Retry-After'));
              const daily = /(?:per day|daily|requests per day|RPD|per_day)/i.test(bodyMsg);
              const wait = Math.min(retryMs || (daily ? MODEL_DEAD_LONG_MS : MODEL_DEAD_QUOTA_DEFAULT_MS), MODEL_DEAD_QUOTA_MAX_MS);
              deadModels.set(id, now + Math.max(1000, wait));
              warn(`${model} (...${keyFp(apiKey)}): 429, ${formatDuration(wait)} bekleme.`);
            } else if (status === 404) {
              deadModels.set(id, now + MODEL_DEAD_LONG_MS);
            } else if (status === 401 || status === 402 ||
                ((status === 400 || status === 403) &&
                  /(?:api[_ -]?key[_ -]?invalid|invalid api key|api key not valid|permission.*api key|key was reported as invalid)/i.test(bodyMsg))) {
              // A truly invalid key affects all models; a model-tier 403 does not.
              keyCooldowns.set(keyId(apiKey), now + MODEL_DEAD_LONG_MS);
            } else if (status === 403) {
              // Model may be unavailable for this tier, while other models work.
              deadModels.set(id, now + MODEL_DEAD_LONG_MS);
            } else if ([400, 422, 501].includes(status)) {
              // A malformed request is not evidence that every API key is bad.
              // Pause this model, keep trying other models; next song can retry.
              modelCooldowns.set(model, now + MODEL_CONFIG_COOLDOWN_MS);
            } else {
              deadModels.set(id, now + MODEL_DEAD_SHORT_MS);
            }
            saveBackoffState();
            lastError = new Error(geminiLastError);
            continue;
          }
          if (simple) simpleModels.add(model);
          const json = await response.json();
          // Some Gemini responses contain thought/metadata parts before text.
          const rawOutput = (json?.candidates?.[0]?.content?.parts || [])
            .filter(p => !p?.thought && typeof p?.text === 'string')
            .map(p => p.text).join('');
          const parsed = parseGeminiJsonArray(rawOutput, chunkLines.length);
          if (!parsed) throw new Error(`Gemini JSON geçersiz / satır sayısı uyuşmuyor (finishReason=${json?.candidates?.[0]?.finishReason || 'unknown'})`);
          if (epoch !== generationId) throw new Error('İstek iptal edildi');

          chunkLines.forEach((rawLine, i) => {
            const item = parsed[i];
            if (!item || typeof item.tr !== 'string' || !item.tr.trim()) return;
            const cleanTr = fixGluedWords(forcePerfectTurkish(item.tr.trim()));
            if (!isUsableTranslation(rawLine, cleanTr)) return;
            let cleanRom = '';
            if (isNonLatin(rawLine)) {
              const romRaw = typeof item.rom === 'string' ? item.rom.trim() : '';
              if (looksGluedRomaja(rawLine, romRaw)) {
                const repaired = splitRepeatingUnit(romRaw);
                if (repaired) cleanRom = repaired;
                else needsRomajaRefetch.add(rawLine);
              } else cleanRom = fixGluedWords(romRaw);
            }
            if (isNonLatin(rawLine) && !cleanRom) cleanRom = cache.get(rawLine)?.romaja || '';
            cache.set(rawLine, { tr: cleanTr, romaja: cleanRom, source: 'gemini' });
            if (isNonLatin(rawLine) && !cleanRom) needsRomajaRefetch.add(rawLine);
          });
          geminiLastError = '';
          modelCooldowns.delete(model);
          deadModels.delete(id);
          saveBackoffState();
          saveCache();
          updateDOMWithCache();
          return chunkLines.filter(l => !cache.get(l)?.tr);
        } catch (e) {
          if (epoch !== generationId) throw e;
          lastError = e;
          geminiLastError = `${model} (...${keyFp(apiKey)}): ${e?.name === 'AbortError' ? 'zaman aşımı' : (e?.message || e)}`;
          if (isGeminiComboReady(apiKey, model)) {
            deadModels.set(id, Date.now() + MODEL_DEAD_SHORT_MS);
            saveBackoffState();
          }
        }
      }
      if (attempted >= GEMINI_ATTEMPTS_PER_BATCH ||
          Date.now() - batchStarted >= GEMINI_BATCH_TIME_BUDGET_MS) break;
    }
    syncGeminiCooldown();
    saveBackoffState();
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

  async function translateWithGTXPerLine(linesToTranslate, epoch) {
    if (epoch !== generationId || !isEnabled) return;
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
          if (epoch !== generationId || !isEnabled) return;
          const adlib = isAdlibPattern(rawText);
          const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=tr&dt=t&dt=rm&q=${encodeURIComponent(normalizeForDumbEngines(rawText))}`;
          const res = await fetchWithTimeout(url, {}, 10000);
          if (!res.ok) {
            gtxLastError = `HTTP ${res.status}`;
            throw new Error(gtxLastError);
          }
          const json = await res.json();
          if (epoch !== generationId || !isEnabled) return;

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
          const useTr = !adlib && isUsableTranslation(rawText, fixedTr);
          const gotSomethingNew = useTr || (cleanRomaja && !existing.romaja);

          if (gotSomethingNew) {
            gtxConsecutiveFailures = 0;
            gtxGloballyDownUntil = 0;
            gtxBackoffStage = 0;
            cache.set(rawText, {
              tr: existing.tr || (useTr ? fixedTr : rawText),
              romaja: cleanRomaja || existing.romaja || '',
              source: existing.source || 'gtx',
              nextGeminiAt: existing.nextGeminiAt || (Date.now() + FALLBACK_UPGRADE_INTERVAL_MS)
            });
            if (isNonLatin(rawText) && !cleanRomaja && !existing.romaja) needsRomajaRefetch.add(rawText);
          } else {
            markFailed(rawText);
          }
        } catch (e) {
          if (epoch !== generationId) return;
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

  async function translateRomajaOnlyWithGTX(lines, epoch) {
    if (epoch !== generationId || !isEnabled) return;
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
          if (epoch !== generationId || !isEnabled) return;
          const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=tr&dt=rm&q=${encodeURIComponent(rawText)}`;
          const res = await fetchWithTimeout(url, {}, 10000);
          if (!res.ok) return;
          const json = await res.json();
          if (epoch !== generationId || !isEnabled) return;
          let romaja = '';
          if (Array.isArray(json[0])) {
            json[0].forEach(item => { if (item[3]) romaja += (romaja ? ' ' : '') + item[3]; });
          }
          romaja = romaja.trim();
          if (romaja) {
            const current = cache.get(rawText) || existing;
            cache.set(rawText, { ...current, romaja: fixGluedWords(romaja) });
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

  async function translateWithMyMemoryPerLine(linesToTranslate, epoch) {
    if (epoch !== generationId || !isEnabled) return;
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
            cache.set(rawText, { tr: rawText, romaja: existing.romaja || '',
              source: 'mymemory', nextGeminiAt: Date.now() + FALLBACK_UPGRADE_INTERVAL_MS });
          }
          return;
        }

        await mmGate.acquire();
        try {
          if (epoch !== generationId || !isEnabled) return;
          const q = normalizeForDumbEngines(rawText).slice(0, 480);
          const srcLang = detectSourceLangForMyMemory(rawText);
          const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(q)}&langpair=${srcLang}|tr`;
          const res = await fetchWithTimeout(url, {}, 10000);
          if (!res.ok) {
            mmLastError = `HTTP ${res.status}`;
            throw new Error(mmLastError);
          }
          const json = await res.json();
          if (epoch !== generationId || !isEnabled) return;

          if (Number(json?.responseStatus) !== 200) {
            mmLastError = json?.responseDetails || 'MyMemory kota/limit';
            throw new Error(mmLastError);
          }

          const trLine = (json?.responseData?.translatedText || '').trim();
          const fixedTr = fixGluedWords(forcePerfectTurkish(trLine));

          // (V44) reject obviously glued MyMemory output instead of caching/showing it
          if (isUsableTranslation(rawText, fixedTr)) {
            mmConsecutiveFailures = 0;
            mmGloballyDownUntil = 0;
            mmBackoffStage = 0;
            const existing = cache.get(rawText) || {};
            cache.set(rawText, {
              tr: existing.tr || fixedTr,
              romaja: existing.romaja || '',
              source: existing.source || 'mymemory',
              nextGeminiAt: existing.nextGeminiAt || (Date.now() + FALLBACK_UPGRADE_INTERVAL_MS)
            });
          } else {
            markFailed(rawText);
          }
        } catch (e) {
          if (epoch !== generationId) return;
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
    if (!isEnabled) return;
    const epoch = generationId;
    const now = Date.now();
    let missing = allVisibleLines.filter(t =>
      (!cache.get(t)?.tr || canUpgradeFallback(t, now)) &&
      !inFlight.has(t) && (failedUntil.get(t) || 0) <= now
    );
    if (missing.length === 0) return;
    missing = prioritizeByActive(missing, allVisibleLines, activeText);
    missing.forEach(t => inFlight.add(t));
    try {
      const groups = chunkArray(missing, MAX_LINES_PER_GEMINI_CALL);
      for (const group of groups) {
        if (epoch !== generationId || !isEnabled) return;
        let leftover = group;
        const available = nextGeminiAvailableAt();
        syncGeminiCooldown();
        if (geminiApiKeys.length > 0 && available <= Date.now()) {
          try {
            leftover = await translateChunkWithGemini(group, allVisibleLines, epoch);
          } catch (e) {
            if (epoch !== generationId) return;
            warn('Gemini bu grupta başarısız oldu, yedek çeviri deneniyor:', e?.message || e);
          }
        }
        if (epoch !== generationId || !isEnabled) return;
        // Do not replace usable fallback text with another weaker fallback.
        const needsFallback = leftover.filter(l => !cache.get(l)?.tr);
        for (const rawLine of needsFallback) {
          const safe = getSafeColloquialTranslation(rawLine);
          if (safe && !cache.get(rawLine)?.tr) {
            const existing = cache.get(rawLine) || {};
            cache.set(rawLine, { ...existing, tr: safe, source: 'glossary',
              nextGeminiAt: Date.now() + FALLBACK_UPGRADE_INTERVAL_MS });
          }
        }
        const stillNeedsGTX = needsFallback.filter(l => !cache.get(l)?.tr);
        if (stillNeedsGTX.length > 0 && Date.now() >= gtxGloballyDownUntil) {
          await translateWithGTXPerLine(prioritizeByActive(stillNeedsGTX, allVisibleLines, activeText), epoch);
        }
        if (epoch !== generationId || !isEnabled) return;
        let stillMissing = group.filter(l => !cache.get(l)?.tr);
        stillMissing = prioritizeByActive(stillMissing, allVisibleLines, activeText);
        if (stillMissing.length > 0 && Date.now() >= mmGloballyDownUntil) {
          await translateWithMyMemoryPerLine(stillMissing, epoch);
        }
        // Failed Gemini upgrades must not hammer the API on every scan.
        const earliest = nextGeminiAvailableAt();
        for (const l of group) {
          const item = cache.get(l);
          if (item && (item.source === 'gtx' || item.source === 'mymemory')) {
            item.nextGeminiAt = Math.max(Date.now() + FALLBACK_UPGRADE_INTERVAL_MS, earliest || 0);
          }
        }
      }
      if (epoch !== generationId || !isEnabled) return;
      if (needsRomajaRefetch.size > 0 && Date.now() >= gtxGloballyDownUntil) {
        const toFetch = Array.from(needsRomajaRefetch).filter(l => cache.get(l) && !cache.get(l).romaja);
        needsRomajaRefetch.clear();
        if (toFetch.length > 0) await translateRomajaOnlyWithGTX(toFetch, epoch);
      }
      if (epoch === generationId) saveCache();
    } catch (e) {
      if (epoch === generationId) err('processQueue beklenmedik hata:', e);
    } finally {
      if (epoch === generationId) missing.forEach(t => inFlight.delete(t));
    }
  }

  function refreshToggleButtonVisual(btn) {
    const now = Date.now();
    const hasKeys = geminiApiKeys.length > 0;
    syncGeminiCooldown();
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
        ? `SpicyTR V49 (${geminiApiKeys.length} Gemini anahtarı tanımlı - sağ tık: anahtarları düzenle / Kaydet ve Sıfırla)`
        : 'Sağ tık: Gemini API anahtarı/anahtarları gir (isteğe bağlı, daha iyi çeviri için)';
    }
    btn.title = `[SpicyTR V49${qualityMode && hasKeys ? ' · kalite modu açık' : ''}] ${btn.title}${qualityMode && hasKeys && geminiDown ? ' · Zayıf yedek çeviriler kasıtlı olarak gizleniyor.' : ''}`;
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
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Türkçe çeviri ve romanizasyonu aç/kapat');
    refreshToggleButtonVisual(btn);

    btn.onclick = () => {
      try {
        isEnabled = !isEnabled;
        if (!isEnabled) {
          abortOngoingWork();
          inFlight.clear();
        }
        localStorage.setItem('spicy_tr_enabled', isEnabled);
        applyEnabledClass();
        refreshToggleButtonVisual(btn);
        triggerRecalc();
        if (isEnabled) triggerMultiStageScan();
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
      abortOngoingWork();
      geminiApiKeys = Array.from(new Set(
        rawInput.split(/[,\n]+/).map(k => k.trim()).filter(k => k.length > 10)
      ));
      try { localStorage.setItem(GEMINI_KEYS_STORAGE, JSON.stringify(geminiApiKeys)); } catch (e2) {}

      geminiGloballyDownUntil = 0; geminiBackoffStage = 0; geminiLastError = '';
      gtxGloballyDownUntil = 0; gtxBackoffStage = 0; gtxConsecutiveFailures = 0; gtxLastError = '';
      mmGloballyDownUntil = 0; mmBackoffStage = 0; mmConsecutiveFailures = 0; mmLastError = '';
      deadModels.clear();
      modelCooldowns.clear();
      keyCooldowns.clear();
      simpleModels.clear();
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
      label.textContent = 'Gemini API anahtarlarını virgül veya yeni satırla ayırın. Google kotaları anahtar başına değil proje başınadır; aynı projeye bağlı anahtarlar kotayı paylaşır.';
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

      const qualityLabel = document.createElement('label');
      qualityLabel.style.display = 'flex';
      qualityLabel.style.gap = '9px';
      qualityLabel.style.alignItems = 'flex-start';
      qualityLabel.style.fontSize = '12px';
      const qualityInput = document.createElement('input');
      qualityInput.type = 'checkbox';
      qualityInput.checked = qualityMode;
      qualityLabel.appendChild(qualityInput);
      const qualityText = document.createElement('span');
      qualityText.textContent = 'Kalite modu: Gemini anahtarım varsa yalnızca AI ve güvenilir kısa ifadeleri göster; zayıf GTX/MyMemory çevirilerini gizle (romanizasyon devam eder).';
      qualityLabel.appendChild(qualityText);
      wrap.appendChild(qualityLabel);

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
          qualityMode = qualityInput.checked;
          localStorage.setItem(QUALITY_MODE_KEY, String(qualityMode));
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
    if (!isEnabled) return;
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
        renderSubtitles(lineEl, cache.get(text), text);
      }
      if ((!cache.get(text)?.tr || canUpgradeFallback(text)) &&
          !inFlight.has(text) && (failedUntil.get(text) || 0) <= Date.now()) {
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
    abortOngoingWork();
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