// NAME: Spicy Lyrics AI Translator & Romaja
// AUTHOR: korelili
// VERSION: 58.0.1
// V58.0.1: Bugfix - 'Önbelleği sıfırla' artık takılı kalmış Gemini kota/model bekleme durumunu da temizliyor (önceki sürümde temizlemiyordu, bu yüzden tek bir 429/5xx sonrası çeviri kalıcı olarak durabiliyordu).
// Preserves saved Gemini API keys, the toggle button and the existing Spicy Lyrics UI.
// Turkish lyric translation is performed only by Gemini AI.

(function spicyTurkishProV58() {
  const DEBUG = localStorage.getItem('spicy_tr_debug') === 'true'; // Enable in DevTools for diagnosis
  const log = (...args) => { if (DEBUG) console.log('%c[SpicyTR V58.0.1]', 'color:#1db954;font-weight:bold', ...args); };
  const warn = (...args) => { if (DEBUG) console.warn('%c[SpicyTR V58.0.1]', 'color:#ffae00;font-weight:bold', ...args); };
  const err = (...args) => { if (DEBUG) console.error('%c[SpicyTR V58.0.1]', 'color:#ff4b4b;font-weight:bold', ...args); };
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
  let geminiLastModel = '';

  if (typeof window.__spicyTRCleanup === 'function') {
    try {
      window.__spicyTRCleanup();
      log('Önceki script örneği tespit edildi ve temizlendi.');
    } catch (e) {
      err('Önceki örnek temizlenirken hata (yine de devam ediliyor):', e);
    }
  }

  const STORAGE_CACHE_KEY = 'spicy_tr_gemini_cache_v58';
  const LEGACY_TRANSLATION_CACHE_KEY = /^spicy_tr_(?:persistent_cache(?:_|$)|marketplace(?:_|$)|stable(?:_|$)|ultimate(?:_|$)|unbreakable(?:_|$)|godmode(?:_|$)|translation_cache(?:_|$)|lyrics_cache(?:_|$)|cache(?:_|$))/i;
  function purgeTranslationCacheStorage(includeCurrent = false) {
    let removed = 0;
    const clearStore = (store) => {
      if (!store) return;
      const keys = [];
      for (let i = store.length - 1; i >= 0; i--) {
        const key = store.key(i);
        if (!key || (!includeCurrent && key === STORAGE_CACHE_KEY)) continue;
        if (key === STORAGE_CACHE_KEY || LEGACY_TRANSLATION_CACHE_KEY.test(key)) keys.push(key);
      }
      for (const key of keys) {
        try { store.removeItem(key); removed++; } catch (e) {}
      }
    };
    try { clearStore(localStorage); } catch (e) {}
    try { clearStore(sessionStorage); } catch (e) {}
    return removed;
  }
  // V58 starts with a genuinely empty translation cache. Saved Gemini keys and project labels are preserved; obsolete V57 cooldowns are intentionally reset.
  const startupPurgedLegacyCacheCount = purgeTranslationCacheStorage(false);
  let lastCacheClearAt = 0;
  let lastCacheClearRemoved = 0;


  let savedCache = {};
  try {
    savedCache = JSON.parse(localStorage.getItem(STORAGE_CACHE_KEY) || '{}');
  } catch (e) {
    savedCache = {};
  }

  const cache = new Map(Object.entries(savedCache));
  const inFlight = new Set();
  const failedUntil = new Map();
  const FAILURE_COOLDOWN_MS = 8000;
  const deadModels = new Map();
  const MODEL_DEAD_SHORT_MS = 15000;
  const MODEL_DEAD_LONG_MS = 6 * 60 * 60 * 1000;
  const MODEL_DEAD_QUOTA_DEFAULT_MS = 45 * 1000;
  const MODEL_DEAD_QUOTA_MAX_MS = 24 * 60 * 60 * 1000;
  const MODEL_CONFIG_COOLDOWN_MS = 3 * 60 * 1000;
  const GEMINI_TIMEOUT_MS = 10000;
  const GEMINI_ATTEMPTS_PER_BATCH = 4; // Hard cap: never fan out across every key/model.
  const GEMINI_BATCH_TIME_BUDGET_MS = 18000;
  const modelCooldowns = new Map(); // Service/config failures that affect the model across keys.
  const comboCooldowns = new Map(); // Short transient failures scoped to one key + model.
  const keyCooldowns = new Map();   // Invalid-key failures affect only that key.
  const projectCooldowns = new Map(); // Gemini 429 limits are shared by keys in the same project.
  let geminiKeyCursor = 0;
  let geminiGloballyDownUntil = 0;
  // One shared serial request stream; real 429 Retry-After is respected.
  const GEMINI_MIN_START_INTERVAL_MS = 1000;
  const TRACK_SETTLE_MS = 450;
  const CACHE_TRANSLATION_VERSION = 58; // Fresh Gemini-only cache namespace.
  const TRANSLATION_PROMPT_VERSION = 4; // Gemini-only contextual lyric localization, V58.
  let nextGeminiRequestAt = 0;
  let lastTrackSwitchAt = Date.now();
  let currentSongId = '';
  let queueRunning = false;
  const stats = {
    geminiCalls: 0, geminiSuccess: 0, geminiResponses: 0, geminiTranslatedLines: 0,
    geminiEmptyResponses: 0, parseFailures: 0, lastStatus: null,
    http400: 0, http401: 0, http403: 0, http404: 0, http429: 0,
    http500: 0, http502: 0, http503: 0, http504: 0,
    trackSwitches: 0, cacheReuse: 0, stalePurged: 0
  };
  async function waitForGeminiSlot(epoch) {
    while (Date.now() < nextGeminiRequestAt) {
      if (disposed || epoch !== generationId || !isEnabled) throw new Error('İstek iptal edildi');
      await sleep(Math.min(300, nextGeminiRequestAt - Date.now()));
    }
    if (disposed || epoch !== generationId || !isEnabled) throw new Error('İstek iptal edildi');
    nextGeminiRequestAt = Date.now() + GEMINI_MIN_START_INTERVAL_MS;
  }
  function trackIdentity() {
    const item = Spicetify?.Player?.data?.item;
    return item?.uri || item?.id || (item?.name ? `${item.name}::${(item.artists || []).map(a => a.name).join(',')}` : '');
  }

  // The old cache used only the raw lyric as its key. That reused translations
  // across unrelated songs, even when the same words had a different subject,
  // idiom or meaning. V58 uses a fresh storage namespace and scopes entries to
  // the Spotify track identity.
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
    return undefined;
  };
  cache.set = function (text, value) {
    const trackId = activeCacheTrackId();
    const nextValue = { ...(value || {}), songId: trackId };
    if (nextValue.source === 'gemini') nextValue.promptVersion = TRANSLATION_PROMPT_VERSION;
    return rawCacheSet(scopedCacheKey(text, trackId), nextValue);
  };
  cache.has = function (text) { return this.get(text) !== undefined; };
  cache.delete = function (text) {
    const scopedDeleted = rawCacheDelete(scopedCacheKey(text));
    const legacyDeleted = rawCacheDelete(String(text));
    return scopedDeleted || legacyDeleted;
  };
  function clearTranslationCache() {
    abortOngoingWork();
    queueRunning = false;
    clearTimeout(batchTimer); batchTimer = null;
    clearTimeout(postResetScanTimer); postResetScanTimer = null;
    clearScheduledScans();
    inFlight.clear();
    failedUntil.clear();
    cache.clear();
    lastCacheClearRemoved = purgeTranslationCacheStorage(true);
    lastCacheClearAt = Date.now();
    currentSongId = trackIdentity() || currentSongId;
    clearRenderedSubtitles();
    // BUG FIX (V58.0.1): "Önbelleği sıfırla" only cleared cached lines; it
    // never cleared deadModels/modelCooldowns/comboCooldowns/keyCooldowns/
    // projectCooldowns. A single 429/403/5xx run could leave every model
    // and key globally cooled down for up to 24 saat, and that state is
    // persisted to localStorage (BACKOFF_STATE_KEY) across reloads - so the
    // extension silently sent zero requests afterward, with no way for the
    // user to recover from the UI. A cache reset must also clear this.
    deadModels.clear();
    modelCooldowns.clear();
    comboCooldowns.clear();
    keyCooldowns.clear();
    projectCooldowns.clear();
    geminiKeyCursor = 0;
    geminiGloballyDownUntil = 0;
    geminiLastError = '';
    geminiLastModel = '';
    saveBackoffState();
    return { cacheLines: cache.size, removedStorageKeys: lastCacheClearRemoved };
  }

  function invalidateTrackWork() {
    abortOngoingWork();
    // Release the logical queue immediately. Old async work is fenced by its
    // generation ID and must not block or clean up the new song's queue.
    queueRunning = false;
    inFlight.clear();
    failedUntil.clear();
    clearTimeout(batchTimer);
    batchTimer = null;
    clearScheduledScans();
    lastTrackSwitchAt = Date.now();
    stats.trackSwitches++;
  }
  window.__spicyTRDiagnostics = () => ({
    version: '58.0.1',
    engine: 'Gemini only',
    enabled: isEnabled,
    keyCount: geminiApiKeys.length,
    ...stats,
    currentSong: currentSongId,
    cacheLines: cache.size,
    cacheStorageKey: STORAGE_CACHE_KEY,
    startupPurgedLegacyCacheCount,
    inFlightLines: inFlight.size,
    queueRunning,
    availableModels: GEMINI_MODELS.filter(m => geminiApiKeys.some(k => isGeminiComboReady(k, m))),
    nextRequestInSec: Math.max(0, Math.ceil((nextGeminiRequestAt - Date.now()) / 1000)),
    geminiMinStartIntervalMs: GEMINI_MIN_START_INTERVAL_MS,
    perKeyModelCooldowns: comboCooldowns.size,
    quotaGroups: new Set(geminiApiKeys.map(quotaGroupId)).size,
    projectCooldowns: projectCooldowns.size,
    maxLinesPerGeminiCall: MAX_LINES_PER_GEMINI_CALL,
    geminiTimeoutMs: GEMINI_TIMEOUT_MS,
    nextAvailableInSec: Math.max(0, Math.ceil((nextGeminiAvailableAt() - Date.now()) / 1000)),
    lastModel: geminiLastModel,
    lastError: geminiLastError
  });

  const BACKOFF_STATE_KEY = 'spicy_tr_backoff_state_v2';
  function saveBackoffState() {
    try {
      const state = {
        cooldownSchema: 4,
        deadModels: Array.from(deadModels.entries()),
        modelCooldowns: Array.from(modelCooldowns.entries()),
        comboCooldowns: Array.from(comboCooldowns.entries()),
        keyCooldowns: Array.from(keyCooldowns.entries()),
        projectCooldowns: Array.from(projectCooldowns.entries())
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
      const restore = (target, entries) => {
        if (!Array.isArray(entries)) return;
        entries.forEach(([key, until]) => {
          if (typeof key === 'string' && Number.isFinite(until) && until > now) {
            target.set(key, until);
          }
        });
      };
      if (state.cooldownSchema >= 4) {
        restore(deadModels, state.deadModels);
        restore(modelCooldowns, state.modelCooldowns);
        restore(comboCooldowns, state.comboCooldowns);
        restore(keyCooldowns, state.keyCooldowns);
        restore(projectCooldowns, state.projectCooldowns);
      }
      if (deadModels.size || modelCooldowns.size || comboCooldowns.size ||
          keyCooldowns.size || projectCooldowns.size) {
        log('Geçerli Gemini kota/servis beklemeleri geri yüklendi.');
      }
    } catch (e) {
      warn('Gemini bekleme kayıtları okunamadı; temiz durumla devam ediliyor.');
    }
  }
  loadBackoffState();
  if (startupPurgedLegacyCacheCount > 0) {
    log(`V58 ilk açılışta ${startupPurgedLegacyCacheCount} eski çeviri önbelleği anahtarını sildi; API anahtarları ve proje etiketleri korundu.`);
  }
  
  // Stable text-generation models, ordered by quality/latency.
  const GEMINI_MODELS = [
    'gemini-3.8-flash',
    'gemini-3.7-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash-lite'
  ];

  let isEnabled = localStorage.getItem('spicy_tr_enabled') !== 'false';
  let batchTimer = null;
  let postResetScanTimer = null;
  let scanScheduled = false;
  let scanScheduledTimer = null;
  const multiStageScanTimers = new Set();

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

  function keyFingerprint(apiKey) {
    let h = 2166136261;
    for (const ch of String(apiKey || '')) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(16);
  }
  const KEY_GROUPS_STORAGE = 'spicy_tr_gemini_key_groups_v1';
  let geminiKeyGroups = new Map();
  try {
    const storedGroups = JSON.parse(localStorage.getItem(KEY_GROUPS_STORAGE) || '{}');
    for (const key of geminiApiKeys) {
      const group = storedGroups[keyFingerprint(key)];
      if (typeof group === 'string' && group.trim()) geminiKeyGroups.set(key, group.trim());
    }
  } catch (e) {}
  function quotaGroupId(apiKey) {
    // Unlabelled keys are treated as separate projects. To share one quota
    // cooldown, enter the same project label before each key in settings.
    return geminiKeyGroups.get(apiKey) || `key:${keyFingerprint(apiKey)}`;
  }
  function saveKeyGroups() {
    try {
      const stored = {};
      for (const [key, group] of geminiKeyGroups) stored[keyFingerprint(key)] = group;
      localStorage.setItem(KEY_GROUPS_STORAGE, JSON.stringify(stored));
    } catch (e) {}
  }

  const MAX_LINES_PER_GEMINI_CALL = 8;
  const GEMINI_MAX_OUTPUT_TOKENS = 3072;

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
    const id = comboId(key, model);
    return (deadModels.get(id) || 0) <= now &&
      (comboCooldowns.get(id) || 0) <= now &&
      (projectCooldowns.get(quotaGroupId(key)) || 0) <= now &&
      (keyCooldowns.get(keyId(key)) || 0) <= now &&
      (modelCooldowns.get(model) || 0) <= now;
  }
  function nextGeminiAvailableAt() {
    if (geminiApiKeys.length === 0) return 0;
    const now = Date.now();
    let earliest = Infinity;
    for (const model of GEMINI_MODELS) for (const key of geminiApiKeys) {
      const id = comboId(key, model);
      const next = Math.max(deadModels.get(id) || 0,
        comboCooldowns.get(id) || 0, projectCooldowns.get(quotaGroupId(key)) || 0,
        keyCooldowns.get(keyId(key)) || 0, modelCooldowns.get(model) || 0);
      if (next <= now) return now;
      earliest = Math.min(earliest, next);
    }
    return earliest === Infinity ? 0 : earliest;
  }
  function syncGeminiCooldown() {
    // Derive the global wait only from actual model/key/project cooldowns.
    const next = nextGeminiAvailableAt();
    geminiGloballyDownUntil = next > Date.now() ? next : 0;
    return geminiGloballyDownUntil;
  }

  function markFailed(text, cooldownMs) {
    failedUntil.set(text, Date.now() + (cooldownMs || FAILURE_COOLDOWN_MS));
  }

  function saveCache() {
    try {
      // Persist only usable Gemini translations and Gemini-generated romanization.
      const entries = Array.from(cache.entries()).map(([k, v]) => {
        if (!v || (!v.tr && !v.romaja)) return null;
        return [k, v];
      }).filter(Boolean).slice(-6000);
      localStorage.setItem(STORAGE_CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
    } catch (e) {}
  }

  const TURKISH_COMMON_WORDS = /\b(bir|bu|şu|ben|sen|biz|siz|değil|gibi|için|ama|çok|var|yok|ile|ne|nasıl|neden|her|daha|olan|oldu|olacak|sanki|kadar|benim|senin|onun|beni|seni|bana|sana|benimle|seninle|gel|gelse|değilsin|yine|hep|artık|belki|hiç|hadi|al|ver|kal|ol|git|bunu|şimdi|hepsi|herkes|istiyorum|istiyorsun|istersen|vereceğim|veririm|yeniden)\b/i;
  function looksTurkish(text) {
    if (!text) return false;
    // Mixed-script lyrics must still be translated; a Turkish-looking fragment
    // must not cause the whole Korean/Japanese/Chinese line to be skipped.
    if (isNonLatin(text)) return false;
    if (/[çÇğĞıİşŞöÖüÜ]/.test(text)) return true;
    const words = text.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return false;
    const matches = words.filter(w => TURKISH_COMMON_WORDS.test(w)).length;
    return matches >= 2 || (words.length <= 3 && matches >= 1);
  }

  // Reject obviously malformed model output with missing word boundaries.
  // This protects the cache from a single bad generation.
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
    for (const [cacheKey, data] of Array.from(rawCacheEntries())) {
      if (!data) continue;
      const separatorAt = cacheKey.indexOf(CACHE_KEY_SEPARATOR);
      const isTrackScoped = separatorAt >= 0;
      const rawLine = isTrackScoped ? cacheKey.slice(separatorAt + 1) : cacheKey;

      // Any unscoped legacy translation is unsafe across different songs.
      if (!isTrackScoped && data.tr) {
        data.tr = '';
        data.source = 'romanization';
        data.translationVersion = CACHE_TRANSLATION_VERSION;
        rawCacheSet(cacheKey, data);
        stats.stalePurged++;
        reformalFixed++;
      }


      // Re-translate old Gemini entries after the localization prompt/model change.
      if (data.tr && data.source === 'gemini' && data.translationVersion !== CACHE_TRANSLATION_VERSION) {
        data.tr = '';
        data.source = 'romanization';
        rawCacheSet(cacheKey, data);
        stats.stalePurged++;
        reformalFixed++;
      }
      if (data.tr && !data.source) {
        data.source = 'legacy';
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
    /* Never override Spotify's native lyric rows, blur, opacity or backgrounds. */
    #SpicyLyricsPage .spicy-tr-box {
      display: block !important;
      width: 100% !important;
      flex-basis: 100% !important;
      margin-top: 6px !important;
      pointer-events: none !important;
      line-height: 1.35 !important;
    }
    html.spicy-tr-off #SpicyLyricsPage .spicy-tr-box,
    html.spicy-tr-off #SpicyLyricsPage .spicy-tr-romaja,
    html.spicy-tr-off #SpicyLyricsPage .spicy-tr-turkish,
    body.spicy-tr-off #SpicyLyricsPage .spicy-tr-box {
      display: none !important;
    }
    #SpicyLyricsPage .spicy-tr-romaja {
      font-size: 0.46em !important;
      font-weight: 500 !important;
      color: rgba(255, 255, 255, 0.82) !important;
      -webkit-text-fill-color: rgba(255, 255, 255, 0.82) !important;
      word-spacing: 2px !important;
    }
    #SpicyLyricsPage .spicy-tr-turkish {
      font-size: 0.52em !important;
      font-weight: 700 !important;
      color: #ffffff !important;
      -webkit-text-fill-color: #ffffff !important;
    }
    #SpicyLyricsPage .spicy-tr-credit-romaja {
      font-size: 0.88em !important;
      font-weight: 500 !important;
      color: rgba(255, 255, 255, 0.72) !important;
      -webkit-text-fill-color: rgba(255, 255, 255, 0.72) !important;
      white-space: normal !important;
      margin-left: 0.18em !important;
    }
    html.spicy-tr-off #SpicyLyricsPage .spicy-tr-credit-romaja,
    body.spicy-tr-off #SpicyLyricsPage .spicy-tr-credit-romaja {
      display: none !important;
    }
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
  offGuardStyle.id = 'spicy-tr-v58-off-guard';
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
    document.querySelectorAll('#SpicyLyricsPage .spicy-tr-box, #SpicyLyricsPage .spicy-tr-credit-romaja').forEach(el => el.remove());
    document.querySelectorAll('#SpicyLyricsPage [data-spicy-tr-credit-source]').forEach(el => {
      delete el.dataset.spicyTrCreditSource;
    });
  }
  applyEnabledClass();
  clearRenderedSubtitles();

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


  function romanizeHangulText(value) {
    return Array.from(String(value || '')).map(char => {
      const code = char.codePointAt(0);
      if (code < 0xAC00 || code > 0xD7A3) return char;
      const syllable = code - 0xAC00;
      const initial = Math.floor(syllable / 588);
      const vowel = Math.floor((syllable % 588) / 28);
      const final = syllable % 28;
      return HANGUL_INITIALS[initial] + HANGUL_VOWELS[vowel] + HANGUL_FINALS[final];
    }).join('');
  }

  function capitalizeCreditRomanization(value) {
    return String(value || '').replace(/(^|[\s-])([a-z])/g, (_, prefix, letter) => prefix + letter.toUpperCase());
  }

  function romanizeCreditNames(value) {
    return String(value || '').split(/[,;&/·•]|\band\b/i)
      .map(name => name.trim())
      .filter(name => /[\uAC00-\uD7A3]/.test(name))
      .map(name => capitalizeCreditRomanization(romanizeHangulText(name)))
      .filter(Boolean);
  }

  function processSongwriterCredits() {
    const page = document.querySelector('#SpicyLyricsPage');
    if (!page) return;

    // Don't depend on a Spicy Lyrics internal class name: find the smallest
    // element whose complete text is the songwriter credit line.
    const elements = [page, ...page.querySelectorAll('*')];
    elements.forEach(el => {
      if (el.closest?.('.spicy-tr-box')) return;

      let sourceText = el.textContent || '';
      el.querySelectorAll('.spicy-tr-credit-romaja').forEach(node => {
        sourceText = sourceText.replace(node.textContent || '', '');
      });
      const raw = sourceText.replace(/\s+/g, ' ').trim();
      const existing = Array.from(el.children || []).find(child => child.className === 'spicy-tr-credit-romaja') || null;
      if (!raw || raw.length > 180) {
        existing?.remove();
        delete el.dataset.spicyTrCreditSource;
        return;
      }

      const writtenBy = raw.match(/^written\s+by\s*:?\s*(.+)$/i);
      if (!writtenBy) {
        existing?.remove();
        delete el.dataset.spicyTrCreditSource;
        return;
      }

      // A wrapper can contain the same line as a nested child. Process only
      // the innermost matching element to avoid duplicate annotations.
      const hasMatchingChild = Array.from(el.children || []).some(child => {
        let childText = child.textContent || '';
        child.querySelectorAll('.spicy-tr-credit-romaja').forEach(node => {
          childText = childText.replace(node.textContent || '', '');
        });
        return /^written\s+by\s*:?\s*.+$/i.test(childText.replace(/\s+/g, ' ').trim());
      });
      if (hasMatchingChild) {
        existing?.remove();
        delete el.dataset.spicyTrCreditSource;
        return;
      }

      if (el.dataset.spicyTrCreditSource === raw && existing) return;
      existing?.remove();
      delete el.dataset.spicyTrCreditSource;

      // Some layouts put provider attribution in the same text container.
      const namesText = writtenBy[1].split(/\bprovided\s+by\b/i)[0].trim();
      const romanizedNames = romanizeCreditNames(namesText);
      el.dataset.spicyTrCreditSource = raw;
      if (!romanizedNames.length) return;

      const span = document.createElement('span');
      span.className = 'spicy-tr-credit-romaja';
      span.textContent = ` (${romanizedNames.join(', ')})`;
      span.title = 'Korece isimlerin yaklaşık Latin harfli okunuşu';
      el.appendChild(span);
    });
  }

  function getCleanText(lineEl) {
    const clone = lineEl.cloneNode(true);
    clone.querySelectorAll('.spicy-tr-box').forEach(el => el.remove());
    return (clone.textContent || '').replace(/\s+/g, ' ').trim();
  }

  // V49: Never rewrite suffixes with blanket regexes; they mutated valid Turkish
  // nouns/verbs and silently degraded otherwise valid translations.
  function forcePerfectTurkish(text) {
    if (!text) return '';
    const t = String(text).replace(/\s+/g, ' ').trim();
    return t ? t[0].toLocaleUpperCase('tr-TR') + t.slice(1) : '';
  }

  function cleanPhrase(s) {
    return String(s || '').toLowerCase().replace(/['’‘]/g, '')
      .replace(/[.,!?;:()"'-]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function isUsableTranslation(original, translated, songTitle = '', artist = '') {
    if (!translated) return false;
    if (normalize(original) === normalize(translated)) {
      const sourcePhrase = cleanPhrase(original);
      const metadataPhrases = [songTitle, artist].filter(Boolean).map(cleanPhrase);
      const withoutVocalTail = sourcePhrase.replace(/(?:\s+(?:a|o|oh|yeah))+$/g, '').trim();
      if (!metadataPhrases.includes(sourcePhrase) && !metadataPhrases.includes(withoutVocalTail)) return false;
    }
    if (looksGluedTranslation(original, translated)) return false;
    if (/<[^>]*>|&(?:#\d+|[a-z]+);/i.test(translated)) return false;
    if (cleanPhrase(original).includes('talk to me') && /konuşma cihaz/i.test(translated)) return false;

    // Reject English grammar left in the Turkish field (for example, "I'm reborn").
    // Genuine song/artist names are stripped before this check so a title can
    // remain in a Turkish sentence without making the whole line look untranslated.
    const sourceHasWords = /[A-Za-z]{2,}/.test(original);
    const sourceIsStandaloneCredit = cleanPhrase(original) === cleanPhrase(songTitle) ||
      cleanPhrase(original) === cleanPhrase(artist);
    const isBamBamRibbonTrack = cleanPhrase(songTitle).replace(/\s+/g, '') === 'ribbon' &&
      /bambam/.test(cleanPhrase(artist));
    if (isBamBamRibbonTrack && cleanPhrase(original) === 'im ribbon' && /kurdele/i.test(translated)) return false;
    if (isBamBamRibbonTrack && /풀어봐/.test(original) && !/kurdele/i.test(translated)) return false;
    let translatedWithoutNames = String(translated);
    for (const name of [songTitle, artist].filter(Boolean)) {
      const escapedName = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (escapedName) translatedWithoutNames = translatedWithoutNames.replace(new RegExp(escapedName, 'gi'), ' ');
    }
    const untranslatedEnglish = /\b(?:i['’]?m|i\s+am|you(?:['’]?re|\s+are)?|my|me|we|our|they|he|she|it|the|an|and|but|or|to|for|of|in|on|with|is|are|was|were|be|been|does|did|have|has|had|will|would|can|could|should|what|when|where|why|how|now|here|there|wanna|gonna|gotta|reborn|born|ribbon|everything|fine|look|stay|feel|light|tonight|fault|girl|baby)\b/i;
    if (sourceHasWords && untranslatedEnglish.test(translatedWithoutNames) && !sourceIsStandaloneCredit) return false;

    // A Turkish subtitle must not accidentally contain a whole untranslated
    // Korean/Japanese/Chinese/Thai/Cyrillic/Arabic line. A few proper-name
    // characters are tolerated, but script-heavy output is rejected.
    const foreignScriptChars = (translated.match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\u0e00-\u0e7f\u0400-\u04ff\u0600-\u06ff]/g) || []).length;
    const letters = (translated.match(/\p{L}/gu) || []).length;
    if (letters >= 4 && foreignScriptChars / letters > 0.2) return false;
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
    const marker = `${data.tr || ''}\u0000${data.romaja || ''}\u0000${data.source || ''}`;
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

    const showTr = data.source === 'gemini';
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
    if (!rawOutput || !Number.isFinite(expectedCount) || expectedCount < 1) return null;
    const cleaned = String(rawOutput).trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();

    const normalizeItems = (value) => {
      const items = Array.isArray(value) ? value :
        (Array.isArray(value?.translations) ? value.translations :
         (Array.isArray(value?.results) ? value.results : null));
      if (!items || !items.length) return null;

      const hasAnyId = items.some(item => item && item.id !== undefined && item.id !== null);
      const normalizeItem = item => ({
        tr: typeof item?.tr === 'string' ? item.tr :
            typeof item?.translation === 'string' ? item.translation :
            typeof item?.turkish === 'string' ? item.turkish : '',
        rom: typeof item?.rom === 'string' ? item.rom :
             typeof item?.romaja === 'string' ? item.romaja :
             typeof item?.romanization === 'string' ? item.romanization : ''
      });

      if (hasAnyId) {
        const out = Array(expectedCount).fill(null);
        const seen = new Set();
        for (const item of items) {
          const id = Number(item?.id);
          if (!Number.isInteger(id) || id < 1 || id > expectedCount || seen.has(id)) return null;
          seen.add(id);
          out[id - 1] = normalizeItem(item);
        }
        return out;
      }

      // Without explicit IDs, only a complete response can safely be aligned.
      if (items.length !== expectedCount) return null;
      return items.map(normalizeItem);
    };

    try {
      const parsed = normalizeItems(JSON.parse(cleaned));
      if (parsed) return parsed;
    } catch (e) {
      // A truncated response may still contain complete ID-tagged objects.
    }

    // Salvage complete objects only when each has an explicit, unique line ID.
    const objects = [];
    let depth = 0;
    let objectStart = -1;
    let inString = false;
    let escaped = false;
    for (let i = 0; i < cleaned.length; i++) {
      const ch = cleaned[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{') {
        if (depth === 0) objectStart = i;
        depth++;
      } else if (ch === '}' && depth > 0) {
        depth--;
        if (depth === 0 && objectStart >= 0) {
          try {
            const item = JSON.parse(cleaned.slice(objectStart, i + 1));
            if (item && typeof item === 'object' && !Array.isArray(item)) objects.push(item);
          } catch (e) {}
          objectStart = -1;
          if (objects.length >= expectedCount) break;
        }
      }
    }
    return normalizeItems(objects);
  }

  function getTrackContextHint(songTitle, artist) {
    const title = cleanPhrase(songTitle).replace(/\s+/g, '');
    const artists = cleanPhrase(artist);
    if (title === 'ribbon' && /bambam/.test(artists)) {
      return `SPECIAL CONTEXT FOR THIS TRACK (BamBam — riBBon): The title is a deliberate double meaning: English “reborn” (yeniden doğmak) and “ribbon” (kurdele); BamBam has explained that both meanings are intentional. The song is about a hopeful new beginning and presenting a renewed self, while also using ribbon/unwrapping a gift imagery. Translate “I'm riBBon” with the rebirth meaning (for example, “Yeniden doğdum”), NOT as “Ben bir kurdeleyim” and NOT by copying the English. When the lyric says “RiBBon을 풀어봐”, keep the literal gift/ribbon image (for example, “Kurdeleyi çöz bakalım”). “무엇을 원해 원해” is a direct question/offer in context (“Ne istersin, ne istersin?” / “Ne istersen, ne istersen?”); choose the natural Turkish phrasing that fits the neighboring line. “뭐든 다 줄게 For sure” means “Ne istersen hepsini vereceğim, kesinlikle.” Do not apply this note to unrelated tracks.`;
    }
    return '';
  }

  async function translateChunkWithGemini(chunkLines, allSongLines, epoch) {
    const songTitle = Spicetify?.Player?.data?.item?.name || 'Unknown Song';
    const artist = Spicetify?.Player?.data?.item?.artists?.map(a => a.name).filter(Boolean).join(', ') || 'Unknown Artist';
    const trackContextHint = getTrackContextHint(songTitle, artist);
    const firstIndex = Math.max(0, allSongLines.indexOf(chunkLines[0]));
    const endIndex = Math.max(firstIndex, allSongLines.indexOf(chunkLines[chunkLines.length - 1]));
    const contextLinesText = allSongLines.slice(Math.max(0, firstIndex - 2), endIndex + 3)
      .map((line, index) => `${Math.max(1, firstIndex - 1) + index}. ${line}`).join('\n').slice(0, 1800);
    const targetLinesText = chunkLines.map((line, index) => `[ID:${index + 1}] ${line}`).join('\n');
    const prompt = `You are a professional multilingual song-lyric localizer. Translate the target lyrics into fluent, natural Turkish.
Song: ${songTitle} — ${artist}
${trackContextHint ? `
${trackContextHint}
` : ''}
Nearby lyrics for context only:
${contextLinesText}

Translate every target line below, preserving its ID and order:
${targetLinesText}

RULES
- Translate meaning and intent, not isolated dictionary words. Read the lines as one connected stanza and use context to resolve pronouns, omitted subjects, tense, idioms and wordplay.
- Keep Turkish conversational and natural. Preserve the speaker, addressee, negation, tense, number, emotional tone and metaphors.
- Do not censor, sanitize or soften profanity, sexual language, insults or slang. Choose the actual Turkish equivalent that fits this exact context; never replace explicit words with vague euphemisms. In a crude sexual context, keep words such as "pussy" and "dick" equally explicit in Turkish; do not turn them into "ora" or "özel bölge". Do not mechanically translate "fuckin'" as "lanet olasıcasına"; determine whether it is an action, insult or intensifier.
- For Korean/English mixed lines, translate every ordinary Korean and English word into Turkish. A line is not exempt just because it contains the song title, a repeated phrase, a stylized spelling or a hook.
- Keep a title/name only when it is functioning as a proper name by itself. If it is part of a sentence, translate the sentence's intended meaning while preserving the wordplay naturally; never copy a whole English clause into the Turkish field.
- Do not leave ordinary source-language words untranslated. Translate "Talk to me" as "Benimle konuş", never as a device or object. Translate "I'm riBBon" by meaning when the track-specific note applies. Do not put romanization in the Turkish field.
- Preserve repetitions, ad-libs, parentheses and unfinished line fragments. Do not invent actions, causes or emotions.
- The "rom" field is only a readable Latin-script pronunciation of the original non-Latin text. It is not a translation. Use an empty string for Latin-script source lines.
- Before returning, compare each Turkish line with its source for meaning, subject, negation and natural phrasing.

Return only a JSON array with exactly ${chunkLines.length} objects. Each object must be {"id":1,"tr":"natural Turkish translation","rom":"romanization"} using the matching 1-based ID. Include one object per target line; never omit or reorder IDs. No markdown or commentary.`;

    let lastError = new Error('Gemini kombinasyonları şu an kullanılamıyor');
    const keyCount = geminiApiKeys.length;
    if (keyCount === 0) throw lastError;
    // Rotate starting key between batches; skip a model globally after service overload.
    const startKey = geminiKeyCursor++ % keyCount;
    const batchStarted = Date.now();
    let attempted = 0;
    const requestBody = (includeThinking = true) => ({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS,
        responseMimeType: 'application/json',
        ...(includeThinking ? { thinkingConfig: { thinkingLevel: 'low' } } : {})
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
        let includeThinking = true;
        try {
          let response;
          let errJson = null;
          let bodyMsg = '';
          let usedSimpleRetry = false;
          for (;;) {
            await waitForGeminiSlot(epoch);
            const remainingMs = GEMINI_BATCH_TIME_BUDGET_MS - (Date.now() - batchStarted);
            if (remainingMs < 2500) throw new Error('Grup istek zaman bütçesi doldu');
            stats.geminiCalls++;
            response = await fetchWithTimeout(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey.trim() },
              body: JSON.stringify(requestBody(includeThinking))
            }, Math.min(GEMINI_TIMEOUT_MS, remainingMs));
            if (epoch !== generationId) throw new Error('İstek iptal edildi');
            if (response.ok) break;
            errJson = null; bodyMsg = '';
            try {
              errJson = await response.json();
              bodyMsg = String(errJson?.error?.message || '').slice(0, 500);
            } catch (e) { /* keep HTTP status even if error body isn't JSON */ }
            // If a model rejects the optional thinking setting, retry once without it.
            if (response.status === 400 && includeThinking && !usedSimpleRetry &&
                /thinking.?config|thinking.?level/i.test(bodyMsg)) {
              includeThinking = false;
              usedSimpleRetry = true;
              warn(`${model}: thinking ayarı desteklenmedi; sade istek bir kez deneniyor.`);
              continue;
            }
            break;
          }
          if (!response.ok) {
            const status = response.status;
            const reasons = (errJson?.error?.details || [])
              .map(d => d?.reason || d?.metadata?.reason || '')
              .filter(Boolean).join(',');
            const diagnosticText = `${bodyMsg} ${reasons}`.trim();
            geminiLastError = `${model} (anahtar ${j + 1}): HTTP ${status}${reasons ? ` [${reasons}]` : ''} ${bodyMsg}`.trim();
            if (Object.prototype.hasOwnProperty.call(stats, `http${status}`)) stats[`http${status}`]++;
            stats.lastStatus = status;
            geminiLastModel = model;
            const now = Date.now();
            const invalidKey = /(?:api[_ -]?key[_ -]?invalid|api[_ -]?key[_ -]?service[_ -]?blocked|service blocked|invalid api key|api key not valid|permission.*api key|key was reported as invalid|auth key required|migrate.*auth key|standard.*api key|unrestricted.*standard|authorization.*key)/i.test(diagnosticText);
            if (status === 429) {
              const retryMs = parseRetryDelayMs(errJson, bodyMsg, response.headers?.get?.('Retry-After'));
              const daily = /(?:per day|daily|requests per day|RPD|per_day|quota_exceeded)/i.test(diagnosticText);
              const wait = Math.min(daily ? Math.max(retryMs || 0, untilPacificDailyResetMs(now)) :
                (retryMs || MODEL_DEAD_QUOTA_DEFAULT_MS), MODEL_DEAD_QUOTA_MAX_MS);
              const groupId = quotaGroupId(apiKey);
              projectCooldowns.set(groupId, now + Math.max(1000, wait));
              comboCooldowns.set(id, now + Math.max(1000, wait));
              warn(`${model}: Gemini proje kotası 429 döndürdü; ${formatDuration(wait)} bekleyecek.`);
            } else if (status === 503 || status === 500 || status === 502 || status === 504) {
              // Service overload is model-wide; do not burn other keys on the same model.
              modelCooldowns.set(model, now + (status === 503 ? 15000 : 10000));
            } else if (invalidKey || status === 401 || status === 402) {
              keyCooldowns.set(keyId(apiKey), now + MODEL_DEAD_LONG_MS);
            } else if (status === 404) {
              modelCooldowns.set(model, now + MODEL_DEAD_LONG_MS);
            } else if (status === 403) {
              modelCooldowns.set(model, now + MODEL_CONFIG_COOLDOWN_MS);
            } else if ([400, 422, 501].includes(status)) {
              modelCooldowns.set(model, now + MODEL_CONFIG_COOLDOWN_MS);
            } else {
              deadModels.set(id, now + MODEL_DEAD_SHORT_MS);
            }
            saveBackoffState();
            lastError = new Error(geminiLastError);
            continue;
          }
          const json = await response.json();
          stats.geminiResponses++;
          stats.lastStatus = 200;
          geminiLastModel = model;
          // Some Gemini responses contain thought/metadata parts before text.
          const rawOutput = (json?.candidates?.[0]?.content?.parts || [])
            .filter(p => !p?.thought && typeof p?.text === 'string')
            .map(p => p.text).join('');
          const parsed = parseGeminiJsonArray(rawOutput, chunkLines.length);
          if (!parsed?.length) {
            stats.parseFailures++;
            const parseError = new Error(`Gemini JSON okunamadı (finishReason=${json?.candidates?.[0]?.finishReason || 'unknown'})`);
            parseError.code = 'GEMINI_INVALID_RESPONSE';
            throw parseError;
          }
          if (parsed.some(item => !item)) {
            const missingCount = parsed.filter(item => !item).length;
            warn(`Gemini ${chunkLines.length} satırın ${missingCount} tanesini eksik döndürdü; yalnızca eksikler kısa gruplarla yeniden denenecek.`);
          }
          if (epoch !== generationId) throw new Error('İstek iptal edildi');

          const acceptedGeminiLines = new Set();
          chunkLines.forEach((rawLine, i) => {
            const item = parsed[i] || {};
            const existing = cache.get(rawLine) || {};
            const cleanTr = typeof item.tr === 'string' && item.tr.trim()
              ? fixGluedWords(forcePerfectTurkish(item.tr.trim())) : '';
            let cleanRom = '';
            if (isNonLatin(rawLine)) {
              const romRaw = typeof item.rom === 'string' ? item.rom.trim() : '';
              if (looksGluedRomaja(rawLine, romRaw)) {
                const repaired = splitRepeatingUnit(romRaw);
                if (repaired) cleanRom = repaired;
                else cleanRom = '';
              } else cleanRom = fixGluedWords(romRaw);
            }
            const usableTr = !!cleanTr && isUsableTranslation(rawLine, cleanTr, songTitle, artist) &&
              (!cleanRom || normalize(cleanTr) !== normalize(cleanRom));
            if (usableTr) acceptedGeminiLines.add(rawLine);
            // Keep Gemini-generated romanization even if the Turkish field was omitted.
            if (usableTr || cleanRom) {
              cache.set(rawLine, {
                tr: usableTr ? cleanTr : (existing.tr || ''),
                romaja: cleanRom || existing.romaja || '',
                source: usableTr ? 'gemini' : (existing.source || 'romanization'),
                translationVersion: usableTr ? CACHE_TRANSLATION_VERSION : (existing.translationVersion || CACHE_TRANSLATION_VERSION),
                    });
            }
          });
          if (acceptedGeminiLines.size > 0) {
            geminiLastError = '';
            stats.geminiSuccess++;
            stats.geminiTranslatedLines += acceptedGeminiLines.size;
          } else {
            stats.geminiEmptyResponses++;
            geminiLastError = `${model}: HTTP 200 alındı ancak kullanılabilir Türkçe satır üretilemedi.`;
            modelCooldowns.set(model, Date.now() + 10000);
          }
          modelCooldowns.delete(model);
          comboCooldowns.delete(id);
          deadModels.delete(id);
          saveBackoffState();
          saveCache();
          updateDOMWithCache();
          return chunkLines.filter(line => !acceptedGeminiLines.has(line));
        } catch (e) {
          if (epoch !== generationId) throw e;
          lastError = e;
          geminiLastError = `${model} (anahtar ${j + 1}): ${e?.name === 'AbortError' ? 'zaman aşımı' : (e?.message || e)}`;
          if (e?.name === 'AbortError' || e?.code === 'GEMINI_INVALID_RESPONSE') {
            // A timeout or malformed model response is not an API-key problem.
            // Cool down the model and move to the next model instead of retrying
            // the same slow model with every configured key.
            modelCooldowns.set(model, Date.now() + (e?.name === 'AbortError' ? 12000 : 10000));
            saveBackoffState();
            break;
          }
          if (isGeminiComboReady(apiKey, model)) {
            comboCooldowns.set(id, Date.now() + 30000);
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

  function chunkArray(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  function buildPriorityGroups(lines, allOrdered, activeText, groupSize) {
    if (!activeText) return chunkArray(lines, groupSize);
    const activeIdx = allOrdered.indexOf(activeText);
    if (activeIdx === -1) return chunkArray(lines, groupSize);

    const positions = new Map(allOrdered.map((line, index) => [line, index]));
    const upcoming = [];
    const earlier = [];
    for (const line of lines) {
      const index = positions.get(line);
      if (index === undefined || index >= activeIdx) upcoming.push(line);
      else earlier.push(line);
    }
    upcoming.sort((a, b) => (positions.get(a) ?? Infinity) - (positions.get(b) ?? Infinity));
    earlier.sort((a, b) => (positions.get(a) ?? Infinity) - (positions.get(b) ?? Infinity));

    // Keep the end-of-song -> start-of-song wrap between groups. A batch must
    // never combine lyrics from opposite ends of the track as one stanza.
    return [...chunkArray(upcoming, groupSize), ...chunkArray(earlier, groupSize)];
  }

  async function processQueue(allVisibleLines, activeText) {
    if (disposed || !isEnabled || queueRunning || !geminiApiKeys.length) return;
    const epoch = generationId;
    const now = Date.now();
    let missing = allVisibleLines.filter(t =>
      (!cache.get(t)?.tr || cache.get(t)?.source !== 'gemini') &&
      !inFlight.has(t) && (failedUntil.get(t) || 0) <= now
    );
    if (missing.length === 0) return;

    queueRunning = true;
    missing.forEach(t => inFlight.add(t));

    const retryWaitMs = () => {
      const next = nextGeminiAvailableAt();
      return next > Date.now()
        ? Math.min(MODEL_DEAD_QUOTA_MAX_MS, next - Date.now())
        : FAILURE_COOLDOWN_MS;
    };

    const startGemini = async (lines) => {
      if (!lines.length || !geminiApiKeys.length) return;
      if (nextGeminiAvailableAt() > Date.now()) return;
      try {
        const missingFromResponse = await translateChunkWithGemini(lines, allVisibleLines, epoch);
        // Retry only omitted rows, once, in a small batch. Never resend completed rows.
        if (missingFromResponse.length && missingFromResponse.length < lines.length &&
            epoch === generationId && isEnabled && nextGeminiAvailableAt() <= Date.now()) {
          for (const retryChunk of chunkArray(missingFromResponse, 4)) {
            if (disposed || epoch !== generationId || !isEnabled) break;
            if (nextGeminiAvailableAt() > Date.now()) break;
            try {
              await translateChunkWithGemini(retryChunk, allVisibleLines, epoch);
            } catch (retryError) {
              warn('Gemini eksik satırların kısa tekrarında başarısız:', retryError?.message || retryError);
              break;
            }
          }
        }
      } catch (e) {
        if (epoch === generationId) warn('Gemini çevirisi başarısız:', e?.message || e);
      }
    };

    try {
      const groups = buildPriorityGroups(missing, allVisibleLines, activeText, MAX_LINES_PER_GEMINI_CALL);
      for (const group of groups) {
        if (disposed || epoch !== generationId || !isEnabled) return;
        const toTranslate = group.filter(line =>
          (!cache.get(line)?.tr || cache.get(line)?.source !== 'gemini') &&
          (failedUntil.get(line) || 0) <= Date.now()
        );
        if (!toTranslate.length) continue;

        await startGemini(toTranslate);
        if (disposed || epoch !== generationId || !isEnabled) return;

        const untranslated = toTranslate.filter(line =>
          !cache.get(line)?.tr || cache.get(line)?.source !== 'gemini'
        );
        if (untranslated.length) {
          const wait = retryWaitMs();
          untranslated.forEach(line => markFailed(line, wait));
        }
        saveCache();
        updateDOMWithCache();
      }
    } catch (e) {
      if (epoch === generationId) err('processQueue beklenmedik hata:', e);
    } finally {
      if (epoch === generationId) {
        for (const t of allVisibleLines) inFlight.delete(t);
        queueRunning = false;
        scheduleScan();
      }
    }
  }

  function refreshToggleButtonVisual(btn) {
    if (!btn) return;
    btn.setAttribute('aria-pressed', String(isEnabled));
    btn.setAttribute('aria-label', isEnabled ? 'Gemini Türkçe çevirisini kapat' : 'Gemini Türkçe çevirisini aç');
    btn.setAttribute('data-spicy-tr-state', isEnabled ? 'on' : 'off');
    const now = Date.now();
    const hasKeys = geminiApiKeys.length > 0;
    syncGeminiCooldown();
    const geminiDown = hasKeys && now < geminiGloballyDownUntil;

    btn.className = `${isEnabled ? 'active' : ''} ${hasKeys ? 'ai-mode' : ''} ${isEnabled && geminiDown ? 'quota-warn' : ''}`.trim();
    btn.textContent = !isEnabled ? 'OFF' : !hasKeys ? 'KEY' : (geminiDown ? 'AI!' : 'AI');
    if (!isEnabled) {
      btn.title = 'SpicyTR V58.0.1 · KAPALI — Açmak için sol tıkla. Gemini ayarları için sağ tıkla.';
      return;
    }

    if (!hasKeys) {
      btn.title = 'SpicyTR V58.0.1 — Gemini API anahtarı eklemek için sağ tıkla.';
    } else if (geminiDown) {
      const waitSec = Math.max(0, Math.ceil((geminiGloballyDownUntil - now) / 1000));
      btn.title = `SpicyTR V58.0.1 — Gemini geçici olarak beklemede (${waitSec} sn). Son hata: ${geminiLastError || 'geçici servis/kota beklemesi'}`;
    } else {
      btn.title = `SpicyTR V58.0.1 — Gemini AI çevirisi açık (${geminiApiKeys.length} anahtar).`;
    }
    btn.title += ` İstek: ${stats.geminiCalls}, başarılı grup: ${stats.geminiSuccess}, çevrilen satır: ${stats.geminiTranslatedLines}. Son hata: ${geminiLastError || 'yok'}. Konsol: __spicyTRDiagnostics()`;
  }

  // The Spicy Lyrics controls are React-managed. A button-local onclick is
  // unreliable if React remounts/replaces the controls between mousedown and
  // click. Use one delegated, capture-phase handler for our owned button.
  // It survives React replacing the toolbar and blocks ancestor click handlers.
  let ownedToggleButton = null;
  const TOGGLE_OWNER = 'spicytr-58-0';
  function handleToggleClick(event) {
    if (disposed || !ownedToggleButton) return;
    const target = event.target;
    // An obsolete button may have appeared during an old observer callback.
    // Route its clicks into V58 state rather than its old onclick.
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
      queueRunning = false;
      clearTimeout(batchTimer); batchTimer = null;
      clearScheduledScans();
      inFlight.clear();
      failedUntil.clear();
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
      queueRunning = false;
      clearScheduledScans();
      clearTimeout(batchTimer); batchTimer = null;
      clearTimeout(postResetScanTimer); postResetScanTimer = null;
      const parsedEntries = rawInput.split(/[,\n]+/).map(entry => {
        const value = entry.trim();
        if (!value) return null;
        const match = /^([A-Za-z0-9_.-]{1,40})\s*=\s*(.+)$/.exec(value);
        return match
          ? { key: match[2].trim(), group: match[1].trim() }
          : { key: value, group: '' };
      }).filter(entry => entry && entry.key.length > 10);

      geminiApiKeys = Array.from(new Set(parsedEntries.map(entry => entry.key)));
      geminiKeyGroups = new Map();
      for (const entry of parsedEntries) {
        if (entry.group) geminiKeyGroups.set(entry.key, entry.group);
      }
      saveKeyGroups();
      try { localStorage.setItem(GEMINI_KEYS_STORAGE, JSON.stringify(geminiApiKeys)); } catch (e2) {}
      const activeGroups = new Set(geminiApiKeys.map(quotaGroupId));
      for (const group of Array.from(projectCooldowns.keys())) {
        if (!activeGroups.has(group)) projectCooldowns.delete(group);
      }
      failedUntil.clear();
      inFlight.clear();

      if (resetCache) {
        // Remove every old SpicyTR translation namespace plus V58's active one.
        // Gemini API keys and project labels remain untouched.
        const cleared = clearTranslationCache();
        refreshToggleButtonVisual(btn);
        try { Spicetify.showNotification?.(
          `Önbellek tamamen sıfırlandı (${cleared.removedStorageKeys} kayıt silindi). Eski çeviriler gösterilmeyecek; yeni Gemini çevirisi hemen yeniden başlayacak.`
        ); } catch (e5) {}
        postResetScanTimer = setTimeout(() => {
          postResetScanTimer = null;
          if (!disposed && isEnabled) triggerMultiStageScan();
        }, 250);
        return;
      }

      clearRenderedSubtitles();
      refreshToggleButtonVisual(btn);
      triggerMultiStageScan();
      try { Spicetify.showNotification?.('Ayarlar kaydedildi; mevcut çeviri önbelleği korundu.'); } catch (e5) {}
    }

    function openKeySettingsModal() {
      if (!Spicetify?.PopupModal?.display) {
        // Extremely old/unsupported Spicetify build without PopupModal -
        // last-resort fallback (may not show anything, but at least we tried).
        try {
          const fallbackInput = prompt('Gemini API anahtarlarını girin (aynı proje için aynı etiket: projeA=...):',
            geminiApiKeys.map(key => geminiKeyGroups.has(key) ? `${geminiKeyGroups.get(key)}=${key}` : key).join(', '));
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
      label.textContent = 'Gemini API anahtarlarını virgül veya yeni satırla girin. Farklı Google Cloud projelerindeki anahtarlar farklı kotalara sahip olabilir. Aynı projeye ait anahtarları aynı etiketle yazın (ör. projeA=...). Anahtarlarını kimseyle paylaşma.';
      label.style.fontSize = '13px';
      label.style.lineHeight = '1.4';
      wrap.appendChild(label);

      const textarea = document.createElement('textarea');
      textarea.value = geminiApiKeys.map(key => {
        const group = geminiKeyGroups.get(key);
        return group ? `${group}=${key}` : key;
      }).join('\n');
      textarea.placeholder = 'projeA=GEMINI_API_KEY_1\nprojeB=GEMINI_API_KEY_2';
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
      warnText.textContent = `Önbellek: ${cache.size} satır. Yalnızca Gemini tarafından üretilen Türkçe çeviriler gösterilir. 'Önbelleği sıfırla' tüm eski çevirileri siler; Gemini API anahtarlarını korur.`;
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
        applySettings(textarea.value, false);
        Spicetify.PopupModal.hide();
      };
      const resetBtn = mkBtn('Önbelleği sıfırla', false);
      resetBtn.title = 'Tüm eski ve yeni çeviri kayıtlarını VE Gemini kota/bekleme durumunu siler; Gemini API anahtarlarını korur.';
      resetBtn.onclick = () => {
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
      if (document.querySelector('#SpicyLyricsPage .spicy-tr-box, #SpicyLyricsPage .spicy-tr-credit-romaja')) clearRenderedSubtitles();
      return;
    }
    processSongwriterCredits();
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
      if (geminiApiKeys.length > 0 &&
          (!cache.get(text)?.tr || cache.get(text)?.source !== 'gemini') &&
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

  function clearScheduledScans() {
    if (scanScheduledTimer !== null) {
      clearTimeout(scanScheduledTimer);
      scanScheduledTimer = null;
    }
    for (const timer of multiStageScanTimers) clearTimeout(timer);
    multiStageScanTimers.clear();
    scanScheduled = false;
  }

  function scheduleScan() {
    if (disposed || scanScheduled) return;
    scanScheduled = true;
    scanScheduledTimer = setTimeout(() => {
      scanScheduled = false;
      scanScheduledTimer = null;
      safeScanLines();
    }, 80);
  }

  function triggerMultiStageScan() {
    if (disposed) return;
    clearScheduledScans();
    for (const delay of [0, 100, 300, 600, 1200]) {
      const timer = setTimeout(() => {
        multiStageScanTimers.delete(timer);
        safeScanLines();
      }, delay);
      multiStageScanTimers.add(timer);
    }
  }

  if (window._spicyTrObserver) window._spicyTrObserver.disconnect();
  function mutationTouchesLyricsPage(mutation) {
    const target = mutation.target;
    const targetElement = target instanceof Element ? target : target?.parentElement;
    if (targetElement?.closest?.('#SpicyLyricsPage')) return true;
    for (const node of [...mutation.addedNodes, ...mutation.removedNodes]) {
      if (node.nodeType !== 1) continue;
      if (node.id === 'SpicyLyricsPage' || node.matches?.('#SpicyLyricsPage') ||
          node.querySelector?.('#SpicyLyricsPage') || node.closest?.('#SpicyLyricsPage')) return true;
    }
    return false;
  }
  const observer = new MutationObserver((mutations) => {
    try {
      if (mutations.some(mutationTouchesLyricsPage)) scheduleScan();
    } catch (e) { err('MutationObserver hata verdi:', e); }
  });
  window._spicyTrObserver = observer;
  observer.observe(document.body, { childList: true, subtree: true });

  const scrollHandler = (event) => {
    const target = event?.target;
    if (target === document || target === document.documentElement || target === document.body ||
        target?.closest?.('#SpicyLyricsPage')) scheduleScan();
  };
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
    queueRunning = false;
    inFlight.clear();
    try { observer.disconnect(); } catch (e) {}
    try { clearInterval(watchdogInterval); } catch (e) {}
    try { clearTimeout(batchTimer); } catch (e) {}
    try { clearTimeout(postResetScanTimer); } catch (e) {}
    try { clearScheduledScans(); } catch (e) {}
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