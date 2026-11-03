# Spicy Lyrics AI Translator & Romaja

**Turkish translations and romanized pronunciation, right below the original lyrics.** A companion extension for [Spicy Lyrics](https://spicylyrics.org/) on Spotify Desktop.

**Available on Spicetify Marketplace · v47.0.0**

![Extension preview](preview.png)

## Features

- **Three-line lyrics:** Original text, pronunciation (romanization), and Turkish translation together, without replacing the original.
- **Multilingual pronunciation:** Romanization for Korean, Japanese, Chinese, Thai, and other non-Latin scripts when available. v47 improves Thai and mixed-language lyric handling.
- **No API key needed:** Google Translate works out of the box, with MyMemory as a fallback.
- **Optional Gemini AI:** More natural Turkish translations using the song's context, tone, idioms, and slang.
- **Smart cache:** Saves translated lines locally, skips lyrics detected as already Turkish, and filters certain broken results.
- **Cleaner lyrics:** Removes distracting blur and automatically falls back to other translation services when needed.

## Installation

Requires **Spotify Desktop**, **Spicetify**, and **Spicy Lyrics**.

### Marketplace (recommended)

1. Open **Spicetify Marketplace** in Spotify and select **Extensions**.
2. Search for **Spicy Lyrics AI Translator & Romaja**.
3. Click **Install**, then open the full Spicy Lyrics view while playing a song.

No additional setup is required.

### Manual installation

1. Download [`spicy-tr.js`](https://raw.githubusercontent.com/korelili/spicetify-spicy-lyrics-tr/main/spicy-tr.js).
2. Move it to your Spicetify `Extensions` folder:
   - **Windows:** `%appdata%\spicetify\Extensions`
   - **macOS / Linux:** `~/.config/spicetify/Extensions`
3. Run:

   ```bash
   spicetify config extensions spicy-tr.js
   spicetify apply
   ```

## How to use

First, turn **off** Spicy Lyrics' built-in **`A` (Romanization)** option to keep the original characters visible.

- **Left-click `TR` / `AI`:** Show or hide the additional lyric lines.
- **Right-click `TR` / `AI`:** Open Gemini API key settings.
- **`TR`:** No Gemini key configured; uses the free translation services.
- **`AI`:** Gemini key configured; fallback services remain available. An **`!`** indicates a temporary service warning.

### Add Gemini AI (optional)

1. Get a key from [Google AI Studio](https://aistudio.google.com/apikey).
2. Right-click the `TR` button and paste your key. Multiple keys can be separated by commas or new lines.
3. Click **Save & Reset** to apply the keys and translate again.

> **Important:** **Save & Reset clears the entire local translation cache**, even if the keys haven't changed. Previously translated lyrics will need new requests, which may use API quota. API keys are stored locally; keep them private.

## Troubleshooting

- **Button missing?** Confirm both extensions are installed, open the full Spicy Lyrics view, and restart Spotify if needed.
- **No pronunciation?** Disable Spicy Lyrics' built-in `A` option. Romanization depends on the source lyrics and available results.
- **Outdated translations or Gemini issues?** Check your key and quota, then use **Save & Reset**. The extension can fall back to Google Translate or MyMemory.

For bugs and suggestions, [open an issue](https://github.com/korelili/spicetify-spicy-lyrics-tr/issues).

---

Made by [@korelili](https://github.com/korelili).
