// NAME: Spicy Lyrics AI Translator & Romaja
// AUTHOR: korelili
// VERSION: 17.0.0 (BETTER-LYRICS EDITION)
// DESCRIPTION: LRClib Whole-Song Context + Dual Cloud AI (Gemini/Gemma + OpenAI Fallback) + Pure Hybrid Romaja

(function spicyLyricsBetterTranslator() {
  // Eski tüm bozuk önbellekleri temizle
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
    'spicy_tr_clean_v5_cache'
  ].forEach(k => localStorage.removeItem(k));

  const STORAGE_CACHE_KEY = 'spicy_tr_better_lyrics_v17';
  let savedCache = {};
  try {
    savedCache = JSON.parse(localStorage.getItem(STORAGE_CACHE_KEY) || '{}');
  } catch (e) {
    savedCache = {};
  }

  const cache = new Map(Object.entries(savedCache));
  const deadModels = new Map();
  let currentSongKey = '';
  let lrclibFullLyrics = '';
  let lrclibFetchedForSong = '';

  let isEnabled = localStorage.getItem('spicy_tr_enabled') !== 'false';
  let geminiApiKey = localStorage.getItem('spicy_tr_gemini_key') || '';
  let isProcessing = false;
  let pendingFollowUp = false;
  let scanTimer = null;
  let lastUsedEngine = 'Hazır';

  function saveCache() {
    try {
      const entries = Array.from(cache.entries())
        .filter(([, val]) => val && val.tr && !val.temp)
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

  // ROMAJA MOTORU (DOKUNULMADI - KUSURSUZ ÇALIŞIR)
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
    return resolvedParts
      .filter(Boolean)
      .join(' ')
      .replace(/([a-zāēīōū])([A-Z])/g, '$1 $2')
      .replace(/([,!?])([A-Za-z0-9])/g, '$1 $2')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // BETTER LYRICS GİBİ LRCLIB ÜZERİNDEN TAM ŞARKI SÖZÜ BAĞLAMI ÇEKİCİ
  async function fetchLRClibContext(songTitle, artist) {
    const key = `${artist} - ${songTitle}`;
    if (lrclibFetchedForSong === key) return lrclibFullLyrics;
    lrclibFetchedForSong = key;
    lrclibFullLyrics = '';

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1800);
      const url = `https://lrclib.net/api/get?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(songTitle)}`;
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      if (res.ok) {
        const data = await res.json();
        if (data && data.plainLyrics) {
          lrclibFullLyrics = data.plainLyrics.slice(0, 2500);
        }
      }
    } catch (e) {}
    return lrclibFullLyrics;
  }

  // EVRENSEL TÜRKÇE DİLBİLGİSİ VE "SEN" UYUMU KORUYUCU (Hiçbir kelimeyi bozmaz, "siz" -> "sen" yapar)
  function polishTurkishGrammar(tr, rawText) {
    if (!tr) return '';
    let fixed = tr.trim();
    if (fixed.includes('||')) fixed = fixed.split('||').pop().trim();

    // Satır başındaki [0] gibi numaraları ve satır sonu nokta/soru işaretlerini temizle
    fixed = fixed.replace(/^\s*(?:\[\d+\]|\d+[.:)])\s*/, '').replace(/[?？.]+$/g, '').trim();

    // Zamirleri samimi tekil "Sen" diline çevir
    fixed = fixed
      .replace(/\bSizin\b/g, 'Senin').replace(/\bsizin\b/g, 'senin')
      .replace(/\bSize\b/g, 'Sana').replace(/\bsize\b/g, 'sana')
      .replace(/\bSizi\b/g, 'Seni').replace(/\bsizi\b/g, 'seni')
      .replace(/\bSizde\b/g, 'Sende').replace(/\bsizde\b/g, 'sende')
      .replace(/\bSizden\b/g, 'Senden').replace(/\bsizden\b/g, 'senden')
      .replace(/\bSiz\b/g, 'Sen').replace(/\bsiz\b/g, 'sen');

    // Evrensel "-niz/-nız/-nuz/-nüz" -> "-n" dönüşümü ("hissettiğinizde gözleriniz" -> "hissettiğinde gözlerin")
    const rootExceptions = /^(deniz|yalnız|henüz|boynuz|geniz|beniz)/i;
    fixed = fixed.split(/\s+/).map(word => {
      const cleanW = word.replace(/[.,!?'"()]/g, '');
      if (rootExceptions.test(cleanW)) return word;
      return word
        .replace(/s([iıuü])n[iıuü]z\b/gi, 's$1n')
        .replace(/n[iıuü]z(e|a|i|ı|u|ü|de|da|den|dan|le|la|in|ın|un|ün)?\b/gi, 'n$1');
    }).join(' ');

    // Özne-yüklem uyumlu emir düzeltmesi
    if (/\b(herkes|hepsi|kimse)\b/i.test(fixed)) {
      fixed = fixed.replace(/\bherkes\s+(.*?\s+)?hisset(sin|in)?$/i, 'herkes $1hissetsin');
    } else {
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
    let box = lineEl.querySelector('.spicy-tr-box');
    if (box) box.remove();

    box = document.createElement('div');
    box.className = 'spicy-tr-box';

    if (data.romaja && isNonLatin(rawText)) {
      const romEl = document.createElement('div');
      romEl.className = 'spicy-tr-romaja';
      romEl.textContent = data.romaja;
      box.appendChild(romEl);
    }

    const cleanedTr = polishTurkishGrammar(data.tr, rawText);
    if (cleanedTr && cleanedTr.toLowerCase() !== rawText.toLowerCase()) {
      const trEl = document.createElement('div');
      trEl.className = 'spicy-tr-turkish';
      trEl.textContent = cleanedTr;
      box.appendChild(trEl);
    }

    if (box.children.length === 0) {
      box.style.setProperty('display', 'none', 'important');
    }
    lineEl.appendChild(box);
    triggerRecalc();
  }

  function updateDOMWithCache() {
    document.querySelectorAll('#SpicyLyricsPage .line:not(.musical-line)').forEach(el => {
      const text = getCleanText(el);
      if (cache.has(text)) {
        renderSubtitles(el, cache.get(text), text);
      }
    });
    const btn = document.getElementById('spicy-tr-toggle-btn');
    if (btn) {
      btn.title = `Aktif Çeviri Motoru: ${lastUsedEngine} | Sol Tık: Aç/Kapat | Sağ Tık: API Anahtarı & Önbellek Sıfırla`;
    }
  }

  // ESNEK AI ÇIKTI AYRIŞTIRICI ("[0] ...", "0. ...", JSON dizisi hepsini okur, asla çökmez!)
  function parseAiOutput(rawOutput) {
    const resultMap = new Map();
    if (!rawOutput) return resultMap;

    const cleaned = rawOutput.replace(/^```[a-z]*\s*/im, '').replace(/```\s*$/im, '').trim();

    const lineRegex = /^\s*(?:\*\*)?(?:\[(\d+)\]|(\d+)[.:)])(?:\*\*)?\s*[-–—:]?\s*(.+)$/gm;
    let match;
    while ((match = lineRegex.exec(cleaned)) !== null) {
      const idx = parseInt(match[1] !== undefined ? match[1] : match[2], 10);
      let text = match[3].trim();
      if (text.includes('||')) text = text.split('||').pop().trim();
      text = text.replace(/^["']|["']$/g, '').trim();
      if (!isNaN(idx) && text) {
        resultMap.set(idx, text);
      }
    }

    if (resultMap.size > 0) return resultMap;

    try {
      const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed)) {
          parsed.forEach((item, i) => {
            const tr = typeof item === 'string' ? item : (item?.tr || '');
            const idx = typeof item?.i === 'number' ? item.i : i;
            if (tr) resultMap.set(idx, tr);
          });
        }
      }
    } catch (e) {}

    return resultMap;
  }

  function buildMasterPrompt(linesToTranslate, allDomLines, songTitle, artist, lrclibContext) {
    const numberedLines = linesToTranslate.map((l, i) => `[${i}] ${l}`).join('\n');
    const fullContext = lrclibContext || allDomLines.join('\n');

    return `You are Turkey's #1 poetic music translator (like the best Turkish lyric translation channels on YouTube and Better Lyrics).
Song: "${songTitle}" by "${artist}"

FULL SONG CONTEXT (Read the whole song first so split sentences across consecutive lines connect seamlessly):
${fullContext}

Translate EVERY numbered lyric line below into 100% natural, emotional, idiomatic, uncensored Turkish song lyrics.

CRITICAL RULES:
1. MEANING & CONTEXT OVER LITERAL WORDS:
   - Mentally translate each line (including mixed English/Korean/Japanese/Thai/Chinese/Spanish) into complete idiomatic English in the context of the whole song first, then write natural Turkish.
   - Connect split sentences across lines! For example, in Korean "우아하게 날 부른 손짓에 날 맡길 때 우리 사인" followed by "한없이 깊어져 깊어져", "우리 사인" is a contraction of "우리 사이는" (aramız / aramızdaki bağ), NOT "işaretimiz/tabelamız"! Translate it naturally as "Beni zarifçe çağıran o el hareketine kendimi bıraktığımda, aramızdaki bağ".
   - Understand slang & idioms: "옆구리 찔러서 절 받기" = "zorla ilgi beklemek", "바람을 피우다" = "aldatmak", "ma darling" = "sevgilim", "Imma" = "yapacağım", "9 to 6, boo" = "sabah 9 akşam 6 çalışan bir kız, bebeğim", "Feel like a fool" = "Kendimi aptal gibi hissediyorum".
2. 100% SINGULAR INFORMAL ("SEN") TONE: Always address the lover/listener as "sen" (e.g. "hissettiğimde gözlerin", "bana bak, etrafına aldırma"). NEVER use plural/formal "siz" ("hissettiğinizde", "gözleriniz", "bakın")!
3. UNCENSORED & NATURAL: Do not censor profanity or +18 themes. Do not leave untranslated foreign words. Do not put periods (".") or question marks ("?") at the end of lines.

Return ONLY the numbered Turkish translations in this exact format (one line per index):
[0] Turkish translation
[1] Turkish translation

Lines to translate:
${numberedLines}`;
  }

  // 1. KATMAN: Kullanıcının Gemini/Gemma API Anahtarı (Günlük 14.400 Kotalı Gemma-3-27B + Gemini 2.5 Havuzu)
  async function tryGeminiModels(prompt, linesToTranslate) {
    if (!geminiApiKey || geminiApiKey.trim().length <= 10) {
      throw new Error('No Gemini API key');
    }

    // gemma-3-27b-it günde 14.400 ücretsiz isteğe izin verir (gemini-2.5-flash'ın 20'lik kotası dolsa bile kesintisiz çalışır!)
    const models = [
      'gemma-3-27b-it',
      'gemini-2.5-flash-lite',
      'gemini-2.5-flash',
      'gemma-3-12b-it',
      'gemini-1.5-flash'
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

        if (res.status === 429 || res.status === 404 || res.status === 400) {
          deadModels.set(model, Date.now() + 120000);
          throw new Error(`HTTP ${res.status} on ${model}`);
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const json = await res.json();
        const parts = json?.candidates?.[0]?.content?.parts || [];
        const rawOutput = parts.filter(p => !p.thought && p.text).map(p => p.text).join('\n') || parts.map(p => p.text || '').join('\n');

        const parsedMap = parseAiOutput(rawOutput);
        if (parsedMap.size < Math.min(2, linesToTranslate.length)) {
          throw new Error('Incomplete AI output');
        }

        lastUsedEngine = `Gemini AI (${model})`;
        return parsedMap;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  }

  // 2. KATMAN: Anahtarsız & Kotasız Ücretsiz Bulut Yapay Zeka Yedeği (Gemini kotan dolsa bile ASLA aptal Google Translate'e düşmez!)
  async function tryFreeCloudAI(prompt, linesToTranslate) {
    const res = await fetch('https://text.pollinations.ai/openai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openai',
        messages: [
          { role: 'system', content: 'You are a professional Turkish poetic lyric translator. Output only [index] Turkish translation lines.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.3
      })
    });

    if (!res.ok) throw new Error(`Cloud AI HTTP ${res.status}`);
    const json = await res.json();
    const rawOutput = json?.choices?.[0]?.message?.content || '';
    const parsedMap = parseAiOutput(rawOutput);

    if (parsedMap.size === 0) throw new Error('Empty Cloud AI output');
    lastUsedEngine = 'Cloud AI (GPT-4o-mini)';
    return parsedMap;
  }

  // 3. KATMAN: İki Aşamalı (Kaynak -> EN -> TR) Acil Durum Yedeği (Sadece tüm yapay zekalar çevrimdışıysa)
  async function translateEmergencyFallback(linesToTranslate, isTemp = false) {
    lastUsedEngine = 'GTX Fallback';
    const cleanedLines = linesToTranslate.map(raw =>
      raw
        .replace(/우리 사인/g, '우리 사이는')
        .replace(/\bImma\b/gi, 'I am going to')
        .replace(/\btryna\b/gi, 'trying to')
        .replace(/\berrday\b/gi, 'every day')
        .replace(/\bma\s+(darling|baby|babe|love|girl|boy)\b/gi, 'my $1')
    );

    let trLines = [];
    try {
      const joined = cleanedLines.map(l => l.replace(/[.!?]+$/, '') + '.').join('\n');
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=tr&dt=t&dj=1&q=${encodeURIComponent(joined)}`;
      const res = await fetch(url);
      const json = await res.json();
      const full = (json.sentences || []).map(s => s.trans || '').join('');
      const split = full.split('\n').map(s => s.replace(/\.$/, '').trim()).filter(Boolean);
      if (split.length === linesToTranslate.length) trLines = split;
    } catch (e) {}

    await Promise.all(
      linesToTranslate.map(async (rawText, idx) => {
        let tr = trLines[idx] || '';
        if (!tr) {
          try {
            const sUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=tr&dt=t&q=${encodeURIComponent(cleanedLines[idx])}`;
            const sRes = await fetch(sUrl);
            const sJson = await sRes.json();
            if (Array.isArray(sJson[0])) {
              sJson[0].forEach(seg => { if (seg[0]) tr += seg[0]; });
            }
          } catch (e) {}
        }
        const romaja = isNonLatin(rawText) ? await buildHybridRomaja(rawText) : '';
        const polished = polishTurkishGrammar(tr, rawText);
        if (polished) {
          cache.set(rawText, { tr: polished, romaja, temp: isTemp });
        }
      })
    );
    if (!isTemp) saveCache();
    updateDOMWithCache();
  }

  async function processWholeSongTranslation() {
    if (isProcessing) {
      pendingFollowUp = true;
      return;
    }

    const songTitle = Spicetify?.Player?.data?.item?.name || 'Unknown Song';
    const artist = Spicetify?.Player?.data?.item?.artists?.[0]?.name || 'Unknown Artist';
    const songKey = `${artist} - ${songTitle}`;

    const lineEls = Array.from(document.querySelectorAll('#SpicyLyricsPage .line:not(.musical-line)'));
    const allDomLines = [];
    const missingLines = [];

    lineEls.forEach(lineEl => {
      const text = getCleanText(lineEl);
      if (!text || text === '•••') return;

      if (!allDomLines.includes(text)) allDomLines.push(text);

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
      // Better Lyrics gibi önce LRClib üzerinden tam şarkı sözünü çek (bağlamın hiç kopmaması için)
      const lrclibContext = await fetchLRClibContext(songTitle, artist);
      // Şarkıyı tek seferde (35 satırlık blok halinde) yapay zekaya gönder (kota dostu!)
      const batch = missingLines.slice(0, 35);
      const prompt = buildMasterPrompt(batch, allDomLines, songTitle, artist, lrclibContext);

      let aiMap = null;
      try {
        aiMap = await tryGeminiModels(prompt, batch);
      } catch (geminiErr) {
        console.warn('Spicy TR: Gemini API kotası dolu veya meşgul, Ücretsiz Bulut AI devreye giriyor...', geminiErr);
        try {
          aiMap = await tryFreeCloudAI(prompt, batch);
        } catch (cloudErr) {
          console.warn('Spicy TR: Bulut AI meşgul, Yedek Motor devreye giriyor...', cloudErr);
        }
      }

      if (aiMap && aiMap.size > 0) {
        const missed = [];
        await Promise.all(
          batch.map(async (rawText, idx) => {
            const tr = aiMap.get(idx);
            const romaja = isNonLatin(rawText) ? await buildHybridRomaja(rawText) : '';
            if (tr && tr.trim()) {
              cache.set(rawText, {
                tr: polishTurkishGrammar(tr, rawText),
                romaja,
                temp: false
              });
            } else {
              missed.push(rawText);
            }
          })
        );
        if (missed.length > 0) {
          await translateEmergencyFallback(missed, false);
        }
        saveCache();
        updateDOMWithCache();
      } else {
        await translateEmergencyFallback(batch, false);
      }
    } catch (e) {
      console.error('Spicy TR Hata:', e);
    } finally {
      isProcessing = false;
      if (pendingFollowUp) {
        pendingFollowUp = false;
        clearTimeout(scanTimer);
        scanTimer = setTimeout(processWholeSongTranslation, 500);
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
      btn.title = `Aktif Çeviri Motoru: ${lastUsedEngine} | Sol Tık: Aç/Kapat | Sağ Tık: API Anahtarı & Önbellek Sıfırla`;
    };
    updateBtnVisual();

    btn.onclick = () => {
      isEnabled = !isEnabled;
      localStorage.setItem('spicy_tr_enabled', isEnabled);
      updateBtnVisual();
      document.querySelectorAll('#SpicyLyricsPage .spicy-tr-box').forEach(b => {
        if (b.children.length > 0) {
          b.style.setProperty('display', isEnabled ? 'flex' : 'none', 'important');
        }
      });
      triggerRecalc();
    };

    btn.oncontextmenu = (e) => {
      e.preventDefault();
      const input = prompt(
        '🔥 Spicy Lyrics AI Çeviri & Romaja (LRClib + Çift AI Motorlu) 🔥\n\n' +
        '• Ücretsiz Gemini API Anahtarınızı aşağıya yapıştırın.\n' +
        '• Tamam\'a bastığınızda önbellek temizlenir ve şarkı yeniden çevrilir:',
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
        processWholeSongTranslation();
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
      scanTimer = setTimeout(processWholeSongTranslation, 500);
    }
  }

  if (window._spicyTrObserver) window._spicyTrObserver.disconnect();
  window._spicyTrObserver = new MutationObserver(() => scanLines());
  window._spicyTrObserver.observe(document.body, { childList: true, subtree: true });
  scanLines();
})();
