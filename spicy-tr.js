// NAME: Spicy Lyrics AI Translator & Romaja
// AUTHOR: korelili
// VERSION: 7.0.0
// DESCRIPTION: Flawless Hybrid Romanization & Queued Gemini AI / Context-Aware Translations for Spicy Lyrics

(function spicyLyricsAITranslatorV7() {
  // Önceki tüm bozuk önbellekleri temizle
  ['spicy_tr_persistent_cache_v5', 'spicy_tr_persistent_cache_v6', 'spicy_tr_persistent_cache_v6_1'].forEach(k => {
    localStorage.removeItem(k);
  });

  const STORAGE_CACHE_KEY = 'spicy_tr_persistent_cache_v7_0';
  let savedCache = {};
  try {
    savedCache = JSON.parse(localStorage.getItem(STORAGE_CACHE_KEY) || '{}');
  } catch (e) {
    savedCache = {};
  }

  const cache = new Map(Object.entries(savedCache));
  let isEnabled = localStorage.getItem('spicy_tr_enabled') !== 'false';
  let geminiApiKey = localStorage.getItem('spicy_tr_gemini_key') || '';
  let isRequestLocked = false;
  let pendingRescan = false;
  let scanTimer = null;

  function saveCacheToDisk() {
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

  function detectScriptLang(text) {
    if (/[\uac00-\ud7a3]/.test(text)) return 'ko';
    if (/[\u3040-\u30ff]/.test(text)) return 'ja';
    if (/[\u0e00-\u0e7f]/.test(text)) return 'th';
    if (/[\u4e00-\u9faf]/.test(text)) {
      // Şarkının genelinde Japonca kana varsa Kanji satırlarını da Japonca ('ja') olarak tanı
      const pageText = document.querySelector('#SpicyLyricsPage')?.textContent || '';
      if (/[\u3040-\u30ff]/.test(pageText)) return 'ja';
      return 'zh-CN';
    }
    if (/[\u0400-\u04ff]/.test(text)) return 'ru';
    return 'en';
  }

  // Kelime kutularını (span) birbirine yapıştırmadan okuyan DOM ayrıştırıcı
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

  // Ritim ve ses efektlerinin "İpucu musluğu" diye çevrilmesini önleyen koruyucu
  function isPureRhythmOrVocal(text) {
    const cleaned = text.replace(/[(),.!?\-~]/g, ' ').replace(/\s+/g, ' ').trim();
    return /^(tip tap(\s+tip|\s+tap)*|yeah(\s+yeah)*|la(\s+la)+|na(\s+na)+|oh(\s+oh)+|whoo(\s+whoo)*|ooh(\s+ooh)*|ah(\s+ah)+|uh(\s+uh)+|bam(\s+bam)+)$/i.test(cleaned);
  }

  function cleanPostTranslation(tr, rawText) {
    if (!tr) return '';
    if (isPureRhythmOrVocal(rawText)) return '';

    let fixed = tr.trim();
    // "Tip tap" geçen satırlarda "ipucu musluğu / ipucu dokunun" saçmalığını temizle
    if (/tip\s+tap/i.test(rawText)) {
      fixed = fixed
        .replace(/\(?\s*[İi]pucu\s+(musluğu\vert{}dokunun)[^)]*\)?/gi, '(Tip tap tip tap tap)')
        .replace(/[İi]pucu\s+ucu/gi, 'Tip tap');
    }
    if (/like a python/i.test(rawText)) {
      fixed = fixed.replace(/python/gi, 'piton');
      if (/yakaladı|tutması gerekiyor|tuttu/i.test(fixed)) {
        fixed = 'Ama beni bir piton gibi kıskacına aldı';
      }
    }
    if (/^I should move on I know$/i.test(rawText.replace(/[,!.]/g, ''))) {
      fixed = 'Önüme bakmam gerektiğini biliyorum';
    }
    if (/falling for the shooter/i.test(rawText) && /tetikçiye düşüyordum/i.test(fixed)) {
      fixed = 'Göğsümden vuruldum, beni vurana aşık oluyordum';
    }
    return fixed.replace(/\s+/g, ' ').trim();
  }

  function cleanRomajaString(rom) {
    if (!rom) return '';
    return rom
      .replace(/([a-zāēīōū])([A-Z])/g, '$1 $2')
      .replace(/([,!?])([A-Za-z0-9])/g, '$1 $2')
      .replace(/([0-9])([a-zA-Z])/g, '$1 $2')
      .replace(/([a-zA-Z])([0-9])/g, '$1 $2')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // V7 DEVRİMİ: Satırın içindeki İngilizce kelimeleri ("Yeah", "Up and down", "MY SWAGGER", "Ready")
  // Japon/Kore aksanıyla ("I~ēi", "ando", "suwagā", "redi") bozmadan SADECE Asya harflerini okunuşa çevirir!
  async function buildHybridRomaja(rawText, lang) {
    if (!isNonLatin(rawText)) return '';
    const parts = rawText.split(NON_LATIN_CHUNK_REGEX);
    const resolvedParts = await Promise.all(
      parts.map(async (part) => {
        if (!part) return '';
        if (!isNonLatin(part)) {
          // İngilizce/Latin kısmı olduğu gibi tertemiz koru!
          return part.trim();
        }
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
    return cleanRomajaString(resolvedParts.filter(Boolean).join(' '));
  }

  // Karma (Japonca/Korece + BÜYÜK HARF İNGİLİZCE) satırlarda "Nozomi Dori" / "Kabukumi" hatasını önleyen çevirici
  async function translateMixedLineGTX(rawText, lang) {
    if (isPureRhythmOrVocal(rawText)) return '';

    // Satırın içinde "MY SWAGGER" veya "(Tip tap...)" gibi gramer bozan kalıplar varsa geçici yer tutucu ile koru
    let preparedText = rawText.replace(/\(Tip tap[^)]*\)/gi, '');
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${lang}&tl=tr&dt=t&q=${encodeURIComponent(preparedText.trim())}`;
    const res = await fetch(url);
    const json = await res.json();

    let tr = '';
    if (Array.isArray(json[0])) {
      json[0].forEach(item => {
        if (item[0]) tr += item[0];
      });
    }

    // Eğer büyük harfli İngilizce ifade yüzünden Japonca/Korece kısım çevrilmeden ("Nozomi Dori" / "Kabukumi") kaldıysa,
    // Asya karakterli parçaları doğrudan çevirip birleştir
    if (isNonLatin(rawText) && /MY SWAGGER/i.test(rawText)) {
      const nonLatinMatches = rawText.match(NON_LATIN_CHUNK_REGEX);
      if (nonLatinMatches && nonLatinMatches.length > 0) {
        const joinedNonLatin = nonLatinMatches.join(' ');
        const pureUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${lang}&tl=tr&dt=t&q=${encodeURIComponent(joinedNonLatin)}`;
        const pureRes = await fetch(pureUrl);
        const pureJson = await pureRes.json();
        let pureTr = '';
        if (Array.isArray(pureJson[0])) {
          pureJson[0].forEach(item => {
            if (item[0]) pureTr += item[0];
          });
        }
        if (pureTr && /nozomi|kabuku/i.test(tr)) {
          tr = `${pureTr.trim()} (MY SWAGGER)`;
        }
      }
    }

    return cleanPostTranslation(tr, rawText);
  }

  function renderSubtitles(lineEl, data, rawText) {
    let box = lineEl.querySelector('.spicy-tr-box');
    if (box) box.remove();

    if (isPureRhythmOrVocal(rawText)) return;

    box = document.createElement('div');
    box.className = 'spicy-tr-box';

    if (data.romaja && isNonLatin(rawText)) {
      const romEl = document.createElement('div');
      romEl.className = 'spicy-tr-romaja';
      romEl.textContent = cleanRomajaString(data.romaja);
      box.appendChild(romEl);
    }

    const cleanedTr = cleanPostTranslation(data.tr, rawText);
    if (cleanedTr && cleanedTr.toLowerCase() !== rawText.toLowerCase()) {
      const trEl = document.createElement('div');
      trEl.className = 'spicy-tr-turkish';
      trEl.textContent = cleanedTr;
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

  // 1. MOTOR: Sıra Kilitli, 3 Model Havuzlu Kusursuz Gemini AI Motoru
  async function translateBatchWithGeminiAI(missingLines, allContextLines) {
    const songTitle = Spicetify?.Player?.data?.item?.name || 'Unknown Song';
    const artist = Spicetify?.Player?.data?.item?.artists?.[0]?.name || 'Unknown Artist';

    const indexedInput = missingLines.map((line, idx) => ({ i: idx, text: line }));

    const prompt = `You are an elite poetic music translator for Spotify.
Song: "${songTitle}" by "${artist}".
Full stanza context: ${JSON.stringify(allContextLines)}

Translate each item in the following indexed list into natural, idiomatic, emotionally accurate Turkish ("tr") and clean Romanization ("romaja").
STRICT RULES:
1. NEVER translate rhythmic sound effects literally (e.g. "Tip tap tip tap tap" is a tapping rhythm/footstep sound — set "tr" to "" or keep "(Tip tap)" in parentheses; NEVER write "İpucu musluğu" or "İpucu dokunun"!).
2. In mixed Japanese/Korean + English lines (e.g. "Yeah 目指す高み", "可能性のみ信じて超える Up and down", "君も連れて Ready, set, go", "輝け MY SWAGGER のぞみ通り", "MY SWAGGER かぶくのみ"):
   - For "romaja": Romanize ONLY the Japanese/Korean characters and keep English words in their exact original English spelling! (e.g. "Yeah mezasu takami", "Kanōsei nomi shinjite koeru Up and down", "Kimi mo tsurete Ready, set, go", "Kagayake MY SWAGGER nozomi dōri"). NEVER write Katakana English like "I~ēi", "ando", "redi", or "suwagā"!
   - For "tr": Translate ALL Japanese/Korean meanings fully into Turkish (e.g. "のぞみ通り" = "tam istediğim gibi", "かぶくのみ" = "sadece farkımı ortaya koyarım", "歩む道" = "yürüdüğüm yol", "Ready, set, go" = "Hazır, dikkat, başla"). NEVER leave Japanese words untranslated as "Nozomi Dori" or "Kabukumi"!
3. If a line has no non-Latin characters, set "romaja" to "".

Return ONLY a valid JSON array of objects with keys "i" (number), "tr" (string), and "romaja" (string):
${JSON.stringify(indexedInput)}`;

    // 3 Ayrı Ücretsiz Kota Havuzu
    const models = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.5-flash-lite'];
    let lastErr = null;

    for (const model of models) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey.trim()}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: 'application/json', temperature: 0.1 }
          })
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        let rawOutput = json?.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
        rawOutput = rawOutput.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
        const parsed = JSON.parse(rawOutput);

        if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('Empty AI array');

        parsed.forEach(item => {
          const idx = typeof item.i === 'number' ? item.i : parsed.indexOf(item);
          const rawText = missingLines[idx];
          if (rawText) {
            cache.set(rawText, {
              tr: cleanPostTranslation(item.tr || '', rawText),
              romaja: isNonLatin(rawText) ? cleanRomajaString(item.romaja || '') : ''
            });
          }
        });

        // Eğer AI bazı satırları atladıysa sadece o satırları hibrit motorla tamamla
        const stillMissing = missingLines.filter(l => !cache.has(l));
        if (stillMissing.length > 0) {
          await translateBatchWithHybridGTX(stillMissing, false);
        }

        saveCacheToDisk();
        updateDOMWithCache();
        return;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  }

  // 2. MOTOR: Hibrit Parçalı Romaja + Dil Ayrıştırmalı GTX Yedek Motoru
  async function translateBatchWithHybridGTX(missingLines, shouldSaveToDisk = true) {
    await Promise.all(
      missingLines.map(async (rawText) => {
        if (isPureRhythmOrVocal(rawText)) {
          cache.set(rawText, { tr: '', romaja: '' });
          return;
        }
        const lang = detectScriptLang(rawText);
        const [tr, romaja] = await Promise.all([
          translateMixedLineGTX(rawText, lang),
          buildHybridRomaja(rawText, lang)
        ]);
        cache.set(rawText, { tr, romaja });
      })
    );

    if (shouldSaveToDisk) saveCacheToDisk();
    updateDOMWithCache();
  }

  async function processQueue() {
    if (isRequestLocked) {
      pendingRescan = true;
      return;
    }

    const lineEls = Array.from(document.querySelectorAll('#SpicyLyricsPage .line:not(.musical-line)'));
    const allVisibleTexts = [];
    const missingLines = [];

    lineEls.forEach(lineEl => {
      const text = getCleanText(lineEl);
      if (!text || text === '•••') return;

      if (!allVisibleTexts.includes(text)) allVisibleTexts.push(text);

      if (cache.has(text)) {
        if (!lineEl.querySelector('.spicy-tr-box')) {
          renderSubtitles(lineEl, cache.get(text), text);
        }
      } else if (!missingLines.includes(text)) {
        missingLines.push(text);
      }
    });

    if (missingLines.length === 0) return;

    isRequestLocked = true;
    try {
      if (geminiApiKey && geminiApiKey.trim().length > 10) {
        try {
          await translateBatchWithGeminiAI(missingLines, allVisibleTexts);
        } catch (aiErr) {
          console.warn('Spicy TR V7: AI geçici sınırda, Hibrit GTX devreye girdi:', aiErr);
          await translateBatchWithHybridGTX(missingLines, false);
        }
      } else {
        await translateBatchWithHybridGTX(missingLines, true);
      }
    } catch (e) {
      console.error('Spicy TR V7 Hata:', e);
    } finally {
      isRequestLocked = false;
      if (pendingRescan) {
        pendingRescan = false;
        setTimeout(processQueue, 250);
      }
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
        ? 'Sol Tık: Çeviriyi Aç/Kapat | Sağ Tık: Gemini AI Anahtarını Yönet ve Önbelleği Sıfırla (V7.0 Aktif)'
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
        '🌟 Spicy Lyrics AI Çeviri & Romaja V7.0 🌟\n\n' +
        '• Ücretsiz Gemini API Anahtarınızı aşağıya yapıştırın (aistudio.google.com/apikey).\n' +
        '• Tamam\'a bastığınızda tüm eski önbellek temizlenir ve şarkı V7.0 motoruyla yeniden çevrilir:',
        geminiApiKey
      );
      if (input !== null) {
        geminiApiKey = input.trim();
        localStorage.setItem('spicy_tr_gemini_key', geminiApiKey);
        cache.clear();
        localStorage.removeItem(STORAGE_CACHE_KEY);
        document.querySelectorAll('#SpicyLyricsPage .spicy-tr-box').forEach(b => b.remove());
        updateBtnVisual();
        processQueue();
      }
    };

    controls.appendChild(btn);
  }

  function scanLines() {
    injectToggleButton();
    // Önbellekte olanları anında ekrana bas (0 gecikme)
    const lineEls = document.querySelectorAll('#SpicyLyricsPage .line:not(.musical-line)');
    let needsFetch = false;

    lineEls.forEach(lineEl => {
      const text = getCleanText(lineEl);
      if (!text || text === '•••') return;
      if (cache.has(text)) {
        if (!lineEl.querySelector('.spicy-tr-box')) {
          renderSubtitles(lineEl, cache.get(text), text);
        }
      } else {
        needsFetch = true;
      }
    });

    if (needsFetch) {
      clearTimeout(scanTimer);
      scanTimer = setTimeout(processQueue, 250);
    }
  }

  if (window._spicyTrObserver) window._spicyTrObserver.disconnect();
  window._spicyTrObserver = new MutationObserver(() => scanLines());
  window._spicyTrObserver.observe(document.body, { childList: true, subtree: true });
  scanLines();
})();
