// NAME: Spicy Lyrics AI Translator & Romaja
// AUTHOR: korelili
// VERSION: 58.0.0
// V58 candidate: contextual Gemini-first, ID-bound results, bounded retries, queue isolation and preserved caches;
// Based on the supplied V54 source; verify locally before publishing over newer Marketplace builds.
// Preserves saved API keys, translation cache key and existing Spicy Lyrics UI.
// Note: Google Gemini quotas are per project, not per API key.

(function spicyTurkishProV58() {
  const DEBUG = localStorage.getItem('spicy_tr_debug') === 'true'; // Enable in DevTools for diagnosis
  const log = (...args) => { if (DEBUG) console.log('%c[SpicyTR V58]', 'color:#1db954;font-weight:bold', ...args); };
  const warn = (...args) => { if (DEBUG) console.warn('%c[SpicyTR V58]', 'color:#ffae00;font-weight:bold', ...args); };
  const err = (...args) => { if (DEBUG) console.error('%c[SpicyTR V58]', 'color:#ff4b4b;font-weight:bold', ...args); };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  let generationId = 0;
  let disposed = false;
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

  const STORAGE_CACHE_KEY = 'spicy_tr_godmode_v57'; // Adopt current Marketplace cache, keep v35 intact.
  let savedCache = {};
  for (const priorKey of ['spicy_tr_godmode_v35', STORAGE_CACHE_KEY]) {
    try {
      const next = JSON.parse(localStorage.getItem(priorKey) || '{}');
      if (next && typeof next === 'object' && !Array.isArray(next)) savedCache = { ...savedCache, ...next };
    } catch (e) { /* Retain successfully read cache entries. */ }
  }

  const cache = new Map(Object.entries(savedCache));
  const inFlight = new Set();
  const needsRomajaRefetch = new Set();
  const failedUntil = new Map();
  const FAILURE_COOLDOWN_MS = 8000;
  const deadModels = new Map();
  const MODEL_DEAD_SHORT_MS = 45000;
  const MODEL_DEAD_LONG_MS = 6 * 60 * 60 * 1000;
  const MODEL_DEAD_QUOTA_DEFAULT_MS = 30 * 60 * 1000;
  const MODEL_DEAD_QUOTA_MAX_MS = 24 * 60 * 60 * 1000;
  const MODEL_CONFIG_COOLDOWN_MS = 10 * 60 * 1000;
  const GEMINI_TIMEOUT_MS = 16000;
  const GEMINI_ATTEMPTS_PER_BATCH = 2; // Avoid consuming every key on repeated failures.
  const GEMINI_BATCH_TIME_BUDGET_MS = 24000;
  const FALLBACK_UPGRADE_INTERVAL_MS = 30 * 60 * 1000;
  const modelCooldowns = new Map(); // 400 after safe retry: affects model/config, not each key.
  const keyCooldowns = new Map();   // 401/403: affects key, not all models.
  const simpleModels = new Set();   // Models that need a simpler response config.
  let geminiKeyCursor = 0;
  const GEMINI_BACKOFF_STEPS_MS = [30000, 60000, 120000, 180000]; // kept for state compatibility
  let geminiGloballyDownUntil = 0;
  let geminiBackoffStage = 0;
  // One shared serial request stream. No artificial 9-second wait; real 429 Retry-After is respected.
  const GEMINI_MIN_START_INTERVAL_MS = 3000; // Controlled pacing; HTTP 429 still authoritative.
  const TRACK_SETTLE_MS = 350;
  const CACHE_QUALITY_VERSION = 51; // Keep existing good Gemini cache entries.
  let nextGeminiRequestAt = 0;
  let lastTrackSwitchAt = Date.now();
  let currentSongId = '';
  let queueRunning = false;
  let queueEpoch = -1;
  const stats = { geminiCalls: 0, geminiSuccess: 0, http429: 0, http503: 0,
    cancelled: 0, trackSwitches: 0, cacheReuse: 0, stalePurged: 0 };
  async function waitForGeminiSlot(epoch) {
    while (Date.now() < nextGeminiRequestAt) {
      if (disposed || epoch !== generationId || !isEnabled) throw new Error('İstek iptal edildi');
      await sleep(Math.min(300, nextGeminiRequestAt - Date.now()));
    }
    if (disposed || epoch !== generationId || !isEnabled) throw new Error('İstek iptal edildi');
    nextGeminiRequestAt = Date.now() + GEMINI_MIN_START_INTERVAL_MS;
    stats.geminiCalls++;
  }
  function trackIdentity() {
    const item = Spicetify?.Player?.data?.item;
    return item?.uri || item?.id || (item?.name ? `${item.name}::${(item.artists || []).map(a => a.name).join(',')}` : '');
  }

  // The old cache used only the raw lyric as its key. That reused translations
  // across unrelated songs, even when the same words had a different subject,
  // idiom or meaning. Keep the same localStorage key, but scope new entries to
  // the Spotify track identity. Old romanization-only entries remain reusable.
  const CACHE_KEY_SEPARATOR = '\u001f';
  const rawCacheGet = Map.prototype.get.bind(cache);
  const rawCacheSet = Map.prototype.set.bind(cache);
  const rawCacheDelete = Map.prototype.delete.bind(cache);
  const rawCacheEntries = Map.prototype.entries.bind(cache);
  function activeCacheTrackId() {
    return currentSongId || trackIdentity() || '__unknown_track__';
  }
  function scopedCacheKey(text, trackId = activeCacheTrackId()) {
    return `${trackId}${CACHE_KEY_SEPARATOR}${String(text)}`;
  }
  cache.get = function (text) {
    const scoped = rawCacheGet(scopedCacheKey(text));
    if (scoped) return scoped;
    const legacy = rawCacheGet(String(text));
    // Preserve romanization from the old cache, but never display an old
    // context-free translation. Curated glossary entries are context-neutral.
    if (legacy && !legacy.tr && legacy.romaja) return legacy;
    if (legacy && legacy.source === 'glossary' && legacy.qualityVersion === CACHE_QUALITY_VERSION) return legacy;
    return undefined;
  };
  cache.set = function (text, value) {
    const trackId = activeCacheTrackId();
    return rawCacheSet(scopedCacheKey(text, trackId), { ...(value || {}), songId: trackId });
  };
  cache.has = function (text) { return this.get(text) !== undefined; };
  cache.delete = function (text) {
    const scopedDeleted = rawCacheDelete(scopedCacheKey(text));
    const legacyDeleted = rawCacheDelete(String(text));
    return scopedDeleted || legacyDeleted;
  };

  function invalidateTrackWork() {
    abortOngoingWork();
    inFlight.clear();
    needsRomajaRefetch.clear();
    failedUntil.clear();
    queueRunning = false;
    queueEpoch = -1;
    clearTimeout(batchTimer);
    batchTimer = null;
    lastTrackSwitchAt = Date.now();
    stats.trackSwitches++;
  }
  window.__spicyTRDiagnostics = () => ({ version: '58.0.0', enabled: isEnabled, ...stats,
    currentSong: currentSongId, cacheLines: cache.size,
    inFlightLines: inFlight.size, queueRunning,
    availableModels: GEMINI_MODELS.filter(m => geminiApiKeys.some(k => isGeminiComboReady(k, m))),
    nextRequestInSec: Math.max(0, Math.ceil((nextGeminiRequestAt - Date.now()) / 1000)),
    fallbackEnabled: !qualityMode, geminiMinStartIntervalMs: GEMINI_MIN_START_INTERVAL_MS,
    maxLinesPerGeminiCall: MAX_LINES_PER_GEMINI_CALL, geminiTimeoutMs: GEMINI_TIMEOUT_MS,
    nextAvailableInSec: Math.max(0, Math.ceil((nextGeminiAvailableAt() - Date.now()) / 1000)),
    lastError: geminiLastError
  });

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

  // Quality-first order: use the strongest current Flash model first; keep Lite models as fallbacks.
  // This does not add requests or change the shared 9-second request pacing.
  const GEMINI_MODELS = [
    'gemini-3.8-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite'
  ];

  let isEnabled = localStorage.getItem('spicy_tr_enabled') !== 'false';
  // An accurate but temporarily missing lyric is better than a misleading mistranslation.
  // Applies when Gemini keys exist. Users may opt into GTX/MyMemory in settings.
  const QUALITY_MODE_KEY = 'spicy_tr_quality_first_v54';
  // Default OFF: Gemini is primary, but a fallback is allowed only after AI failure.
  let qualityMode = localStorage.getItem(QUALITY_MODE_KEY) === 'true'; // Gemini first, optional machine fallback on failure.
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

  const MAX_LINES_PER_GEMINI_CALL = 20; // Short coherent stanzas; bound latency and JSON size.
  const GEMINI_MAX_OUTPUT_TOKENS = 4096;
  const GEMINI_FALLBACK_GRACE_MS = 800;

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
      (!item.tr || ['gtx', 'mymemory', 'legacy', 'romanization'].includes(item.source)) &&
      (item.nextGeminiAt || 0) <= now && nextGeminiAvailableAt() <= now;
  }

  function markFailed(text, cooldownMs) {
    failedUntil.set(text, Date.now() + (cooldownMs || FAILURE_COOLDOWN_MS));
  }

  function saveCache() {
    try {
      // Persist every usable translation source. Gemini may upgrade a GTX/MyMemory
      // result later, but a fallback must never disappear after restart.
      const entries = Array.from(cache.entries()).map(([k, v]) => {
        if (!v || (!v.tr && !v.romaja)) return null;
        return [k, v];
      }).filter(Boolean).slice(-6000);
      localStorage.setItem(STORAGE_CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
    } catch (e) {}
  }

  const STRONG_TURKISH_WORDS = new Set([
    'benim','senin','seni','bana','sana','bizim','sizden','için','gibi',
    'değil','değilsin','şimdi','artık','hiç','çok','nasıl','neden','niye',
    'olacak','oldu','sanki','kadar','seviyorum','istiyorum','geliyorum'
  ]);
  function looksTurkish(text) {
    if (!text || isNonLatin(text)) return false;
    const words = (String(text).toLocaleLowerCase('tr-TR').match(/[a-zçğıöşü]+/g) || []);
    if (!words.length) return false;
    const hits = words.filter(w => STRONG_TURKISH_WORDS.has(w)).length;
    return hits >= 2 || (hits >= 1 && /[ığş]/i.test(text));
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
    if (trTokens.length === 1 && srcTokens.length >= 3 && trTokens[0].replace(/[^a-zçğıöşüA-ZÇĞİÖŞÜ]/g, '').length > 34) return true;
    return false;
  }

  function repairCache() {
    let fixed = 0, purged = 0, reformalFixed = 0, turkishPurged = 0, gluedPurged = 0;
    for (const [cacheKey, data] of Array.from(rawCacheEntries())) {
      if (!data) continue;
      const separatorAt = cacheKey.indexOf(CACHE_KEY_SEPARATOR);
      const isTrackScoped = separatorAt >= 0;
      const rawLine = isTrackScoped ? cacheKey.slice(separatorAt + 1) : cacheKey;

      // V52 and earlier stored translations by lyric text alone. They cannot
      // safely be reused in another song; retain only their romanization.
      if ((!isTrackScoped && data.tr) || (data.tr && data.source === 'glossary')) {
        data.tr = '';
        data.source = 'romanization';
        data.nextGeminiAt = 0;
        data.qualityVersion = CACHE_QUALITY_VERSION;
        rawCacheSet(cacheKey, data);
        stats.stalePurged++;
        reformalFixed++;
      }

      // Re-translate old Gemini entries after the localization prompt/model change.
      if (data.tr && data.source === 'gemini' && (!data.qualityVersion || data.qualityVersion < CACHE_QUALITY_VERSION)) {
        data.tr = '';
        data.source = 'romanization';
        data.nextGeminiAt = 0;
        rawCacheSet(cacheKey, data);
        stats.stalePurged++;
        reformalFixed++;
      }
      if (data.tr && !data.source) {
        data.source = 'legacy';
        data.nextGeminiAt = 0;
        rawCacheSet(cacheKey, data);
        reformalFixed++;
      }

      if (looksTurkish(rawLine)) {
        rawCacheDelete(cacheKey);
        turkishPurged++;
        continue;
      }

      if (data.tr && looksGluedTranslation(rawLine, data.tr)) {
        rawCacheDelete(cacheKey);
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
        rawCacheDelete(cacheKey);
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

      if (changed) rawCacheSet(cacheKey, data);
    }

    if (fixed || purged || reformalFixed || turkishPurged || gluedPurged) {
      saveCache();
      log(`Cache onarımı: ${fixed} romanizasyon düzeltildi, ${purged} ad-lib çevirisi silindi, ${reformalFixed} eski/bağlam dışı çeviri yenileme için temizlendi, ${turkishPurged} zaten-Türkçe satır silindi, ${gluedPurged} bozuk çeviri silindi.`);
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
    html:not(.spicy-tr-off) #SpicyLyricsPage .line:not(.musical-line) {
      display: flex !important;
      flex-wrap: wrap !important;
      align-content: flex-start !important;
      --BlurAmount: 0px !important;
      filter: none !important;
      -webkit-filter: none !important;
    }
    html:not(.spicy-tr-off) #SpicyLyricsPage .spicy-tr-box, html:not(.spicy-tr-off) #SpicyLyricsPage .spicy-tr-box * {
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
    html:not(.spicy-tr-off) #SpicyLyricsPage .spicy-tr-box {
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
    html.spicy-tr-off #SpicyLyricsPage .spicy-tr-box,
    html.spicy-tr-off #SpicyLyricsPage .spicy-tr-romaja,
    html.spicy-tr-off #SpicyLyricsPage .spicy-tr-turkish,
    body.spicy-tr-off #SpicyLyricsPage .spicy-tr-box {
      display: none !important;
    }
    html:not(.spicy-tr-off) #SpicyLyricsPage .spicy-tr-romaja {
      font-size: 0.46em !important;
      font-weight: 500 !important;
      color: rgba(255, 255, 255, 0.82) !important;
      -webkit-text-fill-color: rgba(255, 255, 255, 0.82) !important;
      opacity: 1 !important;
      word-spacing: 2px !important;
    }
    html:not(.spicy-tr-off) #SpicyLyricsPage .spicy-tr-turkish {
      font-size: 0.52em !important;
      font-weight: 700 !important;
      color: #ffffff !important;
      -webkit-text-fill-color: #ffffff !important;
      opacity: 1 !important;
    }
    html:not(.spicy-tr-off) #SpicyLyricsPage .line.NotSung, html:not(.spicy-tr-off) #SpicyLyricsPage .line.Sung { opacity: 0.78 !important; }
    html:not(.spicy-tr-off) #SpicyLyricsPage .line.Active { opacity: 1 !important; }
    #spicy-tr-toggle-btn {
      background: rgba(255, 255, 255, 0.15); color: #fff; border: 1px solid rgba(255, 255, 255, 0.3);
      border-radius: 50%; width: 32px; height: 32px; font-size: 10px; font-weight: 800; cursor: pointer;
      display: inline-flex; align-items: center; justify-content: center; margin-left: 6px; transition: all 0.2s ease;
    }
    #spicy-tr-toggle-btn:not(.active) { opacity: 0.63; filter: grayscale(1); }
    #spicy-tr-toggle-btn.active { background: #1db954; border-color: #1db954; color: #000; }
    #spicy-tr-toggle-btn.ai-mode.active { background: linear-gradient(135deg, #1db954, #00d2ff); border-color: #00d2ff; color: #000; }
    #spicy-tr-toggle-btn.quota-warn { background: linear-gradient(135deg, #ffae00, #ff4b4b) !important; border-color: #ffae00 !important; color: #000; font-size: 8px; }
  `;
  document.getElementById('spicy-tr-style')?.remove();
  document.head.appendChild(style);
  // A stale V47 may still be installed separately; keep the OFF visibility
  // guard in an independently named stylesheet old versions do not know.
  // An old instance can still spend API quota: uninstall duplicates.
  const offGuardStyle = document.createElement('style');
  offGuardStyle.id = 'spicy-tr-v52-off-guard';
  offGuardStyle.textContent = `
    html.spicy-tr-off #SpicyLyricsPage .spicy-tr-box,
    html.spicy-tr-off #SpicyLyricsPage .spicy-tr-turkish,
    html.spicy-tr-off #SpicyLyricsPage .spicy-tr-romaja,
    body.spicy-tr-off #SpicyLyricsPage .spicy-tr-box { display: none !important; }
    html.spicy-tr-off #SpicyLyricsPage .line:not(.musical-line) {
      --BlurAmount: initial !important;
    }
  `;
  document.getElementById(offGuardStyle.id)?.remove();
  document.head.appendChild(offGuardStyle);

  function applyEnabledClass() {
    // Use both roots: older SpicyTR scripts may independently change BODY.
    // HTML is our authoritative off-state so their changes cannot unhide us.
    document.documentElement?.classList.toggle('spicy-tr-off', !isEnabled);
    document.body.classList.toggle('spicy-tr-off', !isEnabled);
  }
  function clearRenderedSubtitles() {
    document.querySelectorAll('#SpicyLyricsPage .spicy-tr-box').forEach(el => el.remove());
  }
  applyEnabledClass();
  if (!isEnabled) clearRenderedSubtitles();

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

  // Google RPD resets at midnight in Pacific time (including DST).
  // Search for the next date boundary in that timezone; no hardcoded UTC
  // offset or arbitrary 6/12-hour daily lockout.
  function untilPacificDailyResetMs(now = Date.now()) {
    try {
      const dateKey = t => new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit'
      }).format(new Date(t));
      const today = dateKey(now);
      let lo = now, hi = now + 27 * 60 * 60 * 1000;
      while (hi - lo > 30000) {
        const mid = Math.floor((lo + hi) / 2);
        if (dateKey(mid) === today) lo = mid; else hi = mid;
      }
      return Math.max(60000, hi - now + 60000);
    } catch (e) { return 12 * 60 * 60 * 1000; }
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
    // A completed stale network task or cached DOM scan must NEVER recreate
    // subtitles while the user has turned the extension off.
    if (disposed || !isEnabled || (lineEl && lineEl.isConnected === false)) return;
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
      if (data.source === 'gtx' || data.source === 'mymemory') {
        trEl.title = 'Geçici makine çevirisi; bağlam/duygu doğruluğu garanti edilmez';
        trEl.dataset.translationSource = data.source;
      }
      box.appendChild(trEl);
    }

    if (box.children.length > 0) {
      lineEl.appendChild(box);
      triggerRecalc();
    }
  }

  function updateDOMWithCache() {
    if (disposed || !isEnabled) return;
    const lines = document.querySelectorAll('#SpicyLyricsPage .line:not(.musical-line)');
    lines.forEach(el => {
      const text = getCleanText(el);
      if (cache.has(text)) {
        renderSubtitles(el, cache.get(text), text);
      }
    });
  }

  function parseGeminiJsonArray(rawOutput, expectedCount) {
    const byId = new Map();
    if (!rawOutput || !Number.isInteger(expectedCount) || expectedCount < 1) return byId;
    const cleaned = String(rawOutput).trim()
      .replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    const accept = (item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return;
      const id = typeof item.id === 'number' ? item.id :
        (typeof item.id === 'string' && /^\d+$/.test(item.id) ? Number(item.id) : -1);
      if (!Number.isInteger(id) || id < 0 || id >= expectedCount || byId.has(id)) return;
      const tr = typeof item.tr === 'string' ? item.tr : '';
      const rom = typeof item.rom === 'string' ? item.rom : '';
      if (tr.trim() || rom.trim()) byId.set(id, { tr, rom });
    };
    try {
      const doc = JSON.parse(cleaned);
      const list = Array.isArray(doc) ? doc :
        (Array.isArray(doc?.translations) ? doc.translations : doc?.results);
      if (Array.isArray(list)) list.forEach(accept);
      return byId;
    } catch (e) { /* Recover only complete objects with explicit IDs. */ }
    let depth = 0, start = -1, inString = false, escaped = false;
    for (let i = 0; i < cleaned.length; i++) {
      const c = cleaned[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === '{') { if (!depth) start = i; depth++; }
      else if (c === '}' && depth) {
        depth--;
        if (!depth && start >= 0) {
          try { accept(JSON.parse(cleaned.slice(start, i + 1))); } catch (e) {}
          start = -1;
        }
      }
    }
    return byId;
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
    const prompt = `You are an expert song-lyrics literary translator and native Turkish editor.
