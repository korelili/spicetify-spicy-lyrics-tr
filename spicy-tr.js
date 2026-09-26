// NAME: Spicy Lyrics AI Translator & Romaja
// AUTHOR: korelili
// VERSION: 14.0.0
// DESCRIPTION: Universal Multi-Language AI Lyric Localizer (Fault-Tolerant Line Protocol, Auto-AI Upgrade, Universal "Sen" Grammar & Pure Hybrid Romaja)

(function spicyLyricsAITranslatorV14() {
  // Önceki tüm bozuk önbellekleri kesin olarak temizle
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
    'spicy_tr_persistent_cache_v13_clean'
  ].forEach(k => localStorage.removeItem(k));

  const STORAGE_CACHE_KEY = 'spicy_tr_persistent_cache_v14_universal';
  let savedCache = {};
  try {
    savedCache = JSON.parse(localStorage.getItem(STORAGE_CACHE_KEY) || '{}');
  } catch (e) {
    savedCache = {};
  }

  const cache = new Map(Object.entries(savedCache));
  const modelCooldowns = new Map();
  let currentSongUri = '';
  const songFullLyricsContext = new Set();

  let isEnabled = localStorage.getItem('spicy_tr_enabled') !== 'false';
  let geminiApiKey = localStorage.getItem('spicy_tr_gemini_key') || '';
  let isProcessing = false;
  let scanTimer = null;
  let retryAiTimer = null;

  function saveCacheToDisk() {
    try {
      // Sadece gerçek (kalıcı) çevirileri diske kaydet; geçici yedek çevirileri kaydetme ki AI ezebilsin!
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

  // EVRENSEL TÜRKÇE ŞARKI DİLİ DÜZELTİCİ (Her dilde "siz" -> "sen" yapar, "için" kelimesine ASLA dokunmaz, "tabela" ve "?" hatalarını siler)
  function universalTurkishPolish(tr, rawText) {
    if (!tr) return '';
    if (isPureRhythmOrVocal(rawText)) return '';

    let fixed = tr.trim();

    // 1. Satır sonundaki gereksiz "?" ve "." işaretlerini temizle
    fixed = fixed.replace(/[?？.]+$/g, '').trim();

    // 2. Evrensel kelime/anlam düzeltmeleri ("tabelamız" -> "aramızdaki işaret", "senin iç" -> "senin için" vb.)
    fixed = fixed
      .replace(/\bsenin iç\b/gi, 'senin için')
      .replace(/\btabelamız\b/gi, 'aramızdaki işaret')
      .replace(/\btabelan\b/gi, 'işaretin')
      .replace(/\btabelası\b/gi, 'işareti')
      .replace(/\bbir tabela\b/gi, 'bir işaret')
      .replace(/Bakın,\s*çevrenize dikkat etmeyin/gi, 'Bana bak, etrafına hiç aldırma')
      .replace(/Heyecan verici bakışları hissettiğinizde gözleriniz gizemli hale gelir/gi, 'O büyüleyici bakışları hissettiğimde gözlerin daha da derinleşiyor')
      .replace(/Heyecan verici bakışları hissettiğinde gözlerin gizemli hale gelir/gi, 'O büyüleyici bakışları hissettiğimde gözlerin daha da derinleşiyor')
      .replace(/Beni zarafetle çağıran bir elin jestine kendimi bıraktığımda/gi, 'Beni zarifçe çağıran o el hareketine kendimi bıraktığımda')
      .replace(/Sadece bana izin veriyorsun/gi, 'Sadece bana izin ver')
      .replace(/Sadece şimdiyi düşünüyorsun/gi, 'Sadece bu anı düşün')
      .replace(/Tamam,\s*senin için anladım/gi, 'Tamam, senin için aldım')
      .replace(/RiBBon'un kilidini aç/gi, 'Kurdeleyi çöz bakalım')
      .replace(/Kendimi senin çağıran sesine teslim etme işareti/gi, 'Beni kendine çağıran o sesine teslim oluyorum')
      .replace(/Sınırlı bir süre içinde yakala/gi, 'Bu kısacık anda sıkıca tut beni')
      .replace(/Kelimeler olmadan bile genişliyor/gi, 'Kelimeler olmasa bile içimde büyüyor')
      .replace(/Göz kamaştırıcı (benliğiniz|benliğin) pencereye yansıyor/gi, 'Göz kamaştıran güzelliğin pencereye yansıyor')
      .replace(/Ritimimizi aynı tempoya uydurmak/gi, 'Ritmimizi aynı tempoda buluşturalım')
      .replace(/Umurumda olmayan her şey/gi, 'Başka hiçbir şey umurumda değil')
      .replace(/Sen sorun değil/gi, 'Seninle her şey yolunda')
      .replace(/Bekleyişim seni bekliyor/gi, 'Hasretim bile senin yolunu gözlüyor')
      .replace(/\b(BENİM SAVAŞÇIM|Benim savaşçım)\b/gi, 'Benim kendi tarzım')
      .replace(/Shine Nozomi Caddesi/gi, 'Tam istediğim gibi parlasın')
      .replace(/Yalnızca Kabuku/gi, 'Sadece kendi farkımı ortaya koyarım');

    // 3. Zamir dönüşümleri (Siz -> Sen)
    fixed = fixed
      .replace(/\bSizin\b/g, 'Senin').replace(/\bsizin\b/g, 'senin')
      .replace(/\bSize\b/g, 'Sana').replace(/\bsize\b/g, 'sana')
      .replace(/\bSizi\b/g, 'Seni').replace(/\bsizi\b/g, 'seni')
      .replace(/\bSizde\b/g, 'Sende').replace(/\bsizde\b/g, 'sende')
      .replace(/\bSizden\b/g, 'Senden').replace(/\bsizden\b/g, 'senden')
      .replace(/\bSiz\b/g, 'Sen').replace(/\bsiz\b/g, 'sen');

    // 4. EVRENSEL MORFOLOJİK "-NİZ" -> "-N" DÖNÜŞÜMÜ
    // ("çevrenize" -> "çevrene", "hissettiğinizde" -> "hissettiğinde", "gözleriniz" -> "gözlerin", "zihninizde" -> "zihninde", "düşüncelerinizi" -> "düşüncelerini")
    // Kökünde "niz/nız/nuz/nüz" olan 6 kelimeyi (deniz, yalnız, henüz, boynuz, geniz, beniz) korur, "için" kelimesine ASLA dokunmaz!
    const rootExceptions = /^(deniz|yalnız|henüz|boynuz|geniz|beniz)/i;
    fixed = fixed.split(/\s+/).map(word => {
      const cleanW = word.replace(/[.,!?'"()]/g, '');
      if (rootExceptions.test(cleanW)) return word;
      return word
        // Gelecek/şimdiki/geniş zaman 2. çoğul şahıs: ediyorsunuz -> ediyorsun, edeceksiniz -> edeceksin
        .replace(/s([iıuü])n[iıuü]z\b/gi, 's$1n')
        // Tüm iyelik ve geçmiş zaman 2. çoğul şahıs ekleri: -niz/-nız/-nuz/-nüz (+ hal ekleri) -> -n (+ hal ekleri)
        .replace(/n[iıuü]z(e|a|i|ı|u|ü|de|da|den|dan|le|la|in|ın|un|ün)?\b/gi, 'n$1');
    }).join(' ');

    // 5. EVRENSEL ÇOĞUL EMİR KİPLERİ ("dikkat etmeyin" -> "dikkat etme", "bakın" -> "bak" — Sadece tam kelimeler, "için" ASLA etkilenmez!)
    fixed = fixed
      // Tüm olumsuz çoğul emirler: -meyin / -mayın -> -me / -ma
      .replace(/([a-zçğıöşü]+m[ae])y[iı]n\b/gi, '$1')
      // Ünlüyle biten çoğul emirler: dinleyin -> dinle, bekleyin -> bekle, izleyin -> izle, söyleyin -> söyle, başlayın -> başla, anlayın -> anla
      .replace(/([a-zçğıöşü]{2,}[aeıioöuü])y[iıuü]n\b/gi, '$1')
      // Ettirgen çoğul emirler: eşleştirin -> eşleştir, geliştirin -> geliştir, birleştirin -> birleştir
      .replace(/([a-zçğıöşü]+l[aeıi]şt[iı]r)[iı]n\b/gi, '$1')
      // Yardımcı fiiller ve yaygın emir kipleri (Tam kelime eşleşmesi):
      .replace(/\b(bakın|Bakın)\b/g, 'bak')
      .replace(/\b(bırakın|Bırakın)\b/g, 'bırak')
      .replace(/\b(yapın|Yapın)\b/g, 'yap')
      .replace(/\b(edin|Edin)\b/g, 'et')
      .replace(/\b(ettirin|Ettirin)\b/g, 'ettir')
      .replace(/\b(olun|Olun)\b/g, 'ol')
      .replace(/\b(hissedin|Hissedin)\b/g, 'hisset')
      .replace(/\b(verin|Verin)\b/g, 'ver')
      .replace(/\b(alın|Alın)\b/g, 'al')
      .replace(/\b(kalın|Kalın)\b/g, 'kal')
      .replace(/\b(açın|Açın)\b/g, 'aç')
      .replace(/\b(kapatın|Kapatın)\b/g, 'kapat')
      .replace(/\b(tutun|Tutun)\b/g, 'tut')
      .replace(/\b(unutun|Unutun)\b/g, 'unut')
      .replace(/\b(koşun|Koşun)\b/g, 'koş')
      .replace(/\b(dokunun|Dokunun)\b/g, 'dokun')
      .replace(/\b(konuşun|Konuşun)\b/g, 'konuş')
      .replace(/\b(durun|Durun)\b/g, 'dur')
      .replace(/\b(görün|Görün)\b/g, 'gör')
      .replace(/\b(düşünün|Düşünün)\b/g, 'düşün')
      .replace(/\b(inanın|İnanın)\b/g, 'inan')
      .replace(/\b(yükseltin|Yükseltin)\b/g, 'yükselt')
      .replace(/\b(kurtulun|Kurtulun)\b/g, 'bir kenara bırak')
      .replace(/\b(aşın|Aşın)\b/g, 'aş');

    // 6. Cümle sonu sözlük mastarlarını (-mak/-mek) doğal fiile çevir
    fixed = fixed
      .replace(/\b([a-zçğıöşü]{2,})mak$/i, '$1alım')
      .replace(/\b([a-zçğıöşü]{2,})mek$/i, '$1elim');

    fixed = fixed.replace(/\s+/g, ' ').trim();
    if (fixed.length > 0) {
      fixed = fixed.charAt(0).toUpperCase() + fixed.slice(1);
    }
    return fixed;
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

    const cleanedTr = universalTurkishPolish(data.tr, rawText);
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

  // KIRILMAZ AI ÇIKTI AYRIŞTIRICI: Hem "[0] Çeviri" formatını hem de JSON formatını %100 hatasız okur (Tırnak işareti yüzünden ASLA çökmez!)
  function parseFaultTolerantAiOutput(rawOutput, expectedCount) {
    const resultMap = new Map();
    if (!rawOutput) return resultMap;

    // 1. Önce "[0] Çeviri" satır formatını tara
    const lineRegex = /^\s*\[(\d+)\]\s*(.+)$/gm;
    let match;
    while ((match = lineRegex.exec(rawOutput)) !== null) {
      const idx = parseInt(match[1], 10);
      let trText = match[2].trim().replace(/^["']|["']$/g, '');
      if (!isNaN(idx) && trText) {
        resultMap.set(idx, trText);
      }
    }

    if (resultMap.size > 0) return resultMap;

    // 2. Eğer model JSON döndürdüyse JSON olarak ayrıştır
    try {
      const jsonMatch = rawOutput.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed)) {
          parsed.forEach((item, i) => {
            if (typeof item === 'string') {
              resultMap.set(i, item);
            } else if (item && typeof item.tr === 'string') {
              const idx = typeof item.i === 'number' ? item.i : i;
              resultMap.set(idx, item.tr);
            }
          });
        }
      }
    } catch (e) {}

    return resultMap;
  }

  // 1. ANA MOTOR: Evrensel Çok Dilli (Korece, Japonca, Tayca, İngilizce, İspanyolca) Kırılmaz Gemini AI Motoru
  async function translateBatchWithUniversalAI(batchLines, fullSongContextArray) {
    const songTitle = Spicetify?.Player?.data?.item?.name || 'Unknown Song';
    const artist = Spicetify?.Player?.data?.item?.artists?.[0]?.name || 'Unknown Artist';

    const numberedInput = batchLines.map((line, idx) => `[${idx}] ${line}`).join('\n');
    const contextPreview = fullSongContextArray.slice(0, 45).join(' / ');

    const prompt = `You are a master Turkish poetic lyricist translating a song on Spotify.
Song: "${songTitle}" by "${artist}".
Whole-Song Context (use this to understand the full story, mood, and connected sentences across lines):
${contextPreview}

Translate each numbered lyric line below (whether Korean, Japanese, Thai, Spanish, English, or mixed) into natural, emotional, poetic Turkish song lyrics.

UNIVERSAL RULES FOR ALL LANGUAGES:
1. WHOLE-SONGS & CONNECTED LINES: Connect split sentences across consecutive lines so every Turkish line reads like a real, meaningful lyric. Mentally translate into idiomatic English first to resolve slang, metaphors, and omitted subjects, then write fluent Turkish.
2. 100% SINGULAR INFORMAL ("SEN") TONE: Address the lover/listener exclusively as "sen" (e.g., "Bana bak, etrafına aldırma", "gözlerin", "kendini bırak"). NEVER use plural/formal "siz" ("bakın", "çevrenize", "dikkat etmeyin", "hissettiğinizde", "gözleriniz")!
3. NATURAL LYRIC VOCABULARY: In romance songs, translate "sign / 사인 / サイン" as "işaret" or "aramızdaki bağ" (NEVER as "tabela"!). Never end lines with dictionary infinitives ("-mak / -mek").
4. NO EXTRA PUNCTUATION: Do NOT put periods (".") or question marks ("?") at the end of lines.
5. OUTPUT FORMAT: Return ONLY the numbered lines in the exact format "[index] Turkish translation" (one line per index, no extra commentary):

${numberedInput}`;

    // Hız ve kota açısından en sağlam 4 model sırası
    const models = [
      'gemma-3-27b-it',
      'gemini-2.5-flash-lite',
      'gemini-2.0-flash',
      'gemini-2.5-flash'
    ];

    let lastErr = null;

    for (const modelId of models) {
      const cooldownUntil = modelCooldowns.get(modelId) || 0;
      if (Date.now() < cooldownUntil) continue;

      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${geminiApiKey.trim()}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.2 }
          })
        });

        if (res.status === 429 || res.status === 404 || res.status === 400) {
          modelCooldowns.set(modelId, Date.now() + 45000);
          throw new Error(`HTTP ${res.status} on ${modelId}`);
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const json = await res.json();
        const parts = json?.candidates?.[0]?.content?.parts || [];
        const rawOutput = parts.filter(p => !p.thought && p.text).map(p => p.text).join('\n') || parts.map(p => p.text || '').join('\n');

        const parsedMap = parseFaultTolerantAiOutput(rawOutput, batchLines.length);
        if (parsedMap.size === 0) throw new Error('Could not parse AI lines');

        await Promise.all(
          batchLines.map(async (rawText, idx) => {
            if (isPureRhythmOrVocal(rawText)) {
              cache.set(rawText, { tr: '', romaja: '', temp: false });
              return;
            }
            const aiTr = parsedMap.get(idx);
            const lang = detectScriptLang(rawText);
            const existingRomaja = cache.get(rawText)?.romaja;
            const romaja = existingRomaja || (isNonLatin(rawText) ? await buildHybridRomaja(rawText, lang) : '');

            if (aiTr) {
              cache.set(rawText, {
                tr: universalTurkishPolish(aiTr, rawText),
                romaja,
                temp: false
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

  // 2. YEDEK BÜTÜNSEL MOTOR (AI Anahtarı Yoksa Veya Geçici Kota Bekleniyorsa)
  async function translateWithUniversalFallback(targetLines, isTempForAi = false) {
    const validItems = [];
    targetLines.forEach((raw, idx) => {
      if (isPureRhythmOrVocal(raw)) {
        cache.set(raw, { tr: '', romaja: '', temp: false });
      } else {
        // Korece/Japonca "사인 / サイン" kelimesinin "tabela" olmasını ön하기 için ön-temizlik
        const cleanedRaw = raw
          .replace(/\(Tip tap[^)]*\)/gi, '')
          .replace(/우리 사인/g, 'aramızdaki işaret')
          .replace(/\bE'ryday\b/gi, 'every day')
          .replace(/\bMY SWAGGER\b/gi, 'my own cool style');
        validItems.push({ raw, prepared: cleanedRaw, idx });
      }
    });

    if (validItems.length === 0) return;

    let turkishLines = [];
    try {
      const joinedBlock = validItems.map(i => i.prepared).join('\n');
      const trUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=tr&dt=t&dj=1&q=${encodeURIComponent(joinedBlock)}`;
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
        const lang = detectScriptLang(item.raw);

        if (!tr || /bu çok önemli/i.test(tr)) {
          try {
            const fbUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${lang}&tl=tr&dt=t&q=${encodeURIComponent(item.prepared)}`;
            const fbRes = await fetch(fbUrl);
            const fbJson = await fbRes.json();
            tr = '';
            if (Array.isArray(fbJson[0])) {
              fbJson[0].forEach(seg => {
                if (seg[0]) tr += seg[0];
              });
            }
          } catch (e) {}
        }

        const existingRomaja = cache.get(item.raw)?.romaja;
        const romaja = existingRomaja || (isNonLatin(item.raw) ? await buildHybridRomaja(item.raw, lang) : '');

        cache.set(item.raw, {
          tr: universalTurkishPolish(tr, item.raw),
          romaja,
          temp: isTempForAi
        });
      })
    );

    if (!isTempForAi) saveCacheToDisk();
    updateDOMWithCache();
  }

  async function processVisibleLyrics() {
    if (isProcessing) return;

    const activeUri = Spicetify?.Player?.data?.item?.uri || Spicetify?.Player?.data?.item?.name || '';
    if (activeUri && activeUri !== currentSongUri) {
      currentSongUri = activeUri;
      songFullLyricsContext.clear();
    }

    const lineEls = Array.from(document.querySelectorAll('#SpicyLyricsPage .line:not(.musical-line)'));
    const missingOrTempLines = [];

    lineEls.forEach(lineEl => {
      const text = getCleanText(lineEl);
      if (!text || text === '•••') return;

      songFullLyricsContext.add(text);

      if (cache.has(text)) {
        const cachedItem = cache.get(text);
        if (!lineEl.querySelector('.spicy-tr-box')) {
          renderSubtitles(lineEl, cachedItem, text);
        }
        // Eğer geçici yedek çeviri varsa ve AI anahtarı aktifse AI ile yükseltmek üzere listeye al
        if (cachedItem.temp && geminiApiKey && geminiApiKey.trim().length > 10) {
          if (!missingOrTempLines.includes(text)) missingOrTempLines.push(text);
        }
      } else if (!missingOrTempLines.includes(text)) {
        missingOrTempLines.push(text);
      }
    });

    if (missingOrTempLines.length === 0) return;

    isProcessing = true;
    try {
      const fullContextArray = Array.from(songFullLyricsContext);
      // Modelin boğulmaması için her seferinde ekrandaki ilk 22 satırlık kıtayı çevir
      const currentBatch = missingOrTempLines.slice(0, 22);

      if (geminiApiKey && geminiApiKey.trim().length > 10) {
        try {
          await translateBatchWithUniversalAI(currentBatch, fullContextArray);
        } catch (aiErr) {
          console.warn('Spicy TR V14: AI geçici yoğunlukta, geçici çeviri gösteriliyor (3sn sonra AI yenileyecek):', aiErr);
          const uncachedOnly = currentBatch.filter(t => !cache.has(t));
          if (uncachedOnly.length > 0) {
            await translateWithUniversalFallback(uncachedOnly, true);
          }
          clearTimeout(retryAiTimer);
          retryAiTimer = setTimeout(processVisibleLyrics, 3200);
        }
      } else {
        await translateWithUniversalFallback(currentBatch, false);
      }
    } catch (e) {
      console.error('Spicy TR V14 Hata:', e);
    } finally {
      isProcessing = false;
      // Kalan satırlar varsa hemen devam et
      const remaining = Array.from(document.querySelectorAll('#SpicyLyricsPage .line:not(.musical-line)'))
        .map(el => getCleanText(el))
        .filter(t => t && t !== '•••' && !cache.has(t));
      if (remaining.length > 0) {
        clearTimeout(scanTimer);
        scanTimer = setTimeout(processVisibleLyrics, 400);
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
        ? 'Sol Tık: Çeviriyi Aç/Kapat | Sağ Tık: AI Anahtarını Yönet ve Önbelleği Sıfırla (V14.0 Evrensel AI Aktif)'
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
        '🌟 Spicy Lyrics AI Çeviri & Romaja V14.0 (Evrensel Sürüm) 🌟\n\n' +
        '• Ücretsiz Gemini API Anahtarınızı aşağıya yapıştırın (aistudio.google.com/apikey).\n' +
        '• Tamam\'a bastığınızda tüm önbellek temizlenir ve şarkı yeniden çevrilir:',
        geminiApiKey
      );
      if (input !== null) {
        geminiApiKey = input.trim();
        localStorage.setItem('spicy_tr_gemini_key', geminiApiKey);
        cache.clear();
        modelCooldowns.clear();
        songFullLyricsContext.clear();
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
      scanTimer = setTimeout(processVisibleLyrics, 450);
    }
  }

  if (window._spicyTrObserver) window._spicyTrObserver.disconnect();
  window._spicyTrObserver = new MutationObserver(() => scanLines());
  window._spicyTrObserver.observe(document.body, { childList: true, subtree: true });
  scanLines();
})();
