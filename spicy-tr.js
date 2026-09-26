// NAME: Spicy Lyrics AI Translator & Romaja
// AUTHOR: Aysenur
// VERSION: 5.1.0
// DESCRIPTION: Context-Aware & Gemini AI-Powered Lyrics Translation + Romanization for Spicy Lyrics

(function spicyLyricsAITranslatorV5_1() {
  const STORAGE_CACHE_KEY = 'spicy_tr_persistent_cache_v5';
  let savedCache = {};
  try {
    savedCache = JSON.parse(localStorage.getItem(STORAGE_CACHE_KEY) || '{}');
  } catch (e) {
    savedCache = {};
  }

  const cache = new Map(Object.entries(savedCache));
  const inFlight = new Set();
  let isEnabled = localStorage.getItem('spicy_tr_enabled') !== 'false';
  let geminiApiKey = localStorage.getItem('spicy_tr_gemini_key') || '';
  let batchTimer = null;

  function saveCacheToDisk() {
    try {
      // Hafızanın şişmemesi için son 2500 satırı kalıcı tut
      const entries = Array.from(cache.entries()).slice(-2500);
      localStorage.setItem(STORAGE_CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
    } catch (e) {
      console.warn('Spicy TR Cache Yazma Uyarısı:', e);
    }
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

  function detectLang(text) {
    if (/[\uac00-\ud7a3]/.test(text)) return 'ko';
    if (/[\u3040-\u30ff]/.test(text)) return 'ja';
    if (/[\u0e00-\u0e7f]/.test(text)) return 'th';
    if (/[\u4e00-\u9faf]/.test(text)) return 'zh-CN';
    return 'auto';
  }

  function isNonLatin(text) {
    return /[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\uff00-\uff9f\u4e00-\u9faf\u3400-\u4dbf\uac00-\ud7a3\u0e00-\u0e7f\u0400-\u04ff\u0600-\u06ff]/.test(text);
  }

  function getCleanText(lineEl) {
    const clone = lineEl.cloneNode(true);
    clone.querySelectorAll('.spicy-tr-box').forEach(el => el.remove());
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

  async function translateWithGeminiAI(allVisibleLines) {
    const songTitle = Spicetify?.Player?.data?.item?.name || 'Unknown Song';
    const artist = Spicetify?.Player?.data?.item?.artists?.[0]?.name || 'Unknown Artist';

    const prompt = `You are an expert poetic music translator. Translate the following song lyrics (Song: "${songTitle}" by "${artist}") into natural, idiomatic, emotionally accurate Turkish. Understand slang, metaphors, and context across lines (e.g., "you got me" means "bana sahipsin/elinde ben varım", NOT "beni yakaladın"; "losing it" means "kontrolümü kaybediyorum/kafayı yiyorum").
If a line is in a non-Latin script (Korean, Japanese, Thai, Chinese, Russian, etc.), also provide its smooth Latin pronunciation (romanization). If it is already in Latin script (English, Spanish, etc.), set "romaja" to "".
Return ONLY a valid JSON array of objects in the exact same order as the input lines, with keys "tr" and "romaja".
Input lines:
${JSON.stringify(allVisibleLines)}`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiApiKey.trim()}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.2 }
      })
    });

    if (!res.ok) throw new Error('Gemini API limit or error');
    const json = await res.json();
    const rawOutput = json?.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
    const parsed = JSON.parse(rawOutput);

    allVisibleLines.forEach((rawText, idx) => {
      if (parsed[idx]) {
        cache.set(rawText, {
          tr: (parsed[idx].tr || '').trim(),
          romaja: (parsed[idx].romaja || '').trim()
        });
      }
    });
    saveCacheToDisk();
    updateDOMWithCache();
  }

  async function translateWithContextGTX(allVisibleLines) {
    const sourceLang = detectLang(allVisibleLines.join(' '));
    const joinedBlock = allVisibleLines.join('.\n');

    const contextUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sourceLang}&tl=tr&dt=t&dj=1&q=${encodeURIComponent(joinedBlock)}`;
    const contextRes = await fetch(contextUrl);
    const contextJson = await contextRes.json();

    const fullTranslatedText = (contextJson.sentences || [])
      .map(s => s.trans || '')
      .join('');

    const splitLines = fullTranslatedText.split('\n').map(s => s.replace(/\.$/, '').trim());

    await Promise.all(
      allVisibleLines.map(async (rawText, idx) => {
        let trLine = splitLines[idx] || '';
        let romaja = '';

        if (isNonLatin(rawText) || !trLine) {
          const singleUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sourceLang}&tl=tr&dt=t&dt=rm&q=${encodeURIComponent(rawText)}`;
          const singleRes = await fetch(singleUrl);
          const singleJson = await singleRes.json();

          if (Array.isArray(singleJson[0])) {
            let fallbackTr = '';
            singleJson[0].forEach(item => {
              if (item[0]) fallbackTr += item[0];
              if (item[3]) romaja = item[3];
            });
            if (!trLine) trLine = fallbackTr.trim();
          }
        }

        cache.set(rawText, { tr: trLine, romaja: romaja.trim() });
      })
    );
    saveCacheToDisk();
    updateDOMWithCache();
  }

  async function processStanzaTranslation(allVisibleLines) {
    const missingLines = allVisibleLines.filter(t => !cache.has(t) && !inFlight.has(t));
    if (missingLines.length === 0) return;
    missingLines.forEach(t => inFlight.add(t));

    try {
      if (geminiApiKey && geminiApiKey.trim().length > 10) {
        try {
          await translateWithGeminiAI(allVisibleLines);
          return;
        } catch (aiErr) {
          console.warn('Spicy TR: AI sınırı/hatası, GTX yedek motoruna geçiliyor...', aiErr);
        }
      }
      await translateWithContextGTX(allVisibleLines);
    } catch (e) {
      console.error('Spicy TR V5.1 Hata:', e);
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
        ? 'Sol Tık: Çeviriyi Aç/Kapat | Sağ Tık: Gemini AI Anahtarını Yönet (Kalıcı Hafıza Aktif)'
        : 'Sol Tık: Çeviriyi Aç/Kapat | Sağ Tık: Ücretsiz Gemini AI Anahtarı Gir';
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
        '🌟 Spicy Lyrics AI Çeviri & Romaja Ayarları 🌟\n\n' +
        '• Ücretsiz Gemini API Anahtarınızı aşağıya yapıştırın (aistudio.google.com/apikey).\n' +
        '• Çevrilen şarkılar bilgisayarınıza kalıcı olarak kaydedilir, kotanız harcanmaz!\n' +
        '• Standart (GTX) moda dönmek için kutuyu boş bırakıp Tamam\'a basın:',
        geminiApiKey
      );
      if (input !== null) {
        geminiApiKey = input.trim();
        localStorage.setItem('spicy_tr_gemini_key', geminiApiKey);
        cache.clear();
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
      } else {
        hasMissing = true;
      }
    });

    if (hasMissing && allVisibleTexts.length > 0) {
      clearTimeout(batchTimer);
      // Kaydırma esnasında kotayı korumak için 350ms akıllı bekleme
      batchTimer = setTimeout(() => {
        processStanzaTranslation(allVisibleTexts);
      }, 350);
    }
  }

  if (window._spicyTrObserver) window._spicyTrObserver.disconnect();
  window._spicyTrObserver = new MutationObserver(() => scanLines());
  window._spicyTrObserver.observe(document.body, { childList: true, subtree: true });
  scanLines();
})();