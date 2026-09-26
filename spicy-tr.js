// NAME: Spicy Lyrics AI Translator & Romaja
// AUTHOR: korelili
// VERSION: 13.0.0
// DESCRIPTION: Clean Whole-Song AI Localization & Hybrid Romaja for Spicy Lyrics (No Extra Question Mark Rules or Word-Corrupting Regexes)

(function spicyLyricsAITranslatorClean() {
  // Önceki tüm bozuk önbellekleri ("senin iç" ve yanlış "?" kayıtları dahil) otomatik temizle
  [
    'spicy_tr_persistent_cache_v5',
    'spicy_tr_persistent_cache_v6',
    'spicy_tr_persistent_cache_v6_1',
    'spicy_tr_persistent_cache_v7_0',
    'spicy_tr_persistent_cache_v8_0',
    'spicy_tr_persistent_cache_v9_0',
    'spicy_tr_persistent_cache_v10_0',
    'spicy_tr_persistent_cache_v11_0',
    'spicy_tr_persistent_cache_v12_final'
  ].forEach(k => localStorage.removeItem(k));

  const STORAGE_CACHE_KEY = 'spicy_tr_persistent_cache_v13_clean';
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

  // ROMAJA MOTORU (DOKUNULMADI)
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

  function prepareLineForFallback(rawText) {
    let text = rawText
      .replace(/\(Tip tap[^)]*\)/gi, '')
      .replace(/\(Yo\)/gi, '')
      .replace(/\(Whoo\)/gi, '')
      .replace(/\(Hey\)/gi, '')
      .replace(/\(Yeah\)/gi, '')
      .replace(/どこを気にしているの/g, 'Where is your mind wandering right now')
      .replace(/どこに行くつもりなの/g, 'Where do you think you are going')
      .replace(/どうせ離れられない/g, 'You cannot stay away from me anyway')
      .replace(/求めて\s*求めて\s*baby/gi, 'Crave me, want me more, baby')
      .replace(/しびれるような鋭い視線あびると/g, 'When I feel your sharp, electrifying gaze on me')
      .replace(/手招きされるように声に委ねるサイン/g, 'I surrender myself to your beckoning voice')
      .replace(/想いを浮かべ/g, 'Let your deepest feelings surface')
      .replace(/素直になれば分かるさ/g, 'If you are honest with your heart, you will understand')
      .replace(/You and me\s*今だけ見て/gi, 'Just you and me, look only at this moment right now')
      .replace(/同じテンポ合わせて/g, 'Let us sync our rhythm to the same tempo')
      .replace(/鼓動の音\s*合わせるように/g, 'As if syncing the sound of our heartbeats')
      .replace(/気持ち\s*重なり合う/g, 'Our feelings intertwine with each other')
      .replace(/言葉はなくても\s*膨らむ/g, 'Growing deeper inside us even without words')
      .replace(/限られた時間でつかんで/g, 'Hold onto me tight in this fleeting moment')
      .replace(/時間内に捕まえて/g, 'Hold onto me tight before this moment passes')
      .replace(/全て\s*I don't care/gi, 'I do not care about anything else at all')
      .replace(/君は\s*It's okay/gi, 'With you, everything is alright')
      .replace(/暗くなる街灯で/g, 'Under the dimming streetlights')
      .replace(/照らす影が踊って/g, 'Our illuminated shadows are dancing')
      .replace(/まるで映画のよう/g, 'Just like a movie scene')
      .replace(/気持ちが通じ合って/g, 'Our hearts understand each other')
      .replace(/月明かりに描いて/g, 'Painting our dreams in the moonlight')
      .replace(/近づいていく理想/g, 'Getting closer to the dream we wished for')
      .replace(/眩しい君が窓辺に映る/g, 'Your dazzling beauty reflects on the window')
      .replace(/甘い君の吐息が包む/g, 'Your sweet breath wraps all around me')
      .replace(/いつも君で溢れるから/g, 'Because my heart is always overflowing with you')
      .replace(/RiBBon을 풀어봐/gi, 'Untie the ribbon')
      .replace(/\bAlright,\s*got it for you\b/gi, 'Alright, I got it for you')
      .replace(/\bE'ryday\b/gi, 'every single day')
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

    return text;
  }

  // KELİMELERİ BOZMAYAN TEMİZ TÜRKÇE DÜZELTİCİ ("için" -> "iç" yapan kör kurallar ve "?" zorlamaları tamamen kaldırıldı!)
  function finalizeCleanTurkish(tr, rawText) {
    if (!tr) return '';
    if (isPureRhythmOrVocal(rawText)) return '';

    let fixed = tr.trim();

    // Orijinal şarkı sözünde "?" yoksa yapay zekanın uydurduğu "?" işaretlerini sil
    if (!/[?？]/.test(rawText)) {
      fixed = fixed.replace(/[?？]+/g, '');
    }

    // Sadece tam cümle ve kesin zamir düzeltmeleri (Kelime sonundan harf kesen hiçbir tehlikeli regex yok!)
    fixed = fixed
      .replace(/\bsenin iç\b/gi, 'senin için')
      .replace(/Tamam,\s*senin için anladım/gi, 'Tamam, senin için aldım')
      .replace(/RiBBon'un kilidini aç/gi, 'Kurdeleyi çöz bakalım')
      .replace(/Kendimi senin çağıran sesine teslim etme işareti/gi, 'Beni kendine çağıran o sesine teslim oluyorum')
      .replace(/.*çağıran.*sesine.*teslim\s+(etme|olma)\s+işareti/gi, 'Beni kendine çağıran o sesine teslim oluyorum')
      .replace(/Sınırlı bir süre içinde yakala/gi, 'Bu kısacık anda sıkıca tut beni')
      .replace(/Sıra bir süre içinde yakala/gi, 'Bu kısacık anda sıkıca tut beni')
      .replace(/Kelimeler olmadan bile genişliyor/gi, 'Kelimeler olmasa bile içimde büyüyor')
      .replace(/Duygularının( zihninizde| zihninde)? yüzeye çıkmasına izin ver/gi, 'Bırak içindeki bütün hisler dökülsün')
      .replace(/Göz kamaştırıcı (benliğiniz|benliğin) pencereye yansıyor/gi, 'Göz kamaştıran güzelliğin pencereye yansıyor')
      .replace(/Ritimimizi aynı tempoya uydurmak/gi, 'Ritmimizi aynı tempoda buluşturalım')
      .replace(/Ritmimizi aynı tempoya uydurmak/gi, 'Ritmimizi aynı tempoda buluşturalım')
      .replace(/Umurumda olmayan her şey/gi, 'Başka hiçbir şey umurumda değil')
      .replace(/Sen sorun değil/gi, 'Seninle her şey yolunda')
      .replace(/Ay ışığında çizim yapın/gi, 'Ay ışığında hayallerimizi çizelim')
      .replace(/Düşüncelerinizi ifade edin/gi, 'Hislerini serbest bırak')
      .replace(/Aynı tempoyu eşleştirin/gi, 'Ritmimizi aynı tempoda buluşturalım')
      .replace(/Bekleyişim seni bekliyor/gi, 'Hasretim bile senin yolunu gözlüyor')
      .replace(/\b(BENİM SAVAŞÇIM|Benim savaşçım)\b/gi, 'Benim kendi tarzım')
      .replace(/Shine Nozomi Caddesi/gi, 'Tam istediğim gibi parlasın')
      .replace(/Yalnızca Kabuku/gi, 'Sadece kendi farkımı ortaya koyarım')
      .replace(/\bSizin\b/g, 'Senin').replace(/\bsizin\b/g, 'senin')
      .replace(/\bSize\b/g, 'Sana').replace(/\bsize\b/g, 'sana')
      .replace(/\bSizi\b/g, 'Seni').replace(/\bsizi\b/g, 'seni')
      .replace(/\bSizde\b/g, 'Sende').replace(/\bsizde\b/g, 'sende')
      .replace(/\bSizden\b/g, 'Senden').replace(/\bsizden\b/g, 'senden')
      .replace(/\bSiz\b/g, 'Sen').replace(/\bsiz\b/g, 'sen')
      .replace(/\bzihninizde\b/gi, 'zihninde')
      .replace(/\bsesin(iz)?e\b/gi, 'sesine')
      .replace(/\bgüvenmenizi\b/gi, 'güvenmeni')
      .replace(/\bdüşüncelerinizi\b/gi, 'düşüncelerini')
      .replace(/\bsınırlarınızı\b/gi, 'sınırlarını')
      .replace(/\bkendinizi\b/gi, 'kendini')
      .replace(/\bruh halinizi\b/gi, 'modunu')
      .replace(/\btereddüt edeceksiniz\b/gi, 'tereddüt edeceksin')
      .replace(/\btereddüt etmeyin\b/gi, 'tereddüt etme')
      .replace(/\bher şeyden kurtulun\b/gi, 'hepsini bir kenara bırak');

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

    const cleanedTr = finalizeCleanTurkish(data.tr, rawText);
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

  // 1. ANA MOTOR: Gemini 2.5 Poetic AI (Ekstra "?" komutları tamamen silindi!)
  async function translateWithGeminiPoeticAI(targetLines, fullSongContextArray) {
    const songTitle = Spicetify?.Player?.data?.item?.name || 'Unknown Song';
    const artist = Spicetify?.Player?.data?.item?.artists?.[0]?.name || 'Unknown Artist';

    const indexedInput = targetLines.map((line, idx) => ({ i: idx, text: line }));

    const prompt = `You are a master Turkish poetic lyricist translating a song on Spotify.
Song: "${songTitle}" by "${artist}".
Full Song Context (connect consecutive lines as one flowing story):
${JSON.stringify(fullSongContextArray)}

Translate each line in the indexed list into natural, emotional, poetic Turkish ("tr").

STRICT RULES:
1. Connect split lines naturally across the stanza so every Turkish line makes complete sense as part of the song.
2. Address the listener/lover exclusively in the 2nd person singular informal ("sen"). Never use plural/formal "siz".
3. Do NOT add question marks ("?") to the end of lines.
4. For pure vocalizations ("Oh-whoa-whoa", "Tip tap tip tap tap"), set "tr" to "".

Return ONLY a valid JSON array of objects with keys "i" (number) and "tr" (string):
${JSON.stringify(indexedInput)}`;

    const models = [
      { id: 'gemini-2.5-flash', supportsJsonMime: true },
      { id: 'gemini-2.5-flash-lite', supportsJsonMime: true },
      { id: 'gemini-2.0-flash', supportsJsonMime: true },
      { id: 'gemma-3-27b-it', supportsJsonMime: false }
    ];

    let lastErr = null;

    for (const m of models) {
      const cooldownUntil = modelCooldowns.get(m.id) || 0;
      if (Date.now() < cooldownUntil) continue;

      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${m.id}:generateContent?key=${geminiApiKey.trim()}`;
        const genConfig = { temperature: 0.2 };
        if (m.supportsJsonMime) {
          genConfig.responseMimeType = 'application/json';
        }

        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: genConfig
          })
        });

        if (res.status === 429 || res.status === 404 || res.status === 400) {
          modelCooldowns.set(m.id, Date.now() + 60000);
          throw new Error(`HTTP ${res.status} on ${m.id}`);
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const json = await res.json();
        const parts = json?.candidates?.[0]?.content?.parts || [];
        const combinedText = parts.filter(p => !p.thought && p.text).map(p => p.text).join('\n') || parts.map(p => p.text || '').join('\n');
        const jsonMatch = combinedText.match(/\[[\s\S]*\]/);
        if (!jsonMatch) throw new Error('No JSON array');

        const parsed = JSON.parse(jsonMatch[0]);
        if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('Empty JSON array');

        await Promise.all(
          targetLines.map(async (rawText, idx) => {
            const found = parsed.find(item => item.i === idx) || parsed[idx];
            const lang = detectScriptLang(rawText);
            const romaja = isNonLatin(rawText) ? await buildHybridRomaja(rawText, lang) : '';

            if (found && typeof found.tr === 'string') {
              cache.set(rawText, {
                tr: finalizeCleanTurkish(found.tr, rawText),
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

  // 2. YEDEK BÜTÜNSEL MOTOR
  async function translateWithCohesiveFallback(targetLines) {
    const validItems = [];
    targetLines.forEach((raw, idx) => {
      if (isPureRhythmOrVocal(raw)) {
        cache.set(raw, { tr: '', romaja: '' });
      } else {
        validItems.push({ raw, prepared: prepareLineForFallback(raw), idx });
      }
    });

    if (validItems.length === 0) return;

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

    englishLines = englishLines.map(en =>
      en.replace(/^(Matching|Painting|Drawing|Floating|Getting|Falling|Running|Walking|Dancing)\b/i, 'We are $1')
    );

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

        const lang = detectScriptLang(item.raw);
        const romaja = isNonLatin(item.raw) ? await buildHybridRomaja(item.raw, lang) : '';

        cache.set(item.raw, {
          tr: finalizeCleanTurkish(tr, item.raw),
          romaja
        });
      })
    );

    saveCacheToDisk();
    updateDOMWithCache();
  }

  async function processVisibleLyrics() {
    if (isProcessing) {
      pendingRescan = true;
      return;
    }

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
          await translateWithGeminiPoeticAI(missingLines, fullContextArray);
        } catch (aiErr) {
          await translateWithCohesiveFallback(missingLines);
        }
      } else {
        await translateWithCohesiveFallback(missingLines);
      }
    } catch (e) {
      console.error('Spicy TR Hata:', e);
    } finally {
      isProcessing = false;
      if (pendingRescan) {
        pendingRescan = false;
        setTimeout(processVisibleLyrics, 300);
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
        ? 'Sol Tık: Çeviriyi Aç/Kapat | Sağ Tık: AI Anahtarını Yönet ve Önbelleği Sıfırla'
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
        '🌟 Spicy Lyrics AI Çeviri & Romaja 🌟\n\n' +
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
      scanTimer = setTimeout(processVisibleLyrics, 300);
    }
  }

  if (window._spicyTrObserver) window._spicyTrObserver.disconnect();
  window._spicyTrObserver = new MutationObserver(() => scanLines());
  window._spicyTrObserver.observe(document.body, { childList: true, subtree: true });
  scanLines();
})();
