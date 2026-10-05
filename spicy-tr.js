// NAME: Spicy Lyrics AI Translator & Romaja
// AUTHOR: korelili
// VERSION: 21.0.0 (5 Ekim 2026 - Ultimate Marketplace Release)
// DESCRIPTION: Pure Context-Aware Gemini AI Turkish Localization & Romanization (Zero Regex Hacks)

(function spicyTurkishProV21Final() {
  // Eski tüm bozuk önbellekleri temizle
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
    'spicy_tr_persistent_cache_v16_uncensored',
    'spicy_tr_clean_v5_cache',
    'spicy_tr_better_lyrics_v17',
    'spicy_tr_instant_v18',
    'spicy_tr_marketplace_v19',
    'spicy_tr_stable_v20'
  ].forEach(k => localStorage.removeItem(k));

  const STORAGE_CACHE_KEY = 'spicy_tr_ultimate_v21';
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
      const entries = Array.from(cache.entries())
        .filter(([, v]) => v && v.tr)
        .slice(-3000);
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

  function isNonLatin(text) {
    return /[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\uff00-\uff9f\u4e00-\u9faf\u3400-\u4dbf\uac00-\ud7a3\u0e00-\u0e7f\u0400-\u04ff\u0600-\u06ff]/.test(text);
  }

  function detectLang(text) {
    if (/[\uac00-\ud7a3]/.test(text)) return 'ko';
    if (/[\u3040-\u30ff]/.test(text)) return 'ja';
    if (/[\u0e00-\u0e7f]/.test(text)) return 'th';
    if (/[\u4e00-\u9faf]/.test(text)) return 'zh-CN';
    if (/[\u0400-\u04ff]/.test(text)) return 'ru';
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
    document.querySelectorAll('#SpicyLyricsPage .line:not(.musical-line)').forEach(el => {
      const text = getCleanText(el);
      if (cache.has(text)) {
        renderSubtitles(el, cache.get(text), text);
      }
    });
  }

  // 1. MOTOR: SAF YAPAY ZEKA (Hiçbir Regex/Yama Yok. Her Şeyi Sadece Prompt İle Yapar)
  async function translateWithGeminiAI(linesToTranslate, allVisibleLines) {
    const songTitle = Spicetify?.Player?.data?.item?.name || 'Unknown Song';
    const artist = Spicetify?.Player?.data?.item?.artists?.[0]?.name || 'Unknown Artist';

    const prompt = `You are a professional Turkish music lyricist and translator (like the best Turkish lyric translation channels on YouTube).
Song: "${songTitle}" by "${artist}"

FULL VISIBLE LYRICS CONTEXT (Read this first so split sentences connect perfectly!):
${JSON.stringify(allVisibleLines)}

TASK: Translate the following song lyric lines into natural, poetic, emotional Turkish. Provide smooth Latin romanization for Asian/Cyrillic scripts.

STRICT RULES:
1. SEAMLESS SENTENCE CONNECTION: Often a single sentence spans multiple lines (e.g. "Don't you know make me" / "The perfect kinda crazy"). Look at the context and connect them logically in Turkish (e.g. "Beni o mükemmel deliliğe sürüklediğini bilmiyor musun?"). NEVER translate them as broken separate fragments.
2. TRANSLATE MIXED LANGUAGES FULLY: If a line contains mixed languages (e.g. Thai + English like "ใครจะไม่อยากอยู่กับยู cuz you're my baby babe"), translate the ENTIRE line's meaning into Turkish. Do NOT leave untranslated Thai or English words in the Turkish result!
3. 100% "SEN" TONE: Address the listener/lover exclusively in the informal singular "sen" (e.g., "gör", "biliyorsun", "hisset"). NEVER use the formal/plural "siz" (e.g., NEVER use "görün", "biliyorsunuz", "hissedin").
4. NO CENSORSHIP & NO PUNCTUATION: Translate slang, idioms, and explicit words naturally without censorship. Do NOT add periods (".") or question marks ("?") to the end of the Turkish lines. Let it flow like poetry.
5. ROMAJA: For the 'romaja' field, provide the Latin alphabet pronunciation ONLY for Korean, Japanese, Thai, Chinese, or Cyrillic characters. Keep any English words in the line exactly as they are. If the original line is purely English/Spanish, set "romaja" to "".

Return ONLY a valid JSON array of objects in the exact same order as the input lines. The array must contain exactly ${linesToTranslate.length} objects.
Keys must be exactly "tr" and "romaja". Do not use markdown blocks.

Input lines:
${JSON.stringify(linesToTranslate)}`;

    // Model rotasyonu: Biri kota veya hata verirse anında diğerine geçer.
    const models = [
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
      'gemini-2.0-flash',
      'gemini-1.5-flash'
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
            generationConfig: { responseMimeType: 'application/json', temperature: 0.25 }
          })
        });

        if (res.status === 429 || res.status === 404 || res.status === 400) {
          deadModels.set(model, Date.now() + 60000);
          throw new Error(`HTTP ${res.status} on ${model}`);
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const json = await res.json();
        const rawOutput = json?.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
        
        let parsed;
        try {
            // Markdown temizliği yapıp JSON'ı parse et
            const cleanJsonStr = rawOutput.replace(/^```[a-z]*\s*/im, '').replace(/```\s*$/im, '').trim();
            parsed = JSON.parse(cleanJsonStr);
        } catch (e) {
            // Eğer JSON parse edilemezse array içinden çekmeyi dene
            const match = rawOutput.match(/\[[\s\S]*\]/);
            if (match) parsed = JSON.parse(match[0]);
            else throw new Error("Invalid JSON");
        }

        if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('Empty JSON array');

        linesToTranslate.forEach((rawText, idx) => {
          if (parsed[idx]) {
            const tr = (parsed[idx].tr || '').trim();
            const romaja = (parsed[idx].romaja || '').trim();
            if (tr) {
              cache.set(rawText, { tr, romaja });
            }
          }
        });

        saveCache();
        updateDOMWithCache();
        return;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  }

  // 2. MOTOR: Saf V5 GTX Yedeği (Sadece AI Anahtarı Yoksa Çalışır)
  async function translateWithContextGTX(linesToTranslate) {
    const joinedBlock = linesToTranslate.join('.\n');
    const sourceLang = detectLang(joinedBlock);
    
    const contextUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sourceLang}&tl=tr&dt=t&dj=1&q=${encodeURIComponent(joinedBlock)}`;
    let splitLines = [];
    
    try {
        const contextRes = await fetch(contextUrl);
        const contextJson = await contextRes.json();
        const fullTranslatedText = (contextJson.sentences || []).map(s => s.trans || '').join('');
        splitLines = fullTranslatedText.split('\n').map(s => s.replace(/\.$/, '').trim());
    } catch (e) {}

    await Promise.all(
      linesToTranslate.map(async (rawText, idx) => {
        let trLine = splitLines[idx] || '';
        let romaja = '';

        if (isNonLatin(rawText) || !trLine) {
          try {
              const singleUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=tr&dt=t&dt=rm&q=${encodeURIComponent(rawText)}`;
              const singleRes = await fetch(singleUrl);
              const singleJson = await singleRes.json();

              if (Array.isArray(singleJson[0])) {
                let fallbackTr = '';
                singleJson[0].forEach(item => {
                  if (item[0]) fallbackTr += item[0];
                  if (item[3]) romaja += (romaja ? ' ' : '') + item[3];
                });
                if (!trLine) trLine = fallbackTr.trim();
              }
          } catch(e) {}
        }

        if (trLine) {
            cache.set(rawText, { tr: trLine, romaja: romaja.trim() });
        }
      })
    );
    saveCache();
    updateDOMWithCache();
  }

  async function processStanzaTranslation(allVisibleLines) {
    const missingLines = allVisibleLines.filter(t => !cache.has(t) && !inFlight.has(t));
    if (missingLines.length === 0) return;
    
    // İşlemdekileri işaretle
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
      // AI yoksa veya hata verirse GTX çalıştır
      await translateWithContextGTX(missingLines);
    } catch (e) {
      console.error('Spicy TR V21 Hata:', e);
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
        ? 'Sol Tık: Çeviriyi Aç/Kapat | Sağ Tık: Gemini AI Anahtarını Yönet & Önbelleği Sıfırla (Ultimate AI Aktif)'
        : 'Sol Tık: Çeviriyi Aç/Kapat | Sağ Tık: %100 Kusursuz Çeviri İçin Ücretsiz Gemini AI Anahtarı Gir';
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
      const input = prompt(
        '🌟 Spicy Lyrics AI Çeviri & Romaja V21.0 (ULTIMATE) 🌟\n\n' +
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

  // Senin asıl V5'indeki saf, bozulmaz tarayıcı mantığı
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
