// NAME: Spicy Lyrics AI Translator & Romaja
// AUTHOR: korelili
// VERSION: 30.0.0 (Ultimate Flawless - Aggressive Observer & Zero-Skip)
// DESCRIPTION: Eliminates skipped lines caused by virtual scrolling and pending requests.

(function spicyTurkishProV30() {
  const DEBUG = true;
  const log = (...args) => { if (DEBUG) console.log('%c[SpicyTR V30]', 'color:#1db954;font-weight:bold', ...args); };
  const warn = (...args) => { if (DEBUG) console.warn('%c[SpicyTR V30]', 'color:#ffae00;font-weight:bold', ...args); };
  const err = (...args) => { if (DEBUG) console.error('%c[SpicyTR V30]', 'color:#ff4b4b;font-weight:bold', ...args); };

  [
    'spicy_tr_persistent_cache_v5', 'spicy_tr_persistent_cache_v12_final',
    'spicy_tr_marketplace_v19', 'spicy_tr_stable_v20', 'spicy_tr_ultimate_v21',
    'spicy_tr_unbreakable_v22', 'spicy_tr_godmode_v23', 'spicy_tr_godmode_v26', 
    'spicy_tr_godmode_v27', 'spicy_tr_godmode_v28', 'spicy_tr_godmode_v29'
  ].forEach(k => localStorage.removeItem(k));

  const STORAGE_CACHE_KEY = 'spicy_tr_godmode_v30';
  let savedCache = {};
  try {
    savedCache = JSON.parse(localStorage.getItem(STORAGE_CACHE_KEY) || '{}');
  } catch (e) {
    savedCache = {};
  }

  const cache = new Map(Object.entries(savedCache));
  const inFlight = new Map(); // text -> timestamp (deadlock engellemek için)
  const failedUntil = new Map();
  const FAILURE_COOLDOWN_MS = 5000;
  const IN_FLIGHT_TIMEOUT_MS = 6000;
  const deadModels = new Map();
  let isEnabled = localStorage.getItem('spicy_tr_enabled') !== 'false';
  let geminiApiKey = localStorage.getItem('spicy_tr_gemini_key') || '';
  let batchTimer = null;

  const CHUNK_SIZE = 10;

  function markFailed(text) {
    failedUntil.set(text, Date.now() + FAILURE_COOLDOWN_MS);
  }

  function saveCache() {
    try {
      const entries = Array.from(cache.entries())
        .filter(([, v]) => v && (v.tr || v.romaja))
        .slice(-5000);
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
    let container = clone;
    while (container.children.length === 1 && container.children[0].children.length > 0) {
      container = container.children[0];
    }
    if (container.children.length > 1) {
      const words = [];
      Array.from(container.childNodes).forEach(n => {
        const txt = (n.textContent || '').trim();
        if (txt) words.push(txt);
      });
      return words.join(' ').replace(/\s+/g, ' ').trim();
    }
    return clone.textContent.replace(/\s+/g, ' ').trim();
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

    t = t.replace(/([a-zçğıöşü]+)n[iıuü]z\b/gi, '$1n')
         .replace(/([a-zçğıöşü]+)s[iıuü]n[iıuü]z\b/gi, '$1sın');

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

    const prompt = `You are Turkey's ultimate, professional music translator, localizing song lyrics into natural, idiomatic Turkish.
Song: "${songTitle}" by "${artist}"

CRITICAL RULES:
1. ALWAYS INFORMAL "SEN": ALWAYS use "sen", "vücudun", "bebeğim", "söyle", "biliyorsun". NEVER use "siz", "vücudunuz".
2. NO LINE SKIP OR SHIFT: You MUST translate EVERY SINGLE line listed below. Do not omit any line.
3. OUTPUT FORMAT: For EVERY line listed below, output exactly this format separated by ---:
SRC: <exact original line>
ROM: <accurate Latin romanization if non-Latin script, otherwise write NONE>
TR: <natural Turkish translation using informal 'sen'>
---

Lines to translate:
${inputLinesText}`;

    let lastError = null;

    for (const model of GEMINI_MODELS) {
      if ((deadModels.get(model) || 0) > Date.now()) continue;

      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey.trim()}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.3, maxOutputTokens: 4096 }
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

        const leftover = chunkLines.filter(l => !matched.has(l));
        return leftover;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  }

  async function translateWithGTX(linesToTranslate) {
    const joinedBlock = linesToTranslate.join('.\n');
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=tr&dt=t&dj=1&q=${encodeURIComponent(joinedBlock)}`;
    
    let splitLines = [];
    try {
      const res = await fetch(url);
      const json = await res.json();
      const fullText = (json.sentences || []).map(s => s.trans || '').join('');
      splitLines = fullText.split('\n').map(s => s.replace(/\.$/, '').trim());
    } catch (e) {}

    await Promise.all(
      linesToTranslate.map(async (rawText, idx) => {
        let trLine = splitLines[idx] || rawText;
        const romaja = await fetchRomajaLine(rawText);
        cache.set(rawText, { tr: forcePerfectTurkish(trLine), romaja });
      })
    );
    saveCache();
    updateDOMWithCache();
  }

  async function processQueue(allVisibleLines) {
    const now = Date.now();
    const missing = allVisibleLines.filter(t => {
      if (cache.has(t)) return false;
      if ((failedUntil.get(t) || 0) > now) return false;
      const flightTime = inFlight.get(t);
      if (flightTime && (now - flightTime) < IN_FLIGHT_TIMEOUT_MS) return false;
      return true;
    });

    if (missing.length === 0) return;

    missing.forEach(t => inFlight.set(t, now));
    log('Kuyruk taranıyor & çevriliyor (V30 Aggressive):', missing.length, 'satır');

    const chunks = [];
    for (let i = 0; i < missing.length; i += CHUNK_SIZE) {
      chunks.push(missing.slice(i, i + CHUNK_SIZE));
    }

    try {
      for (const chunk of chunks) {
        let leftover = chunk;
        if (geminiApiKey && geminiApiKey.trim().length > 10) {
          try {
            leftover = await translateChunkWithGemini(chunk);
          } catch (e) {
            warn('Gemini hatası, GTX yedek motoruna geçiliyor', e);
            leftover = chunk;
          }
        }
        if (leftover && leftover.length > 0) {
          await translateWithGTX(leftover);
        }
      }
    } catch (e) {
      err('Kuyruk hatası', e);
    } finally {
      missing.forEach(t => inFlight.delete(t));
    }
  }

  function injectToggleButton() {
    const controls = document.querySelector('#SpicyLyricsPage .ViewControls');
    if (!controls || document.getElementById('spicy-tr-toggle-btn')) return;

    const btn = document.createElement('button');
    btn.id = 'spicy-tr-toggle-btn';
    const updateBtnVisual = () => {
      btn.className = `${isEnabled ? 'active' : ''} ${geminiApiKey ? 'ai-mode' : ''}`.trim();
      btn.textContent = geminiApiKey ? 'AI' : 'TR';
      btn.title = geminiApiKey ? 'God Mode V30 Aktif' : 'API Anahtarı Gir';
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
      const input = prompt('🌟 Spicy Lyrics V30 🌟\nGemini API Anahtarınızı girin:', geminiApiKey);
      if (input !== null) {
        geminiApiKey = input.trim();
        localStorage.setItem('spicy_tr_gemini_key', geminiApiKey);
        cache.clear();
        inFlight.clear();
        failedUntil.clear();
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
    const now = Date.now();

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
      } else {
        const flightTime = inFlight.get(text);
        if (!flightTime || (now - flightTime) >= IN_FLIGHT_TIMEOUT_MS) {
          hasMissing = true;
        }
      }
    });

    if (hasMissing && allVisibleTexts.length > 0) {
      clearTimeout(batchTimer);
      batchTimer = setTimeout(() => {
        processQueue(allVisibleTexts);
      }, 100);
    }
  }

  function triggerMultiStageScan() {
    scanLines();
    setTimeout(scanLines, 200);
    setTimeout(scanLines, 600);
    setTimeout(scanLines, 1200);
    setTimeout(scanLines, 2500);
  }

  if (window._spicyTrObserver) window._spicyTrObserver.disconnect();
  window._spicyTrObserver = new MutationObserver(() => scanLines());
  window._spicyTrObserver.observe(document.body, { childList: true, subtree: true });

  // Scroll yapıldıkça ekrana yeni giren satırları anında yakala
  window.addEventListener('scroll', () => scanLines(), true);

  if (Spicetify?.Player) {
    Spicetify.Player.addEventListener("songchange", () => {
      setTimeout(triggerMultiStageScan, 150);
    });
  }

  triggerMultiStageScan();
})();