Your task is to LOCALIZE meaning, not turn sentences into literal dictionary phrases.
Song: ${songTitle} — ${artist}

Lyrics around this stanza (for context, DO NOT translate these extra lines):
${contextLinesText}

TARGET LINES, with immutable zero-based IDs:
${chunkLines.map((l, i) => `[${i}] ${l}`).join('\n')}

TRANSLATION PRINCIPLES:
- Resolve the song's speaker, addressee, recurring themes, poetic images, emotional register and hidden implications using the surrounding lyrics. Never invent facts absent from the source.
- Translate into fluent, idiomatic contemporary Turkish. If a metaphor, cultural reference, pun, slang phrase, romantic or literary expression has no direct equivalent, convey what it actually implies rather than translating each word. Preserve ambiguity where the original is ambiguous.
- Match feeling: tender lyrics should feel tender; poetic lines should stay poetic; teasing should stay playful; profanity or explicit expressions must retain their force and must not be sanitized.
- Preserve negation, time, tense, agent, grammatical person, intentions and unfinished line breaks. Read adjacent lines together before translating individually.
- Keep named people, proper names and deliberate signature hooks unaltered, but translate ordinary English sentences even in Korean/English mixed lyrics.
- Pay attention to Korean sentence continuations, particles, idioms and interjections. A standalone Hangul 오 is not automatically the Turkish pronoun "o".
- Do not blindly turn "you" into plural/formal "siz". Do not force a dramatic register on a conversational lyric.
- Do not invent a euphemism. Do not turn a statement into a command, or a desire into a certainty.
- If a line is a repetition or an ad-lib, treat it naturally; do not produce nonsense mechanical repetitions.
- Turkish text must be real Turkish, not romanization or commentary about the line. Do not add translator notes.
- For non-Latin text provide a human-readable Latin-script pronunciation with correct word separation in rom; otherwise rom is "".
- Return EXACTLY one object for EACH provided target ID. For each {"id":0,"tr":"...","rom":"..."}, id MUST equal the input bracketed number; NEVER omit, renumber, or reorder IDs. Missing IDs will not be guessed.
- Output ONLY a JSON ARRAY. No markdown. No extra fields.`;

    let lastError = new Error('Gemini kombinasyonları şu an kullanılamıyor');
    const keyCount = geminiApiKeys.length;
    if (keyCount === 0) throw lastError;
    // Rotate starting key between batches; model order prioritizes translation quality.
    const startKey = geminiKeyCursor++ % keyCount;
    const batchStarted = Date.now();
    let attempted = 0;
    const requestBody = (simple, model) => ({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        // No temperature override: current Gemini 3.x guidance prefers model defaults.
        maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS,
        responseMimeType: 'application/json',
        ...(!simple ? { thinkingConfig: { thinkingLevel: model.endsWith('flash-lite') ? 'minimal' : 'low' },
          responseSchema: {
          type: 'ARRAY',
          items: { type: 'OBJECT', properties: {
            id: { type: 'INTEGER' }, rom: { type: 'STRING' }, tr: { type: 'STRING' }
          }, required: ['id', 'rom', 'tr'] }
        }} : {})
      }
    });

    for (const model of GEMINI_MODELS) {
      for (let j = 0; j < keyCount; j++) {
        if (disposed || epoch !== generationId || !isEnabled) throw new Error('İstek iptal edildi');
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
            await waitForGeminiSlot(epoch);
            const remainingMs = GEMINI_BATCH_TIME_BUDGET_MS - (Date.now() - batchStarted);
            if (remainingMs < 2500) throw new Error('Grup istek zaman bütçesi doldu');
            response = await fetchWithTimeout(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey.trim() },
              body: JSON.stringify(requestBody(simple, model))
            }, Math.min(GEMINI_TIMEOUT_MS, remainingMs));
            if (epoch !== generationId) throw new Error('İstek iptal edildi');
            if (response.ok) break;
            errJson = null; bodyMsg = '';
            try {
              errJson = await response.json();
              bodyMsg = String(errJson?.error?.message || '').slice(0, 500);
            } catch (e) { /* keep HTTP status even if error body isn't JSON */ }
            // If the schema/parameters are unsupported, retry ONCE without
            // schema/thinking config. Do not waste all keys on the same 400.
            if (response.status === 400 && !simple && !usedSimpleRetry &&
                /response.?schema|response.?format|generation.?config|unsupported.*schema/i.test(bodyMsg)) {
              simple = true;
              usedSimpleRetry = true;
              warn(`${model}: şemalı istek 400 döndürdü; sade JSON isteği bir kez deneniyor.`);
              continue;
            }
            break;
          }
          if (!response.ok) {
            const status = response.status;
            geminiLastError = `${model} (anahtar ${j + 1}): HTTP ${status} ${bodyMsg}`;
            const now = Date.now();
            if (status === 429) {
              stats.http429++;
              const retryMs = parseRetryDelayMs(errJson, bodyMsg, response.headers?.get?.('Retry-After'));
              const daily = /(?:per day|daily|requests per day|RPD|per_day)/i.test(bodyMsg);
              const wait = Math.min(daily ? Math.max(retryMs || 0, untilPacificDailyResetMs(now)) :
                (retryMs || MODEL_DEAD_QUOTA_DEFAULT_MS), MODEL_DEAD_QUOTA_MAX_MS);
              modelCooldowns.set(model, now + Math.max(1000, wait));
              warn(`${model}: 429, ${formatDuration(wait)} bekleme; aynı model diğer anahtarlarla tekrar denenmeyecek.`);
            } else if (status === 503 || status === 500 || status === 502 || status === 504) {
              // The *model service* is busy: switching API keys wastes quota.
              if (status === 503) stats.http503++;
              modelCooldowns.set(model, now + (status === 503 ? 3 * 60 * 1000 : 70 * 1000));
            } else if (status === 404) {
              modelCooldowns.set(model, now + MODEL_DEAD_LONG_MS);
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
          if (!parsed.size) throw new Error(`Gemini ID'li JSON okunamadı (finishReason=${json?.candidates?.[0]?.finishReason || 'unknown'})`);
          if (parsed.size < chunkLines.length) {
            warn(`Gemini ${chunkLines.length} satırdan ${parsed.size} tanesini ID ile eşleştirdi; diğer satırlar yanlış sıraya kaydırılmayacak.`);
          }
          if (epoch !== generationId) throw new Error('İstek iptal edildi');

          chunkLines.forEach((rawLine, i) => {
            const item = parsed.get(i) || {};
            const existing = cache.get(rawLine) || {};
            const cleanTr = typeof item.tr === 'string' && item.tr.trim()
              ? fixGluedWords(forcePerfectTurkish(item.tr.trim())) : '';
            let cleanRom = '';
            if (isNonLatin(rawLine)) {
              const romRaw = typeof item.rom === 'string' ? item.rom.trim() : '';
              if (looksGluedRomaja(rawLine, romRaw)) {
                const repaired = splitRepeatingUnit(romRaw);
                if (repaired) cleanRom = repaired;
                else needsRomajaRefetch.add(rawLine);
              } else cleanRom = fixGluedWords(romRaw);
            }
            const usableTr = !!cleanTr && isUsableTranslation(rawLine, cleanTr);
            // Keep romanization even if Gemini omitted/failed the Turkish field.
            // The queue will fill the missing Turkish text with GTX/MyMemory.
            if (usableTr || cleanRom) {
              cache.set(rawLine, {
                tr: usableTr ? cleanTr : (existing.tr || ''),
                romaja: cleanRom || existing.romaja || '',
                source: usableTr ? 'gemini' : (existing.source || 'romanization'),
                qualityVersion: usableTr ? CACHE_QUALITY_VERSION : (existing.qualityVersion || CACHE_QUALITY_VERSION),
                nextGeminiAt: usableTr ? 0 : (existing.nextGeminiAt || 0)
              });
            }
            if (isNonLatin(rawLine) && !cleanRom && !existing.romaja) needsRomajaRefetch.add(rawLine);
          });
          geminiLastError = '';
          stats.geminiSuccess++;
          modelCooldowns.delete(model);
          deadModels.delete(id);
          saveBackoffState();
          saveCache();
          updateDOMWithCache();
          return chunkLines.filter(l => !cache.get(l)?.tr);
        } catch (e) {
          if (epoch !== generationId) throw e;
          lastError = e;
          geminiLastError = `${model} (anahtar ${j + 1}): ${e?.name === 'AbortError' ? 'zaman aşımı' : (e?.message || e)}`;
          if (isGeminiComboReady(apiKey, model)) {
            // A timeout / malformed response is not solved by hammering the
            // same model with four keys in the next seconds.
            modelCooldowns.set(model, Date.now() + (e?.name === 'AbortError' ? 120000 : 60000));
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

  function normalizeForDumbEngines(text) { return text; }

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

  const GTX_CHUNK_SIZE = 6;
  const GTX_CHUNK_PAUSE_MS = 200;
  const MM_CHUNK_SIZE = 4;
  const MM_CHUNK_PAUSE_MS = 350;

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
          if (disposed || epoch !== generationId || !isEnabled) return;
          const adlib = isAdlibPattern(rawText);
          const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=tr&dt=t&dt=rm&q=${encodeURIComponent(normalizeForDumbEngines(rawText))}`;
          const res = await fetchWithTimeout(url, {}, 7000);
          if (!res.ok) {
            gtxLastError = `HTTP ${res.status}`;
            throw new Error(gtxLastError);
          }
          const json = await res.json();
          if (disposed || epoch !== generationId || !isEnabled) return;

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
              tr: existing.tr || (useTr ? fixedTr : (adlib ? rawText : '')),
              romaja: cleanRomaja || existing.romaja || '',
              source: existing.tr ? (existing.source || 'gtx') :
                (useTr ? 'gtx' : (existing.source || 'romanization')),
              nextGeminiAt: existing.tr ? (existing.nextGeminiAt || (Date.now() + FALLBACK_UPGRADE_INTERVAL_MS)) :
                (geminiApiKeys.length ? Date.now() : (Date.now() + FALLBACK_UPGRADE_INTERVAL_MS))
            });
            updateDOMWithCache();
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
          if (disposed || epoch !== generationId || !isEnabled) return;
          const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=tr&dt=rm&q=${encodeURIComponent(rawText)}`;
          const res = await fetchWithTimeout(url, {}, 10000);
          if (!res.ok) return;
          const json = await res.json();
          if (disposed || epoch !== generationId || !isEnabled) return;
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
          if (disposed || epoch !== generationId || !isEnabled) return;
          const q = normalizeForDumbEngines(rawText).slice(0, 480);
          const srcLang = detectSourceLangForMyMemory(rawText);
          const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(q)}&langpair=${srcLang}|tr`;
          const res = await fetchWithTimeout(url, {}, 10000);
          if (!res.ok) {
            mmLastError = `HTTP ${res.status}`;
            throw new Error(mmLastError);
          }
          const json = await res.json();
          if (disposed || epoch !== generationId || !isEnabled) return;

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
              source: existing.tr ? (existing.source || 'mymemory') : 'mymemory',
              nextGeminiAt: existing.tr ? (existing.nextGeminiAt || (Date.now() + FALLBACK_UPGRADE_INTERVAL_MS)) :
                (geminiApiKeys.length ? Date.now() : (Date.now() + FALLBACK_UPGRADE_INTERVAL_MS))
            });
            updateDOMWithCache();
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
    if (disposed || !isEnabled || (queueRunning && queueEpoch === generationId)) return;
    const epoch = generationId;
    const now = Date.now();
    let missing = allVisibleLines.filter(t =>
      (!cache.get(t)?.tr || canUpgradeFallback(t, now)) &&
      !inFlight.has(t) && (failedUntil.get(t) || 0) <= now
    );
    if (!missing.length) return;
    queueRunning = true;
    queueEpoch = epoch;
    missing = prioritizeByActive(missing, allVisibleLines, activeText);
    missing.forEach(t => inFlight.add(t));
    const valid = () => !disposed && isEnabled && epoch === generationId;
    const hasGemini = geminiApiKeys.length > 0;
    const allowFallback = !hasGemini || !qualityMode;
    try {
      // Translate one coherent stanza at a time with Gemini. Do not start
      // dozens of GTX calls while a good Gemini answer is still in flight.
      for (const group of chunkArray(missing, MAX_LINES_PER_GEMINI_CALL)) {
        if (!valid()) return;
        const target = group.filter(l => !cache.get(l)?.tr || canUpgradeFallback(l));
        if (!target.length) continue;
        if (hasGemini && nextGeminiAvailableAt() <= Date.now()) {
          try {
            await translateChunkWithGemini(target, allVisibleLines, epoch);
          } catch (e) {
            if (!valid()) return;
            warn('Gemini geçici olarak kullanılamıyor:', e?.message || e);
          }
        }
        if (!valid()) return;
        // Machine translation is the user's explicit fallback choice; never
        // silently turn it into a "high quality AI translation".
        if (allowFallback) {
          const needTr = group.filter(l => !cache.get(l)?.tr);
          if (needTr.length && Date.now() >= gtxGloballyDownUntil) {
            await translateWithGTXPerLine(needTr, epoch);
          }
          if (!valid()) return;
          const stillMissing = group.filter(l => !cache.get(l)?.tr);
          if (stillMissing.length && Date.now() >= mmGloballyDownUntil) {
            await translateWithMyMemoryPerLine(stillMissing, epoch);
          }
        }
        if (!valid()) return;
        const needRom = group.filter(l => isNonLatin(l) && !cache.get(l)?.romaja);
        if (needRom.length && Date.now() >= gtxGloballyDownUntil) {
          for (const l of needRom) if (!cache.has(l)) cache.set(l, { tr: '', romaja: '', source: 'romanization' });
          await translateRomajaOnlyWithGTX(needRom, epoch);
        }
        if (!valid()) return;
        const modelReadyAt = nextGeminiAvailableAt();
        for (const l of group) {
          const item = cache.get(l);
          if (item && item.source !== 'gemini' && item.source !== 'glossary') {
            // A cheap fallback isn't repeatedly upgraded every 2 minutes.
            item.nextGeminiAt = Math.max(Date.now() + FALLBACK_UPGRADE_INTERVAL_MS, modelReadyAt || 0);
          }
          if (!item?.tr) {
            const wait = hasGemini && modelReadyAt > Date.now()
              ? Math.max(FAILURE_COOLDOWN_MS, modelReadyAt - Date.now())
              : Math.max(FAILURE_COOLDOWN_MS, 90000);
            markFailed(l, wait);
          }
        }
        saveCache();
        updateDOMWithCache();
      }
    } catch (e) {
      if (valid()) err('processQueue beklenmedik hata:', e);
    } finally {
      if (queueEpoch === epoch) {
        for (const t of missing) inFlight.delete(t);
        queueRunning = false;
        queueEpoch = -1;
        if (!disposed) scheduleScan();
      }
    }
  }

  function refreshToggleButtonVisual(btn) {
    if (!btn) return;
    btn.setAttribute('aria-pressed', String(isEnabled));
    btn.setAttribute('aria-label', isEnabled ? 'Türkçe çeviri ve romanizasyonu kapat' : 'Türkçe çeviri ve romanizasyonu aç');
    btn.setAttribute('data-spicy-tr-state', isEnabled ? 'on' : 'off');
    const now = Date.now();
    const hasKeys = geminiApiKeys.length > 0;
    syncGeminiCooldown();
    const geminiDown = hasKeys && now < geminiGloballyDownUntil;
    const gtxDown = now < gtxGloballyDownUntil;
    const mmDown = now < mmGloballyDownUntil;
    const allDown = (!hasKeys || geminiDown) && gtxDown && mmDown;
    const anyWarn = geminiDown || (!hasKeys || !qualityMode) && (gtxDown || mmDown);

    btn.className = `${isEnabled ? 'active' : ''} ${hasKeys ? 'ai-mode' : ''} ${isEnabled && anyWarn ? 'quota-warn' : ''}`.trim();
    btn.textContent = !isEnabled ? 'OFF' : allDown ? '!!' : (hasKeys ? (anyWarn ? 'AI!' : 'AI') : (anyWarn ? 'TR!' : 'TR'));
    if (!isEnabled) {
      btn.title = 'SpicyTR V58 · KAPALI — Açmak için sol tıkla. Ayarlar için sağ tıkla.';
      return;
    }

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
      btn.title = `Gemini şu an kullanılamıyor (${geminiLastError || 'geçici'}) - otomatik bekleme etkin`;
    } else if (gtxDown || mmDown) {
      const which = gtxDown ? 'Google Translate' : 'MyMemory';
      const reason = gtxDown ? gtxLastError : mmLastError;
      btn.title = `${which} şu anda geçici olarak kullanılamıyor (${reason || 'rate-limit'}) - diğer motorlar devrede`;
    } else {
      btn.title = hasKeys
        ? `SpicyTR V58 (${geminiApiKeys.length} Gemini anahtarı tanımlı - sağ tık: ayarlar)`
        : 'Sağ tık: Gemini API anahtarı/anahtarları gir (isteğe bağlı, daha iyi çeviri için)';
    }
    btn.title = `[SpicyTR V58${qualityMode && hasKeys ? ' · kalite modu açık' : ''}] ${btn.title} | Gemini istek: ${stats.geminiCalls}, başarılı: ${stats.geminiSuccess}, 429: ${stats.http429}, 503: ${stats.http503}. Konsol: __spicyTRDiagnostics()`;
  }

  // The Spicy Lyrics controls are React-managed. A button-local onclick is
  // unreliable if React remounts/replaces the controls between mousedown and
  // click. Use one delegated, capture-phase handler for our owned button.
  // It survives React replacing the toolbar and blocks ancestor click handlers.
  let ownedToggleButton = null;
  const TOGGLE_OWNER = 'spicytr-58';
  function handleToggleClick(event) {
    if (disposed || !ownedToggleButton) return;
    const target = event.target;
    // An obsolete V47/V49 button may have appeared during an old observer
    // callback. Route those clicks into V54 state rather than old onclick.
    const clickedButton = target instanceof Element && target.closest('#spicy-tr-toggle-btn');
    if (!clickedButton || !clickedButton.closest('#SpicyLyricsPage .ViewControls')) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    setExtensionEnabled(!isEnabled, ownedToggleButton);
  }
  document.addEventListener('click', handleToggleClick, true);

  function setExtensionEnabled(next, btn) {
    if (disposed || next === isEnabled) return;
    isEnabled = next;
    // Save first: a restart or track switch must never re-enable by accident.
    try { localStorage.setItem('spicy_tr_enabled', String(isEnabled)); } catch (e) {}
    if (!isEnabled) {
      // Stop ongoing and scheduled work and immediately REMOVE every overlay.
      // CSS also remains as a failsafe in case an older async callback runs.
      abortOngoingWork();
      clearTimeout(batchTimer); batchTimer = null;
      inFlight.clear();
      needsRomajaRefetch.clear();
      queueRunning = false;
      queueEpoch = -1;
      applyEnabledClass();
      clearRenderedSubtitles();
    } else {
      applyEnabledClass();
    }
    refreshToggleButtonVisual(btn);
    // In addition to removing legacy .spicy-tr-box nodes, neutralize style
    // leftovers and cancel every pending scan. A resize can remount the lyrics
    // view, so only request it when translations are being re-enabled.
    if (isEnabled) {
      triggerRecalc();
      triggerMultiStageScan();
    }
  }

  function injectToggleButton() {
    const controls = document.querySelector('#SpicyLyricsPage .ViewControls');
    if (!controls) return;

    // Remove orphaned buttons from old script copies (including buttons that
    // share an ID). Never reuse their attached event listeners or state.
    document.querySelectorAll('#spicy-tr-toggle-btn').forEach(el => {
      if (el !== ownedToggleButton) el.remove();
    });
    if (ownedToggleButton) {
      if (ownedToggleButton.parentElement !== controls) controls.appendChild(ownedToggleButton);
      refreshToggleButtonVisual(ownedToggleButton);
      return;
    }

    const btn = document.createElement('button');
    btn.id = 'spicy-tr-toggle-btn';
    btn.type = 'button';
    btn.dataset.spicyTrOwner = TOGGLE_OWNER;
    ownedToggleButton = btn;
    refreshToggleButtonVisual(btn);
    // Event delegation on document handles both native clicks and keyboard
    // activation. No inline onclick: it is too easy to lose on DOM remount.

    // (V45) CRITICAL FIX: window.prompt()/confirm() DO NOT WORK inside
    // Spotify's CEF (Chromium Embedded Framework) runtime - calling them
    // does not show any dialog at all, they just silently do nothing /
    // return immediately. This is why right-click+OK looked like it did
    // literally nothing: the prompt() call for entering keys never
    // produced a visible box to type into in the first place, on ANY
    // version of this script, including V44 and everything before it.
    // Fixed by building a real on-screen panel with Spicetify.PopupModal
    // (Spicetify's own supported modal API) instead of prompt()/confirm().
    function applySettings(rawInput, resetCache = false) {
      abortOngoingWork();
      clearTimeout(batchTimer); batchTimer = null;
      geminiApiKeys = Array.from(new Set(
        rawInput.split(/[,\n]+/).map(k => k.trim()).filter(k => k.length > 10)
      ));
      try { localStorage.setItem(GEMINI_KEYS_STORAGE, JSON.stringify(geminiApiKeys)); } catch (e2) {}
      failedUntil.clear();
      inFlight.clear();
      needsRomajaRefetch.clear();
      // Saving API keys or toggling quality mode does not destroy successful
      // translations. Only an explicit reset wipes the translation cache.
      if (resetCache) {
        // Preserve 429/503 cooldowns even across manual cache reset.
        cache.clear();
        try { localStorage.removeItem(STORAGE_CACHE_KEY); localStorage.removeItem('spicy_tr_godmode_v35'); } catch (e4) {}
        saveBackoffState();
        saveCache();
      }
      document.querySelectorAll('#SpicyLyricsPage .spicy-tr-box').forEach(el => el.remove());
      refreshToggleButtonVisual(btn);
      triggerMultiStageScan();
      try { Spicetify.showNotification?.(resetCache ?
        'Önbellek temizlendi; yeniden çeviri istekleri yapılacak.' :
        'Ayarlar kaydedildi; mevcut çeviriler korundu.'); } catch (e5) {}
    }

    function openKeySettingsModal() {
      if (!Spicetify?.PopupModal?.display) {
        // Extremely old/unsupported Spicetify build without PopupModal -
        // last-resort fallback (may not show anything, but at least we tried).
        try {
          const fallbackInput = prompt('Gemini API anahtarlarınızı girin (virgülle ayırın):', geminiApiKeys.join(', '));
          if (fallbackInput !== null) applySettings(fallbackInput);
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
      qualityText.textContent = 'Yalnızca Gemini çevirisi: Açarsan Google Translate/MyMemory yedeği gizlenir, AI kotası dolunca bazı satırlar boş kalabilir. Kapalıyken Gemini yine önceliklidir, başarısız olursa makine çevirisi geçici yedek olarak kullanılır.';
      qualityLabel.appendChild(qualityText);
      wrap.appendChild(qualityLabel);

      const warnText = document.createElement('div');
      warnText.style.fontSize = '12px';
      warnText.style.opacity = '0.75';
      warnText.textContent = `Önbellek: ${cache.size} satır. Kaydet mevcut çevirileri korur. Sadece ayrı 'Önbelleği sıfırla' düğmesi eski çevirileri siler ve yeni API kotası harcar.`;
      wrap.appendChild(warnText);

      const btnRow = document.createElement('div');
      btnRow.style.display = 'flex';
      btnRow.style.gap = '8px';
      btnRow.style.justifyContent = 'flex-end';
      btnRow.style.flexWrap = 'wrap';
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

      const saveBtn = mkBtn('Kaydet', true);
      saveBtn.onclick = () => {
        qualityMode = qualityInput.checked;
        localStorage.setItem(QUALITY_MODE_KEY, String(qualityMode));
        applySettings(textarea.value, false);
        Spicetify.PopupModal.hide();
      };
      const resetBtn = mkBtn('Önbelleği sıfırla', false);
      resetBtn.title = 'Tüm çevirileri siler; yeniden Gemini kotası tüketilir';
      resetBtn.onclick = () => {
        qualityMode = qualityInput.checked;
        localStorage.setItem(QUALITY_MODE_KEY, String(qualityMode));
        applySettings(textarea.value, true);
        Spicetify.PopupModal.hide();
      };

      btnRow.appendChild(cancelBtn);
      btnRow.appendChild(saveBtn);
      btnRow.appendChild(resetBtn);
      wrap.appendChild(btnRow);

      Spicetify.PopupModal.display({
        title: 'Spicy Lyrics - Gemini API Anahtarları',
        content: wrap
      });
    }

    btn.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation?.();
      try {
        openKeySettingsModal();
      } catch (err2) {
        err('Sağ tık menüsü hata verdi:', err2);
      }
    };
    controls.appendChild(btn);
  }

  function scanLines() {
    if (disposed) return;
    applyEnabledClass();
    injectToggleButton();
    if (!isEnabled) {
      // Clean up overlay remnants on remounted lyric views.
      if (document.querySelector('#SpicyLyricsPage .spicy-tr-box')) clearRenderedSubtitles();
      return;
    }
    const id = trackIdentity();
    if (id && currentSongId && id !== currentSongId) invalidateTrackWork();
    if (id) currentSongId = id;
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
        stats.cacheReuse++;
        renderSubtitles(lineEl, cache.get(text), text);
      }
      if ((!cache.get(text)?.tr || canUpgradeFallback(text)) &&
          !inFlight.has(text) && (failedUntil.get(text) || 0) <= Date.now()) {
        hasMissing = true;
      }
    });

    if (hasMissing && allVisibleTexts.length > 0 && !queueRunning && !batchTimer) {
      // Debounce track changes and keep one scheduled queue start. Rapid
      // next/previous actions now consume no requests for skipped songs.
      const delay = Math.max(250, lastTrackSwitchAt + TRACK_SETTLE_MS - Date.now());
      batchTimer = setTimeout(() => {
        batchTimer = null;
        if (!isEnabled) return;
        // Always read the CURRENT DOM: a rapid skip may have replaced every
        // line after the original scheduling scan.
        const latestId = trackIdentity();
        if (latestId && currentSongId && latestId !== currentSongId) {
          safeScanLines();
          return;
        }
        const freshEls = Array.from(document.querySelectorAll('#SpicyLyricsPage .line:not(.musical-line)'));
        const freshTexts = [];
        let freshActive = '';
        for (const el of freshEls) {
          const raw = getCleanText(el);
          if (!raw || raw === '•••' || looksTurkish(raw)) continue;
          if (!freshTexts.includes(raw)) freshTexts.push(raw);
          if (!freshActive && el.classList.contains('Active')) freshActive = raw;
        }
        if (freshTexts.length) processQueue(freshTexts, freshActive);
      }, delay);
    }
  }
  function safeScanLines() {
    try { scanLines(); } catch (e) { err('scanLines hata verdi:', e); }
  }

  let scanScheduled = false;
  function scheduleScan() {
    if (disposed || scanScheduled) return;
    scanScheduled = true;
    setTimeout(() => {
      scanScheduled = false;
      safeScanLines();
    }, 80);
  }

  function triggerMultiStageScan() {
    if (disposed) return;
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
        scheduleScan(); // seeking doesn't invalidate the song's cached lyrics
      }
    }
    lastKnownPos = posMs;
    lastKnownPosAt = now;
  }

  const songChangeHandler = () => {
    try {
      lastKnownPos = null;
      lastKnownPosAt = null;
      invalidateTrackWork();
      currentSongId = trackIdentity();
      setTimeout(triggerMultiStageScan, 90);
    } catch (e) { err('songchange handler hata verdi:', e); }
  };
  const progressHandler = (event) => {
    try { handleProgress(event?.data); } catch (e) { err('progress handler hata verdi:', e); }
  };

  if (Spicetify?.Player) {
    Spicetify.Player.addEventListener('songchange', songChangeHandler);
    Spicetify.Player.addEventListener('onprogress', progressHandler);
  }

  let lastBackoffPersistAt = 0;
  const watchdogInterval = setInterval(() => {
    try {
      if (disposed) return;
      applyEnabledClass();
      if (!document.getElementById('spicy-tr-style')) {
        document.head.appendChild(style);
        log('Stil etiketi kayboldu, yeniden eklendi.');
      }
      if (Date.now() - lastBackoffPersistAt > 15000) {
        saveBackoffState();
        lastBackoffPersistAt = Date.now();
      }
      scanLines();
    } catch (e) {
      err('Watchdog turu hata verdi:', e);
    }
  }, 3500);

  window.__spicyTRCleanup = function () {
    disposed = true;
    abortOngoingWork();
    try { observer.disconnect(); } catch (e) {}
    try { clearInterval(watchdogInterval); } catch (e) {}
    try { clearTimeout(batchTimer); } catch (e) {}
    try { window.removeEventListener('scroll', scrollHandler, true); } catch (e) {}
    try { document.removeEventListener('click', handleToggleClick, true); } catch (e) {}
    try {
      if (Spicetify?.Player) {
        Spicetify.Player.removeEventListener('songchange', songChangeHandler);
        Spicetify.Player.removeEventListener('onprogress', progressHandler);
      }
    } catch (e) {}
    try { saveBackoffState(); } catch (e) {}
    try { delete window.__spicyTRDiagnostics; } catch (e) {}
    try { clearRenderedSubtitles(); } catch (e) {}
    try { document.documentElement?.classList.remove('spicy-tr-off'); } catch (e) {}
    try { document.body.classList.remove('spicy-tr-off'); } catch (e) {}
    try { document.getElementById('spicy-tr-style')?.remove(); } catch (e) {}
    try { offGuardStyle.remove(); } catch (e) {}
    try { ownedToggleButton?.remove(); } catch (e) {}
  };

  triggerMultiStageScan();
})();