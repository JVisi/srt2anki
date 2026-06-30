#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import kuromoji from "kuromoji";

const KUROMOJI_DICT_FILES = [
  "base.dat.gz",
  "cc.dat.gz",
  "check.dat.gz",
  "tid.dat.gz",
  "tid_map.dat.gz",
  "tid_pos.dat.gz",
  "unk.dat.gz",
  "unk_char.dat.gz",
  "unk_compat.dat.gz",
  "unk_invoke.dat.gz",
  "unk_map.dat.gz",
  "unk_pos.dat.gz",
];
const KUROMOJI_DICT_CDN = "https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/dict";

const JLPT_ORDER = ["N5", "N4", "N3", "N2", "N1", "Names", "Other"];
const SEARCH_MODES = ["quick", "normal", "full"];
const KANJI_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/;
const FURIGANA_RE = /([\u4e00-\u9fff\u3400-\u4dbf]+(?:[\u4e00-\u9fff\u3400-\u4dbf・]+)*)\(([ぁ-んァ-ヶー]+)\)/g;
const SRT_TIME_RE = /^\d{2}:\d{2}:\d{2},\d{3}\s-->\s/;
const POS_ALLOW_RE = /^(名詞|動詞|形容詞|形容動詞|副詞)/;
const SKIP_WORD_RE = /^(第|[0-9０-９]+|[A-Za-z]+)$/;

const usage = `Usage: srt-kanji-list --srt=<file-or-folder> --output=<folder> [--search=quick|normal|full]

Options:
  --srt=<path>        SRT file or directory containing .srt files
  --output=<path>     Directory where kanji list files are written
  --search=<mode>     Lookup depth (default: normal)
                        quick  - kuromoji + JLPT kanji inference only (offline, fast)
                        normal - Jisho dictionary + JLPT inference fallback
                        full   - Jisho + reading search + kanjiapi per-kanji fallback
  --cache=<path>      Optional lookup cache directory (default: .kanji-list-cache)
  --help              Show this help

Output naming:
  "Episode - 05.srt" -> "Episode - 05 - kanji list.txt"
`;

/** @typedef {"quick"|"normal"|"full"} SearchMode */
/** @typedef {{ word: string, reading: string, meanings: string[], jlpt: string, source: string }} Entry */
/** @typedef {{ word: string, reading: string, meanings: string[], jlpt: string, source: string }} LookupResult */

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
  /** @type {{ srt?: string, output?: string, cache?: string, search?: string, help?: boolean }} */
  const opts = {};

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
      continue;
    }
    const match = arg.match(/^--(srt|output|cache|search)=(.+)$/);
    if (match) {
      opts[match[1]] = match[2];
    } else if (arg === "--quick" || arg === "--normal" || arg === "--full") {
      opts.search = arg.slice(2);
    } else {
      throw new Error(`Unknown argument: ${arg}\n\n${usage}`);
    }
  }

  if (opts.help) {
    console.log(usage);
    process.exit(0);
  }

  if (!opts.srt || !opts.output) {
    throw new Error(`Missing required arguments.\n\n${usage}`);
  }

  const search = opts.search ?? "normal";
  if (!SEARCH_MODES.includes(search)) {
    throw new Error(`Invalid --search mode "${search}". Use quick, normal, or full.\n\n${usage}`);
  }

  return {
    srt: path.resolve(opts.srt),
    output: path.resolve(opts.output),
    cache: path.resolve(opts.cache ?? ".kanji-list-cache"),
    search: /** @type {SearchMode} */ (search),
  };
}

/**
 * @param {string} target
 * @returns {Promise<string[]>}
 */
async function collectSrtFiles(target) {
  const stat = await fs.stat(target);
  if (stat.isFile()) {
    if (!target.toLowerCase().endsWith(".srt")) {
      throw new Error(`Not an SRT file: ${target}`);
    }
    return [target];
  }

  const entries = await fs.readdir(target);
  return entries
    .filter((name) => name.toLowerCase().endsWith(".srt"))
    .map((name) => path.join(target, name))
    .sort();
}

/**
 * @param {string} srtText
 */
function parseSrtDialogue(srtText) {
  const lines = srtText.split(/\r?\n/);
  /** @type {string[]} */
  const dialogue = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^\d+$/.test(line)) continue;
    if (SRT_TIME_RE.test(line)) continue;
    if (/^[♪〜～]+$/.test(line)) continue;
    dialogue.push(line);
  }

  return dialogue.join("\n");
}

