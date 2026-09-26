// NAME: Spicy Lyrics AI Translator & Romaja
// AUTHOR: korelili
// VERSION: 20.0.0 (V5 Core + Multi-Server Guarantee)
// DESCRIPTION: Unblockable Multi-Server Turkish Translation & Romanization for Spicy Lyrics

(function spicyLyricsUnblockableV20() {
  // Eski önbellekleri temizle
  [
    'spicy_tr_marketplace_v19',
    'spicy_tr_instant_v18',
    'spicy_tr_better_lyrics_v17'
  ].forEach(k => localStorage.removeItem(k));

  const STORAGE_CACHE_KEY = 'spicy_tr_stable_v20';
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

  function formatRomaja(rom) {
    if (!rom) return '';
    return rom
      .replace(/([a-zāēīōū])([A-Z])/g, '$1 $2')
      .replace(/([,!?])([A-Za-z0-9])/g, '$1 $2')
      .replace(/([0-9])([a-zA-Z])/g, '$1 $2')
      .replace(/([a-zA-Z])([0-9])/g, '$1 $2')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function prepareMeaning(rawText) {
    return rawText
      .replace(/우리 사인/g, '우리 사이는')
      .replace(/\bI'm\s+riBBon\b/gi, 'I am reborn')
      .replace(/\bversion of my side\b/gi, 'version of myself')
      .replace(/\bImma\b/gi, 'I am going to')
      .replace(/\bI'mma\b/gi, 'I am going to')
      .replace(/\btryna\b/gi, 'trying to')
      .replace(/\bgonna\b/gi, 'going to')
      .replace(/\bwanna\b/gi, 'want to')
      .replace(/\bgotta\b/gi, 'got to')
      .replace(/\berrday\b/gi, 'every day')
      .replace(/\be'ryday\b/gi, 'every day')
      .replace(/\bma\s+(darling|baby|babe|love|girl|boy|heart|life|mind)\b/gi, 'my $1')
      .replace(/,\s*boo\b/gi, ', my darling');
  }

  function enforceTurkishHarmony(tr, rawText) {
    if (!tr) return '';
    let fixed = tr.trim();
    if (fixed.includes('||')) fixed = fixed.split('||').pop().trim();
    fixed = fixed.replace(/^\s*(?:\[\d+\]|\d+[.:)])\s*/, '').replace(/[?？.]+$/g, '').trim();

    if (/\bfucked\b/i.test(rawText) && /\bberbat\b/i.test(fixed)) {
      fixed = fixed.replace(/\bberbat\b/gi, 'boktan');
    }

    fixed = fixed
      .replace(/Benim tarafımın daha iyi bir versiyonunu görün/gi, 'Benim çok daha iyi bir halimi gör')
      .replace(/Benim tarafımın daha iyi bir versiyonunu gör/gi, 'Benim çok daha iyi bir halimi gör')
      .replace(/\btarafımın daha iyi bir versiyonunu\b/gi, 'daha iyi bir halimi')
      .replace(/^Ben kurdeleyim$/i, 'Yeniden doğdum')
      .replace(/\btabelamız\b/gi, 'aramızdaki bağ')
      .replace(/\bbir tabela\b/gi, 'bir işaret')
      .replace(/\bSizin\b/g, 'Senin').replace(/\bsizin\b/g, 'senin')
      .replace(/\bSize\b/g, 'Sana').replace(/\bsize\b/g, 'sana')
      .replace(/\bSizi\b/g, 'Seni').replace(/\bsizi\b/g, 'seni')
      .replace(/\bSizde\b/g, 'Sende').replace(/\bsizde\b/g, 'sende')
      .replace(/\bSizden\b/g, 'Senden').replace(/\bsizden\b/g, 'senden')
      .replace(/\bSiz\b/g, 'Sen').replace(/\bsiz\b/g, 'sen');

    const rootNizExceptions = /^(deniz|yalnız|henüz|boynuz|geniz|beniz)/i;
    fixed = fixed.split(/\s+/).map(word => {
      const cleanW = word.replace(/[.,!?'"()]/g, '');
      if (rootNizExceptions.test(cleanW)) return word;
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
        .replace(/\b([a-zçğıöşü]+)\s+ettirin\b/gi, '$1 ettir')
        .replace(/\b([a-zçğıöşü]+)\s+yapın\b/gi, '$1 yap')
        .replace(/\b([a-zçğıöşü]+)\s+olun\b/gi, '$1 ol')
        .replace(/\b(görün|Görün)\b/g, 'gör')
        .replace(/\b(düşünün|Düşünün)\b/g, 'düşün')
        .replace(/\b(hissedin|Hissedin)\b/g, 'hisset')
        .replace(/\b(bakın|Bakın)\b/g, 'bak')
        .replace(/\b(bırakın|Bırakın)\b/g, 'bırak')
        .replace(/\b(tutun|Tutun)\b/g, 'tut')
        .replace(/\b(unutun|Unutun)\b/g, 'unut')
        .replace(/\b(koşun|Koşun)\b/g, 'koş')
        .replace(/\b(gelin|Gelin)\b/g, 'gel')
        .replace(/\b(gidin|Gidin)\b/g, 'git')
        .replace(/\b(verin|Verin)\b/g, 'ver')
        .replace(/\b(alın|Alın)\b/g, 'al')
        .replace(/\b(açın|Açın)\b/g, 'aç')
        .replace(/\b(kapatın|Kapatın)\b/g, 'kapat')
        .replace(/\b(inanın|İnanın)\b/g, 'inan')
        .replace(/\b(yükseltin|Yükseltin)\b/g, 'yükselt')
        .replace(/\b(kurtulun|Kurtulun)\b/g, 'bir kenara bırak')
        .replace(/\b(aşın|Aşın)\b/g, 'aş');
    }

    if (fixed.length > 0) {
      fixed = fixed.charAt(0).toUpperCase() + fixed.slice(1);
    }
    return fixed.replace(/\s+/g, ' ').trim();
  }

  function renderSubtitles(lineEl, data, rawText) {
    if (!data) return;
    let box = lineEl.querySelector('.spicy-tr-box');
    if (box) box.remove();

    box = document.createElement('div');
    box.className = 'spicy-tr-box';

    if (data.romaja && isNonLatin(rawText)) {
      const romEl = document.createElement('div');
      romEl.className = 'spicy-tr-romaja';
      romEl.textContent = formatRomaja(data.romaja);
      box.appendChild(romEl);
    }

    const cleanTr = enforceTurkishHarmony(data.tr, rawText);
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

  // TEK İSTEKTE TÜM KITAYI VE ROMAJA'YI ÇEKEN ÇİFT SUNUCULU MOTOR (429 Engeline Asla Takılmaz!)
  async function translateWithMultiServerGTX(linesToTranslate) {
    const preparedLines = linesToTranslate.map(l => prepareMeaning(l));
    const joinedBlock = preparedLines.join('\n');

    let trLines = [];
    let romajaLines = [];

    // 1. Sunucu: translate.googleapis.com (Tek istekte hem çeviri dt=t hem okunuş dt=rm alır!)
    try {
      const url1 = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=tr&dt=t&dt=rm&q=${encodeURIComponent(joinedBlock)}`;
      const res1 = await fetch(url1);
      if (res1.ok) {
        const json1 = await res1.json();
        if (Array.isArray(json1[0])) {
          let fullTr = '';
          let fullRom = '';
          json1[0].forEach(seg => {
            if (seg[0]) fullTr += seg[0];
            if (seg[3]) fullRom += seg[3] + '\n';
          });
          trLines = fullTr.split('\n').map(s => s.trim());
          romajaLines = fullRom.split('\n').map(s => s.trim());
        }
      }
    } catch (e) {}

    // 2. Yedek Sunucu: Eğer 1. sunucu hız sınırına takıldıysa clients5.google.com üzerinden çek!
    if (trLines.filter(Boolean).length === 0) {
      try {
        const url2 = `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl=tr&q=${encodeURIComponent(joinedBlock)}`;
        const res2 = await fetch(url2);
        if (res2.ok) {
          const json2 = await res2.json();
          const rawTranslated = Array.isArray(json2) ? (Array.isArray(json2[0]) ? json2[0][0] : json2[0]) : '';
          if (typeof rawTranslated === 'string') {
            trLines = rawTranslated.split('\n').map(s => s.trim());
          }
        }
      } catch (e) {}
    }

    // Satırların okunuşlarını ve eksik kalan çevirilerini tamamla
    await Promise.all(
      linesToTranslate.map(async (rawText, idx) => {
        let tr = trLines[idx] || '';
        let romaja = romajaLines[idx] || '';

        if ((isNonLatin(rawText) && !romaja) || !tr) {
          try {
            const singleUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=tr&dt=t&dt=rm&q=${encodeURIComponent(preparedLines[idx])}`;
            const sRes = await fetch(singleUrl);
            if (sRes.ok) {
              const sJson = await sRes.json();
              if (Array.isArray(sJson[0])) {
                let sTr = '';
                let sRom = '';
                sJson[0].forEach(item => {
                  if (item[0]) sTr += item[0];
                  if (item[3]) sRom += (sRom ? ' ' : '') + item[3];
                });
                if (!tr) tr = sTr.trim();
                if (!romaja) romaja = sRom.trim();
              }
            }
          } catch (e) {}
        }

        const cleanTr = enforceTurkishHarmony(tr, rawText);
        if (cleanTr || romaja) {
          cache.set(rawText, {
            tr: cleanTr,
            romaja: formatRomaja(romaja)
          });
        }
      })
    );

    saveCache();
    updateDOMWithCache();
  }

  // GEMINI AI MOTORU (API Anahtarı Varsa Tüm Kıtayı Birbiriyle Bağlantılı Olarak Çevirir)
  async function translateWithGeminiAI(linesToTranslate, allVisibleLines) {
    const songTitle = Spicetify?.Player?.data?.item?.name || 'Unknown Song';
    const artist = Spicetify?.Player?.data?.item?.artists?.[0]?.name || 'Unknown Artist';

    const numberedInput = linesToTranslate.map((l, i) => `[${i}] ${l}`).join('\n');

    const prompt = `You are Turkey's top poetic music translator.
Song: "${songTitle}" by "${artist}"
Full stanza context:
${allVisibleLines.join('\n')}

Translate each numbered line below into natural, connected, idiomatic Turkish song lyrics.
Rules:
1. Connect consecutive lines naturally so the whole song reads smoothly from top to bottom without inverted or broken grammar.
2. Always address the listener as informal singular "sen" (never formal "siz" like "görün", "bakın", "gözleriniz").
3. Understand wordplay and slang in context (e.g. "I'm riBBon" = "Yeniden doğdum", "See a better version of my side" = "Benim çok daha iyi bir halimi gör", "우리 사인" = "aramızdaki bağ").
4. Do not put periods (".") or question marks ("?") at the end of lines.

Return ONLY the numbered Turkish translations in this exact format:
[0] Turkish translation
[1] Turkish translation

Lines:
${numberedInput}`;

    const models = [
      'gemma-3-27b-it',
      'gemini-2.0-flash',
      'gemini-2.5-flash-lite',
      'gemini-2.5-flash',
      'gemma-3-12b-it'
    ];

    let lastErr = null;
    for (const model of models) {
      if ((deadModels.get(model) || 0) > Date.now()) continue;

      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey.trim()}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.3 }
          })
        });

        if (!res.ok) {
          deadModels.set(model, Date.now() + 60000);
          throw new Error(`HTTP ${res.status}`);
        }

        const json = await res.json();
        const parts = json?.candidates?.[0]?.content?.parts || [];
        const rawOutput = parts.filter(p => !p.thought && p.text).map(p => p.text).join('\n') || parts.map(p => p.text || '').join('\n');

        const lineRegex = /^\s*(?:\*\*)?(?:\[(\d+)\]|(\d+)[.:)])(?:\*\*)?\s*[-–—:]?\s*(.+)$/gm;
        const aiMap = new Map();
        let match;
        while ((match = lineRegex.exec(rawOutput)) !== null) {
          const idx = parseInt(match[1] !== undefined ? match[1] : match[2], 10);
          const trText = match[3].trim().replace(/^["']|["']$/g, '');
          if (!isNaN(idx) && trText) aiMap.set(idx, trText);
        }

        if (aiMap.size === 0) throw new Error('Empty AI parse');

        // Romaja için tek bir toplu istek at (40 ayrı istek atıp sunucuyu kilitleme!)
        let romajaMap = new Map();
        const nonLatinLines = linesToTranslate.filter(l => isNonLatin(l));
        if (nonLatinLines.length > 0) {
          try {
            const rmUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=tr&dt=rm&q=${encodeURIComponent(nonLatinLines.join('\n'))}`;
            const rmRes = await fetch(rmUrl);
            if (rmRes.ok) {
              const rmJson = await rmRes.json();
              if (Array.isArray(rmJson[0])) {
                let fullRm = '';
                rmJson[0].forEach(seg => {
                  if (seg[3]) fullRm += seg[3] + '\n';
                });
                const splitRm = fullRm.split('\n').map(s => s.trim());
                nonLatinLines.forEach((l, i) => {
                  if (splitRm[i]) romajaMap.set(l, splitRm[i]);
                });
              }
            }
          } catch (e) {}
        }

        linesToTranslate.forEach((rawText, idx) => {
          const tr = aiMap.get(idx);
          const romaja = romajaMap.get(rawText) || '';
          if (tr) {
            cache.set(rawText, {
              tr: enforceTurkishHarmony(tr, rawText),
              romaja: formatRomaja(romaja)
            });
          }
        });

        saveCache();
        updateDOMWithCache();
        return;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  }

  async function processStanzaTranslation(allVisibleLines) {
    const missingLines = allVisibleLines.filter(t => !cache.has(t) && !inFlight.has(t));
    if (missingLines.length === 0) return;
    missingLines.forEach(t => inFlight.add(t));

    try {
      // Önce anında çok sunuculu çeviriyi bas ki ekran asla boş kalmasın
      await translateWithMultiServerGTX(missingLines);

      // Eğer AI anahtarı varsa hemen üzerine AI çevirisini uygula
      if (geminiApiKey && geminiApiKey.trim().length > 10) {
        try {
          await translateWithGeminiAI(missingLines, allVisibleLines);
        } catch (aiErr) {
          console.warn('Spicy TR: AI meşgul, çok sunuculu çeviri korundu.');
        }
      }
    } catch (e) {
      console.error('Spicy TR V20 Hata:', e);
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
        ? 'Sol Tık: Çeviriyi Aç/Kapat | Sağ Tık: Gemini AI Anahtarını Yönet & Önbelleği Sıfırla'
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
        '🌟 Spicy Lyrics AI Çeviri & Romaja V20.0 🌟\n\n' +
        '• Ücretsiz Gemini API Anahtarınızı aşağıya yapıştırın.\n' +
        '• Tamam\'a bastığınızda önbellek sıfırlanır ve şarkı yeniden çevrilir:',
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

  // SENİN V5.0 KODUNDAKİ ASLA BOZULMAYAN SAF TARAYICI
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
      }, 200);
    }
  }

  if (window._spicyTrObserver) window._spicyTrObserver.disconnect();
  window._spicyTrObserver = new MutationObserver(() => scanLines());
  window._spicyTrObserver.observe(document.body, { childList: true, subtree: true });
  scanLines();
})();
