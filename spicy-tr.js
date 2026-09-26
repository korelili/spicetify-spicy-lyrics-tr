// NAME: Spicy Lyrics AI Translator & Romaja
// AUTHOR: korelili
// VERSION: 8.0.0
// DESCRIPTION: Two-Step English Pivot Localization + Gemini AI Poetic Translation & Pure Hybrid Romaja for Spicy Lyrics

(function spicyLyricsAITranslatorV8() {
  // Önceki tüm sürüm önbelleklerini kesin olarak temizle
  [
    'spicy_tr_persistent_cache_v5',
    'spicy_tr_persistent_cache_v6',
    'spicy_tr_persistent_cache_v6_1',
    'spicy_tr_persistent_cache_v7_0'
  ].forEach(k => localStorage.removeItem(k));

  const STORAGE_CACHE_KEY = 'spicy_tr_persistent_cache_v8_0';
  let savedCache = {};
  try {
    savedCache = JSON.parse(localStorage.getItem(STORAGE_CACHE_KEY) || '{}');
  } catch (e) {
    savedCache = {};
  }

  const cache = new Map(Object.entries(savedCache));
  const aiUpgradeQueue = new Set();
  let isEnabled = localStorage.getItem('spicy_tr_enabled') !== 'false';
  let geminiApiKey = localStorage.getItem('spicy_tr_gemini_key') || '';
  let isProcessing = false;
  let lastAiCallTime = 0;
  let scanTimer = null;
  let upgradeTimer = null;

  function saveCacheToDisk() {
    try {
      // Sadece kalıcı (AI veya tam onaylı) çevirileri diske kaydet
      const permanentEntries = Array.from(cache.entries())
        .filter(([, val]) => val && !val.temp)
        .slice(-3000);
      localStorage.setItem(STORAGE_CACHE_KEY, JSON.stringify(Object.fromEntries(permanentEntries)));
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
      const pageText = document.querySelector('#SpicyLyricsPage')?.textContent || '';
      if (/[\u3040-\u30ff]/.test(pageText)) return 'ja';
      return 'zh-CN';
    }
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

  function isPureRhythmOrVocal(text) {
    const cleaned = text.replace(/[(),.!?\-~]/g, ' ').replace(/\s+/g, ' ').trim();
    return /^(tip tap(\s+tip|\s+tap)*|yeah(\s+yeah)*|la(\s+la)+|na(\s+na)+|oh(\s+oh)+|whoo(\s+whoo)*|ooh(\s+ooh)*|ah(\s+ah)+|uh(\s+uh)+|bam(\s+bam)+|go(\s+go)+|let's go(\s+go)*)$/i.test(cleaned);
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

  // ROMAJA MOTORU (KENDİ HALİNDE KUSURSUZ ÇALIŞAN HİBRİT MOTOR - DOKUNULMADI)
  async function buildHybridRomaja(rawText, lang) {
    if (!isNonLatin(rawText)) return '';
    const parts = rawText.split(NON_LATIN_CHUNK_REGEX);
    const resolvedParts = await Promise.all(
      parts.map(async (part) => {
        if (!part) return '';
        if (!isNonLatin(part)) {
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

  // Şarkı sözlerindeki devrik ifadeleri, argoyu ve kelime tuzaklarını İngilizce köprüsüne hazırlayan akıllı ön-işlemci
  function prepareTextForEnglishPivot(rawText) {
    let text = rawText
      // Ritim parantezlerini çeviri motorunun kafasını karıştırmaması için temizle
      .replace(/\(Tip tap[^)]*\)/gi, '')
      // Japonca devrik emir cümlelerini ("壊せ概念を", "正せ常識を") düz gramer sırasına çevir
      .replace(/壊せ概念を/g, '固定概念を壊せ')
      .replace(/正せ常識を/g, '常識を覆せ')
      // Hiragana yazıldığı için özel isim ("Nozomi Caddesi" / "Kabuku") sanılan deyimleri gerçek anlamlarıyla değiştir
      .replace(/のぞみ通り/g, '望み通りに')
      .replace(/かぶくのみ/g, '自分のスタイルを貫くだけ')
      .replace(/世界を股にかけ/g, 'Across the whole world, ')
      .replace(/まだまだ/g, 'We are just getting started, ')
      .replace(/オフロード進もう/g, 'Let us blaze our own trail off-road')
      .replace(/真似はできない\s*Fake\s*は寄せ付けない/gi, 'Nobody can imitate me and I keep fake people away')
      .replace(/今しかない\s*Flow/gi, 'Capture this flow right now')
      // Hip-hop/K-pop argosu: "MY SWAGGER" -> "my own cool style" ("BENİM SAVAŞÇIM" hatasını %100 engeller!)
      .replace(/\bMY SWAGGER\b/gi, 'my own cool style')
      .replace(/\bswagger\b/gi, 'cool style')
      // "Kicks" -> "sneakers"
      .replace(/新品の\s*Kicks/gi, 'brand new sneakers')
      .replace(/\s+/g, ' ')
      .trim();
    return text;
  }

  function finalizeTurkishLyric(tr, rawText) {
    if (!tr) return '';
    if (isPureRhythmOrVocal(rawText)) return '';

    let fixed = tr
      .replace(/\b(BENİM SAVAŞÇIM|Benim savaşçım)\b/gi, 'Benim kendi tarzım')
      .replace(/Shine Nozomi Caddesi/gi, 'Tam istediğim gibi parlasın')
      .replace(/Nozomi Caddesi/gi, 'istediğim gibi')
      .replace(/Yalnızca Kabuku/gi, 'Sadece kendi farkımı ortaya koyarım')
      .replace(/Taklit edemezsin,\s*taklit edemezsin/gi, 'Beni taklit edemezsin, sahte olanları yanıma yaklaştırmam')
      .replace(/^Doğru sağduyu$/i, 'Alışılmış kuralları baştan yaz')
      .replace(/^Konsepti kırmak$/i, 'Kalıpları yık geç')
      .replace(/\(?\s*[İi]pucu\s+(musluğu\vert{}dokunun)[^)]*\)?/gi, '')
      .replace(/\bpython\b/gi, 'piton')
      .replace(/\s+/g, ' ')
      .trim();

    if (/like a python/i.test(rawText) && /yakaladı|tutması gerekiyor|tuttu/i.test(fixed)) {
      fixed = 'Ama beni bir piton gibi kıskacına aldı';
    }
    if (/^I should move on I know$/i.test(rawText.replace(/[,!.]/g, ''))) {
      fixed = 'Önüme bakmam gerektiğini biliyorum';
    }
    if (/falling for the shooter/i.test(rawText) && /tetikçiye düşüyordum/i.test(fixed)) {
      fixed = 'Göğsümden vuruldum, beni vurana aşık oluyordum';
    }

    // İlk harfi her zaman büyük yap (örn: "kendi tarzın" -> "Kendi tarzım")
    if (fixed.length > 0) {
      fixed = fixed.charAt(0).toUpperCase() + fixed.slice(1);
    }
    return fixed;
  }

  // 2 AŞAMALI İNGİLİZCE KÖPRÜ MOTORU (Kaynak Dil -> Tam İngilizce Cümle -> Doğal Türkçe)
  async function translateViaEnglishPivot(rawText, sourceLang) {
    if (isPureRhythmOrVocal(rawText)) return '';

    const prepared = prepareTextForEnglishPivot(rawText);
    if (!prepared) return '';

    let englishSentence = prepared;

    // 1. AŞAMA: Eğer satırda Korece, Japonca, Tayca veya İngilizce dışı kelimeler varsa ÖNCE İNGİLİZCEYE çevirip tam cümle kur!
    if (isNonLatin(prepared) || sourceLang !== 'en') {
      try {
        const toEnUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sourceLang}&tl=en&dt=t&q=${encodeURIComponent(prepared)}`;
        const toEnRes = await fetch(toEnUrl);
        const toEnJson = await toEnRes.json();
        if (Array.isArray(toEnJson[0])) {
          let enText = '';
          toEnJson[0].forEach(item => {
            if (item[0]) enText += item[0];
          });
          if (enText.trim()) englishSentence = enText.trim();
        }
      } catch (e) {}
    }

    // İngilizce cümlede kalan kalıpları doğal İngilizceye yuvarla
    englishSentence = englishSentence
      .replace(/\bMY SWAGGER\b/gi, 'my own cool style')
      .replace(/\bReady, set, go\b/gi, 'ready, set, let us go')
      .replace(/\bUp and down\b/gi, 'through all the ups and downs');

    // 2. AŞAMA: Oluşan anlamlı, bütünleşik İngilizce cümleyi TÜRKÇEYE çevir!
    const toTrUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=tr&dt=t&q=${encodeURIComponent(englishSentence)}`;
    const toTrRes = await fetch(toTrUrl);
    const toTrJson = await toTrRes.json();

    let tr = '';
    if (Array.isArray(toTrJson[0])) {
      toTrJson[0].forEach(item => {
        if (item[0]) tr += item[0];
      });
    }

    return finalizeTurkishLyric(tr, rawText);
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

    const cleanedTr = finalizeTurkishLyric(data.tr, rawText);
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

  // 1. ANA MOTOR: Gemini AI (2 Aşamalı Zihinsel İngilizce Köprüsü + Şiirsel Yerelleştirme + Düşünme Kutusu Filtresi)
  async function translateBatchWithGeminiAI(targetLines, allContextLines) {
    const songTitle = Spicetify?.Player?.data?.item?.name || 'Unknown Song';
    const artist = Spicetify?.Player?.data?.item?.artists?.[0]?.name || 'Unknown Artist';

    const indexedInput = targetLines.map((line, idx) => ({ i: idx, text: line }));

    const prompt = `You are an elite music lyric localizer for Spotify.
Song: "${songTitle}" by "${artist}".
Full visible stanza context:
${JSON.stringify(allContextLines)}

Your task is to localize each lyric line in the indexed list into 100% natural, meaningful, poetic Turkish ("tr") that a Turkish listener can immediately understand as a real sentence.

MANDATORY TWO-STEP MENTAL PROCESS:
Step 1 (Mental English Pivot): For every line (whether Korean, Japanese, Thai, Spanish, English, or mixed K-Pop/J-Pop), first translate the full line into idiomatic English in your head considering the surrounding lines. Resolve inverted grammar (e.g. Japanese "壊せ概念を" = "Break the stereotypes", "正せ常識を" = "Challenge common sense"), idioms ("のぞみ通り" = "just as I wish", "かぶくのみ" = "just showing off my unique style", "世界を股にかけ" = "striding across the world"), and hip-hop slang ("MY SWAGGER" = "kendi tarzım/duruşum" — NEVER translate SWAGGER as "savaşçı"!; "Kicks" = "yeni ayakkabılar"; "Fake" = "sahte olanlar").
Step 2 (Poetic Turkish Localization): Translate that complete English meaning into fluent, natural Turkish ("tr").
- NEVER do word-by-word dictionary translation!
- NEVER leave foreign words untranslated as fake proper nouns like "Nozomi Caddesi" or "Kabuku"!
- For pure rhythmic sound effects (like "Tip tap tip tap tap"), set "tr" to "".

Return ONLY a valid JSON array of objects with keys "i" (number) and "tr" (string):
${JSON.stringify(indexedInput)}`;

    const modelConfigs = [
      { name: 'gemini-2.5-flash', disableThinking: true },
      { name: 'gemini-2.5-flash-lite', disableThinking: true },
      { name: 'gemini-2.0-flash', disableThinking: false }
    ];

    let lastErr = null;

    for (const cfg of modelConfigs) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${cfg.name}:generateContent?key=${geminiApiKey.trim()}`;
        const genConfig = {
          responseMimeType: 'application/json',
          temperature: 0.15
        };
        if (cfg.disableThinking) {
          genConfig.thinkingConfig = { thinkingBudget: 0 };
        }

        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: genConfig
          })
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();

        // Gemini 2.5 'thought' (düşünme) parçalarını atlayıp gerçek JSON parçasını al
        const parts = json?.candidates?.[0]?.content?.parts || [];
        const validPart = parts.filter(p => !p.thought && p.text).pop() || parts[parts.length - 1];
        let rawOutput = (validPart?.text || '').trim();

        const jsonMatch = rawOutput.match(/\[[\s\S]*\]/);
        if (!jsonMatch) throw new Error('No JSON array found');
        const parsed = JSON.parse(jsonMatch[0]);

        if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('Empty array');

        // Romaja'yı kendi hibrit motorumuzdan (bozulmadan) paralel al
        await Promise.all(
          targetLines.map(async (rawText, idx) => {
            const found = parsed.find(item => item.i === idx) || parsed[idx];
            const existing = cache.get(rawText);
            const lang = detectScriptLang(rawText);
            const romaja = existing?.romaja || (isNonLatin(rawText) ? await buildHybridRomaja(rawText, lang) : '');

            if (found && typeof found.tr === 'string') {
              cache.set(rawText, {
                tr: finalizeTurkishLyric(found.tr, rawText),
                romaja,
                temp: false
              });
              aiUpgradeQueue.delete(rawText);
            }
          })
        );

        lastAiCallTime = Date.now();
        saveCacheToDisk();
        updateDOMWithCache();
        return true;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  }

  // 2. YEDEK & ANLIK MOTOR: İki Aşamalı İngilizce Köprüsü (Source -> EN -> TR) + Hibrit Romaja
  async function translateBatchWithPivotEngine(targetLines, markAsTempForAi = false) {
    await Promise.all(
      targetLines.map(async (rawText) => {
        if (isPureRhythmOrVocal(rawText)) {
          cache.set(rawText, { tr: '', romaja: '', temp: false });
          return;
        }
        const lang = detectScriptLang(rawText);
        const [tr, romaja] = await Promise.all([
          translateViaEnglishPivot(rawText, lang),
          buildHybridRomaja(rawText, lang)
        ]);
        cache.set(rawText, { tr, romaja, temp: markAsTempForAi });
        if (markAsTempForAi) {
          aiUpgradeQueue.add(rawText);
        }
      })
    );

    if (!markAsTempForAi) saveCacheToDisk();
    updateDOMWithCache();
  }

  function scheduleAiUpgrade( allVisibleTexts ) {
    if (!geminiApiKey || geminiApiKey.trim().length <= 10 || aiUpgradeQueue.size === 0) return;
    clearTimeout(upgradeTimer);
    const waitTime = Math.max(2200 - (Date.now() - lastAiCallTime), 1500);
    upgradeTimer = setTimeout(async () => {
      if (isProcessing || aiUpgradeQueue.size === 0) return;
      isProcessing = true;
      const linesToUpgrade = Array.from(aiUpgradeQueue).slice(0, 20);
      try {
        await translateBatchWithGeminiAI(linesToUpgrade, allVisibleTexts);
      } catch (e) {
        // Kota doluysa 5 saniye sonra tekrar dene, ekranda zaten temiz İngilizce Köprüsü çevirisi var
      } finally {
        isProcessing = false;
      }
    }, waitTime);
  }

  async function processVisibleLyrics() {
    if (isProcessing) return;

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

    if (missingLines.length === 0) {
      if (aiUpgradeQueue.size > 0) scheduleAiUpgrade(allVisibleTexts);
      return;
    }

    isProcessing = true;
    try {
      const hasAiKey = geminiApiKey && geminiApiKey.trim().length > 10;
      const cooldownRemaining = 2000 - (Date.now() - lastAiCallTime);

      if (hasAiKey && cooldownRemaining <= 0) {
        try {
          await translateBatchWithGeminiAI(missingLines, allVisibleTexts);
        } catch (aiErr) {
          console.warn('Spicy TR V8: AI yoğunlukta, 2 Aşamalı İngilizce Köprü Motoru devreye girdi:', aiErr);
          await translateBatchWithPivotEngine(missingLines, true);
          scheduleAiUpgrade(allVisibleTexts);
        }
      } else if (hasAiKey && cooldownRemaining > 0) {
        // Kaydırma esnasında hız sınırına (429) takılmamak için anında İngilizce Köprü çevirisini göster, 2 sn sonra AI ile yükselt
        await translateBatchWithPivotEngine(missingLines, true);
        scheduleAiUpgrade(allVisibleTexts);
      } else {
        await translateBatchWithPivotEngine(missingLines, false);
      }
    } catch (e) {
      console.error('Spicy TR V8 Hata:', e);
    } finally {
      isProcessing = false;
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
        ? 'Sol Tık: Çeviriyi Aç/Kapat | Sağ Tık: Gemini AI Anahtarını Yönet ve Önbelleği Sıfırla (V8.0 Pivot + AI Aktif)'
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
        '🌟 Spicy Lyrics AI Çeviri & Romaja V8.0 (İngilizce Köprülü & AI Yerelleştirmeli) 🌟\n\n' +
        '• Ücretsiz Gemini API Anahtarınızı aşağıya yapıştırın (aistudio.google.com/apikey).\n' +
        '• Tamam\'a bastığınızda tüm eski önbellek temizlenir ve şarkı yeniden çevrilir:',
        geminiApiKey
      );
      if (input !== null) {
        geminiApiKey = input.trim();
        localStorage.setItem('spicy_tr_gemini_key', geminiApiKey);
        cache.clear();
        aiUpgradeQueue.clear();
        localStorage.removeItem(STORAGE_CACHE_KEY);
        document.querySelectorAll('#SpicyLyricsPage .spicy-tr-box').forEach(b => b.remove());
        updateBtnVisual();
        processVisibleLyrics();
      }
    };

    controls.appendChild(btn);
  }

  function scanLines() {
    injectToggleButton();
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
      scanTimer = setTimeout(processVisibleLyrics, 450);
    }
  }

  if (window._spicyTrObserver) window._spicyTrObserver.disconnect();
  window._spicyTrObserver = new MutationObserver(() => scanLines());
  window._spicyTrObserver.observe(document.body, { childList: true, subtree: true });
  scanLines();
})();
