// NAME: Spicy Lyrics AI Translator & Romaja
// AUTHOR: korelili
// VERSION: 1.0.0 (Marketplace Final / Engine V19)
// DESCRIPTION: Whole-Song Connected Context AI Localization, 100% "Sen" Lyric Harmony & Hybrid Multi-Line Romaja for Spicy Lyrics

(function spicyLyricsMarketplaceFinal() {
  // Önceki tüm test sürümlerinin önbelleklerini temizle
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
    'spicy_tr_instant_v18'
  ].forEach(k => localStorage.removeItem(k));

  const STORAGE_CACHE_KEY = 'spicy_tr_marketplace_v19';
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
  let preferredAiModel = '';
  let currentSongId = '';
  const fullSongLinesMemory = new Set();

  let isEnabled = localStorage.getItem('spicy_tr_enabled') !== 'false';
  let geminiApiKey = localStorage.getItem('spicy_tr_gemini_key') || '';
  let scanScheduled = false;
  let aiTimer = null;

  function saveCache() {
    try {
      const entries = Array.from(cache.entries())
        .filter(([, val]) => val && val.tr)
        .slice(-4000);
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

  async function fetchWithTimeout(url, options = {}, timeoutMs = 14000) {
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

  // HİBRİT ROMAJA MOTORU (Kusursuz Çalışan Okunuş Motoru)
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
          const res = await fetchWithTimeout(url, {}, 4000);
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

  // EVRENSEL ŞARKI DİLİ & ARGO ÖN-HAZIRLAYICI (Anlık motorda bile anlam kaymasını engeller)
  function prepareLyricMeaning(rawText) {
    return rawText
      .replace(/우리 사인/g, '우리 사이는')
      .replace(/\bI'm\s+riBBon\b/gi, 'I am reborn')
      .replace(/\bversion of my side\b/gi, 'version of myself')
      .replace(/\bof my side\b/gi, 'of myself')
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
      .replace(/\bFor sure\b/gi, 'for sure')
      .replace(/\bHere we go\b/gi, 'here we go')
      .replace(/\bFeel so right\b/gi, 'I feel so right');
  }

  // EVRENSEL TÜRKÇE ŞARKI DİLİ UYUM MOTORU (%100 "Sen" Dili, Sıfır "Görün/Bakın/Hissedin", Sıfır Kelime Bozulması)
  function enforceTurkishSongHarmony(tr, rawText) {
    if (!tr) return '';
    let fixed = tr.trim();
    if (fixed.includes('||')) fixed = fixed.split('||').pop().trim();

    fixed = fixed.replace(/^\s*(?:\[\d+\]|\d+[.:)])\s*/, '').replace(/[?？.]+$/g, '').trim();

    if (/\bfucked\b/i.test(rawText) && /\bberbat\b/i.test(fixed)) {
      fixed = fixed.replace(/\bberbat\b/gi, 'boktan');
    }

    // Doğal olmayan kelime kalıplarını akıcı Türkçeye yuvarla
    fixed = fixed
      .replace(/Benim tarafımın daha iyi bir versiyonunu görün/gi, 'Benim çok daha iyi bir halimi gör')
      .replace(/Benim tarafımın daha iyi bir versiyonunu gör/gi, 'Benim çok daha iyi bir halimi gör')
      .replace(/\btarafımın daha iyi bir versiyonunu\b/gi, 'daha iyi bir halimi')
      .replace(/^Ben kurdeleyim$/i, 'Yeniden doğdum')
      .replace(/\btabelamız\b/gi, 'aramızdaki bağ')
      .replace(/\bbir tabela\b/gi, 'bir işaret');

    // 1. Zamirleri samimi tekil "Sen" diline çevir
    fixed = fixed
      .replace(/\bSizin\b/g, 'Senin').replace(/\bsizin\b/g, 'senin')
      .replace(/\bSize\b/g, 'Sana').replace(/\bsize\b/g, 'sana')
      .replace(/\bSizi\b/g, 'Seni').replace(/\bsizi\b/g, 'seni')
      .replace(/\bSizde\b/g, 'Sende').replace(/\bsizde\b/g, 'sende')
      .replace(/\bSizden\b/g, 'Senden').replace(/\bsizden\b/g, 'senden')
      .replace(/\bSiz\b/g, 'Sen').replace(/\bsiz\b/g, 'sen');

    // 2. Evrensel "-niz/-nız/-nuz/-nüz" -> "-n" dönüşümü ("gözleriniz" -> "gözlerin", "hissettiğinizde" -> "hissettiğinde")
    const rootNizExceptions = /^(deniz|yalnız|henüz|boynuz|geniz|beniz)/i;
    fixed = fixed.split(/\s+/).map(word => {
      const cleanW = word.replace(/[.,!?'"()]/g, '');
      if (rootNizExceptions.test(cleanW)) return word;
      return word
        .replace(/s([iıuü])n[iıuü]z\b/gi, 's$1n')
        .replace(/n[iıuü]z(e|a|i|ı|u|ü|de|da|den|dan|le|la|in|ın|un|ün)?\b/gi, 'n$1');
    }).join(' ');

    // 3. Evrensel Çoğul Emir -> Tekil "Sen" Emir Dönüşümü ("görün" -> "gör", "bakın" -> "bak", "izleyin" -> "izle")
    // "için", "derin", "yakın", "kesin" gibi edat/sıfatlara ASLA dokunmaz!
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
        .replace(/\b(sevin|Sevin)\b/g, 'sev')
        .replace(/\b(gülün|Gülün)\b/g, 'gül')
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
    if (!data || (!data.tr && !data.romaja)) return;

    const cleanTr = enforceTurkishSongHarmony(data.tr, rawText);
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

  // 1. ANLIK BAĞLAMSAL MOTOR (API Anahtarı Olmayan Kullanıcılar İçin Veya AI Yanıtı Gelene Kadar 0.2sn İçinde Akıcı Çeviri Sunar)
  async function translateInstantConnectedStanza(linesToProcess) {
    linesToProcess.forEach(l => inFlightFast.add(l));

    try {
      const preparedList = linesToProcess.map(raw => prepareLyricMeaning(raw));

      // Aşama 1: Karma veya yabancı satırları önce anlamlı İngilizceye çevirerek cümle içindeki kopuklukları birleştir
      const englishBridged = await Promise.all(
        preparedList.map(async (prep, idx) => {
          const raw = linesToProcess[idx];
          if (!isNonLatin(raw)) return prep;
          try {
            const lang = detectLang(raw);
            const enUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${lang}&tl=en&dt=t&q=${encodeURIComponent(prep)}`;
            const res = await fetchWithTimeout(enUrl, {}, 3500);
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

      // Aşama 2: Alt alta gelen satırların birbirine bağlanması için nokta (.) yerine noktalı virgül (;) ile tek kıta olarak çevir
      let stanzaTrList = [];
      try {
        const connectedStanza = englishBridged.map(l => l.replace(/[.;!?]+$/, '').trim()).join(';\n');
        const trUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=tr&dt=t&dj=1&q=${encodeURIComponent(connectedStanza)}`;
        const res = await fetchWithTimeout(trUrl, {}, 4000);
        const json = await res.json();
        const fullTr = (json.sentences || []).map(s => s.trans || '').join('');
        const splitTr = fullTr.split('\n').map(s => s.replace(/[.;]+$/, '').trim()).filter(Boolean);
        if (splitTr.length === linesToProcess.length) {
          stanzaTrList = splitTr;
        }
      } catch (e) {}

      await Promise.all(
        linesToProcess.map(async (rawText, idx) => {
          let tr = stanzaTrList[idx] || '';
          const lang = detectLang(rawText);

          if (!tr || /bu çok önemli/i.test(tr)) {
            try {
              const sUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${lang}&tl=tr&dt=t&q=${encodeURIComponent(englishBridged[idx])}`;
              const sRes = await fetchWithTimeout(sUrl, {}, 3500);
              const sJson = await sRes.json();
              tr = '';
              if (Array.isArray(sJson[0])) {
                sJson[0].forEach(seg => { if (seg[0]) tr += seg[0]; });
              }
            } catch (e) {}
          }

          const romaja = isNonLatin(rawText) ? await buildHybridRomaja(rawText) : '';
          const finalTr = enforceTurkishSongHarmony(tr, rawText);

          if (finalTr || romaja) {
            cache.set(rawText, {
              tr: finalTr,
              romaja,
              aiUpgraded: false
            });
          }
        })
      );

      if (!geminiApiKey) saveCache();
      updateDOMWithCache();
    } finally {
      linesToProcess.forEach(l => inFlightFast.delete(l));
    }
  }

  // 2. ANA BÜTÜNSEL GEMINI/GEMMA AI MOTORU (15 Saniye Timeout, Sıfır Yazım Hatası, Tam Şarkı Akışı!)
  async function upgradeWithWholeSongAI(allVisibleLines) {
    if (!geminiApiKey || geminiApiKey.trim().length <= 10) return;

    const linesNeedingAi = allVisibleLines.filter(
      t => (!cache.has(t) || !cache.get(t).aiUpgraded) && !inFlightAi.has(t)
    );
    if (linesNeedingAi.length === 0) return;

    const batch = linesNeedingAi.slice(0, 20);
    batch.forEach(t => inFlightAi.add(t));

    try {
      const songTitle = Spicetify?.Player?.data?.item?.name || 'Unknown Song';
      const artist = Spicetify?.Player?.data?.item?.artists?.[0]?.name || 'Unknown Artist';
      const fullSongContext = Array.from(fullSongLinesMemory).slice(0, 60).join('\n');
      const numberedInput = batch.map((l, i) => `[${i}] ${l}`).join('\n');

      const prompt = `You are Turkey's #1 poetic music translator and lyricist.
Song: "${songTitle}" by "${artist}"

Full Song Lyrics Context (Read the entire song first so every line flows seamlessly into the next line when read from top to bottom):
${fullSongContext}

Translate each numbered line below into 100% natural, emotional, idiomatic, non-inverted Turkish song lyrics.

STRICT RULES:
1. SEAMLESS LINE-TO-LINE FLOW: When read from top to bottom, consecutive lines must connect naturally as one coherent story (e.g. "무엇을 원해 원해" -> "Ne istersen iste", followed by "뭐든 다 줄게 For sure" -> "Sana her şeyi vereceğimden emin ol"). Never write awkward or inverted sentences.
2. IDIOMS, WORDPLAY & CONTEXT:
   - Understand song wordplay and metaphors in context (e.g. in BamBam's "riBBon", "I'm riBBon" is wordplay on "I'm reborn" -> translate as "Yeniden doğdum", NEVER literally as "Ben kurdeleyim"!; "See a better version of my side" -> "Benim çok daha iyi bir halimi gör", NEVER "tarafımın versiyonunu görün"!).
   - Blend mixed Korean/Japanese/Thai/Spanish + English lines into pure, natural Turkish.
3. 100% SINGULAR INFORMAL ("SEN") TONE: Always address the listener/lover as "sen" (e.g. "gör", "bak", "gözlerin", "hisset"). NEVER use formal/plural "siz" ("görün", "bakın", "gözleriniz", "hissedin")!
4. Do not censor explicit words. Do not put periods (".") or question marks ("?") at the end of lines.

Return ONLY the numbered Turkish lines in this exact format:
[0] Turkish translation
[1] Turkish translation

Lines to translate:
${numberedInput}`;

      // Çalışan modeli en başa al; yoksa hem hızlı hem 14.400 günlük kotalı modelleri sırayla dene
      const defaultModels = [
        'gemma-3-27b-it',
        'gemini-2.5-flash-lite',
        'gemini-2.5-flash',
        'gemini-2.0-flash',
        'gemma-3-12b-it'
      ];
      const models = preferredAiModel
        ? [preferredAiModel, ...defaultModels.filter(m => m !== preferredAiModel)]
        : defaultModels;

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
                generationConfig: { temperature: 0.3 }
              })
            },
            15000
          );

          if (res.status === 429 || res.status === 404 || res.status === 400) {
            deadModels.set(model, Date.now() + 90000);
            if (preferredAiModel === model) preferredAiModel = '';
            continue;
          }
          if (!res.ok) continue;

          const json = await res.json();
          const parts = json?.candidates?.[0]?.content?.parts || [];
          const rawOutput = parts.filter(p => !p.thought && p.text).map(p => p.text).join('\n') || parts.map(p => p.text || '').join('\n');

          const cleaned = rawOutput.replace(/^```[a-z]*\s*/im, '').replace(/```\s*$/im, '').trim();
          const lineRegex = /^\s*(?:\*\*)?(?:\[(\d+)\]|(\d+)[.:)])(?:\*\*)?\s*[-–—:]?\s*(.+)$/gm;
          let match;
          let updatedCount = 0;

          while ((match = lineRegex.exec(cleaned)) !== null) {
            const idx = parseInt(match[1] !== undefined ? match[1] : match[2], 10);
            const trText = match[3].trim().replace(/^["']|["']$/g, '');
            const rawText = batch[idx];
            if (rawText && trText) {
              const existing = cache.get(rawText) || {};
              const romaja = existing.romaja || (isNonLatin(rawText) ? await buildHybridRomaja(rawText) : '');
              cache.set(rawText, {
                tr: enforceTurkishSongHarmony(trText, rawText),
                romaja,
                aiUpgraded: true
              });
              updatedCount++;
            }
          }

          if (updatedCount > 0) {
            preferredAiModel = model;
            saveCache();
            updateDOMWithCache();
            break;
          }
        } catch (e) {}
      }
    } finally {
      batch.forEach(t => inFlightAi.delete(t));
      // Eğer ekranda hala AI ile güncellenmemiş satırlar varsa devam et
      const stillRemaining = allVisibleLines.filter(
        t => (!cache.has(t) || !cache.get(t).aiUpgraded) && !inFlightAi.has(t)
      );
      if (stillRemaining.length > 0) {
        clearTimeout(aiTimer);
        aiTimer = setTimeout(() => upgradeWithWholeSongAI(allVisibleLines), 1200);
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
        '🔥 Spicy Lyrics AI Translator & Romaja (Marketplace Edition) 🔥\n\n' +
        '• Ücretsiz Gemini API Anahtarınızı aşağıya yapıştırın (aistudio.google.com/apikey).\n' +
        '• Tamam\'a bastığınızda önbellek temizlenir ve şarkı yeniden çevrilir:',
        geminiApiKey
      );
      if (input !== null) {
        geminiApiKey = input.trim();
        localStorage.setItem('spicy_tr_gemini_key', geminiApiKey);
        cache.clear();
        deadModels.clear();
        fullSongLinesMemory.clear();
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

    const activeSong = Spicetify?.Player?.data?.item?.uri || Spicetify?.Player?.data?.item?.name || '';
    if (activeSong && activeSong !== currentSongId) {
      currentSongId = activeSong;
      fullSongLinesMemory.clear();
    }

    const lineEls = Array.from(document.querySelectorAll('#SpicyLyricsPage .line:not(.musical-line)'));
    const allVisibleTexts = [];
    const missingFastLines = [];

    lineEls.forEach(lineEl => {
      const text = getCleanText(lineEl);
      if (!text || text === '•••') return;

      fullSongLinesMemory.add(text);
      if (!allVisibleTexts.includes(text)) allVisibleTexts.push(text);

      if (cache.has(text)) {
        renderSubtitles(lineEl, cache.get(text), text);
      } else if (!inFlightFast.has(text)) {
        missingFastLines.push(text);
      }
    });

    if (missingFastLines.length > 0) {
      translateInstantConnectedStanza(missingFastLines.slice(0, 30));
    }

    if (geminiApiKey && geminiApiKey.trim().length > 10 && allVisibleTexts.length > 0) {
      const needsAi = allVisibleTexts.some(t => !cache.has(t) || !cache.get(t).aiUpgraded);
      if (needsAi) {
        clearTimeout(aiTimer);
        aiTimer = setTimeout(() => {
          upgradeWithWholeSongAI(allVisibleTexts);
        }, 400);
      }
    }
  }

  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    setTimeout(runScanNow, 150);
  }

  if (window._spicyTrObserver) window._spicyTrObserver.disconnect();
  // Kendi eklediğimiz .spicy-tr-box değişikliklerini yoksay ki AI sayacı asla sıfırlanmasın!
  window._spicyTrObserver = new MutationObserver((mutations) => {
    const isExternalChange = mutations.some(m => !m.target?.closest?.('.spicy-tr-box'));
    if (isExternalChange) scheduleScan();
  });
  window._spicyTrObserver.observe(document.body, { childList: true, subtree: true });
  runScanNow();
})();
