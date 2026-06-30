# srt-kanji-list

Build Anki-ready kanji and vocabulary lists from subtitle (SRT) files. The tool reads dialogue from one or more `.srt` files, extracts Japanese words containing kanji, looks up readings and meanings, groups them by JLPT level, and writes tab-separated text files you can import into Anki.

## QuickStart

**Requirements:** [Node.js](https://nodejs.org/) 18 or later (for native `fetch` support).

```bash
# Install dependencies
npm install

# Process a single subtitle file
node srt-kanji-list.mjs --srt=path/to/Episode\ -\ 05.srt --output=./output

# Process every .srt file in a folder
node srt-kanji-list.mjs --srt=path/to/subtitles/ --output=./output
```

Each input file produces a matching list in the output folder, for example `Episode - 05.srt` → `Episode - 05 - kanji list.txt`.

Use `--search=quick` for a fast offline run (no dictionary lookups, see constrainst below), or `--search=full` when you want the most thorough online lookups. The default is `normal`.


## How it works

### Input and parsing

You point the program at an SRT file or a directory of SRT files. For each file it strips subtitle metadata (index numbers, timestamps, music-only lines) and keeps the spoken dialogue. Lines that include furigana in parentheses — e.g. `漢字(かんじ)` — are parsed directly so those readings are preserved.

### Tokenization and word extraction

Dialogue is tokenized with [kuromoji](https://github.com/takuyaa/kuromoji.js), a Japanese morphological analyzer. The tokenizer dictionary is downloaded once on first run and cached locally. From the tokens, the tool keeps nouns, verbs, adjectives, adverbs, and similar content words that contain at least one kanji. Pure kana words, numbers, and obvious non-vocabulary tokens are skipped.

### Dictionary lookup and JLPT grouping

Each extracted word is enriched with a reading, English meaning(s), and a JLPT level. How much lookup happens depends on the search mode:

| Mode | Behavior |
|------|----------|
| `quick` | Offline only. Readings come from kuromoji; JLPT is inferred from known kanji levels. No English definitions. |
| `normal` | Queries the [Jisho](https://jisho.org/) API for definitions and JLPT tags, with kanji-based JLPT inference as a fallback. |
| `full` | Same as `normal`, plus reading-based Jisho searches and per-kanji lookups via [kanjiapi.dev](https://kanjiapi.dev/) when a word cannot be resolved directly. |

Lookups are cached under `.kanji-list-cache/` (configurable with `--cache=`) so re-running on the same material is much faster and avoids redundant API calls.

Conjugated verb forms are handled by trying several de-conjugated dictionary-form candidates before giving up.

### Output format

Results are written as plain text, grouped into JLPT sections (`N5` through `N1`, then `Names` and `Other`). Each line is tab-separated:

```
Kanji    Reading(s)    Translation(s)
```

This matches Anki’s tab-delimited import format: **File → Import**, choose the generated `.txt` file, and map the three fields to your deck’s front, reading, and back columns.
