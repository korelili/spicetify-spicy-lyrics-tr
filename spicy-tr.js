// NAME: Spicy Lyrics TR & Romaja AI Pro
// AUTHOR: korelili
// VERSION: 5.5.0 (Pure V5 Restored)
// DESCRIPTION: Clean Context-Aware Gemini AI Turkish Translation + Hybrid Romanization for Spicy Lyrics

(function spicyTurkishProV5Restored() {
  // Eski bozuk önbellekleri temizle
  [
    'spicy_tr_persistent_cache_v5',
    'spicy_tr_persistent_cache_v6',
    'spicy_tr_persistent_cache_v6_1',
    'spicy_tr_persistent_cache_v7_0',
    'spicy_tr_persistent_cache_v8_0',
    'spicy_tr_persistent_cache_v9_0',
    'spicy_tr_persistent_cache_v10_0',
    'spicy_tr_persistent_cache_v11_0',
    'spicy_tr_persistent_cache_v12_final',
    'spicy_tr_persistent_cache_v13_clean',
    'spicy_tr_persistent_cache_v14_universal',
    'spicy_tr_persistent_cache_v15_universal',
    'spicy_tr_persistent_cache_v15_master',
    'spicy_tr_persistent_cache_v16_uncensored'
  ].forEach(k => localStorage.removeItem(k));

  const STORAGE_CACHE_KEY = 'spicy_tr_clean_v5_cache';
  let savedCache = {};
  try {
    savedCache = JSON.parse(localStorage.getItem(STORAGE_CACHE_KEY) || '{}');
  } catch (e) {
    savedCache = {};
  }

  const cache = new Map(Object.entries(savedCache));
  const inFlight = new Set();
  const deadModels = new Map();
  let isEnabled = localStorage.getItem('spicy_tr_enabled') !== 'false';
  let geminiApiKey = localStorage.getItem('spicy_tr_gemini_key') || '';
  let batchTimer = null;

  function saveCache() {
    try {
      const entries = Array.from(cache.entries()).slice(-3000);
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

    #SpicyLyricsPage .spicy-tr-box,
    #SpicyLyricsPage .spicy-tr-box * {
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
      margin-top: 8px !important;
      display: ${isEnabled ? 'flex' : 'none'} !important;
      flex-direction: column !important;
      gap: 4px !important;
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

    #SpicyLyricsPage .line.NotSung,
    #SpicyLyricsPage .line.Sung {
      opacity: 0.78 !important;
    }
    #SpicyLyricsPage .line.Active {
      opacity: 1 !important;
    }

    #spicy-tr-toggle-btn {
      background: rgba(255, 255, 255, 0.15);
      color: #fff;
      border: 1px solid rgba(255, 255, 255, 0.3);
      border-radius: 50%;
      width: 32px;
      height: 32px;
      font-size: 10px;
      font-weight: 800;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      margin-left: 6px;
      transition: all 0.2s ease;
    }
    #spicy-tr-toggle-btn.active {
      background: #1db954;
      border-color: #1db954;
      color: #000;
    }
    #spicy-tr-toggle-btn.ai-mode.active {
      background: linear-gradient(135deg, #1db954, #00d2ff);
      border-color: #00d2ff;
      color: #000;
    }
  `;
  document.getElementById('spicy-tr-style')?.remove();
  document.head.appendChild(style);

  let resizeTimer;
  function triggerRecalc() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      window.dispatchEvent(new Event('resize'));
    }, 100);
  }

  const NON_LATIN_REGEX = /[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\uff00-\uff9f\u4e00-\u9faf\u3400-\u4dbf\uac00-\ud7a3\u0e00-\u0e7f\u0400-\u04ff\u0600-\u06ff]/;
  const NON_LATIN_CHUNK_REGEX = /([\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\uff00-\uff9f\u4e00-\u9faf\u3400-\u4dbf\uac00-\ud7a3\u0e00-\u0e7f\u0400-\u04ff\u0600-\u06ff]+)/g;

  function isNonLatin(text) {
    return NON_LATIN_REGEX.test(text);
  }

  function detectLang(text) {
    if (/[\uac00-\ud7a3]/.test(text)) return 'ko';
    if (/[\u3040-\u30ff]/.test(text)) return 'ja';
    if (/[\u0e00-\u0e7f]/.test(text)) return 'th';
    if (/[\u4e00-\u9faf]/.test(text)) {
      const pageText = document.querySelector('#SpicyLyricsPage')?.textContent || '';
      if (/[\u3040-\u30ff]/.test(pageText)) return 'ja';
      return 'zh-CN';
    }
    return 'auto';
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
      Array.from(container.childNodes).forEach(node => {
        const txt = (node.textContent || '').trim();
        if (txt) words.push(txt);
      });
      return words.join(' ').replace(/\s+/g, ' ').trim();
    }

    return clone.textContent.replace(/\s+/g, ' ').trim();
  }

  // Düzgün çalışan Romaja motoru (Dokunulmadı)
  async function buildHybridRomaja(rawText) {
    if (!isNonLatin(rawText)) return '';
    const lang = detectLang(rawText);
    const parts = rawText.split(NON_LATIN_CHUNK_REGEX);
    const resolvedParts = await Promise.all(
      parts.map(async (part) => {
        if (!part) return '';
        if (!isNonLatin(part)) return part.trim();
        try {
          const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${lang}&tl=tr&dt=rm&q=${encodeURIComponent(part.trim())}`;
          const res = await fetch(url);
          const json = await res.json();
          let rom = '';
          if (Array.isArray(json[0])) {
            json[0].forEach(item => {
              if (item[3]) rom += (rom ? ' ' : '') + item[3];
            });
          }
          return rom.trim() || part.trim();
        } catch (e) {
          return part.trim();
        }
      })
    );
    return resolvedParts
      .filter(Boolean)
      .join(' ')
      .replace(/([a-zāēīōū])([A-Z])/g, '$1 $2')
      .replace(/([,!?])([A-Za-z0-9])/g, '$1 $2')
      .replace(/\s+/g, ' ')
      .trim();
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

    // Sonsuz döngüyü önlemek için kutuyu her zaman satıra ekle (boşsa gizli kalır)
    if (box.children.length === 0) {
      box.style.setProperty('display', 'none', 'important');
    }
    lineEl.appendChild(box);
    triggerRecalc();
  }

  function updateDOMWithCache() {
    document.querySelectorAll('#SpicyLyricsPage .line:not(.musical-line)').forEach(el => {
      const text = getCleanText(el);
      if (cache.has(text)) {
        renderSubtitles(el, cache.get(text), text);
      }
    });
  }

  // 1. MOTOR: Senin V5 Gemini AI Motorun (Çoklu Model Yedekli, Sıfır HTTP 400 Hatası!)
  async function translateWithGeminiAI(linesToTranslate, allVisibleLines) {
    const songTitle = Spicetify?.Player?.data?.item?.name || 'Unknown Song';
    const artist = Spicetify?.Player?.data?.item?.artists?.[0]?.name || 'Unknown Artist';

    const prompt = `You are an expert poetic Turkish music translator. Translate the following song lyrics (Song: "${songTitle}" by "${artist}") into natural, idiomatic, emotionally accurate, uncensored Turkish.
Full visible stanza context:
${JSON.stringify(allVisibleLines)}

Rules:
- Translate idioms, proverbs, and slang by their true meaning in the song, NEVER word-by-word (e.g., Korean "옆구리 찔러서 절 받기" means "zorla ilgi/özür beklemek", NOT "yan tarafımdan bıçaklamak"; "네 전공은 했던 얘기 또 하기" means "senin uzmanlık alanın eski konuları tekrar açmak", NOT "branşın"; "바람을 피우다" means "aldatmak", NOT "dolandırıcı"; English "Feel like a fool" means "Kendimi aptal gibi hissediyorum", NOT "Aptal gibi hisset"; "ma darling" means "sevgilim").
- Always use natural, informal singular "sen" in Turkish lyrics (never formal "siz"). Do not censor explicit words.
- Return ONLY a valid JSON array of strings (the Turkish translations) in the exact same order and exact same length as the Input lines below.

Input lines (${linesToTranslate.length} items):
${JSON.stringify(linesToTranslate)}`;

    // Biri kotaya takılırsa diğerine geçen 5 ayrı ücretsiz model havuzu
    const models = [
      'gemini-2.0-flash',
      'gemini-2.5-flash-lite',
      'gemini-2.5-flash',
      'gemini-2.0-flash-lite',
      'gemma-3-27b-it'
    ];

    let lastError = null;

    for (const model of models) {
      if ((deadModels.get(model) || 0) > Date.now()) continue;

      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey.trim()}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.2 }
          })
        });

        if (res.status === 429 || res.status === 404 || res.status === 400) {
          deadModels.set(model, Date.now() + 60000);
          throw new Error(`HTTP ${res.status} on ${model}`);
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const json = await res.json();
        const parts = json?.candidates?.[0]?.content?.parts || [];
        const rawOutput = parts.filter(p => !p.thought && p.text).map(p => p.text).join('\n') || parts.map(p => p.text || '').join('\n');

        const jsonMatch = rawOutput.match(/\[[\s\S]*\]/);
        if (!jsonMatch) throw new Error('No JSON array in AI output');

        const parsed = JSON.parse(jsonMatch[0]);
        if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('Empty JSON array');

        await Promise.all(
          linesToTranslate.map(async (rawText, idx) => {
            const item = parsed[idx];
            const trText = typeof item === 'string' ? item : (item?.tr || '');
            const romaja = isNonLatin(rawText) ? await buildHybridRomaja(rawText) : '';

            if (trText.trim()) {
              cache.set(rawText, {
                tr: trText.trim(),
                romaja
              });
            }
          })
        );

        saveCache();
        updateDOMWithCache();
        return;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  }

  // 2. MOTOR: V5 Tam Kıta Bağlamlı GTX Yedek Motoru
  async function translateWithContextGTX(linesToTranslate) {
    const joinedBlock = linesToTranslate.join('.\n');
    const contextUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=tr&dt=t&dj=1&q=${encodeURIComponent(joinedBlock)}`;
    const contextRes = await fetch(contextUrl);
    const contextJson = await contextRes.json();

    const fullTranslatedText = (contextJson.sentences || [])
      .map(s => s.trans || '')
      .join('');

    const splitLines = fullTranslatedText.split('\n').map(s => s.replace(/\.$/, '').trim());

    await Promise.all(
      linesToTranslate.map(async (rawText, idx) => {
        let trLine = splitLines[idx] || '';
        const romaja = isNonLatin(rawText) ? await buildHybridRomaja(rawText) : '';

        if (!trLine) {
          const singleUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=tr&dt=t&q=${encodeURIComponent(rawText)}`;
          const singleRes = await fetch(singleUrl);
          const singleJson = await singleRes.json();
          if (Array.isArray(singleJson[0])) {
            singleJson[0].forEach(item => {
              if (item[0]) trLine += item[0];
            });
          }
        }

        cache.set(rawText, { tr: trLine.trim(), romaja });
      })
    );
    updateDOMWithCache();
  }

  async function processStanzaTranslation(allVisibleLines) {
    const missingLines = allVisibleLines.filter(t => !cache.has(t) && !inFlight.has(t));
    if (missingLines.length === 0) return;
    missingLines.forEach(t => inFlight.add(t));

    try {
      if (geminiApiKey && geminiApiKey.trim().length > 10) {
        try {
          await translateWithGeminiAI(missingLines, allVisibleLines);
          return;
        } catch (aiErr) {
          console.warn('Spicy TR: AI Modu hatası, GTX motoruna geçiliyor...', aiErr);
        }
      }
      await translateWithContextGTX(missingLines);
    } catch (e) {
      console.error('Spicy TR V5 Hata:', e);
    } finally {
      missingLines.forEach(t => inFlight.delete(t));
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
      btn.title = geminiApiKey
        ? 'Sol Tık: Çeviriyi Aç/Kapat | Sağ Tık: Gemini AI Anahtarını Değiştir (Saf V5 AI Modu Aktif!)'
        : 'Sol Tık: Çeviriyi Aç/Kapat | Sağ Tık: %100 Kusursuz Çeviri İçin Ücretsiz Gemini AI Anahtarı Gir';
    };
    updateBtnVisual();

    btn.onclick = () => {
      isEnabled = !isEnabled;
      localStorage.setItem('spicy_tr_enabled', isEnabled);
      updateBtnVisual();
      document.querySelectorAll('#SpicyLyricsPage .spicy-tr-box').forEach(b => {
        if (b.children.length > 0) {
          b.style.setProperty('display', isEnabled ? 'flex' : 'none', 'important');
        }
      });
      triggerRecalc();
    };

    btn.oncontextmenu = (e) => {
      e.preventDefault();
      const input = prompt(
        '🌟 Saf V5 Yapay Zeka (Gemini AI) Şarkı Çevirisi 🌟\n\n' +
        'Ücretsiz Gemini API anahtarınızı buraya yapıştırın (aistudio.google.com/apikey):\n' +
        'Tamam\'a bastığınızda eski önbellek sıfırlanır ve şarkı yeniden çevrilir:',
        geminiApiKey
      );
      if (input !== null) {
        geminiApiKey = input.trim();
        localStorage.setItem('spicy_tr_gemini_key', geminiApiKey);
        cache.clear();
        deadModels.clear();
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
      } else if (!inFlight.has(text)) {
        hasMissing = true;
      }
    });

    if (hasMissing && allVisibleTexts.length > 0) {
      clearTimeout(batchTimer);
      batchTimer = setTimeout(() => {
        processStanzaTranslation(allVisibleTexts);
      }, 250);
    }
  }

  if (window._spicyTrObserver) window._spicyTrObserver.disconnect();
  window._spicyTrObserver = new MutationObserver(() => scanLines());
  window._spicyTrObserver.observe(document.body, { childList: true, subtree: true });
  scanLines();
})();