/**
 * @param {string} text
 */
function dialogueForTokenization(text) {
  return text
    .replace(/（[^）]*）/g, " ")
    .replace(/([一-龯々]+)\([ぁ-んァ-ヶー]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @param {string} value
 */
function katakanaToHiragana(value) {
  return value.replace(/[\u30a1-\u30f6]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0x60),
  );
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function parseJlptLevel(value) {
  if (value == null) return null;

  /** @type {string[]} */
  const items = Array.isArray(value) ? value.map(String) : [String(value)];
  /** @type {number[]} */
  const nums = [];

  for (const item of items) {
    const match = item.match(/(?:jlpt-)?n?([1-5])/i);
    if (match) nums.push(Number(match[1]));
  }

  if (!nums.length) return null;
  return `N${Math.min(...nums)}`;
}

/**
 * @param {string} word
 */
function deconjugateCandidates(word) {
  /** @type {Set<string>} */
  const candidates = new Set([word]);

  const push = (value) => {
    if (value && KANJI_RE.test(value)) candidates.add(value);
  };

  if (word.endsWith("す") && !word.endsWith("する")) {
    push(`${word}る`);
  }

  if (word.endsWith("せる") && word.length > 2) {
    push(`${word.slice(0, -2)}す`);
  }

  if (word.endsWith("れる") && word.length > 2) {
    push(`${word.slice(0, -2)}る`);
  }

  const godanPotential = [
    ["てる", "つ"],
    ["ける", "く"],
    ["げる", "ぐ"],
    ["ねる", "ぬ"],
    ["べる", "ぶ"],
    ["める", "む"],
    ["える", "う"],
  ];

  for (const [suffix, replacement] of godanPotential) {
    if (word.endsWith(suffix) && word.length > suffix.length) {
      push(`${word.slice(0, -suffix.length)}${replacement}`);
    }
  }

  return [...candidates].sort(
    (a, b) => dictionaryFormScore(b) - dictionaryFormScore(a),
  );
}

/**
 * Prefer plain dictionary forms over potential / auxiliary stems.
 * @param {string} word
 */
function dictionaryFormScore(word) {
  let score = 0;
  if (word.endsWith("する")) score += 4;
  if (/[るすくつぬぶむ]$/.test(word)) score += 2;
  if (word.endsWith("れる") || word.endsWith("せる") || word.endsWith("てる")) score -= 3;
  if (word.endsWith("できる")) score += 1;
  return score;
}

/**
 * @param {string} word
 * @param {(text: string) => import("kuromoji").IpadicFeatures[]} tokenize
 */
function readingForWord(word, tokenize) {
  const tokens = tokenize(word);
  const content = tokens.filter((token) => token.pos.split(",")[0] !== "記号");
  if (!content.length) return word;

  return katakanaToHiragana(
    content
      .map((token) => token.reading || token.pronunciation || token.surface_form)
      .join(""),
  );
}

/**
 * @param {string} text
 * @returns {Entry[]}
 */
function extractFuriganaEntries(text) {
  /** @type {Entry[]} */
  const entries = [];

  for (const line of text.split("\n")) {
    FURIGANA_RE.lastIndex = 0;
    let match;
    while ((match = FURIGANA_RE.exec(line)) !== null) {
      const word = match[1];
      const reading = match[2];
      if (!KANJI_RE.test(word)) continue;
      entries.push({
        word,
        reading,
        meanings: ["(name / reading from subtitles)"],
        jlpt: "Names",
        source: "furigana",
      });
    }
  }

  return entries;
}

/**
 * @param {string} cacheDir
 */
async function ensureKuromojiDict(cacheDir) {
  const dictDir = path.join(cacheDir, "kuromoji-dict");
  await fs.mkdir(dictDir, { recursive: true });

  for (const file of KUROMOJI_DICT_FILES) {
    const dest = path.join(dictDir, file);
    try {
      await fs.access(dest);
      continue;
    } catch {
      // download below
    }

    const url = `${KUROMOJI_DICT_CDN}/${file}`;
    process.stderr.write(`Downloading kuromoji dictionary: ${file}\n`);
    const res = await fetch(url, { headers: { "User-Agent": "srt-kanji-list/1.0" } });
    if (!res.ok) {
      throw new Error(`Failed to download kuromoji dict file (${url}): ${res.status}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.writeFile(dest, buf);
  }

  return dictDir;
}

/**
 * @param {string} dictDir
 * @returns {Promise<(text: string) => import("kuromoji").IpadicFeatures[]>}
 */
async function createTokenizer(dictDir) {
  const builder = await new Promise((resolve, reject) => {
    kuromoji.builder({ dicPath: dictDir }).build((err, tokenizer) => {
      if (err) reject(err);
      else resolve(tokenizer);
    });
  });

  return (text) => builder.tokenize(text);
}

/**
 * @param {import("kuromoji").IpadicFeatures[]} tokens
 * @param {(text: string) => import("kuromoji").IpadicFeatures[]} tokenize
 * @returns {Entry[]}
 */
function extractTokenEntries(tokens, tokenize) {
  /** @type {Map<string, Entry>} */
  const entries = new Map();

  for (const token of tokens) {
    const pos = token.pos.split(",")[0];
    if (!POS_ALLOW_RE.test(pos)) continue;

    const word = token.basic_form === "*" ? token.surface_form : token.basic_form;
    if (!word || word === "*") continue;
    if (!KANJI_RE.test(word)) continue;
    if (/^[ー・…]+$/.test(word)) continue;
    if (SKIP_WORD_RE.test(word)) continue;
    if (/^[一-龯]$/.test(word) && pos !== "名詞") continue;

    const reading = readingForWord(word, tokenize);

    if (!entries.has(word)) {
      entries.set(word, {
        word,
        reading,
        meanings: [],
        jlpt: "Other",
        source: "kuromoji",
      });
    }
  }

  return [...entries.values()];
}

/**
 * @param {{ meanings?: string[] }} entry
 */
function isFailedLookup(entry) {
  return entry.meanings?.some((m) => m === "(lookup failed)");
}

/**
 * @param {LookupResult} result
 */
function isUsableLookup(result) {
  return !result.meanings.some((m) =>
    ["(lookup failed)", "(no dictionary entry)"].includes(m),
  );
}

class LookupService {
  /**
   * @param {string} cacheDir
   * @param {SearchMode} mode
   */
  constructor(cacheDir, mode) {
    this.mode = mode;
    this.cacheDir = cacheDir;
    this.wordsPath = path.join(cacheDir, "words.json");
    this.kanjiPath = path.join(cacheDir, "kanji.json");
    /** @type {Record<string, LookupResult>} */
    this.words = {};
    /** @type {Record<string, { meanings: string[], jlpt: string | null }>} */
    this.kanji = {};
    /** @type {Record<string, number>} */
    this.kanjiLevels = {};
  }

  async load() {
    await fs.mkdir(this.cacheDir, { recursive: true });

    try {
      const raw = JSON.parse(await fs.readFile(this.wordsPath, "utf8"));
      this.words = Object.fromEntries(
        Object.entries(raw).filter(([, value]) => value && !isFailedLookup(value)),
      );
    } catch {
      this.words = {};
    }

    // Migrate legacy cache file from earlier script versions.
    if (!Object.keys(this.words).length) {
      try {
        const legacyPath = path.join(this.cacheDir, "jisho.json");
        const legacy = JSON.parse(await fs.readFile(legacyPath, "utf8"));
        this.words = Object.fromEntries(
          Object.entries(legacy)
            .filter(([, value]) => value && !isFailedLookup(value))
            .map(([word, value]) => [
              word,
              {
                word,
                reading: value.reading,
                meanings: value.meanings,
                jlpt: parseJlptLevel(value.jlpt) ?? value.jlpt ?? "Other",
                source: "jisho",
              },
            ]),
        );
      } catch {
        // no legacy cache
      }
    }

    try {
      this.kanji = JSON.parse(await fs.readFile(this.kanjiPath, "utf8"));
    } catch {
      this.kanji = {};
    }

    this.kanjiLevels = await this.loadKanjiLevels();
  }

  async save() {
    await fs.writeFile(this.wordsPath, JSON.stringify(this.words, null, 2), "utf8");
    await fs.writeFile(this.kanjiPath, JSON.stringify(this.kanji, null, 2), "utf8");
  }

  async loadKanjiLevels() {
    const cacheFile = path.join(this.cacheDir, "jlpt-kanji.json");
    try {
      return JSON.parse(await fs.readFile(cacheFile, "utf8"));
    } catch {
      // fall through
    }

    /** @type {Record<string, number>} */
    const mapping = {};
    try {
      for (const level of [5, 4, 3, 2, 1]) {
        const url = `https://kanjiapi.dev/v1/kanji/jlpt-${level}`;
        const res = await fetch(url, { headers: { "User-Agent": "srt-kanji-list/1.0" } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        /** @type {string[]} */
        const chars = await res.json();
        for (const ch of chars) {
          if (!(ch in mapping)) mapping[ch] = level;
        }
      }
      await fs.writeFile(cacheFile, JSON.stringify(mapping, null, 2), "utf8");
    } catch (err) {
      process.stderr.write(
        `Warning: could not fetch JLPT kanji lists (${err.message}). Using cached/per-kanji lookups only.\n`,
      );
      return {};
    }

    return mapping;
  }

  /**
   * @param {string} word
   * @param {Record<string, number>} kanjiLevels
   */
  inferJlptFromKanji(word, kanjiLevels = this.kanjiLevels) {
    /** @type {number[]} */
    const levels = [];
    for (const ch of word) {
      if (KANJI_RE.test(ch) && kanjiLevels[ch]) levels.push(kanjiLevels[ch]);
    }
    if (!levels.length) return "Other";
    return `N${Math.min(...levels)}`;
  }

  /**
   * @param {string} word
   * @param {string} fallbackReading
   * @param {(text: string) => import("kuromoji").IpadicFeatures[]} tokenize
   */
  async lookupWord(word, fallbackReading, tokenize) {
    const candidates = deconjugateCandidates(word);
    const primary = candidates[0] ?? word;

    if (this.mode === "quick") {
      return {
        word: primary,
        reading: readingForWord(primary, tokenize) || fallbackReading,
        meanings: ["(quick mode — no definition lookup)"],
        jlpt: this.inferJlptFromKanji(primary),
        source: "quick",
      };
    }

    for (const candidate of candidates) {
      if (candidate in this.words) {
        const cached = this.words[candidate];
        return { ...cached, word: cached.word || candidate };
      }
    }

    /** @type {LookupResult[]} */
    const results = [];

    if (this.mode === "normal" || this.mode === "full") {
      for (const candidate of candidates) {
        const jisho = await this.lookupJisho(candidate);
        if (jisho) results.push(jisho);
      }
    }

    if (this.mode === "full") {
      const reading = fallbackReading || readingForWord(primary, tokenize);
      if (reading) {
        const byReading = await this.lookupJishoByReading(reading, primary);
        if (byReading) results.push(byReading);
      }

      if (!results.some(isUsableLookup)) {
        const kanjiFallback = await this.lookupFromKanjiParts(primary, fallbackReading, tokenize);
        if (kanjiFallback) results.push(kanjiFallback);
      }
    }

    const best = pickBestLookup(results, primary, fallbackReading);
    if (best) {
      this.words[best.word] = best;
      return best;
    }

    const fallback = {
      word: primary,
      reading: fallbackReading || readingForWord(primary, tokenize),
      meanings: ["(no dictionary entry)"],
      jlpt: this.inferJlptFromKanji(primary),
      source: "fallback",
    };
    this.words[primary] = fallback;
    return fallback;
  }

  /**
   * @param {string} word
   * @returns {Promise<LookupResult | null>}
   */
  async lookupJisho(word) {
    const url = `https://jisho.org/api/v1/search/words?keyword=${encodeURIComponent(word)}`;
    const body = await this.fetchJson(url);
    if (!body) return null;

    const match = pickJishoMatch(body.data ?? [], word);
    if (!match) return null;

    const canonicalWord = match.japanese.find((j) => j.word)?.word ?? word;
    const reading = katakanaToHiragana(
      match.japanese[0]?.reading || match.japanese[0]?.word || word,
    );

    return {
      word: canonicalWord,
      reading,
      meanings: (match.senses ?? [])
        .flatMap((sense) => sense.english_definitions ?? [])
        .slice(0, 4),
      jlpt:
        parseJlptLevel(match.jlpt) ??
        this.inferJlptFromKanji(canonicalWord),
      source: "jisho",
    };
  }

  /**
   * @param {string} reading
   * @param {string} preferredWord
   * @returns {Promise<LookupResult | null>}
   */
  async lookupJishoByReading(reading, preferredWord) {
    const cacheKey = `#reading:${reading}`;
    if (cacheKey in this.words) return this.words[cacheKey];

    const url = `https://jisho.org/api/v1/search/words?keyword=${encodeURIComponent(reading)}`;
    const body = await this.fetchJson(url);
    if (!body) return null;

    const data = body.data ?? [];
    const match =
      data.find((item) => item.japanese?.some((j) => j.word === preferredWord)) ??
      data.find((item) => item.japanese?.some((j) => j.reading === reading && j.word)) ??
      data[0];

    if (!match) return null;

    const canonicalWord = match.japanese.find((j) => j.word)?.word ?? preferredWord;
    const result = {
      word: canonicalWord,
      reading: katakanaToHiragana(match.japanese[0]?.reading || reading),
      meanings: (match.senses ?? [])
        .flatMap((sense) => sense.english_definitions ?? [])
        .slice(0, 4),
      jlpt:
        parseJlptLevel(match.jlpt) ??
        this.inferJlptFromKanji(canonicalWord),
      source: "jisho-reading",
    };

    this.words[cacheKey] = result;
    return result;
  }

  /**
   * @param {string} word
   * @param {string} fallbackReading
   * @param {(text: string) => import("kuromoji").IpadicFeatures[]} tokenize
   */
  async lookupFromKanjiParts(word, fallbackReading, tokenize) {
    /** @type {string[]} */
    const meanings = [];
    /** @type {number[]} */
    const levels = [];

    for (const ch of word) {
      if (!KANJI_RE.test(ch)) continue;
      const info = await this.lookupKanjiChar(ch);
      if (info.meanings.length) meanings.push(`${ch}: ${info.meanings.slice(0, 2).join(", ")}`);
      const parsed = parseJlptLevel(info.jlpt);
      if (parsed) levels.push(Number(parsed.slice(1)));
      else if (this.kanjiLevels[ch]) levels.push(this.kanjiLevels[ch]);
    }

    if (!meanings.length && !levels.length) return null;

    return {
      word,
      reading: fallbackReading || readingForWord(word, tokenize),
      meanings: meanings.length
        ? [`(${meanings.slice(0, 3).join("; ")})`]
        : ["(kanji components only)"],
      jlpt: levels.length ? `N${Math.min(...levels)}` : this.inferJlptFromKanji(word),
      source: "kanjiapi",
    };
  }

  /**
   * @param {string} ch
   */
  async lookupKanjiChar(ch) {
    if (ch in this.kanji) return this.kanji[ch];

    const url = `https://kanjiapi.dev/v1/kanji/${encodeURIComponent(ch)}`;
    const info = await this.fetchJson(url);
    const result = {
      meanings: info?.meanings ?? [],
      jlpt: info?.jlpt ? `N${info.jlpt}` : this.kanjiLevels[ch] ? `N${this.kanjiLevels[ch]}` : null,
    };

    this.kanji[ch] = result;
    return result;
  }

  /**
   * @param {string} url
   */
  async fetchJson(url) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await sleep(this.mode === "full" ? 120 + attempt * 150 : 80 + attempt * 100);
      try {
        const res = await fetch(url, { headers: { "User-Agent": "srt-kanji-list/1.0" } });
        if (res.ok) return res.json();
      } catch {
        // retry
      }
    }
    return null;
  }
}

/**
 * @param {LookupResult[]} results
 * @param {string} preferredWord
 * @param {string} fallbackReading
 */
function pickBestLookup(results, preferredWord, fallbackReading) {
  if (!results.length) return null;

  const ranked = [...results].sort((a, b) => scoreLookup(b, preferredWord) - scoreLookup(a, preferredWord));
  const best = ranked[0];
  return {
    ...best,
    reading: best.reading || fallbackReading,
  };
}

/**
 * @param {LookupResult} result
 * @param {string} preferredWord
 */
function scoreLookup(result, preferredWord) {
  let score = 0;
  if (isUsableLookup(result)) score += 20;
  if (result.word === preferredWord) score += 10;
  if (result.source === "jisho") score += 5;
  if (result.jlpt !== "Other") score += 3;
  if (result.word.endsWith("する") && preferredWord.endsWith("す")) score += 2;
  if (!result.word.endsWith("れる") && !result.word.endsWith("せる")) score += 1;
  return score;
}

/**
 * @param {any[]} data
 * @param {string} word
 */
function pickJishoMatch(data, word) {
  const exactKanji = data.find((item) => item.japanese?.some((j) => j.word === word));
  if (exactKanji) return exactKanji;

  const exactReading = data.find((item) => item.japanese?.some((j) => j.reading === word));
  if (exactReading) return exactReading;

  const common = data.find((item) => item.is_common);
  if (common) return common;

  return data[0] ?? null;
}

/**
 * @param {Entry[]} entries
 * @param {LookupService} lookup
 * @param {(text: string) => import("kuromoji").IpadicFeatures[]} tokenize
 */
async function enrichEntries(entries, lookup, tokenize) {
  /** @type {Map<string, Entry>} */
  const merged = new Map();

  for (const entry of entries) {
    if (entry.source === "furigana") {
      merged.set(`name:${entry.word}`, entry);
      continue;
    }

    const lookedUp = await lookup.lookupWord(entry.word, entry.reading, tokenize);
    const key = lookedUp.word;

    if (merged.has(key)) continue;

    merged.set(key, {
      word: lookedUp.word,
      reading: lookedUp.reading,
      meanings: lookedUp.meanings,
      jlpt: lookedUp.jlpt,
      source: lookedUp.source,
    });
  }

  return [...merged.values()].sort((a, b) => a.word.localeCompare(b.word, "ja"));
}

/**
 * @param {string} srtPath
 * @param {Entry[]} entries
 * @param {SearchMode} searchMode
 */
function renderOutput(srtPath, entries, searchMode) {
  const baseName = path.basename(srtPath);
  const lines = [
    `${path.basename(srtPath, ".srt")} — Kanji/Vocabulary List`,
    "Anki format: Kanji | Reading(s) | Translation(s)",
    `Source: ${baseName}`,
    `Search mode: ${searchMode}`,
    "",
  ];

  /** @type {Map<string, Entry[]>} */
  const grouped = new Map(JLPT_ORDER.map((level) => [level, []]));
  for (const entry of entries) {
    const level = grouped.has(entry.jlpt) ? entry.jlpt : "Other";
    grouped.get(level).push(entry);
  }

  for (const level of JLPT_ORDER) {
    const items = grouped.get(level) ?? [];
    if (!items.length) continue;
    lines.push(`=== ${level} ===`);
    lines.push("Kanji\tReading(s)\tTranslation(s)");
    for (const item of items) {
      lines.push(`${item.word}\t${item.reading}\t${item.meanings.join("; ")}`);
    }
    lines.push("");
  }

  lines.push("Anki import tip: File → Import → Fields separated by Tab.");
  return lines.join("\n");
}

/**
 * @param {string} srtPath
 * @param {string} outputDir
 * @param {(text: string) => import("kuromoji").IpadicFeatures[]} tokenize
 * @param {LookupService} lookup
 * @param {SearchMode} searchMode
 */
async function processSrtFile(srtPath, outputDir, tokenize, lookup, searchMode) {
  const srtText = await fs.readFile(srtPath, "utf8");
  const dialogue = parseSrtDialogue(srtText);
  const furiganaEntries = extractFuriganaEntries(dialogue);
  const tokenEntries = extractTokenEntries(tokenize(dialogueForTokenization(dialogue)), tokenize);
  const entries = await enrichEntries([...furiganaEntries, ...tokenEntries], lookup, tokenize);

  const outName = `${path.basename(srtPath, ".srt")} - kanji list.txt`;
  const outPath = path.join(outputDir, outName);
  await fs.writeFile(outPath, renderOutput(srtPath, entries, searchMode), "utf8");
  return { outPath, count: entries.length };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const srtFiles = await collectSrtFiles(opts.srt);
  if (!srtFiles.length) {
    throw new Error(`No .srt files found in: ${opts.srt}`);
  }

  await fs.mkdir(opts.output, { recursive: true });

  const lookup = new LookupService(opts.cache, opts.search);
  await lookup.load();
  const dictDir = await ensureKuromojiDict(opts.cache);
  const tokenize = await createTokenizer(dictDir);

  for (const srtPath of srtFiles) {
    process.stdout.write(`Processing ${path.basename(srtPath)} [${opts.search}]... `);
    const { outPath, count } = await processSrtFile(
      srtPath,
      opts.output,
      tokenize,
      lookup,
      opts.search,
    );
    console.log(`wrote ${count} entries -> ${outPath}`);
  }

  await lookup.save();
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
