// NAME: Spicy Lyrics AI Translator & Romaja
// AUTHOR: korelili
// VERSION: 9.0.0
// DESCRIPTION: Whole-Song Context-Unified AI Localization, 100% "Sen" Pronoun Harmony & Pure Hybrid Romaja for Spicy Lyrics

(function spicyLyricsAITranslatorV9() {
  // Önceki tüm sürüm önbelleklerini kesin olarak temizle
  [
    'spicy_tr_persistent_cache_v5',
    'spicy_tr_persistent_cache_v6',
    'spicy_tr_persistent_cache_v6_1',
    'spicy_tr_persistent_cache_v7_0',
    'spicy_tr_persistent_cache_v8_0'
  ].forEach(k => localStorage.removeItem(k));

  const STORAGE_CACHE_KEY = 'spicy_tr_persistent_cache_v9_0';
  let savedCache = {};
  try {
    savedCache = JSON.parse(localStorage.getItem(STORAGE_CACHE_KEY) || '{}');
  } catch (e) {
    savedCache = {};
  }

  const cache = new Map(Object.entries(savedCache));
  // Şarkının bütününü hafızada tutan tam şarkı bağlam listesi
  let currentSongUri = '';
  const songFullLyricsContext = new Set();

  let isEnabled = localStorage.getItem('spicy_tr_enabled') !== 'false';
  let geminiApiKey = localStorage.getItem('spicy_tr_gemini_key') || '';
  let isProcessing = false;
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
    return /^(tip tap(\s+tip|\s+tap)*|yeah(\s+yeah)*|la(\s+la)+|na(\s+na)+|oh(\s+oh|\s+whoa)*|whoo(\s+whoo)*|whoa(\s+whoa)*|ooh(\s+ooh)*|ah(\s+ah)+|uh(\s+uh)+|bam(\s+bam)+|go(\s+go)+|let's go(\s+go)*|yo(\s+yo)*)$/i.test(cleaned);
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

  // ROMAJA MOTORU (DOKUNULMADI - KENDİ HALİNDE KUSURSUZ AKAR)
  async function buildHybridRomaja(rawText, lang) {
    if (!isNonLatin(rawText)) return '';
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
    return cleanRomajaString(resolvedParts.filter(Boolean).join(' '));
  }

  // Şarkı içindeki argo, kısaltma ve deyimleri çeviri öncesi bütünlüğe hazırlayan ön-işlemci
  function prepareLineForCohesiveTranslation(rawText) {
    let text = rawText
      .replace(/\(Tip tap[^)]*\)/gi, '')
      .replace(/\(Yo\)/gi, '')
      .replace(/\(Whoo\)/gi, '')
      .replace(/\(Hey\)/gi, '')
      .replace(/\(Yeah\)/gi, '')
      // Sokak ağzı kısaltmalar ("E'ryday'da oynayalım" ve "Onları aldığımı" hatalarını kökten çözer)
      .replace(/\bE'ryday\b/gi, 'every single day')
      .replace(/\berrday\b/gi, 'every single day')
      .replace(/\bI got '?em\b/gi, 'I have everyone captivated')
      .replace(/\bgot '?em\b/gi, 'captivated them all')
      .replace(/내 욕심\s*Stays hungry\s*나 언제나 배고프잖아/gi, 'My ambition is never satisfied, I am always hungry for more')
      .replace(/내 기다림이 너를 기다려/g, 'Even my longing is waiting just for you')
      .replace(/그대로 내게로 와/g, 'Come to me just as you are')
      .replace(/복잡한 건 싫어 치워 전부 다/g, 'I hate complicated things, just push them all aside')
      .replace(/분위기를 더 끌어올려 줘\s*Tonight/gi, 'Turn the energy up even higher tonight')
      .replace(/우리\s*every single day\s*놀아\s*But not enough/gi, 'We party every single day, but it is still not enough')
      .replace(/壊せ概念を/g, 'Break all the stereotypes')
      .replace(/正せ常識を/g, 'Rewrite the rules')
      .replace(/のぞみ通り/g, 'just the way I want')
      .replace(/かぶくのみ/g, 'I just show off my unique style')
      .replace(/世界を股にかけ/g, 'Striding across the whole world, ')
      .replace(/オフロード進もう/g, 'Let us blaze our own trail')
      .replace(/真似はできない\s*Fake\s*は寄せ付けない/gi, 'Nobody can imitate me, I keep fake people away')
      .replace(/\bMY SWAGGER\b/gi, 'my own cool style')
      .replace(/新品の\s*Kicks/gi, 'brand new sneakers')
      .replace(/\s+/g, ' ')
      .trim();

    // Karma satırlarda cümlenin ortasında kalan İngilizce kelimenin baş harfini küçült ki tek cümle olarak çevrilsin
    if (isNonLatin(rawText)) {
      text = text.replace(/([\uac00-\ud7a3\u3040-\u30ff\u4e00-\u9faf])\s+([A-Z][a-z]+)/g, (m, p1, p2) => {
        if (p2 === 'I') return m;
        return `${p1} ${p2.toLowerCase()}`;
      });
    }
    return text;
  }

  // TÜRKÇE ŞARKI DİLİ UYUM MOTORU: "Siz" (çoğul/resmi) eklerini %100 samimi "Sen" diline çevirir ve tuhaf kalıpları düzeltir!
  function enforceTurkishLyricHarmony(tr, rawText) {
    if (!tr) return '';
    if (isPureRhythmOrVocal(rawText)) return '';

    let fixed = tr.trim();

    // 1. Özel anlam ve deyim düzeltmeleri
    fixed = fixed
      .replace(/Bekleyişim seni bekliyor/gi, 'Hasretim bile senin yolunu gözlüyor')
      .replace(/Sadece bana gel/gi, 'Olduğun gibi bana gel')
      .replace(/Bana işaretini ver/gi, 'Bana bir işaret ver')
      .replace(/Sadece bana bir işaret ver/gi, 'Yeter ki bana bir işaret ver')
      .replace(/Açgözlülüğüm\s*Aç\s*kalır\s*Ben\s*her\s*zaman\s*açım/gi, 'Tutkum hiç doymuyor, hep daha fazlasını istiyorum')
      .replace(/Onları aldığımı biliyorsun/gi, 'Hepsini etkilediğimi biliyorsun')
      .replace(/Karmaşık şeyleri sevmiyorum,\s*her şeyden kurtul(un)?/gi, 'Karmaşık şeyleri sevmem, hepsini bir kenara bırak')
      .replace(/Hadi E'ryday'da oynayalım\s*Ama yeterli değil/gi, 'Her gün eğleniyoruz ama bu bile yetmiyor')
      .replace(/Bu gece ruh halinizi daha da yükselt(in)?/gi, 'Bu gece ortamın enerjisini daha da yükselt')
      .replace(/Tereddüt etmeyin,\s*bu bir zaman kaybı/gi, 'Tereddüt etme artık, zamana yazık oluyor')
      .replace(/\b(BENİM SAVAŞÇIM|Benim savaşçım)\b/gi, 'Benim kendi tarzım')
      .replace(/Shine Nozomi Caddesi/gi, 'Tam istediğim gibi parlasın')
      .replace(/Yalnızca Kabuku/gi, 'Sadece kendi farkımı ortaya koyarım');

    // 2. "SİZ" -> "SEN" ZAMİR VE İYELİK DÖNÜŞÜMÜ (Şarkılarda resmi "siz" dilini %100 yok eder)
    fixed = fixed
      .replace(/\bSizin\b/g, 'Senin').replace(/\bsizin\b/g, 'senin')
      .replace(/\bSize\b/g, 'Sana').replace(/\bsize\b/g, 'sana')
      .replace(/\bSizi\b/g, 'Seni').replace(/\bsizi\b/g, 'seni')
      .replace(/\bSizde\b/g, 'Sende').replace(/\bsizde\b/g, 'sende')
      .replace(/\bSizden\b/g, 'Senden').replace(/\bsizden\b/g, 'senden')
      .replace(/\bSiz\b/g, 'Sen').replace(/\bsiz\b/g, 'sen')
      .replace(/\bruh halinizi\b/gi, 'modunu')
      .replace(/\bsınırlarınızı\b/gi, 'sınırlarını')
      .replace(/\bkendinizi\b/gi, 'kendini')
      .replace(/\bgözlerinizi\b/gi, 'gözlerini')
      .replace(/\bellerinizi\b/gi, 'ellerini')
      .replace(/\bkalbinizi\b/gi, 'kalbini')
      .replace(/\bsesinizi\b/gi, 'sesini')
      .replace(/\b들\b/g, '');

    // 3. FİİL ÇEKİMLERİNDE "SİZ" -> "SEN" DÖNÜŞÜMÜ (örn: "edeceksiniz" -> "edeceksin", "tereddüt etmeyin" -> "tereddüt etme")
    fixed = fixed
      // Olumsuz emir kipi: -meyin / -mayın -> -me / -ma
      .replace(/([a-zçğıöşü]+m[ae])yin\b/gi, '$1')
      .replace(/([a-zçğıöşü]+m[ae])yın\b/gi, '$1')
      // Gelecek, şimdiki, geniş, gereklilik, yeterlilik zaman: -siniz/-sınız/-sunuz/-sünüz -> -sin/-sın/-sun/-sün
      .replace(/([a-zçğıöşü]+)siniz\b/gi, '$1sin')
      .replace(/([a-zçğıöşü]+)sınız\b/gi, '$1sın')
      .replace(/([a-zçğıöşü]+)sunuz\b/gi, '$1sun')
      .replace(/([a-zçğıöşü]+)sünüz\b/gi, '$1sün')
      // Soru ekleri: misiniz/mısınız/musunuz/müsünüz -> misin/mısın/musun/müsün
      .replace(/\bmisiniz\b/gi, 'misin')
      .replace(/\bmısınız\b/gi, 'mısın')
      .replace(/\bmusunuz\b/gi, 'musun')
      .replace(/\bmüsünüz\b/gi, 'müsün')
      // Olumlu çoğul emir kipleri (kurtulun -> kurtul, yükseltin -> yükselt, inanın -> inan vb.)
      .replace(/\bkurtulun\b/gi, 'bir kenara bırak')
      .replace(/\byükseltin\b/gi, 'yükselt')
      .replace(/\bhareket ettirin\b/gi, 'hareket ettir')
      .replace(/\bhissedin\b/gi, 'hisset')
      .replace(/\binanın\b/gi, 'inan')
      .replace(/\başın\b/gi, 'aş')
      .replace(/\bgeliştirmeye devam edin\b/gi, 'geliştirmeye devam et')
      .replace(/\bdevam edin\b/gi, 'devam et')
      .replace(/\badım atın\b/gi, 'adım at')
      .replace(/\bbırakın\b/gi, 'bırak')
      .replace(/\bbakın\b/gi, 'bak')
      .replace(/\bdinleyin\b/gi, 'dinle')
      .replace(/\bsöyleyin\b/gi, 'söyle')
      .replace(/\bizleyin\b/gi, 'izle')
      .replace(/\bgelin\b/gi, 'gel')
      .replace(/\bgidin\b/gi, 'git')
      .replace(/\bverin\b/gi, 'ver')
      .replace(/\balın\b/gi, 'al')
      .replace(/\bkoşun\b/gi, 'koş');

    // 4. Cümle ortasında kalan anlamsız büyük harfleri düzelt (örn: "Açgözlülüğüm Aç kalır" gibi)
    fixed = fixed.replace(/([a-zçğıöşü])\s+([A-ZÇĞİÖŞÜ][a-zçğıöşü]+)/g, (match, w1, w2) => {
      return `${w1}, ${w2.toLowerCase()}`;
    });

    if (fixed.length > 0) {
      fixed = fixed.charAt(0).toUpperCase() + fixed.slice(1);
    }
    return fixed.replace(/\s+/g, ' ').trim();
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

    const cleanedTr = enforceTurkishLyricHarmony(data.tr, rawText);
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

  // 1. ANA MOTOR: TAM ŞARKI BÜTÜNLÜKLÜ GEMINI AI MOTORU (thinkingConfig 400 hatası temizlendi!)
  async function translateWholeSongWithGeminiAI(targetLines, fullSongContextArray) {
    const songTitle = Spicetify?.Player?.data?.item?.name || 'Unknown Song';
    const artist = Spicetify?.Player?.data?.item?.artists?.[0]?.name || 'Unknown Artist';

    const indexedInput = targetLines.map((line, idx) => ({ i: idx, text: line }));

    const prompt = `You are a master Turkish poetic lyricist and music translator.
Song: "${songTitle}" by "${artist}".

FULL SONG CONTEXT (Read the entire song context first to understand the story, mood, and relationship between lines before translating!):
${JSON.stringify(fullSongContextArray)}

Now translate each line in the following indexed list into deeply natural, cohesive, poetic Turkish ("tr") as part of this single unified song.

STRICT RULES FOR WHOLE-SONG COHESION:
1. 100% INFORMAL SINGULAR ("SEN") REGISTER: In Turkish song lyrics, ALWAYS address the listener/lover as "sen" (e.g., "tereddüt edeceksin", "bir kenara bırak", "enerjiyi yükselt", "tereddüt etme"). NEVER use formal/plural "siz" ("edeceksiniz", "kurtulun", "yükseltin", "tereddüt etmeyin")! Keep the tone 100% consistent across all lines.
2. POETIC LOCALIZATION OVER LITERAL WORDS:
   - Never write awkward literal repetitions like "Bekleyişim seni bekliyor" for "내 기다림이 너를 기다려" -> localize poetically as "Hasretim bile senin yolunu gözlüyor".
   - Resolve slang naturally: "E'ryday 놀아 But not enough" -> "Her gün eğleniyoruz ama bu bile yetmiyor"; "내 욕심 Stays hungry 나 언제나 배고프잖아" -> "Tutkum hiç doymuyor, hep daha fazlasını istiyorum"; "You know that I got em" -> "Hepsini etkilediğimi biliyorsun"; "치워 전부 다" -> "hepsini bir kenara bırak".
3. Mentally unify mixed Korean/Japanese/Thai + English lines into one complete thought first, then express that thought in fluent Turkish.
4. For pure vocalizations/rhythm ("Oh-whoa-whoa", "Tip tap tip tap tap"), set "tr" to "".

Return ONLY a valid JSON array of objects with keys "i" (number) and "tr" (string):
${JSON.stringify(indexedInput)}`;

    const models = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-1.5-flash'];
    let lastErr = null;

    for (const model of models) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey.trim()}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              responseMimeType: 'application/json',
              temperature: 0.2
            }
          })
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();

        const parts = json?.candidates?.[0]?.content?.parts || [];
        const combinedText = parts.filter(p => !p.thought && p.text).map(p => p.text).join('\n') || parts.map(p => p.text || '').join('\n');
        const jsonMatch = combinedText.match(/\[[\s\S]*\]/);
        if (!jsonMatch) throw new Error('No JSON array found');

        const parsed = JSON.parse(jsonMatch[0]);
        if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('Empty AI array');

        await Promise.all(
          targetLines.map(async (rawText, idx) => {
            const found = parsed.find(item => item.i === idx) || parsed[idx];
            const lang = detectScriptLang(rawText);
            const romaja = isNonLatin(rawText) ? await buildHybridRomaja(rawText, lang) : '';

            if (found && typeof found.tr === 'string') {
              cache.set(rawText, {
                tr: enforceTurkishLyricHarmony(found.tr, rawText),
                romaja
              });
            }
          })
        );

        saveCacheToDisk();
        updateDOMWithCache();
        return true;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  }

  // 2. BÜTÜNSEL KITA MOTORU (AI Anahtarı Yoksa Veya Kota Dolarsa: Tüm Kıtayı Tek Bütün Olarak Çevirir + %100 "Sen" Uyumu Sağlar)
  async function translateWholeStanzaCohesively(targetLines) {
    // Önce her satırı argo/deyim açısından temizleyip tek bir İngilizce kıta bloğu oluştur
    const preparedLines = targetLines.map(raw => prepareLineForCohesiveTranslation(raw));

    // Aşama 1: Tüm kıtayı birlikte İngilizceye çevir (cümleler arası bağlam kopmasın)
    const englishLines = await Promise.all(
      preparedLines.map(async (prepText, idx) => {
        const raw = targetLines[idx];
        if (!prepText || isPureRhythmOrVocal(raw)) return '';
        const lang = detectScriptLang(raw);
        if (!isNonLatin(prepText) && lang === 'auto') return prepText;
        try {
          const toEnUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${lang}&tl=en&dt=t&q=${encodeURIComponent(prepText)}`;
          const res = await fetch(toEnUrl);
          const json = await res.json();
          let en = '';
          if (Array.isArray(json[0])) {
            json[0].forEach(item => {
              if (item[0]) en += item[0];
            });
          }
          return en.trim() || prepText;
        } catch (e) {
          return prepText;
        }
      })
    );

    // Aşama 2: Oluşan İngilizce kıtanın tamamını TEK BİR ŞARKI METNİ olarak birleştirip Türkçeye çevir!
    const validIndices = [];
    const stanzaSentences = [];
    englishLines.forEach((enLine, idx) => {
      if (enLine) {
        validIndices.push(idx);
        stanzaSentences.push(enLine.replace(/[.!?]+$/, ''));
      }
    });

    const stanzaTrMap = new Map();
    if (stanzaSentences.length > 0) {
      try {
        const unifiedBlock = stanzaSentences.join('.\n');
        const toTrUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=tr&dt=t&dj=1&q=${encodeURIComponent(unifiedBlock)}`;
        const trRes = await fetch(toTrUrl);
        const trJson = await trRes.json();
        const fullTr = (trJson.sentences || []).map(s => s.trans || '').join('');
        const splitTr = fullTr.split('\n').map(s => s.replace(/\.$/, '').trim());

        if (splitTr.length === validIndices.length) {
          validIndices.forEach((origIdx, i) => {
            stanzaTrMap.set(origIdx, splitTr[i]);
          });
        }
      } catch (e) {}
    }

    await Promise.all(
      targetLines.map(async (rawText, idx) => {
        if (isPureRhythmOrVocal(rawText)) {
          cache.set(rawText, { tr: '', romaja: '' });
          return;
        }
        const lang = detectScriptLang(rawText);
        let tr = stanzaTrMap.get(idx) || '';

        // Eğer toplu bölünmede satır eksik kaldıysa o satırı İngilizce cümlesinden çevir
        if (!tr && englishLines[idx]) {
          try {
            const singleTrUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=tr&dt=t&q=${encodeURIComponent(englishLines[idx])}`;
            const sRes = await fetch(singleTrUrl);
            const sJson = await sRes.json();
            if (Array.isArray(sJson[0])) {
              sJson[0].forEach(item => {
                if (item[0]) tr += item[0];
              });
            }
          } catch (e) {}
        }

        const romaja = isNonLatin(rawText) ? await buildHybridRomaja(rawText, lang) : '';
        cache.set(rawText, {
          tr: enforceTurkishLyricHarmony(tr, rawText),
          romaja
        });
      })
    );

    saveCacheToDisk();
    updateDOMWithCache();
  }

  async function processSongLyrics() {
    if (isProcessing) {
      pendingRescan = true;
      return;
    }

    // Şarkı değiştiyse tam şarkı bağlam hafızasını yeni şarkı için sıfırla
    const activeUri = Spicetify?.Player?.data?.item?.uri || Spicetify?.Player?.data?.item?.name || '';
    if (activeUri && activeUri !== currentSongUri) {
      currentSongUri = activeUri;
      songFullLyricsContext.clear();
    }

    const lineEls = Array.from(document.querySelectorAll('#SpicyLyricsPage .line:not(.musical-line)'));
    const missingLines = [];

    lineEls.forEach(lineEl => {
      const text = getCleanText(lineEl);
      if (!text || text === '•••') return;

      songFullLyricsContext.add(text);

      if (cache.has(text)) {
        if (!lineEl.querySelector('.spicy-tr-box')) {
          renderSubtitles(lineEl, cache.get(text), text);
        }
      } else if (!missingLines.includes(text)) {
        missingLines.push(text);
      }
    });

    if (missingLines.length === 0) return;

    isProcessing = true;
    try {
      const fullContextArray = Array.from(songFullLyricsContext);
      if (geminiApiKey && geminiApiKey.trim().length > 10) {
        try {
          await translateWholeSongWithGeminiAI(missingLines, fullContextArray);
        } catch (aiErr) {
          console.warn('Spicy TR V9: AI geçici sınırda, Bütünsel Kıta Motoru devreye girdi:', aiErr);
          await translateWholeStanzaCohesively(missingLines);
        }
      } else {
        await translateWholeStanzaCohesively(missingLines);
      }
    } catch (e) {
      console.error('Spicy TR V9 Hata:', e);
    } finally {
      isProcessing = false;
      if (pendingRescan) {
        pendingRescan = false;
        setTimeout(processSongLyrics, 300);
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
        ? 'Sol Tık: Çeviriyi Aç/Kapat | Sağ Tık: Gemini AI Anahtarını Yönet ve Önbelleği Sıfırla (V9.0 Tam Şarkı Bütünlüğü Aktif)'
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
        '🌟 Spicy Lyrics AI Çeviri & Romaja V9.0 (Tam Şarkı Bütünlüğü & %100 Sen Dili) 🌟\n\n' +
        '• Ücretsiz Gemini API Anahtarınızı aşağıya yapıştırın (aistudio.google.com/apikey).\n' +
        '• Tamam\'a bastığınızda tüm önbellek temizlenir ve şarkı bir bütün olarak yeniden çevrilir:',
        geminiApiKey
      );
      if (input !== null) {
        geminiApiKey = input.trim();
        localStorage.setItem('spicy_tr_gemini_key', geminiApiKey);
        cache.clear();
        songFullLyricsContext.clear();
        localStorage.removeItem(STORAGE_CACHE_KEY);
        document.querySelectorAll('#SpicyLyricsPage .spicy-tr-box').forEach(b => b.remove());
        updateBtnVisual();
        processSongLyrics();
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
      scanTimer = setTimeout(processSongLyrics, 350);
    }
  }

  if (window._spicyTrObserver) window._spicyTrObserver.disconnect();
  window._spicyTrObserver = new MutationObserver(() => scanLines());
  window._spicyTrObserver.observe(document.body, { childList: true, subtree: true });
  scanLines();
})();
