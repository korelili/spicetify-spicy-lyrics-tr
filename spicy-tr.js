// NAME: Spicy Lyrics AI Translator & Romaja
// AUTHOR: korelili
// VERSION: 6.0.0
// DESCRIPTION: Flawless Word-Separated Romanization & Context-Aware / Gemini AI Turkish Translations for Spicy Lyrics

(function spicyLyricsAITranslatorV6() {
  // Eski V5 bozuk önbelleğini otomatik temizle
  localStorage.removeItem('spicy_tr_persistent_cache_v5');

  const STORAGE_CACHE_KEY = 'spicy_tr_persistent_cache_v6';
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
      const entries = Array.from(cache.entries()).slice(-2500);
      localStorage.setItem(STORAGE_CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
    } catch (e) {
      console.warn('Spicy TR Cache Uyarısı:', e);
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

  // V6 KRİTİK DÜZELTME: Kelime kutularının (span/div) birbirine yapışmasını %100 önleyen akıllı okuyucu
  function getCleanText(lineEl) {
    const clone = lineEl.cloneNode(true);
    clone.querySelectorAll('.spicy-tr-box').forEach(el => el.remove());

    // Eğer tek bir dış sarmalayıcı (wrapper) varsa onun içine in
    let container = clone;
    while (container.children.length === 1 && container.children[0].children.length > 0) {
      container = container.children[0];
    }

    // Eğer satır kelime kelime elementlere bölünmüşse her kelime kutusunun arasına boşluk koy
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

  // Romaja metninde bitişik kalan İngilizce/Korece geçişlerini ve noktalamaları ayırır
  function formatRomaja(rom, rawText) {
    if (!rom) return '';
    let cleaned = rom
      // Küçük harften sonra gelen Büyük harfi ayır (örn: daLight -> da Light, hamkkelamyeonSay -> hamkkelamyeon Say)
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      // Virgül veya noktalamadan sonra yapışan kelimeleri ayır
      .replace(/([,!?])([A-Za-z0-9])/g, '$1 $2')
      // Sayı ile harf yapışmışsa ayır (örn: 7for7haeng -> 7 for 7 haeng)
      .replace(/([0-9])([a-zA-Z])/g, '$1 $2')
      .replace(/([a-zA-Z])([0-9])/g, '$1 $2')
      .replace(/\s+/g, ' ')
      .trim();
    return cleaned;
  }

  // Yedek motor (GTX) için şarkı deyimleri ve yanlış çeviri düzeltici
  function polishTurkishTranslation(tr, rawText) {
    if (!tr) return '';
    let fixed = tr;
    if (/like a python/i.test(rawText)) {
      fixed = fixed.replace(/python/gi, 'piton yılanı');
    }
    if (/got a hold on me/i.test(rawText) && /tutması gerekiyor/i.test(fixed)) {
      fixed = 'Ama beni bir piton gibi kıskacına aldı';
    }
    if (/^I should move on I know$/i.test(rawText.replace(/[,!.]/g, ''))) {
      fixed = 'Önüme bakmam gerektiğini biliyorum';
    }
    if (/falling for the shooter/i.test(rawText) && /tetikçiye düşüyordum/i.test(fixed)) {
      fixed = 'Göğsümden vuruldum, beni vurana aşık oluyordum';
    }
    return fixed;
  }

  function renderSubtitles(lineEl, data, rawText) {
    let box = lineEl.querySelector('.spicy-tr-box');
    if (box) box.remove();

    box = document.createElement('div');
    box.className = 'spicy-tr-box';

    if (data.romaja && isNonLatin(rawText)) {
      const romEl = document.createElement('div');
      romEl.className = 'spicy-tr-romaja';
      romEl.textContent = formatRomaja(data.romaja, rawText);
      box.appendChild(romEl);
    }

    if (data.tr && data.tr.toLowerCase() !== rawText.toLowerCase()) {
      const trEl = document.createElement('div');
      trEl.className = 'spicy-tr-turkish';
      trEl.textContent = polishTurkishTranslation(data.tr, rawText);
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

  // 1. MOTOR: Gemini AI Kusursuz Şarkı Çeviri Motoru (Çift Model Yedekli)
  async function translateWithGeminiAI(allVisibleLines) {
    const songTitle = Spicetify?.Player?.data?.item?.name || 'Unknown Song';
    const artist = Spicetify?.Player?.data?.item?.artists?.[0]?.name || 'Unknown Artist';

    const prompt = `You are an expert poetic music translator. Translate the following song lyrics (Song: "${songTitle}" by "${artist}") into natural, idiomatic, emotionally accurate Turkish.
CRITICAL RULES:
1. Translate idioms and metaphors by their true meaning in Turkish (e.g. "got a hold on me like a python" = "beni bir piton gibi sardı/kıskacına aldı", "move on" = "önüme bakmak/unutmak", "falling for the shooter" = "beni vurana aşık oluyordum", "I'm an icon" = "bir ikon olduğumu"). Never leave animals/objects like "python" untranslated.
2. If a line contains Korean, Japanese, Thai, Chinese, or Cyrillic characters, provide its clean, space-separated Latin pronunciation in "romaja" (put spaces between every word!). If the line is purely English/Latin, set "romaja" to "".
Return ONLY a valid JSON array of objects in the exact same order as the input lines, with keys "tr" and "romaja".
Input lines:
${JSON.stringify(allVisibleLines)}`;

    const models = ['gemini-2.5-flash', 'gemini-2.0-flash'];
    let lastError = null;

    for (const model of models) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey.trim()}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: 'application/json', temperature: 0.2 }
          })
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        let rawOutput = json?.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
        rawOutput = rawOutput.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
        const parsed = JSON.parse(rawOutput);

        if (!Array.isArray(parsed)) throw new Error('Invalid JSON array');

        allVisibleLines.forEach((rawText, idx) => {
          if (parsed[idx]) {
            cache.set(rawText, {
              tr: polishTurkishTranslation((parsed[idx].tr || '').trim(), rawText),
              romaja: formatRomaja((parsed[idx].romaja || '').trim(), rawText)
            });
          }
        });
        saveCacheToDisk();
        updateDOMWithCache();
        return;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  }

  // 2. MOTOR: K-Pop Karma Dil Destekli (sl=auto) Bağlamsal Neural Motor
  async function translateWithContextGTX(allVisibleLines, shouldSaveToDisk = true) {
    // K-Pop şarkılarında hem İngilizce hem Korece satırlar olduğu için sl=auto kullanıyoruz
    const joinedBlock = allVisibleLines.join('.\n');

    const contextUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=tr&dt=t&dj=1&q=${encodeURIComponent(joinedBlock)}`;
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

        // Korece/Japonca satırların Romaja okunuşunu kelime boşluklarını koruyarak al
        if (isNonLatin(rawText) || !trLine) {
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
        }

        cache.set(rawText, {
          tr: polishTurkishTranslation(trLine, rawText),
          romaja: formatRomaja(romaja, rawText)
        });
      })
    );
    if (shouldSaveToDisk) saveCacheToDisk();
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
          console.warn('Spicy TR: AI anlık yoğunlukta, geçici olarak GTX kullanılıyor...', aiErr);
          // AI modundayken geçici hata olursa diske kaydetme ki bir sonraki açılışta AI çevirsin
          await translateWithContextGTX(allVisibleLines, false);
          return;
        }
      }
      await translateWithContextGTX(allVisibleLines, true);
    } catch (e) {
      console.error('Spicy TR V6 Hata:', e);
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
        ? 'Sol Tık: Çeviriyi Aç/Kapat | Sağ Tık: Gemini AI Anahtarını Yönet ve Önbelleği Sıfırla (V6 Aktif)'
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
        '🌟 Spicy Lyrics AI Çeviri & Romaja V6.0 🌟\n\n' +
        '• Ücretsiz Gemini API Anahtarınızı aşağıya yapıştırın (aistudio.google.com/apikey).\n' +
        '• Tamam\'a bastığınızda eski çeviri önbelleği temizlenir ve şarkı yeniden çevrilir:',
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
      batchTimer = setTimeout(() => {
        processStanzaTranslation(allVisibleTexts);
      }, 300);
    }
  }

  if (window._spicyTrObserver) window._spicyTrObserver.disconnect();
  window._spicyTrObserver = new MutationObserver(() => scanLines());
  window._spicyTrObserver.observe(document.body, { childList: true, subtree: true });
  scanLines();
})();
