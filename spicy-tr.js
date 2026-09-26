// NAME: Spicy Lyrics AI Translator & Romaja
// AUTHOR: korelili
// VERSION: 15.0.0 (MASTER)
// DESCRIPTION: Universal Two-Step CoT (English Pivot -> Poetic Turkish) Gemini 2.5 AI Engine & Pure Hybrid Romaja for Spicy Lyrics

(function spicyLyricsAITranslatorV15Master() {
  // Önceki tüm sürümlerin önbelleklerini otomatik temizle
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
    'spicy_tr_persistent_cache_v15_universal'
  ].forEach(k => localStorage.removeItem(k));

  const STORAGE_CACHE_KEY = 'spicy_tr_persistent_cache_v15_master';
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
  let retryTimer = null;

  function saveCacheToDisk() {
    try {
      const permanentEntries = Array.from(cache.entries())
        .filter(([, val]) => val && !val.temp)
        .slice(-3500);
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
    return /^(tip tap(\s+tip|\s+tap)*|yeah(\s+yeah)*|la(\s+la)+|na(\s+na)+|oh(\s+oh|\s+whoa)*|whoo(\s+whoo)*|whoa(\s+whoa)*|ooh(\s+ooh)*|ah(\s+ah)+|uh(\s+uh)+|bam(\s+bam)+|go(\s+go)+|let's go(\s+go)*|yo(\s+yo)*|mm(\s+mm)*)$/i.test(cleaned);
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

  // EVRENSEL DİLBİLGİSİ KORUYUCU (Şarkıya özel tek bir yama bile içermez; sadece evrensel Türkçe dilbilgisi uyumu sağlar)
  function cleanUniversalTurkishGrammar(tr, rawText) {
    if (!tr) return '';
    if (isPureRhythmOrVocal(rawText)) return '';

    let fixed = tr.trim();

    // 1. Eğer model "EN || TR" formatında döndürdüyse sadece sağdaki Türkçe kısmı al
    if (fixed.includes('||')) {
      fixed = fixed.split('||').pop().trim();
    }

    // 2. Satır sonu gereksiz nokta ve yapay soru işaretlerini temizle
    fixed = fixed.replace(/[?？.]+$/g, '').trim();

    // 3. Yanlış dost kelime: Şarkılarda "sign / 사인 / サ인 / サイン" kelimesinin "tabela" olarak çevrilmesini evrensel olarak önle
    fixed = fixed
      .replace(/\btabelamız\b/gi, 'aramızdaki işaret')
      .replace(/\btabelan\b/gi, 'işaretin')
      .replace(/\btabelası\b/gi, 'işareti')
      .replace(/\bbir tabela\b/gi, 'bir işaret');

    // 4. Zamirleri samimi tekil "Sen" diline sabitle
    fixed = fixed
      .replace(/\bSizin\b/g, 'Senin').replace(/\bsizin\b/g, 'senin')
      .replace(/\bSize\b/g, 'Sana').replace(/\bsize\b/g, 'sana')
      .replace(/\bSizi\b/g, 'Seni').replace(/\bsizi\b/g, 'seni')
      .replace(/\bSizde\b/g, 'Sende').replace(/\bsizde\b/g, 'sende')
      .replace(/\bSizden\b/g, 'Senden').replace(/\bsizden\b/g, 'senden')
      .replace(/\bSiz\b/g, 'Sen').replace(/\bsiz\b/g, 'sen');

    // 5. Evrensel 2. Çoğul Şahıs İyelik/Fiil Eki (-niz/-nız/-nuz/-nüz) -> 2. Tekil Şahıs (-n)
    const rootExceptions = /^(deniz|yalnız|henüz|boynuz|geniz|beniz)/i;
    fixed = fixed.split(/\s+/).map(word => {
      const cleanW = word.replace(/[.,!?'"()]/g, '');
      if (rootExceptions.test(cleanW)) return word;
      return word
        .replace(/s([iıuü])n[iıuü]z\b/gi, 's$1n')
        .replace(/n[iıuü]z(e|a|i|ı|u|ü|de|da|den|dan|le|la|in|ın|un|ün)?\b/gi, 'n$1');
    }).join(' ');

    // 6. ÖZNE-YÜKLEM UYUMU KORUMALI EMİR KİPİ DÜZELTİCİ:
    // Eğer cümlede 3. şahıs özne ("herkes", "hepsi", "kimse") varsa fiil 3. şahıs ("hissetsin", "baksın") olmalıdır;
    // "herkes hisset" gibi bozuk cümleleri %100 engeller!
    const hasThirdPersonSubject = /\b(herkes|hepsi|hiçbiri|kimse|dünya|kalbim|ruhum)\b/i.test(fixed);
    if (hasThirdPersonSubject) {
      fixed = fixed
        .replace(/\bherkes\s+(.*?\s+)?hisset$/i, 'herkes $1hissetsin')
        .replace(/\bherkes\s+(.*?\s+)?hissedin$/i, 'herkes $1hissetsin')
        .replace(/\bherkes\s+(.*?\s+)?bak(ın)?$/i, 'herkes $1baksın')
        .replace(/\bherkes\s+(.*?\s+)?dans\s+et(in)?$/i, 'herkes $1dans etsin')
        .replace(/\bherkes\s+(.*?\s+)?zıpla(yın)?$/i, 'herkes $1zıplasın')
        .replace(/\bherkes\s+(.*?\s+)?el\s+çırp(ın)?$/i, 'herkes $1el çırpsın');
    } else {
      // Özne 2. şahıs ("sen") ise resmi çoğul emirleri samimi tekil emire çevir
      fixed = fixed
        .replace(/([a-zçğıöşü]+m[ae])y[iı]n\b/gi, '$1')
        .replace(/([a-zçğıöşü]{2,}[aeıioöuü])y[iıuü]n\b/gi, '$1')
        .replace(/([a-zçğıöşü]+l[aeıi]şt[iı]r)[iı]n\b/gi, '$1')
        .replace(/\b([a-zçğıöşü]+)\s+edin\b/gi, '$1 et')
        .replace(/\b([a-zçğıöşü]+)\s+ettirin\b/gi, '$1 ettir')
        .replace(/\b([a-zçğıöşü]+)\s+yapın\b/gi, '$1 yap')
        .replace(/\b([a-zçğıöşü]+)\s+olun\b/gi, '$1 ol')
        .replace(/\b(hissedin|Hissedin)\b/g, 'hisset')
        .replace(/\b(bakın|Bakın)\b/g, 'bak')
        .replace(/\b(bırakın|Bırakın)\b/g, 'bırak');
    }

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

    const cleanedTr = cleanUniversalTurkishGrammar(data.tr, rawText);
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

  // ÇİFT AŞAMALI (EN || TR) VE JSON DESTEKLİ KIRILMAZ AI AYRIŞTIRICI
  function parseMasterAiOutput(rawOutput) {
    const resultMap = new Map();
    if (!rawOutput) return resultMap;

    const cleaned = rawOutput.replace(/^```[a-z]*\s*/im, '').replace(/```\s*$/im, '').trim();

    // 1. Format: "[0] English meaning || Doğal Türkçe Çeviri" veya "[0] Doğal Türkçe Çeviri"
    const lineRegex = /^\s*\[(\d+)\]\s*(.+)$/gm;
    let match;
    while ((match = lineRegex.exec(cleaned)) !== null) {
      const idx = parseInt(match[1], 10);
      let lineContent = match[2].trim();
      if (lineContent.includes('||')) {
        lineContent = lineContent.split('||').pop().trim();
      }
      lineContent = lineContent.replace(/^["']|["']$/g, '').trim();
      if (!isNaN(idx) && lineContent) {
        resultMap.set(idx, lineContent);
      }
    }

    if (resultMap.size > 0) return resultMap;

    // 2. Yedek JSON ayrıştırıcı
    try {
      const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed)) {
          parsed.forEach((item, i) => {
            if (typeof item === 'string') {
              resultMap.set(i, item.includes('||') ? item.split('||').pop().trim() : item);
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

  // 1. ANA MOTOR: GERÇEK İKİ AŞAMALI (KAYNAK DİL -> İNGİLİZCE ANLAM -> YOUTUBE KALİTESİNDE ŞİİRSEL TÜRKÇE) GEMINI 2.5 MOTORU
  async function translateWithMasterGeminiAI(batchLines, fullSongContextArray) {
    const songTitle = Spicetify?.Player?.data?.item?.name || 'Unknown Song';
    const artist = Spicetify?.Player?.data?.item?.artists?.[0]?.name || 'Unknown Artist';

    // Tüm şarkı sözlerini tam bağlam olarak gönder
    const fullSongText = fullSongContextArray.join('\n');
    const numberedBatch = batchLines.map((line, idx) => `[${idx}] ${line}`).join('\n');

    const prompt = `You are Turkey's top professional music translator and lyricist (like the best Turkish lyric translation channels on YouTube).
Song: "${songTitle}" by "${artist}"

FULL SONG LYRICS CONTEXT (Read the entire song first to grasp the story, emotion, pronouns, and how split lines connect):
${fullSongText}

TASK:
Translate each numbered lyric line below (whether Korean, Japanese, Thai, Chinese, English, Spanish, French, or mixed) into 100% natural, emotionally resonant, idiomatic Turkish.

MANDATORY TWO-STEP OUTPUT FORMAT FOR EVERY LINE:
[index] <Complete unified English meaning in context> || <Natural, poetic Turkish lyric translation>

Example of how you MUST resolve mixed-language & split lines using the two-step format:
Input: [0] 짜릿한 리듬에 모두 다 Feel it
Output: [0] Let everyone feel this electrifying rhythm || Herkes bu baş döndürücü ritmi iliklerine kadar hissetsin

STRICT RULES FOR THE TURKISH PART (right side of ||):
1. WRITE LIKE A REAL TURKISH LYRICIST: Never translate word-by-word! Adapt idioms, slang, and metaphors naturally so every Turkish line sounds like a real song lyric with zero awkwardness or broken grammar.
2. PERFECT SUBJECT-VERB AGREEMENT & "SEN" TONE:
   - When addressing the lover/listener ("you"), ALWAYS use informal singular "sen" (e.g., "bana bak", "gözlerin", "kendini bırak"). NEVER use formal/plural "siz" ("bakın", "gözleriniz", "bırakın")!
   - When the subject is 3rd person ("herkes", "hepsi", "kalbim", "gece"), conjugate the Turkish verb in 3rd person (e.g., "Herkes bu ritmi hissetsin" — NEVER write broken Turkish like "Herkes hisset"!).
3. CONNECT SPLIT LINES: In Korean/Japanese/Thai/Spanish/English lyrics, a single sentence is often split across two or three lines. Look at the previous and next lines in the Full Song Context so each line flows seamlessly into the next. Never end a line with a raw dictionary infinitive ("-mak / -mek").
4. ZERO UNTRANSLATED WORDS & FALSE FRIENDS: Translate 100% of the line into pure Turkish (do not leave English/foreign words inside the Turkish translation). In romance/pop songs, "sign / 사인 / サイン" means "işaret" or "aramızdaki bağ" (NEVER "tabela").
5. NO TRAILING PUNCTUATION: Do not put periods (".") or question marks ("?") at the end of lines.

Return ONLY the numbered lines in the exact format "[index] English meaning || Turkish lyric":
${numberedBatch}`;

    // En zeki modeller en başta! (gemini-2.5-flash birinci sırada)
    const models = [
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
      'gemini-2.0-flash',
      'gemma-3-27b-it'
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
            generationConfig: { temperature: 0.35 }
          })
        });

        if (res.status === 429 || res.status === 404 || res.status === 400) {
          modelCooldowns.set(modelId, Date.now() + 35000);
          throw new Error(`HTTP ${res.status} on ${modelId}`);
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const json = await res.json();
        const parts = json?.candidates?.[0]?.content?.parts || [];
        const rawOutput = parts.filter(p => !p.thought && p.text).map(p => p.text).join('\n') || parts.map(p => p.text || '').join('\n');

        const parsedMap = parseMasterAiOutput(rawOutput);
        if (parsedMap.size === 0) throw new Error('Empty AI parse result');

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
                tr: cleanUniversalTurkishGrammar(aiTr, rawText),
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

  // 2. YEDEK İKİ AŞAMALI (KAYNAK DİL -> İNGİLİZCE -> TÜRKÇE) BÜTÜNSEL MOTOR (Sadece API anahtarı yoksa devreye girer)
  async function translateWithTwoStepFallback(targetLines, isTempForAi = false) {
    const validItems = [];
    targetLines.forEach((raw, idx) => {
      if (isPureRhythmOrVocal(raw)) {
        cache.set(raw, { tr: '', romaja: '', temp: false });
      } else {
        const cleaned = raw.replace(/\((Tip tap\vert{}Yo\vert{}Whoo\vert{}Hey\vert{}Yeah)[^)]*\)/gi, '').trim();
        validItems.push({ raw, prepared: cleaned || raw, idx });
      }
    });

    if (validItems.length === 0) return;

    // Aşama 1: Karma ve yabancı dilleri önce bütün olarak İngilizceye çevir (senin istediğin 2 aşamalı köprü!)
    let englishLines = validItems.map(i => i.prepared);
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

    // Aşama 2: Oluşan İngilizce kıtayı bütün olarak Türkçeye çevir
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
        const lang = detectScriptLang(item.raw);

        if (!tr) {
          try {
            const fbUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=tr&dt=t&q=${encodeURIComponent(englishLines[i])}`;
            const fbRes = await fetch(fbUrl);
            const fbJson = await fbRes.json();
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
          tr: cleanUniversalTurkishGrammar(tr, item.raw),
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
      // Şarkının görünür tüm satırlarını (35 satıra kadar tek pakette) doğrudan AI'a gönder
      const currentBatch = missingOrTempLines.slice(0, 35);

      if (geminiApiKey && geminiApiKey.trim().length > 10) {
        try {
          await translateWithMasterGeminiAI(currentBatch, fullContextArray);
        } catch (aiErr) {
          console.warn('Spicy TR V15: AI geçici yoğunlukta, 2.5sn sonra AI tekrar denenecek:', aiErr);
          const uncachedOnly = currentBatch.filter(t => !cache.has(t));
          if (uncachedOnly.length > 0) {
            await translateWithTwoStepFallback(uncachedOnly, true);
          }
          clearTimeout(retryTimer);
          retryTimer = setTimeout(processVisibleLyrics, 2500);
        }
      } else {
        await translateWithTwoStepFallback(currentBatch, false);
      }
    } catch (e) {
      console.error('Spicy TR V15 Hata:', e);
    } finally {
      isProcessing = false;
      const remaining = Array.from(document.querySelectorAll('#SpicyLyricsPage .line:not(.musical-line)'))
        .map(el => getCleanText(el))
        .filter(t => t && t !== '•••' && !cache.has(t));
      if (remaining.length > 0) {
        clearTimeout(scanTimer);
        scanTimer = setTimeout(processVisibleLyrics, 450);
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
        ? 'Sol Tık: Çeviriyi Aç/Kapat | Sağ Tık: AI Anahtarını Yönet ve Önbelleği Sıfırla (V15.0 Master AI Aktif)'
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
        '🌟 Spicy Lyrics AI Çeviri & Romaja V15.0 (MASTER EDITION) 🌟\n\n' +
        '• Ücretsiz Gemini API Anahtarınızı aşağıya yapıştırın (aistudio.google.com/apikey).\n' +
        '• Tamam\'a bastığınızda tüm eski önbellek temizlenir ve şarkı sıfırdan çevrilir:',
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
      scanTimer = setTimeout(processVisibleLyrics, 500);
    }
  }

  if (window._spicyTrObserver) window._spicyTrObserver.disconnect();
  window._spicyTrObserver = new MutationObserver(() => scanLines());
  window._spicyTrObserver.observe(document.body, { childList: true, subtree: true });
  scanLines();
})();
