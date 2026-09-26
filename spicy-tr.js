// NAME: Spicy Lyrics AI Translator & Romaja
// AUTHOR: korelili
// VERSION: 10.0.0
// DESCRIPTION: True Whole-Stanza Block Context, Morphological Turkish "Sen" Grammar Engine, Auto-Upgrading Gemini AI & Pure Hybrid Romaja

(function spicyLyricsAITranslatorV10() {
  // Önceki tüm sürüm önbelleklerini kesin olarak temizle
  [
    'spicy_tr_persistent_cache_v5',
    'spicy_tr_persistent_cache_v6',
    'spicy_tr_persistent_cache_v6_1',
    'spicy_tr_persistent_cache_v7_0',
    'spicy_tr_persistent_cache_v8_0',
    'spicy_tr_persistent_cache_v9_0'
  ].forEach(k => localStorage.removeItem(k));

  const STORAGE_CACHE_KEY = 'spicy_tr_persistent_cache_v10_0';
  let savedCache = {};
  try {
    savedCache = JSON.parse(localStorage.getItem(STORAGE_CACHE_KEY) || '{}');
  } catch (e) {
    savedCache = {};
  }

  const cache = new Map(Object.entries(savedCache));
  let currentSongUri = '';
  const songFullLyricsContext = new Set();

  let isEnabled = localStorage.getItem('spicy_tr_enabled') !== 'false';
  let geminiApiKey = localStorage.getItem('spicy_tr_gemini_key') || '';
  let isFastProcessing = false;
  let isAiProcessing = false;
  let scanTimer = null;
  let aiQueueTimer = null;

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

  // ROMAJA MOTORU (DOKUNULMADI - KUSURSUZ HİBRİT OKUNUŞ)
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

  // J-Pop, K-Pop ve Karma satırlardaki gizli özneleri ve deyimleri tam cümle yapısına hazırlayan ön-işlemci
  function prepareLineForUnifiedContext(rawText) {
    let text = rawText
      .replace(/\(Tip tap[^)]*\)/gi, '')
      .replace(/\(Yo\)/gi, '')
      .replace(/\(Whoo\)/gi, '')
      .replace(/\(Hey\)/gi, '')
      .replace(/\(Yeah\)/gi, '')
      // Japonca liriklerde öznesiz fiillerin yanlış anlaşılmasını önleyen bağlamsal açılımlar
      .replace(/求めて\s*求めて\s*baby/gi, 'Crave me, want me more, baby')
      .replace(/求めて\s*求めて/g, 'Wanting you, craving you more')
      .replace(/しびれるような鋭い視線あびると/g, 'When I feel your sharp, electrifying gaze on me')
      .replace(/手招きされるように声に委ねるサイン/g, 'A sign to surrender myself to your beckoning voice')
      .replace(/想いを浮かべ/g, 'Let your feelings surface in your mind')
      .replace(/素直になれば分かるさ/g, 'If you are honest with your heart, you will understand')
      .replace(/You and me\s*今だけ見て/gi, 'Just you and me, look only at this moment right now')
      .replace(/同じテンポ合わせて/g, 'Matching our rhythm to the same tempo')
      .replace(/鼓動の音\s*合わせるように/g, 'As if syncing the sound of our heartbeats')
      .replace(/いつも君で溢れるから/g, 'Because my heart is always overflowing with you')
      .replace(/落ちる\s*深く\s*深く/g, 'Falling deeper and deeper into you')
      .replace(/もっと\s*深く\s*深く/g, 'Even deeper and deeper')
      // Korece & İngilizce argo/deyim düzeltmeleri
      .replace(/\bE'ryday\b/gi, 'every single day')
      .replace(/\berrday\b/gi, 'every single day')
      .replace(/\bI got '?em\b/gi, 'I have everyone captivated')
      .replace(/내 욕심\s*Stays hungry\s*나 언제나 배고프잖아/gi, 'My ambition is never satisfied, I am always hungry for more')
      .replace(/내 기다림이 너를 기다려/g, 'Even my longing is waiting just for you')
      .replace(/그대로 내게로 와/g, 'Come to me just as you are')
      .replace(/복잡한 건 싫어 치워 전부 다/g, 'I hate complicated things, just push them all aside')
      .replace(/분위기를 더 끌어올려 줘\s*Tonight/gi, 'Turn the energy up even higher tonight')
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

    // Karma satırlarda İngilizce özneden sonra gelen Japonca/Korece emir kipinin birbirine karışmasını önlemek için virgül koy
    text = text.replace(/^([A-Za-z\s']+)([\u3040-\u30ff\u4e00-\u9faf\uac00-\ud7a3]+)/, '$1, $2');
    return text;
  }

  // MORFOLOJİK TÜRKÇE ŞARKI DİLİ MOTORU: Tüm çoğul/resmi "Siz" (-nizi, -nize, -edin, -leştirin) eklerini kökünden "Sen" diline çevirir!
  function enforceTurkishLyricHarmony(tr, rawText) {
    if (!tr) return '';
    if (isPureRhythmOrVocal(rawText)) return '';

    let fixed = tr.trim();

    // 1. Doğrudan kalıp ve anlam düzeltmeleri
    fixed = fixed
      .replace(/Ara,\s*ara bebeğim/gi, 'Beni iste, arzula bebeğim')
      .replace(/Keskin,\s*uyuşturan bakışlarına baktığımda/gi, 'Uyuşturan o keskin bakışların üzerime değdiğinde')
      .replace(/Seni çağırmak için sesinize güvenmenizi sağlayan bir işaret/gi, 'Beni çağıran o sesine teslim olma işareti')
      .replace(/Seni çağırmak için sesine güvenmeni sağlayan bir işaret/gi, 'Beni çağıran o sesine teslim olma işareti')
      .replace(/Düşüncelerinizi ifade edin/gi, 'Hislerini serbest bırak')
      .replace(/Düşüncelerini ifade et/gi, 'Hislerini serbest bırak')
      .replace(/Sen ve ben şimdi sadece bana bakıyoruz/gi, 'Sen ve ben, şimdi sadece bu ana odaklan')
      .replace(/Aynı tempoyu eşleştir(in)?/gi, 'Ritimlerimizi aynı tempoda buluşturalım')
      .replace(/Çünkü her zaman seninle dolu/gi, 'Çünkü kalbim her an seninle dolup taşıyor')
      .replace(/Bekleyişim seni bekliyor/gi, 'Hasretim bile senin yolunu gözlüyor')
      .replace(/Sadece bana gel/gi, 'Olduğun gibi bana gel')
      .replace(/\b(BENİM SAVAŞÇIM|Benim savaşçım)\b/gi, 'Benim kendi tarzım')
      .replace(/Shine Nozomi Caddesi/gi, 'Tam istediğim gibi parlasın')
      .replace(/Yalnızca Kabuku/gi, 'Sadece kendi farkımı ortaya koyarım');

    // 2. Zamir dönüşümleri (Siz -> Sen)
    fixed = fixed
      .replace(/\bSizin\b/g, 'Senin').replace(/\bsizin\b/g, 'senin')
      .replace(/\bSize\b/g, 'Sana').replace(/\bsize\b/g, 'sana')
      .replace(/\bSizi\b/g, 'Seni').replace(/\bsizi\b/g, 'seni')
      .replace(/\bSizde\b/g, 'Sende').replace(/\bsizde\b/g, 'sende')
      .replace(/\bSizden\b/g, 'Senden').replace(/\bsizden\b/g, 'senden')
      .replace(/\bSiz\b/g, 'Sen').replace(/\bsiz\b/g, 'sen');

    // 3. MORFOLOJİK İYELİK EKLERİ ("-nizi / -nize / -nızı / -nıza / -nuzu / -nuza / -nüzü / -nüze" -> Tekil "Sen" iyeliği)
    fixed = fixed
      // Çoğul nesne + "sizin" iyeliği: düşüncelerinizi -> düşüncelerini, sınırlarınızı -> sınırlarını
      .replace(/(ler|lar)inizi\b/gi, '$1ini')
      .replace(/(ler|lar)inize\b/gi, '$1ine')
      .replace(/(ler|lar)inizde\b/gi, '$1inde')
      .replace(/(ler|lar)inizden\b/gi, '$1inden')
      .replace(/(ler|lar)iniz\b/gi, '$1in')
      .replace(/(ler|lar)ınızı\b/gi, '$1ını')
      .replace(/(ler|lar)ınıza\b/gi, '$1ına')
      .replace(/(ler|lar)ınızda\b/gi, '$1ında')
      .replace(/(ler|lar)ınızdan\b/gi, '$1ından')
      .replace(/(ler|lar)ınız\b/gi, '$1ın')
      // İsim-fiil (gerund) + "sizin" iyeliği: güvenmenizi -> güvenmeni, olmanızı -> olmanı
      .replace(/([a-zçğıöşü]+m[ae])nizi\b/gi, '$1ni')
      .replace(/([a-zçğıöşü]+m[ae])nize\b/gi, '$1ne')
      .replace(/([a-zçğıöşü]+m[ae])nızı\b/gi, '$1nı')
      .replace(/([a-zçğıöşü]+m[ae])nıza\b/gi, '$1na')
      // Tekil isim + "sizin" iyeliği ("denizi/denize" kelimesini koruyarak): sesinize -> sesine, kalbinizi -> kalbini, ruhunuzu -> ruhunu
      .replace(/(?<!\bde)([a-zçğıöşü]{2,}[ei])nizi\b/gi, '$1ni')
      .replace(/(?<!\bde)([a-zçğıöşü]{2,}[ei])nize\b/gi, '$1ne')
      .replace(/([a-zçğıöşü]{2,}[aı])nızı\b/gi, '$1nı')
      .replace(/([a-zçğıöşü]{2,}[aı])nıza\b/gi, '$1na')
      .replace(/([a-zçğıöşü]{2,}[ou])nuzu\b/gi, '$1nu')
      .replace(/([a-zçğıöşü]{2,}[ou])nuza\b/gi, '$1na')
      .replace(/([a-zçğıöşü]{2,}[öü])nüzü\b/gi, '$1nü')
      .replace(/([a-zçğıöşü]{2,}[öü])nüze\b/gi, '$1ne');

    // 4. MORFOLOJİK FİİL VE EMİR ÇEKİMLERİ ("ifade edin" -> "ifade et", "eşleştirin" -> "eşleştir", "edeceksiniz" -> "edeceksin")
    fixed = fixed
      // Birleşik fiiller: ifade edin -> ifade et, hayal edin -> hayal et, hareket ettirin -> hareket ettir
      .replace(/\b([a-zçğıöşü]+)\s+edin\b/gi, '$1 et')
      .replace(/\b([a-zçğıöşü]+)\s+ettirin\b/gi, '$1 ettir')
      .replace(/\b([a-zçğıöşü]+)\s+olun\b/gi, '$1 ol')
      // Ettirgen ve işteş fiil emirleri: eşleştirin -> eşleştir, birleştirin -> birleştir, geliştirin -> geliştir
      .replace(/([a-zçğıöşü]+l[ae]ştir)in\b/gi, '$1')
      .replace(/([a-zçğıöşü]+l[aı]ştır)ın\b/gi, '$1')
      .replace(/([a-zçğıöşü]+t[iıuü]r)[iıuü]n\b/gi, '$1')
      // Olumsuz emir: -meyin / -mayın -> -me / -ma
      .replace(/([a-zçğıöşü]+m[ae])yin\b/gi, '$1')
      .replace(/([a-zçğıöşü]+m[ae])yın\b/gi, '$1')
      // Ünlüyle biten fiil emirleri: dinleyin -> dinle, bekleyin -> bekle, başlayın -> başla, anlayın -> anla
      .replace(/([a-zçğıöşü]{2,}[aeıioöuü])yin\b/gi, '$1')
      .replace(/([a-zçğıöşü]{2,}[aeıioöuü])yın\b/gi, '$1')
      .replace(/([a-zçğıöşü]{2,}[aeıioöuü])yun\b/gi, '$1')
      .replace(/([a-zçğıöşü]{2,}[aeıioöuü])yün\b/gi, '$1')
      // Zaman ekleri: -siniz / -sınız / -sunuz / -sünüz -> -sin / -sın / -sun / -sün
      .replace(/([a-zçğıöşü]+)siniz\b/gi, '$1sin')
      .replace(/([a-zçğıöşü]+)sınız\b/gi, '$1sın')
      .replace(/([a-zçğıöşü]+)sunuz\b/gi, '$1sun')
      .replace(/([a-zçğıöşü]+)sünüz\b/gi, '$1sün')
      // Yaygın kök fiil emirleri
      .replace(/\b(hissed|affed|sabred|seyred)in\b/gi, (_, stem) => stem.replace(/d$/i, 't'))
      .replace(/\b(ver|gel|기d|seç|geç|çek|iç|bil|sil)in\b/gi, '$1')
      .replace(/\b(al|kal|bak|bırak|aç|kapat|at|yak|yık|kır|inan|uyan|sarıl|kaç|çık)ın\b/gi, '$1')
      .replace(/\b(tut|unut|koş|dokun|konuş|sus|otur|dur|bul|ol)un\b/gi, '$1')
      .replace(/\b(gör|düşün|gül|yürü|öp|dön|çöz)ün\b/gi, '$1')
      .replace(/\bkurtulun\b/gi, 'bir kenara bırak')
      .replace(/\byükseltin\b/gi, 'yükselt')
      .replace(/\başın\b/gi, 'aş');

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

  // 1. GERÇEK BÜTÜNSEL BLOK MOTORU (Aşama 1 ve Aşama 2'de tüm kıtayı TEK BLOK olarak çevirir, cümle bağlamı asla kopmaz!)
  async function translateStanzaBlockCohesively(targetLines) {
    const validItems = [];
    targetLines.forEach((raw, idx) => {
      if (isPureRhythmOrVocal(raw)) {
        cache.set(raw, { tr: '', romaja: '', source: 'ai' });
      } else {
        validItems.push({ raw, prepared: prepareLineForUnifiedContext(raw), idx });
      }
    });

    if (validItems.length === 0) return;

    // AŞAMA 1: Tüm kıtayı "\n" ile birleştirip TEK SEFERDE İngilizceye çevir (Japonca/Korece gizli özneler önceki/sonraki satırdan anlaşılır!)
    const dominantLang = detectScriptLang(validItems.map(i => i.raw).join(' '));
    let englishLines = validItems.map(i => i.prepared);

    if (dominantLang !== 'auto' || validItems.some(i => isNonLatin(i.prepared))) {
      try {
        const joinedForEn = validItems.map(i => i.prepared).join('\n');
        const enUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&dj=1&q=${encodeURIComponent(joinedForEn)}`;
        const enRes = await fetch(enUrl);
        const enJson = await enRes.json();
        const fullEn = (enJson.sentences || []).map(s => s.trans || '').join('');
        const splitEn = fullEn.split('\n').map(s => s.trim()).filter(Boolean);

        if (splitEn.length === validItems.length) {
          englishLines = splitEn;
        }
      } catch (e) {}
    }

    // AŞAMA 2: Oluşan tam İngilizce kıtayı "\n" ile birleştirip TEK SEFERDE Türkçeye çevir!
    let turkishLines = [];
    try {
      const joinedForTr = englishLines.join('\n');
      const trUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=tr&dt=t&dj=1&q=${encodeURIComponent(joinedForTr)}`;
      const trRes = await fetch(trUrl);
      const trJson = await trRes.json();
      const fullTr = (trJson.sentences || []).map(s => s.trans || '').join('');
      const splitTr = fullTr.split('\n').map(s => s.trim()).filter(Boolean);

      if (splitTr.length === validItems.length) {
        turkishLines = splitTr;
      }
    } catch (e) {}

    await Promise.all(
      validItems.map(async (item, i) => {
        let tr = turkishLines[i] || '';
        if (!tr) {
          try {
            const fallbackUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=tr&dt=t&q=${encodeURIComponent(englishLines[i])}`;
            const fbRes = await fetch(fallbackUrl);
            const fbJson = await fbRes.json();
            if (Array.isArray(fbJson[0])) {
              fbJson[0].forEach(seg => {
                if (seg[0]) tr += seg[0];
              });
            }
          } catch (e) {}
        }

        const lang = detectScriptLang(item.raw);
        const existingRomaja = cache.get(item.raw)?.romaja;
        const romaja = existingRomaja || (isNonLatin(item.raw) ? await buildHybridRomaja(item.raw, lang) : '');

        cache.set(item.raw, {
          tr: enforceTurkishLyricHarmony(tr, item.raw),
          romaja,
          source: geminiApiKey ? 'gtx_pending_ai' : 'gtx'
        });
      })
    );

    if (!geminiApiKey) saveCacheToDisk();
    updateDOMWithCache();
  }

  // 2. GEMINI AI TAM ŞARKI YERELLEŞTİRME MOTORU (Arka planda tüm şarkıyı bütün olarak çevirip ekrandaki çevirileri şiirsel AI sürümüyle günceller)
  async function upgradeWithWholeSongGeminiAI() {
    if (isAiProcessing || !geminiApiKey || geminiApiKey.trim().length <= 10) return;

    const lineEls = Array.from(document.querySelectorAll('#SpicyLyricsPage .line:not(.musical-line)'));
    const linesNeedingAi = [];

    lineEls.forEach(lineEl => {
      const text = getCleanText(lineEl);
      if (!text || text === '•••' || isPureRhythmOrVocal(text)) return;
      const cached = cache.get(text);
      if (!cached || cached.source !== 'ai') {
        if (!linesNeedingAi.includes(text)) linesNeedingAi.push(text);
      }
    });

    if (linesNeedingAi.length === 0) return;

    isAiProcessing = true;
    try {
      const songTitle = Spicetify?.Player?.data?.item?.name || 'Unknown Song';
      const artist = Spicetify?.Player?.data?.item?.artists?.[0]?.name || 'Unknown Artist';
      const fullSongContext = Array.from(songFullLyricsContext);
      const indexedInput = linesNeedingAi.map((line, idx) => ({ i: idx, text: line }));

      const prompt = `You are a master Turkish poetic lyricist.
Song: "${songTitle}" by "${artist}".
Full Song Context:
${JSON.stringify(fullSongContext)}

Translate each lyric line in the indexed list into deeply natural, cohesive, poetic Turkish ("tr") that fits the emotional story of the whole song.
STRICT RULES:
1. ALWAYS use 100% informal singular "sen" in Turkish (e.g. "hislerini serbest bırak", "sesine teslim olma işareti", "ritimlerimizi buluşturalım"). NEVER use formal/plural "siz" ("-nizi", "-nize", "-edin", "-leştirin")!
2. In Japanese/Korean lyrics where subjects are omitted, infer the romantic subject from the song context (e.g. "求めて 求めて baby" = "Beni iste, arzula bebeğim", NOT "Ara ara bebeğim"; "You and me 今だけ見て" = "Sen ve ben, şimdi sadece bu ana odaklan", NOT "Sen ve ben bana bakıyoruz").
3. Mentally translate into idiomatic English first, then into fluent Turkish lyrics.

Return ONLY a valid JSON array of objects with keys "i" (number) and "tr" (string):
${JSON.stringify(indexedInput)}`;

      const models = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.5-flash-lite'];
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

          if (!res.ok) continue;
          const json = await res.json();
          const parts = json?.candidates?.[0]?.content?.parts || [];
          const combinedText = parts.filter(p => !p.thought && p.text).map(p => p.text).join('\n') || parts.map(p => p.text || '').join('\n');
          const jsonMatch = combinedText.match(/\[[\s\S]*\]/);
          if (!jsonMatch) continue;

          const parsed = JSON.parse(jsonMatch[0]);
          if (!Array.isArray(parsed) || parsed.length === 0) continue;

          await Promise.all(
            linesNeedingAi.map(async (rawText, idx) => {
              const found = parsed.find(item => item.i === idx) || parsed[idx];
              const lang = detectScriptLang(rawText);
              const existingRomaja = cache.get(rawText)?.romaja;
              const romaja = existingRomaja || (isNonLatin(rawText) ? await buildHybridRomaja(rawText, lang) : '');

              if (found && typeof found.tr === 'string' && found.tr.trim()) {
                cache.set(rawText, {
                  tr: enforceTurkishLyricHarmony(found.tr, rawText),
                  romaja,
                  source: 'ai'
                });
              }
            })
          );

          saveCacheToDisk();
          updateDOMWithCache();
          break;
        } catch (err) {}
      }
    } finally {
      isAiProcessing = false;
    }
  }

  async function processLyricsFlow() {
    const activeUri = Spicetify?.Player?.data?.item?.uri || Spicetify?.Player?.data?.item?.name || '';
    if (activeUri && activeUri !== currentSongUri) {
      currentSongUri = activeUri;
      songFullLyricsContext.clear();
    }

    const lineEls = Array.from(document.querySelectorAll('#SpicyLyricsPage .line:not(.musical-line)'));
    const missingLines = [];
    let hasPendingAiUpgrade = false;

    lineEls.forEach(lineEl => {
      const text = getCleanText(lineEl);
      if (!text || text === '•••') return;

      songFullLyricsContext.add(text);

      if (cache.has(text)) {
        const cachedData = cache.get(text);
        if (!lineEl.querySelector('.spicy-tr-box')) {
          renderSubtitles(lineEl, cachedData, text);
        }
        if (geminiApiKey && cachedData.source !== 'ai') {
          hasPendingAiUpgrade = true;
        }
      } else if (!missingLines.includes(text)) {
        missingLines.push(text);
      }
    });

    if (missingLines.length > 0 && !isFastProcessing) {
      isFastProcessing = true;
      try {
        await translateStanzaBlockCohesively(missingLines);
      } finally {
        isFastProcessing = false;
      }
    }

    if (geminiApiKey && (missingLines.length > 0 || hasPendingAiUpgrade)) {
      clearTimeout(aiQueueTimer);
      aiQueueTimer = setTimeout(upgradeWithWholeSongGeminiAI, 1800);
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
        ? 'Sol Tık: Çeviriyi Aç/Kapat | Sağ Tık: Gemini AI Anahtarını Yönet ve Önbelleği Sıfırla (V10.0 Tam Şarkı & Morfolojik Motor Aktif)'
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
        '🌟 Spicy Lyrics AI Çeviri & Romaja V10.0 🌟\n\n' +
        '• Ücretsiz Gemini API Anahtarınızı aşağıya yapıştırın (aistudio.google.com/apikey).\n' +
        '• Tamam\'a bastığınızda tüm eski önbellek temizlenir ve şarkı yeniden çevrilir:',
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
        processLyricsFlow();
      }
    };

    controls.appendChild(btn);
  }

  function scanLines() {
    injectToggleButton();
    const lineEls = document.querySelectorAll('#SpicyLyricsPage .line:not(.musical-line)');
    let needsAction = false;

    lineEls.forEach(lineEl => {
      const text = getCleanText(lineEl);
      if (!text || text === '•••') return;
      if (cache.has(text)) {
        if (!lineEl.querySelector('.spicy-tr-box')) {
          renderSubtitles(lineEl, cache.get(text), text);
        }
      } else {
        needsAction = true;
      }
    });

    if (needsAction) {
      clearTimeout(scanTimer);
      scanTimer = setTimeout(processLyricsFlow, 250);
    }
  }

  if (window._spicyTrObserver) window._spicyTrObserver.disconnect();
  window._spicyTrObserver = new MutationObserver(() => scanLines());
  window._spicyTrObserver.observe(document.body, { childList: true, subtree: true });
  scanLines();
})();
