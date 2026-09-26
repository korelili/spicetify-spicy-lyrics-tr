// NAME: Spicy Lyrics AI Translator & Romaja
// AUTHOR: korelili
// VERSION: 16.0.0
// DESCRIPTION: Uncensored (+18) Universal AI Lyric Localizer, Zero-Skip Line Guarantee, Slang/Idiom Engine & Full Multi-Script Romaja

(function spicyLyricsAITranslatorV16() {
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
    'spicy_tr_persistent_cache_v15_universal',
    'spicy_tr_persistent_cache_v15_master'
  ].forEach(k => localStorage.removeItem(k));

  const STORAGE_CACHE_KEY = 'spicy_tr_persistent_cache_v16_uncensored';
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
  let pendingFollowUp = false;
  let scanTimer = null;
  let retryTimer = null;

  function saveCacheToDisk() {
    try {
      const permanentEntries = Array.from(cache.entries())
        .filter(([, val]) => val && val.tr && !val.temp)
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
    if (/[\u0400-\u04ff]/.test(text)) return 'auto';
    return 'auto';
  }

  // Bulgarca, Rusça, Sırpça, Ukraynaca Kiril harfleri Google'dan dönerken Kiril kalırsa %100 Latin okunuşa çeviren fonetik tablo
  const CYRILLIC_TO_LATIN_MAP = {
    'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'yo','ж':'zh','з':'z','и':'i','й':'y','к':'k','л':'l','м':'m',
    'н':'n','о':'o','п':'p','р':'r','с':'s','т':'t','у':'u','ф':'f','х':'h','ц':'ts','ч':'ch','ш':'sh','щ':'sht','ъ':'a',
    'ы':'y','ь':'','э':'e','ю':'yu','я':'ya','і':'i','ї':'yi','є':'ye','ґ':'g','ђ':'dj','ј':'y','љ':'ly','њ':'ny','ћ':'c','џ':'dz',
    'А':'A','Б':'B','В':'V','Г':'G','Д':'D','Е':'E','Ё':'Yo','Ж':'Zh','З':'Z','И':'I','Й':'Y','К':'K','Л':'L','М':'M',
    'Н':'N','О':'O','П':'P','Р':'R','С':'S','Т':'T','У':'U','Ф':'F','Х':'H','Ц':'Ts','Ч':'Ch','Ш':'Sh','Щ':'Sht','Ъ':'A',
    'Ы':'Y','Ь':'','Э':'E','Ю':'Yu','Я':'Ya','І':'I','Ї':'Yi','Є':'Ye','Ґ':'G','Ђ':'Dj','Ј':'Y','Љ':'Ly','Њ':'Ny','Ћ':'C','Џ':'Dz'
  };

  function transliterateRemainingCyrillic(str) {
    if (!/[\u0400-\u04ff]/.test(str)) return str;
    return str.split('').map(ch => CYRILLIC_TO_LATIN_MAP[ch] !== undefined ? CYRILLIC_TO_LATIN_MAP[ch] : ch).join('');
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
    return /^(tip tap(\s+tip|\s+tap)*|yeah(\s+yeah)*|la(\s+la)+|na(\s+na)+|oh(\s+oh|\s+whoa)*|whoo(\s+whoo)*|whoa(\s+whoa)*|ooh(\s+ooh)*|ah(\s+ah)+|uh(\s+uh)+|bam(\s+bam)+|mm(\s+mm)*)$/i.test(cleaned);
  }

  function cleanRomajaString(rom) {
    if (!rom) return '';
    const latinized = transliterateRemainingCyrillic(rom);
    return latinized
      .replace(/([a-zāēīōū])([A-Z])/g, '$1 $2')
      .replace(/([,!?])([A-Za-z0-9])/g, '$1 $2')
      .replace(/([0-9])([a-zA-Z])/g, '$1 $2')
      .replace(/([a-zA-Z])([0-9])/g, '$1 $2')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // HİBRİT ROMAJA MOTORU (Asya ve Kiril alfabelerini %100 Latin okunuşa çevirir, İngilizce kelimeleri korur)
  async function buildHybridRomaja(rawText, lang) {
    if (!isNonLatin(rawText)) return '';
    // Eğer satır tamamen veya kısmen Kiril ise ve Google dt=rm desteklemiyorsa doğrudan fonetik tabloyla da tamamlanır
    const parts = rawText.split(NON_LATIN_CHUNK_REGEX);
    const resolvedParts = await Promise.all(
      parts.map(async (part) => {
        if (!part) return '';
        if (!isNonLatin(part)) return part.trim();
        if (/[\u0400-\u04ff]/.test(part)) {
          return transliterateRemainingCyrillic(part.trim());
        }
        try {
          const rmLang = lang === 'auto' ? 'ko' : lang;
          const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${rmLang}&tl=tr&dt=rm&q=${encodeURIComponent(part.trim())}`;
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

  // EVRENSEL ARGO, KISALTMA VE KARMA DİL ÇÖZÜCÜ (Çeviri motorunun "ma" -> "anne", "errday" -> "Errday", "boo" -> "dostum" yapmasını tüm şarkılarda engeller)
  function expandUniversalSlangForTranslation(rawText) {
    let text = rawText
      // İngilizce vokal ve hip-hop kısaltmaları (Tüm şarkılar için genel kurallar)
      .replace(/\bImma\b/gi, 'I am going to')
      .replace(/\bI'mma\b/gi, 'I am going to')
      .replace(/\bfinna\b/gi, 'going to')
      .replace(/\btryna\b/gi, 'trying to')
      .replace(/\bgonna\b/gi, 'going to')
      .replace(/\bwanna\b/gi, 'want to')
      .replace(/\bgotta\b/gi, 'got to')
      .replace(/\bain't\b/gi, 'is not')
      .replace(/\berrday\b/gi, 'every single day')
      .replace(/\be'ryday\b/gi, 'every single day')
      .replace(/\beveryday\b/gi, 'every day')
      .replace(/\b'cause\b/gi, 'because')
      .replace(/\bcuz\b/gi, 'because')
      .replace(/\boutta\b/gi, 'out of')
      .replace(/\bkinda\b/gi, 'kind of')
      .replace(/\bsorta\b/gi, 'sort of')
      // "ma" = "my" kısaltması ("ma darling" -> "anne" faciasını tüm şarkılarda önler!)
      .replace(/\bma\s+(darling|baby|babe|girl|boy|love|heart|life|mind|way|world|bad|fault|homies|ladies|friends|man|woman|body|soul|eyes|hands|lips|time|type|style|swagger)\b/gi, 'my $1')
      .replace(/\bbe\s+ma\b/gi, 'be my')
      // Romantik hitap olan "boo" ("dostum" veya "böğürtü" diye çevrilmesini önler)
      .replace(/,\s*boo\b/gi, ', my darling')
      .replace(/\bmy\s+boo\b/gi, 'my darling')
      // Yaygın İngilizce deyimler (Sözlük çevirisini önler)
      .replace(/\blive it up\b/gi, 'live life to the fullest')
      .replace(/\bhit the bull'?s?\s*eye\b/gi, 'hit the target right in the center')
      .replace(/\bget her hooked tight\b/gi, 'make her fall deeply for me')
      .replace(/\bget him hooked tight\b/gi, 'make him fall deeply for me')
      .replace(/\bcast a spell\b/gi, 'enchanted us like magic')
      .replace(/\ba 9 to 6\b/gi, 'a busy working girl from 9 to 6')
      .replace(/\ba 9 to 5\b/gi, 'a busy working person from 9 to 5')
      // Korece eklerin İngilizce kelimelere doğrudan yapıştığı karma yapıları ("Attitude는", "너의 Weekend") ayrıştır
      .replace(/([A-Za-z]+)(는|은)\s+([A-Za-z]+)/g, 'Her $1 is like $3')
      .replace(/너의\s+([A-Za-z]+)\s+나의\s+([A-Za-z]+)/gi, 'your $1 and my $2')
      .replace(/\s+/g, ' ')
      .trim();

    return text;
  }

  // EVRENSEL TÜRKÇE DİLBİLGİSİ VE +18 DOĞALLAŞTIRICI
  function cleanUniversalTurkish(tr, rawText) {
    if (!tr) return '';
    if (isPureRhythmOrVocal(rawText)) return '';

    let fixed = tr.trim();
    if (fixed.includes('||')) {
      fixed = fixed.split('||').pop().trim();
    }

    // Satır sonu gereksiz nokta ve soru işaretlerini temizle
    fixed = fixed.replace(/[?？.]+$/g, '').trim();

    // +18 / Küfür sansürü düzeltmesi (Eğer yedek motor "fucked" kelimesini "berbat" diye yumuşattıysa gerçek anlamını koru)
    if (/\bfucked\b/i.test(rawText) && /\bberbat\b/i.test(fixed)) {
      fixed = fixed.replace(/\bberbat\b/gi, 'boktan');
    }
    if (/\bhacer el amor\b/i.test(rawText) && /aşk.*yapılabilir/i.test(fixed)) {
      fixed = 'Telepatiyle sevişebileceğimizi';
    }

    // Yanlış dost kelimeler (sign -> tabela, tarikati -> tarikat)
    fixed = fixed
      .replace(/\btabelamız\b/gi, 'aramızdaki işaret')
      .replace(/\btabelan\b/gi, 'işaretin')
      .replace(/\btabelası\b/gi, 'işareti')
      .replace(/\bbir tabela\b/gi, 'bir işaret')
      .replace(/\bSadece tarikat istiyorum\b/gi, 'Sadece kurnaz ve havalı tipleri istiyorum');

    // Zamirleri samimi tekil "Sen" diline sabitle
    fixed = fixed
      .replace(/\bSizin\b/g, 'Senin').replace(/\bsizin\b/g, 'senin')
      .replace(/\bSize\b/g, 'Sana').replace(/\bsize\b/g, 'sana')
      .replace(/\bSizi\b/g, 'Seni').replace(/\bsizi\b/g, 'seni')
      .replace(/\bSizde\b/g, 'Sende').replace(/\bsizde\b/g, 'sende')
      .replace(/\bSizden\b/g, 'Senden').replace(/\bsizden\b/g, 'senden')
      .replace(/\bSiz\b/g, 'Sen').replace(/\bsiz\b/g, 'sen');

    // Evrensel 2. Çoğul Şahıs (-niz/-nız/-nuz/-nüz) -> 2. Tekil Şahıs (-n)
    const rootExceptions = /^(deniz|yalnız|henüz|boynuz|geniz|beniz)/i;
    fixed = fixed.split(/\s+/).map(word => {
      const cleanW = word.replace(/[.,!?'"()]/g, '');
      if (rootExceptions.test(cleanW)) return word;
      return word
        .replace(/s([iıuü])n[iıuü]z\b/gi, 's$1n')
        .replace(/n[iıuü]z(e|a|i|ı|u|ü|de|da|den|dan|le|la|in|ın|un|ün)?\b/gi, 'n$1');
    }).join(' ');

    // Özne-Yüklem Uyumlu Emir Kipi Düzeltici
    const hasThirdPersonSubject = /\b(herkes|hepsi|hiçbiri|kimse)\b/i.test(fixed);
    if (hasThirdPersonSubject) {
      fixed = fixed
        .replace(/\bherkes\s+(.*?\s+)?hisset(sin|in)?$/i, 'herkes $1hissetsin')
        .replace(/\bherkes\s+(.*?\s+)?yaşa(sın|yın)?$/i, 'herkes $1yaşasın');
    } else {
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

    if (!data || isPureRhythmOrVocal(rawText)) return;

    box = document.createElement('div');
    box.className = 'spicy-tr-box';

    if (data.romaja && isNonLatin(rawText)) {
      const romEl = document.createElement('div');
      romEl.className = 'spicy-tr-romaja';
      romEl.textContent = cleanRomajaString(data.romaja);
      box.appendChild(romEl);
    }

    const cleanedTr = cleanUniversalTurkish(data.tr, rawText);
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

  // ESNEK VE KIRILMAZ AI SATIR AYRIŞTIRICI (Model "[0] ...", "0. ...", "**[0]** ..." veya JSON döndürse bile %100 yakalar!)
  function parseFlexibleAiOutput(rawOutput) {
    const resultMap = new Map();
    if (!rawOutput) return resultMap;

    const cleaned = rawOutput.replace(/^```[a-z]*\s*/im, '').replace(/```\s*$/im, '').trim();

    // "[0] Çeviri", "**[0]** Çeviri", "0: Çeviri", "0. Çeviri" formatlarının tamamını yakalar
    const lineRegex = /^\s*(?:\*\*)?(?:\[(\d+)\]|(\d+)[.:)])(?:\*\*)?\s*[-–—:]?\s*(.+)$/gm;
    let match;
    while ((match = lineRegex.exec(cleaned)) !== null) {
      const idxStr = match[1] !== undefined ? match[1] : match[2];
      const idx = parseInt(idxStr, 10);
      let lineContent = match[3].trim();
      if (lineContent.includes('||')) {
        lineContent = lineContent.split('||').pop().trim();
      }
      lineContent = lineContent.replace(/^["']|["']$/g, '').trim();
      if (!isNaN(idx) && lineContent) {
        resultMap.set(idx, lineContent);
      }
    }

    if (resultMap.size > 0) return resultMap;

    try {
      const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
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

  // 1. ANA MOTOR: SANSÜRSÜZ (+18 BLOCK_NONE) 6 MODELLİ EVRENSEL GEMINI & GEMMA AI MOTORU
  async function translateWithUncensoredAI(batchLines, fullSongContextArray) {
    const songTitle = Spicetify?.Player?.data?.item?.name || 'Unknown Song';
    const artist = Spicetify?.Player?.data?.item?.artists?.[0]?.name || 'Unknown Artist';

    const fullSongText = fullSongContextArray.slice(0, 60).join('\n');
    const numberedBatch = batchLines.map((line, idx) => `[${idx}] ${line}`).join('\n');

    const prompt = `You are an elite, uncensored Turkish lyricist and music translator.
Song: "${songTitle}" by "${artist}"

Full Song Context (read to understand the story, mood, and how split lines connect):
${fullSongText}

Translate EVERY numbered line below into 100% natural, poetic, idiomatic Turkish song lyrics.

CRITICAL UNIVERSAL RULES:
1. ZERO CENSORSHIP (+18 & PROFANITY ALLOWED): Never censor, soften, or sanitize explicit lyrics, profanity, sexual themes, or street slang! Translate "fucked" as "boktan / sikik", "fuck" as "siktir / sikeyim", "bitch" as "sürtük", "hacer el amor / make love" as "sevişmek", "hooked tight" as "onu kendime sırılsıklam bağlayacağım".
2. SLANG & IDIOMS (NEVER TRANSLATE LITERALLY):
   - Understand vocal slang: "ma darling" = "sevgilim" (NEVER translate "ma" as "anne"!), "Imma" = "yapacağım", "tryna" = "çalışıyor", "Errday" = "her gün", "9 to 6, boo" = "sabah 9 akşam 6 çalışan bir kız, bebeğim" (NEVER translate "boo" as "dostum"!), "live it up" = "hayatın tadını sonuna kadar çıkarsın", "hit the bullseye" = "tam on ikiden vuralım", "想尽办法" = "her yolu deniyorum" (NEVER write "çevrilmemiş taş bırakma"!), "애틋해" = "içimi sızlatacak kadar derin ve özel".
   - In mixed Korean/Japanese + English lines (e.g. "Attitude는 Rihanna", "아직은 너완 Thursday", "채우고 싶어 너의 Weekend 나의 weekend", "특별함은 Just daily"), blend the English words seamlessly into natural Turkish ("Duruşu tıpkı Rihanna gibi", "Seninle hala perşembe günündeyiz", "Senin hafta sonunu kendi hafta sonumla doldurmak istiyorum", "En özel anlar bile seninle her günkü sıradanlığımız").
3. 100% SINGULAR INFORMAL ("SEN") TONE: Address the lover/listener as "sen". Never use formal "siz".
4. DO NOT SKIP ANY LINE: Every single index [0], [1], [2]... MUST have a complete Turkish translation. Do not put periods (".") or question marks ("?") at the end.

Return ONLY the numbered lines in this exact format:
[0] Turkish translation
[1] Turkish translation

Lines to translate:
${numberedBatch}`;

    // Sansürsüz +18 Güvenlik Ayarları (Tüm filtreler tamamen kapalı!)
    const uncensoredSafety = [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'BLOCK_NONE' }
    ];

    // 6 Ayrı Model Havuzu (Gemini 2.5 + Günlük 14.400 Kotalı Gemma 3 27B/12B)
    const models = [
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
      'gemma-3-27b-it',
      'gemini-2.0-flash',
      'gemini-2.0-flash-lite',
      'gemma-3-12b-it'
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
            safetySettings: uncensoredSafety,
            generationConfig: { temperature: 0.3 }
          })
        });

        if (res.status === 429 || res.status === 404 || res.status === 400) {
          modelCooldowns.set(modelId, Date.now() + 40000);
          throw new Error(`HTTP ${res.status} on ${modelId}`);
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const json = await res.json();
        const parts = json?.candidates?.[0]?.content?.parts || [];
        const rawOutput = parts.filter(p => !p.thought && p.text).map(p => p.text).join('\n') || parts.map(p => p.text || '').join('\n');

        const parsedMap = parseFlexibleAiOutput(rawOutput);
        if (parsedMap.size === 0) throw new Error('Empty AI parse result');

        const missedLines = [];

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

            if (aiTr && aiTr.trim()) {
              cache.set(rawText, {
                tr: cleanUniversalTurkish(aiTr, rawText),
                romaja,
                temp: false
              });
            } else {
              missedLines.push(rawText);
            }
          })
        );

        // Eğer AI paketteki herhangi bir satırı atladıysa, o satırı asla boş bırakma; anında tamamla!
        if (missedLines.length > 0) {
          await translateWithGuaranteedFallback(missedLines, false);
        }

        saveCacheToDisk();
        updateDOMWithCache();
        return true;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  }

  // 2. SIFIR KAYIPLI & ARGO ÇÖZÜCÜLÜ GARANTİ MOTOR (Çince/İspanyolca deyimleri bozmaz, tek bir satırı bile boş bırakmaz!)
  async function translateWithGuaranteedFallback(targetLines, isTempForAi = false) {
    const validItems = [];
    targetLines.forEach((raw, idx) => {
      if (isPureRhythmOrVocal(raw)) {
        cache.set(raw, { tr: '', romaja: '', temp: false });
      } else {
        validItems.push({
          raw,
          prepared: expandUniversalSlangForTranslation(raw),
          idx
        });
      }
    });

    if (validItems.length === 0) return;

    // Satırların birbirine kaynamaması için her satırın sonuna nokta koyarak toplu çevir, sonra noktayı sil
    let batchTrLines = [];
    try {
      const safeJoined = validItems.map(i => {
        const p = i.prepared.replace(/[.!?]+$/, '').trim();
        return p + '.';
      }).join('\n');

      const trUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=tr&dt=t&dj=1&q=${encodeURIComponent(safeJoined)}`;
      const trRes = await fetch(trUrl);
      const trJson = await trRes.json();
      const fullTr = (trJson.sentences || []).map(s => s.trans || '').join('');
      const splitTr = fullTr.split('\n').map(s => s.replace(/\.$/, '').trim()).filter(Boolean);

      if (splitTr.length === validItems.length) {
        batchTrLines = splitTr;
      }
    } catch (e) {}

    // Paralel isteklerde Google'ın hiçbir satırı düşürmemesi için kontrollü tamamlama
    for (let i = 0; i < validItems.length; i++) {
      const item = validItems[i];
      let tr = batchTrLines[i] || '';
      const lang = detectScriptLang(item.raw);

      // Eğer toplu çeviride satır boş kaldıysa veya kaydıysa, o satırı tekil olarak kesin çek!
      if (!tr || /bu çok önemli/i.test(tr)) {
        try {
          const singleUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${lang}&tl=tr&dt=t&q=${encodeURIComponent(item.prepared)}`;
          const sRes = await fetch(singleUrl);
          const sJson = await sRes.json();
          tr = '';
          if (Array.isArray(sJson[0])) {
            sJson[0].forEach(seg => {
              if (seg[0]) tr += seg[0];
            });
          }
        } catch (e) {}
      }

      const existingRomaja = cache.get(item.raw)?.romaja;
      const romaja = existingRomaja || (isNonLatin(item.raw) ? await buildHybridRomaja(item.raw, lang) : '');
      const finalTr = cleanUniversalTurkish(tr, item.raw);

      // ASLA BOŞ ÇEVİRİYİ HAFIZAYA KAYDETME! (Sadece doluysa kaydet ki hiçbir satır atlanmasın)
      if (finalTr) {
        cache.set(item.raw, {
          tr: finalTr,
          romaja,
          temp: isTempForAi
        });
      }
    }

    if (!isTempForAi) saveCacheToDisk();
    updateDOMWithCache();
  }

  async function processVisibleLyrics() {
    if (isProcessing) {
      pendingFollowUp = true;
      return;
    }

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
      const currentBatch = missingOrTempLines.slice(0, 25);

      if (geminiApiKey && geminiApiKey.trim().length > 10) {
        try {
          await translateWithUncensoredAI(currentBatch, fullContextArray);
        } catch (aiErr) {
          console.warn('Spicy TR V16: AI yoğunlukta, Garanti Motoru devreye girdi:', aiErr);
          const uncachedOnly = currentBatch.filter(t => !cache.has(t));
          if (uncachedOnly.length > 0) {
            await translateWithGuaranteedFallback(uncachedOnly, true);
          }
          clearTimeout(retryTimer);
          retryTimer = setTimeout(processVisibleLyrics, 3000);
        }
      } else {
        await translateWithGuaranteedFallback(currentBatch, false);
      }
    } catch (e) {
      console.error('Spicy TR V16 Hata:', e);
    } finally {
      isProcessing = false;
      if (pendingFollowUp) {
        pendingFollowUp = false;
        clearTimeout(scanTimer);
        scanTimer = setTimeout(processVisibleLyrics, 350);
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
        ? 'Sol Tık: Çeviriyi Aç/Kapat | Sağ Tık: AI Anahtarını Yönet ve Önbelleği Sıfırla (V16.0 +18 Sansürsüz Evrensel Motor)'
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
        '🔥 Spicy Lyrics AI Çeviri & Romaja V16.0 (+18 Sansürsüz & Sıfır Kayıp) 🔥\n\n' +
        '• Ücretsiz Gemini API Anahtarınızı aşağıya yapıştırın (aistudio.google.com/apikey).\n' +
        '• Tamam\'a bastığınızda tüm eski önbellek temizlenir ve şarkı yeniden çevrilir:',
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
      scanTimer = setTimeout(processVisibleLyrics, 350);
    }
  }

  if (window._spicyTrObserver) window._spicyTrObserver.disconnect();
  window._spicyTrObserver = new MutationObserver(() => scanLines());
  window._spicyTrObserver.observe(document.body, { childList: true, subtree: true });
  scanLines();
})();
