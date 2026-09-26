// NAME: Spicy Lyrics AI Translator & Romaja
// AUTHOR: korelili
// VERSION: 18.0.0
// DESCRIPTION: Instant Non-Blocking Hybrid Romaja + Two-Step Mixed-Language Translator & Gemini AI Refiner for Spicy Lyrics

(function spicyLyricsTranslatorV18() {
  // Eski önbellekleri temizle
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
    'spicy_tr_better_lyrics_v17'
  ].forEach(k => localStorage.removeItem(k));

  const STORAGE_CACHE_KEY = 'spicy_tr_instant_v18';
  let savedCache = {};
  try {
    savedCache = JSON.parse(localStorage.getItem(STORAGE_CACHE_KEY) || '{}');
  } catch (e) {
    savedCache = {};
  }

  const cache = new Map(Object.entries(savedCache));
  const inFlightFast = new Set();
  const inFlightAi = new Set();
  const deadModels = new Map();

  let isEnabled = localStorage.getItem('spicy_tr_enabled') !== 'false';
  let geminiApiKey = localStorage.getItem('spicy_tr_gemini_key') || '';
  let scanScheduled = false;
  let aiTimer = null;

  function saveCache() {
    try {
      const entries = Array.from(cache.entries())
        .filter(([, val]) => val && val.tr)
        .slice(-3500);
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

  const CYRILLIC_TO_LATIN = {
    'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'yo','ж':'zh','з':'z','и':'i','й':'y','к':'k','л':'l','м':'m',
    'н':'n','о':'o','п':'p','р':'r','с':'s','т':'t','у':'u','ф':'f','х':'h','ц':'ts','ч':'ch','ш':'sh','щ':'sht','ъ':'a',
    'ы':'y','ь':'','э':'e','ю':'yu','я':'ya','і':'i','ї':'yi','є':'ye','ґ':'g',
    'А':'A','Б':'B','В':'V','Г':'G','Д':'D','Е':'E','Ё':'Yo','Ж':'Zh','З':'Z','И':'I','Й':'Y','К':'K','Л':'L','М':'M',
    'Н':'N','О':'O','П':'P','Р':'R','С':'S','Т':'T','У':'U','Ф':'F','Х':'H','Ц':'Ts','Ч':'Ch','Ш':'Sh','Щ':'Sht','Ъ':'A',
    'Ы':'Y','Ь':'','Э':'E','Ю':'Yu','Я':'Ya','І':'I','Ї':'Yi','Є':'Ye','Ґ':'G'
  };

  function transliterateCyrillic(str) {
    if (!/[\u0400-\u04ff]/.test(str)) return str;
    return str.split('').map(c => CYRILLIC_TO_LATIN[c] !== undefined ? CYRILLIC_TO_LATIN[c] : c).join('');
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

  // Zaman aşımı (Timeout) korumalı Fetch: Hiçbir ağ isteğinin kodu kilitlemesine izin vermez!
  async function fetchWithTimeout(url, options = {}, timeoutMs = 4500) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timer);
      return res;
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  }

  // HİBRİT ROMAJA MOTORU
  async function buildHybridRomaja(rawText) {
    if (!isNonLatin(rawText)) return '';
    const lang = detectLang(rawText);
    const parts = rawText.split(NON_LATIN_CHUNK_REGEX);
    const resolvedParts = await Promise.all(
      parts.map(async (part) => {
        if (!part) return '';
        if (!isNonLatin(part)) return part.trim();
        if (/[\u0400-\u04ff]/.test(part)) return transliterateCyrillic(part.trim());
        try {
          const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${lang}&tl=tr&dt=rm&q=${encodeURIComponent(part.trim())}`;
          const res = await fetchWithTimeout(url, {}, 3500);
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

  // EVRENSEL ARGO & TÜRKÇE "SEN" UYUMU DÜZELTİCİ
  function prepareTextForTranslation(rawText) {
    return rawText
      .replace(/우리 사인/g, '우리 사이는')
      .replace(/\bImma\b/gi, 'I am going to')
      .replace(/\bI'mma\b/gi, 'I am going to')
      .replace(/\btryna\b/gi, 'trying to')
      .replace(/\bgonna\b/gi, 'going to')
      .replace(/\bwanna\b/gi, 'want to')
      .replace(/\bgotta\b/gi, 'got to')
      .replace(/\berrday\b/gi, 'every day')
      .replace(/\be'ryday\b/gi, 'every day')
      .replace(/\bma\s+(darling|baby|babe|love|girl|boy|heart|life|mind)\b/gi, 'my $1')
      .replace(/,\s*boo\b/gi, ', my darling')
      .replace(/\bAM\s*PM\b/g, 'Day and night');
  }

  function polishTurkish(tr, rawText) {
    if (!tr) return '';
    let fixed = tr.trim();
    if (fixed.includes('||')) fixed = fixed.split('||').pop().trim();

    fixed = fixed.replace(/^\s*(?:\[\d+\]|\d+[.:)])\s*/, '').replace(/[?？.]+$/g, '').trim();

    if (/\bfucked\b/i.test(rawText) && /\bberbat\b/i.test(fixed)) {
      fixed = fixed.replace(/\bberbat\b/gi, 'boktan');
    }

    fixed = fixed
      .replace(/\bSizin\b/g, 'Senin').replace(/\bsizin\b/g, 'senin')
      .replace(/\bSize\b/g, 'Sana').replace(/\bsize\b/g, 'sana')
      .replace(/\bSizi\b/g, 'Seni').replace(/\bsizi\b/g, 'seni')
      .replace(/\bSizde\b/g, 'Sende').replace(/\bsizde\b/g, 'sende')
      .replace(/\bSizden\b/g, 'Senden').replace(/\bsizden\b/g, 'senden')
      .replace(/\bSiz\b/g, 'Sen').replace(/\bsiz\b/g, 'sen');

    const rootExceptions = /^(deniz|yalnız|henüz|boynuz|geniz|beniz)/i;
    fixed = fixed.split(/\s+/).map(word => {
      const cleanW = word.replace(/[.,!?'"()]/g, '');
      if (rootExceptions.test(cleanW)) return word;
      return word
        .replace(/s([iıuü])n[iıuü]z\b/gi, 's$1n')
        .replace(/n[iıuü]z(e|a|i|ı|u|ü|de|da|den|dan|le|la|in|ın|un|ün)?\b/gi, 'n$1');
    }).join(' ');

    if (!/\b(herkes|hepsi|kimse)\b/i.test(fixed)) {
      fixed = fixed
        .replace(/([a-zçğıöşü]+m[ae])y[iı]n\b/gi, '$1')
        .replace(/([a-zçğıöşü]{2,}[aeıioöuü])y[iıuü]n\b/gi, '$1')
        .replace(/([a-zçğıöşü]+l[aeıi]şt[iı]r)[iı]n\b/gi, '$1')
        .replace(/\b([a-zçğıöşü]+)\s+edin\b/gi, '$1 et')
        .replace(/\b([a-zçğıöşü]+)\s+yapın\b/gi, '$1 yap')
        .replace(/\b(hissedin|Hissedin)\b/g, 'hisset')
        .replace(/\b(bakın|Bakın)\b/g, 'bak')
        .replace(/\b(bırakın|Bırakın)\b/g, 'bırak');
    }

    if (fixed.length > 0) {
      fixed = fixed.charAt(0).toUpperCase() + fixed.slice(1);
    }
    return fixed.replace(/\s+/g, ' ').trim();
  }

  function renderSubtitles(lineEl, data, rawText) {
    if (!data || (!data.tr && !data.romaja)) return;

    const cleanTr = polishTurkish(data.tr, rawText);
    const signature = `${data.romaja || ''}|${cleanTr}`;

    let box = lineEl.querySelector('.spicy-tr-box');
    if (box && box.dataset.sig === signature) return;
    if (box) box.remove();

    box = document.createElement('div');
    box.className = 'spicy-tr-box';
    box.dataset.sig = signature;

    if (data.romaja && isNonLatin(rawText)) {
      const romEl = document.createElement('div');
      romEl.className = 'spicy-tr-romaja';
      romEl.textContent = data.romaja;
      box.appendChild(romEl);
    }

    if (cleanTr && cleanTr.toLowerCase() !== rawText.toLowerCase()) {
      const trEl = document.createElement('div');
      trEl.className = 'spicy-tr-turkish';
      trEl.textContent = cleanTr;
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

  // 1. ANLIK MOTOR (0.2 Saniyede Romaja + İki Aşamalı Karma Dil Çevirisini Ekrana Basar — ASLA Bekletmez!)
  async function translateInstantFastBatch(linesToProcess) {
    linesToProcess.forEach(l => inFlightFast.add(l));

    try {
      const preparedList = linesToProcess.map(raw => prepareTextForTranslation(raw));

      // Eğer satırda hem Asya harfleri hem İngilizce kelimeler karışıksa ("현혹된 듯 every night" gibi),
      // önce İngilizceye çevirip cümleyi birleştir, sonra tüm kıtayı birlikte Türkçeye çevir!
      const unifiedEnglishOrSource = await Promise.all(
        preparedList.map(async (prep, idx) => {
          const raw = linesToProcess[idx];
          const hasMixedLatinAndAsian = isNonLatin(raw) && /[A-Za-z]{2,}/.test(raw);
          if (!hasMixedLatinAndAsian) return prep;
          try {
            const lang = detectLang(raw);
            const enUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${lang}&tl=en&dt=t&q=${encodeURIComponent(prep)}`;
            const res = await fetchWithTimeout(enUrl, {}, 3000);
            const json = await res.json();
            let en = '';
            if (Array.isArray(json[0])) {
              json[0].forEach(seg => { if (seg[0]) en += seg[0]; });
            }
            return en.trim() || prep;
          } catch (e) {
            return prep;
          }
        })
      );

      // Kıta bütünlüğünü korumak için önce toplu çeviriyi dene
      let batchTr = [];
      try {
        const joined = unifiedEnglishOrSource.map(l => l.replace(/[.!?]+$/, '') + '.').join('\n');
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=tr&dt=t&dj=1&q=${encodeURIComponent(joined)}`;
        const res = await fetchWithTimeout(url, {}, 3500);
        const json = await res.json();
        const full = (json.sentences || []).map(s => s.trans || '').join('');
        const split = full.split('\n').map(s => s.replace(/\.$/, '').trim()).filter(Boolean);
        if (split.length === linesToProcess.length) {
          batchTr = split;
        }
      } catch (e) {}

      // Her satırın Romaja ve Türkçe çevirisini garanti altına al
      await Promise.all(
        linesToProcess.map(async (rawText, idx) => {
          let tr = batchTr[idx] || '';
          const lang = detectLang(rawText);

          if (!tr || /bu çok önemli/i.test(tr)) {
            try {
              const sUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${lang}&tl=tr&dt=t&q=${encodeURIComponent(unifiedEnglishOrSource[idx])}`;
              const sRes = await fetchWithTimeout(sUrl, {}, 3500);
              const sJson = await sRes.json();
              tr = '';
              if (Array.isArray(sJson[0])) {
                sJson[0].forEach(seg => { if (seg[0]) tr += seg[0]; });
              }
            } catch (e) {}
          }

          const romaja = isNonLatin(rawText) ? await buildHybridRomaja(rawText) : '';
          const finalTr = polishTurkish(tr, rawText);

          if (finalTr || romaja) {
            cache.set(rawText, {
              tr: finalTr,
              romaja,
              aiUpgraded: false
            });
          }
        })
      );

      saveCache();
      updateDOMWithCache();
    } finally {
      linesToProcess.forEach(l => inFlightFast.delete(l));
    }
  }

  // 2. ARKA PLAN GEMINI AI YÜKSELTİCİ (Ekranı hiç kilitlemeden arka planda çalışır, başarılı olursa satırları şiirsel AI çevirisiyle günceller)
  async function upgradeVisibleLinesWithGeminiAI(allVisibleLines) {
    if (!geminiApiKey || geminiApiKey.trim().length <= 10) return;

    const linesNeedingAi = allVisibleLines.filter(
      t => (!cache.has(t) || !cache.get(t).aiUpgraded) && !inFlightAi.has(t)
    );
    if (linesNeedingAi.length === 0) return;

    const batch = linesToUpgrade = linesNeedingAi.slice(0, 25);
    batch.forEach(t => inFlightAi.add(t));

    try {
      const songTitle = Spicetify?.Player?.data?.item?.name || 'Unknown Song';
      const artist = Spicetify?.Player?.data?.item?.artists?.[0]?.name || 'Unknown Artist';
      const numberedInput = batch.map((l, i) => `[${i}] ${l}`).join('\n');

      const prompt = `You are an expert poetic Turkish music translator.
Song: "${songTitle}" by "${artist}"
Full visible lyrics context:
${allVisibleLines.join('\n')}

Translate each numbered line below into natural, idiomatic, emotionally accurate, uncensored Turkish song lyrics.
Rules:
1. Translate by true meaning and context across lines, never word-by-word.
2. Always use informal singular "sen" (never formal "siz").
3. Do not put periods (".") or question marks ("?") at the end of lines.
Return ONLY the numbered lines in the exact format "[index] Turkish translation":
${numberedInput}`;

      const models = [
        'gemini-2.0-flash',
        'gemini-2.5-flash-lite',
        'gemini-2.5-flash',
        'gemma-3-27b-it'
      ];

      for (const model of models) {
        if ((deadModels.get(model) || 0) > Date.now()) continue;

        try {
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey.trim()}`;
          const res = await fetchWithTimeout(
            url,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.25 }
              })
            },
            5500
          );

          if (res.status === 429 || res.status === 404 || res.status === 400) {
            deadModels.set(model, Date.now() + 90000);
            continue;
          }
          if (!res.ok) continue;

          const json = await res.json();
          const parts = json?.candidates?.[0]?.content?.parts || [];
          const rawOutput = parts.filter(p => !p.thought && p.text).map(p => p.text).join('\n') || parts.map(p => p.text || '').join('\n');

          const lineRegex = /^\s*(?:\*\*)?(?:\[(\d+)\]|(\d+)[.:)])(?:\*\*)?\s*[-–—:]?\s*(.+)$/gm;
          let match;
          let updatedCount = 0;

          while ((match = lineRegex.exec(rawOutput)) !== null) {
            const idx = parseInt(match[1] !== undefined ? match[1] : match[2], 10);
            const trText = match[3].trim().replace(/^["']|["']$/g, '');
            const rawText = batch[idx];
            if (rawText && trText) {
              const existing = cache.get(rawText) || {};
              const romaja = existing.romaja || (isNonLatin(rawText) ? await buildHybridRomaja(rawText) : '');
              cache.set(rawText, {
                tr: polishTurkish(trText, rawText),
                romaja,
                aiUpgraded: true
              });
              updatedCount++;
            }
          }

          if (updatedCount > 0) {
            saveCache();
            updateDOMWithCache();
            break;
          }
        } catch (e) {}
      }
    } finally {
      batch.forEach(t => inFlightAi.delete(t));
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
        ? 'Sol Tık: Çeviriyi Aç/Kapat | Sağ Tık: Gemini AI Anahtarını Yönet & Önbelleği Sıfırla (V18 Anlık Motor Aktif)'
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
        '🔥 Spicy Lyrics AI Çeviri & Romaja V18.0 🔥\n\n' +
        '• Ücretsiz Gemini API Anahtarınızı aşağıya yapıştırın.\n' +
        '• Tamam\'a bastığınızda önbellek temizlenir ve şarkı anında yeniden çevrilir:',
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
        runScanNow();
      }
    };

    controls.appendChild(btn);
  }

  function runScanNow() {
    scanScheduled = false;
    injectToggleButton();

    const lineEls = Array.from(document.querySelectorAll('#SpicyLyricsPage .line:not(.musical-line)'));
    const allVisibleTexts = [];
    const missingFastLines = [];

    lineEls.forEach(lineEl => {
      const text = getCleanText(lineEl);
      if (!text || text === '•••') return;

      if (!allVisibleTexts.includes(text)) allVisibleTexts.push(text);

      if (cache.has(text)) {
        renderSubtitles(lineEl, cache.get(text), text);
      } else if (!inFlightFast.has(text)) {
        missingFastLines.push(text);
      }
    });

    // 1. Eksik satırları HİÇ BEKLETMEDEN anında çevir ve ekrana bas!
    if (missingFastLines.length > 0) {
      translateInstantFastBatch(missingFastLines.slice(0, 30));
    }

    // 2. AI anahtarı varsa arka planda şiirsel AI güncellemesini çalıştır
    if (geminiApiKey && geminiApiKey.trim().length > 10 && allVisibleTexts.length > 0) {
      clearTimeout(aiTimer);
      aiTimer = setTimeout(() => {
        upgradeVisibleLinesWithGeminiAI(allVisibleTexts);
      }, 600);
    }
  }

  // KİLİTLENMEYEN TARAYICI: clearTimeout ile kendi kendini sıfırlamaz, 150ms içinde kesin çalışır!
  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    setTimeout(runScanNow, 150);
  }

  if (window._spicyTrObserver) window._spicyTrObserver.disconnect();
  window._spicyTrObserver = new MutationObserver(() => scheduleScan());
  window._spicyTrObserver.observe(document.body, { childList: true, subtree: true });
  runScanNow();
})();
