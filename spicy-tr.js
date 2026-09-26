// NAME: Spicy Lyrics AI Translator & Romaja
// AUTHOR: korelili
// VERSION: 12.0.0 (FINAL)
// DESCRIPTION: Gemini 2.5 Poetic Whole-Song Localization, Strict Question/Punctuation Engine, 100% "Sen" Harmony & Pure Hybrid Romaja

(function spicyLyricsAITranslatorV12Final() {
  // Önceki tüm sürüm önbelleklerini kesin olarak temizle
  [
    'spicy_tr_persistent_cache_v5',
    'spicy_tr_persistent_cache_v6',
    'spicy_tr_persistent_cache_v6_1',
    'spicy_tr_persistent_cache_v7_0',
    'spicy_tr_persistent_cache_v8_0',
    'spicy_tr_persistent_cache_v9_0',
    'spicy_tr_persistent_cache_v10_0',
    'spicy_tr_persistent_cache_v11_0'
  ].forEach(k => localStorage.removeItem(k));

  const STORAGE_CACHE_KEY = 'spicy_tr_persistent_cache_v12_final';
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

  // V12 KESİN SORU KONTROLÜ: "いつも" (her zaman) veya "Çünkü..." gibi düz cümlelere ASLA "?" koymaz!
  function fixQuestionPunctuation(tr, rawText) {
    let cleanTr = tr.replace(/[.!?？]+$/, '').trim();

    // Başında "Çünkü", "Ama", "Ve", "Sanki", "Böylece", "Her zaman", "Asla" olan düz cümleler soru olamaz (içinde "mi/mı/musun" yoksa)
    const hasTurkishQuestionParticle = /\b(mi|mı|mu|mü|misin|mısın|musun|müsün|miyim|mıyım|muyum|müyüm|miyiz|mıyız|muyuz|müyüz)\b/i.test(cleanTr);
    if (/^(çünkü|ama\b|fakat\b|sanki\b|her zaman\b|hep\b|asla\b|hiçbir\b|artık\b|bırak\b|şimdi\b)/i.test(cleanTr) && !hasTurkishQuestionParticle) {
      return cleanTr;
    }

    // Orijinal metinde açıkça "?" varsa
    if (/[?？]$/.test(rawText.trim())) {
      return cleanTr + '?';
    }

    // Türkçe cümlede açık soru eki varsa (örn: "var mı", "değil mi", "bilir misin")
    if (hasTurkishQuestionParticle) {
      return cleanTr + '?';
    }

    // Türkçe cümlede gerçek soru kelimesi + 2. tekil şahıs soru çekimi varsa (örn: "Nereye gidiyorsun?", "Neyi kafana takıyorsun?", "Bugün nasılsın?", "Daha ne kadar tereddüt edeceksin?")
    if (/\b(nasılsın|neredesin|kimsin|neyim|neredeyim)\b/i.test(cleanTr)) {
      return cleanTr + '?';
    }
    if (/^(nereye|nerede|nereden|neden|niye|niçin|nasıl|kim|kimi|kime|daha ne kadar|ne zaman)\b/i.test(cleanTr) && !/\b(olursa olsun|gidersek gidelim)\b/i.test(cleanTr)) {
      return cleanTr + '?';
    }
    if (/\b(ne|neyi|nereye|nasıl|neden|niye)\b.*\b(gidiyorsun|endişeleniyorsun|takıyorsun|bakıyorsun|bekliyorsun|istiyorsun|düşünüyorsun|yapıyorsun|arıyorsun|kaçıyorsun|edeceksin)\b/i.test(cleanTr)) {
      return cleanTr + '?';
    }

    return cleanTr;
  }

  // Yedek motor için cümle bütünlüğü hazırlayıcı
  function prepareLineForFallback(rawText) {
    let text = rawText
      .replace(/\(Tip tap[^)]*\)/gi, '')
      .replace(/\(Yo\)/gi, '')
      .replace(/\(Whoo\)/gi, '')
      .replace(/\(Hey\)/gi, '')
      .replace(/\(Yeah\)/gi, '')
      .replace(/どこを気にしているの/g, 'Where is your mind wandering right now?')
      .replace(/どこに行くつもりなの/g, 'Where do you think you are going?')
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

  // V12 FİNAL TÜRKÇE DOĞALLAŞTIRICI: Tüm robotik/sözlük kalıplarını, "-niz" eklerini ve yanlış "?" işaretlerini temizler!
  function finalizePoeticTurkish(tr, rawText) {
    if (!tr) return '';
    if (isPureRhythmOrVocal(rawText)) return '';

    let fixed = tr.trim();

    // 1. Robotik / sözlük çevirisi kalıplarını gerçek şarkı sözüne dönüştür
    fixed = fixed
      .replace(/Kendimi senin çağıran sesine teslim etme işareti/gi, 'Beni kendine çağıran o sesine teslim oluyorum')
      .replace(/.*çağıran.*sesine.*teslim\s+(etme|olma)\s+işareti/gi, 'Beni kendine çağıran o sesine teslim oluyorum')
      .replace(/Sınırlı bir süre içinde yakala/gi, 'Bu kısacık anda sıkıca tut beni')
      .replace(/Sıra bir süre içinde yakala/gi, 'Bu kısacık anda sıkıca tut beni')
      .replace(/Kısıtlı( bir)? sürede yakala/gi, 'Bu kısacık anda sıkıca tut beni')
      .replace(/Kelimeler olmadan bile genişliyor/gi, 'Kelimeler olmasa bile içimde büyüyor')
      .replace(/Kelimeler olmasa( da| bile) genişliyor/gi, 'Kelimeler olmasa bile içimde büyüyor')
      .replace(/^Duygular örtüşüyor$/i, 'Hislerimiz birbiriyle buluşuyor')
      .replace(/Duygularının( zihninizde| zihninde)? yüzeye çıkmasına izin ver/gi, 'Bırak içindeki bütün hisler dökülsün')
      .replace(/Göz kamaştırıcı (benliğiniz|benliğin) pencereye yansıyor/gi, 'Göz kamaştıran güzelliğin pencereye yansıyor')
      .replace(/Ritimimizi aynı tempoya uydurmak/gi, 'Ritmimizi aynı tempoda buluşturalım')
      .replace(/Ritmimizi aynı tempoya uydurmak/gi, 'Ritmimizi aynı tempoda buluşturalım')
      .replace(/Umurumda olmayan her şey/gi, 'Başka hiçbir şey umurumda değil')
      .replace(/Sen sorun değil/gi, 'Seninle her şey yolunda')
      .replace(/Ay ışığında çizim yap(ın)?/gi, 'Ay ışığında hayallerimizi çizelim')
      .replace(/Yaklaşan bir ideal/gi, 'Adım adım yaklaştığımız o hayal')
      .replace(/Ne hakkında endişeleniyorsun\??/gi, 'Aklın nerede, neyi kafana takıyorsun?')
      .replace(/Bekleyişim seni bekliyor/gi, 'Hasretim bile senin yolunu gözlüyor')
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

    // 3. Morfolojik İyelik Motoru (-niz, -nız, -nuz, -nüz, -nizde, -nizi, -nize -> Tekil "Sen")
    const rootExceptions = /^(deniz|denize|denizi|denizde|denizden|yıldız|yalnız|ansız|ikiz|sekiz|temiz|çeyiz|faiz|bariz|cılız|sakız|yaldız|kız|hız)$/i;
    fixed = fixed.split(/\s+/).map(word => {
      const cleanW = word.replace(/[.,!?'"()]/g, '');
      if (rootExceptions.test(cleanW)) return word;

      return word
        .replace(/(ler|lar)inizi\b/gi, '$1ini')
        .replace(/(ler|lar)inize\b/gi, '$1ine')
        .replace(/(ler|lar)inizde\b/gi, '$1inde')
        .replace(/(ler|lar)inizden\b/gi, '$1inden')
        .replace(/(ler|lar)inizle\b/gi, '$1inle')
        .replace(/(ler|lar)iniz\b/gi, '$1in')
        .replace(/(ler|lar)ınızı\b/gi, '$1ını')
        .replace(/(ler|lar)ınıza\b/gi, '$1ına')
        .replace(/(ler|lar)ınızda\b/gi, '$1ında')
        .replace(/(ler|lar)ınızdan\b/gi, '$1ından')
        .replace(/(ler|lar)ınızla\b/gi, '$1ınla')
        .replace(/(ler|lar)ınız\b/gi, '$1ın')
        .replace(/([a-zçğıöşü]+m[ae])nizi\b/gi, '$1ni')
        .replace(/([a-zçğıöşü]+m[ae])nize\b/gi, '$1ne')
        .replace(/([a-zçğıöşü]+m[ae])nizde\b/gi, '$1nde')
        .replace(/([a-zçğıöşü]+m[ae])niz\b/gi, '$1n')
        .replace(/([a-zçğıöşü]+m[ae])nızı\b/gi, '$1nı')
        .replace(/([a-zçğıöşü]+m[ae])nıza\b/gi, '$1na')
        .replace(/([a-zçğıöşü]+m[ae])nızda\b/gi, '$1nda')
        .replace(/([a-zçğıöşü]+m[ae])nız\b/gi, '$1n')
        .replace(/([a-zçğıöşü]{2,})inizde\b/gi, '$1inde')
        .replace(/([a-zçğıöşü]{2,})inizden\b/gi, '$1inden')
        .replace(/([a-zçğıöşü]{2,})inizi\b/gi, '$1ini')
        .replace(/([a-zçğıöşü]{2,})inize\b/gi, '$1ine')
        .replace(/([a-zçğıöşü]{2,})inizle\b/gi, '$1inle')
        .replace(/([a-zçğıöşü]{2,})iniz\b/gi, '$1in')
        .replace(/([a-zçğıöşü]{2,})ınızda\b/gi, '$1ında')
        .replace(/([a-zçğıöşü]{2,})ınızdan\b/gi, '$1ından')
        .replace(/([a-zçğıöşü]{2,})ınızı\b/gi, '$1ını')
        .replace(/([a-zçğıöşü]{2,})ınıza\b/gi, '$1ına')
        .replace(/([a-zçğıöşü]{2,})ınızla\b/gi, '$1ınla')
        .replace(/([a-zçğıöşü]{2,})ınız\b/gi, '$1ın')
        .replace(/([a-zçğıöşü]{2,})unuzda\b/gi, '$1unda')
        .replace(/([a-zçğıöşü]{2,})unuzdan\b/gi, '$1undan')
        .replace(/([a-zçğıöşü]{2,})unuzu\b/gi, '$1unu')
        .replace(/([a-zçğıöşü]{2,})unuza\b/gi, '$1una')
        .replace(/([a-zçğıöşü]{2,})unuz\b/gi, '$1un')
        .replace(/([a-zçğıöşü]{2,})ünüzde\b/gi, '$1ünde')
        .replace(/([a-zçğıöşü]{2,})ünüzden\b/gi, '$1ünden')
        .replace(/([a-zçğıöşü]{2,})ünüzü\b/gi, '$1ünü')
        .replace(/([a-zçğıöşü]{2,})ünüze\b/gi, '$1üne')
        .replace(/([a-zçğıöşü]{2,})ünüz\b/gi, '$1ün');
    }).join(' ');

    // 4. Fiil Çekimleri ve Emir Kipleri ("yapın" -> "yap", "edin" -> "et")
    fixed = fixed
      .replace(/\b([a-zçğıöşü]+)\s+edin\b/gi, '$1 et')
      .replace(/\b([a-zçğıöşü]+)\s+ettirin\b/gi, '$1 ettir')
      .replace(/\b([a-zçğıöşü]+)\s+yapın\b/gi, '$1 yap')
      .replace(/\b([a-zçğıöşü]+)\s+olun\b/gi, '$1 ol')
      .replace(/([a-zçğıöşü]+l[ae]ştir)in\b/gi, '$1')
      .replace(/([a-zçğıöşü]+l[aı]ştır)ın\b/gi, '$1')
      .replace(/([a-zçğıöşü]+t[iıuü]r)[iıuü]n\b/gi, '$1')
      .replace(/([a-zçğıöşü]+m[ae])yin\b/gi, '$1')
      .replace(/([a-zçğıöşü]+m[ae])yın\b/gi, '$1')
      .replace(/([a-zçğıöşü]{2,}[aeıioöuü])yin\b/gi, '$1')
      .replace(/([a-zçğıöşü]{2,}[aeıioöuü])yın\b/gi, '$1')
      .replace(/([a-zçğıöşü]{2,}[aeıioöuü])yun\b/gi, '$1')
      .replace(/([a-zçğıöşü]{2,}[aeıioöuü])yün\b/gi, '$1')
      .replace(/([a-zçğıöşü]+)siniz\b/gi, '$1sin')
      .replace(/([a-zçğıöşü]+)sınız\b/gi, '$1sın')
      .replace(/([a-zçğıöşü]+)sunuz\b/gi, '$1sun')
      .replace(/([a-zçğıöşü]+)sünüz\b/gi, '$1sün')
      .replace(/\b(hissed|affed|sabred|seyred)in\b/gi, (_, stem) => stem.replace(/d$/i, 't'))
      .replace(/\b(ver|gel|git|seç|geç|çek|iç|bil|sil|çiz)in\b/gi, '$1')
      .replace(/\b(yap|al|kal|bak|bırak|aç|kapat|at|yak|yık|kır|inan|uyan|sarıl|kaç|çık|anlat|atlat)ın\b/gi, '$1')
      .replace(/\b(tut|unut|koş|dokun|konuş|sus|otur|dur|bul|ol|vur|kur)un\b/gi, '$1')
      .replace(/\b(gör|düşün|gül|yürü|öp|dön|çöz|sür)ün\b/gi, '$1')
      .replace(/\bkurtulun\b/gi, 'bir kenara bırak')
      .replace(/\byükseltin\b/gi, 'yükselt')
      .replace(/\başın\b/gi, 'aş');

    // 5. Cümle sonu mastarlarını ("-mak/-mek") doğal fiile çevir
    fixed = fixed
      .replace(/\b([a-zçğıöşü]{2,})mak$/i, '$1alım')
      .replace(/\b([a-zçğıöşü]{2,})mek$/i, '$1elim');

    // 6. Kusursuz soru işareti kontrolü (düz cümlelerdeki yanlış "?" işaretini siler, gerçek sorulara "?" ekler)
    fixed = fixQuestionPunctuation(fixed.replace(/\s+/g, ' ').trim(), rawText);

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

    const cleanedTr = finalizePoeticTurkish(data.tr, rawText);
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

  // 1. ANA MOTOR: Gemini 2.5 Flash Öncelikli Tam Şarkı Yerelleştirici
  async function translateWithGeminiPoeticAI(targetLines, fullSongContextArray) {
    const songTitle = Spicetify?.Player?.data?.item?.name || 'Unknown Song';
    const artist = Spicetify?.Player?.data?.item?.artists?.[0]?.name || 'Unknown Artist';

    const indexedInput = targetLines.map((line, idx) => ({ i: idx, text: line }));

    const prompt = `You are a master Turkish poetic lyricist translating a song on Spotify.
Song: "${songTitle}" by "${artist}".
Full Song Context (connect consecutive lines as one flowing story!):
${JSON.stringify(fullSongContextArray)}

Translate each line in the indexed list into deeply natural, emotional, poetic Turkish ("tr").

STRICT RULES:
1. NO ROBOTIC OR LITERAL DICTIONARY TRANSLATIONS:
   - Connect split lines across the stanza! For example, in "気持ち 重なり合う" -> "Hislerimiz birbiriyle buluşuyor", "言葉はなくても 膨らむ" -> "Kelimeler olmasa bile içimde büyüyor" (NEVER write "genişliyor"!), "限られた時間でつかんで" -> "Bu kısacık anda sıkıca tut beni" (NEVER write commercial phrases like "Sınırlı bir süre içinde yakala"!).
   - In "手招きされるように声に委ねるサイン" -> "Beni kendine çağıran o sesine teslim oluyorum" (NEVER write clunky noun labels like "Kendimi senin çağıran sesine teslim etme işareti"!).
2. PUNCTUATION ACCURACY:
   - Put a question mark "?" ONLY on genuine questions (e.g., "Aklın nerede, neyi kafana takıyorsun?", "Nereye gidiyorsun?").
   - NEVER put a question mark "?" on declarative sentences like "いつも君で溢れるから" ("Çünkü kalbim her an seninle dolup taşıyor")!
3. 100% SINGULAR INFORMAL ("SEN") TONE: Address the listener/lover exclusively as "sen". NEVER use plural/formal "siz" ("-niz", "-nız", "-edin", "-yapın").
4. For pure vocalizations ("Oh-whoa-whoa", "Tip tap tip tap tap"), set "tr" to "".

Return ONLY a valid JSON array of objects with keys "i" (number) and "tr" (string):
${JSON.stringify(indexedInput)}`;

    // En zeki modeller en başta!
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
                tr: finalizePoeticTurkish(found.tr, rawText),
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
          tr: finalizePoeticTurkish(tr, item.raw),
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
          console.warn('Spicy TR V12: AI meşgul, Bütünsel Yedek Motor devreye girdi:', aiErr);
          await translateWithCohesiveFallback(missingLines);
        }
      } else {
        await translateWithCohesiveFallback(missingLines);
      }
    } catch (e) {
      console.error('Spicy TR V12 Hata:', e);
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
        ? 'Sol Tık: Çeviriyi Aç/Kapat | Sağ Tık: AI Anahtarını Yönet ve Önbelleği Sıfırla (V12.0 Final Aktif)'
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
        '🌟 Spicy Lyrics AI Çeviri & Romaja V12.0 (FINAL) 🌟\n\n' +
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
