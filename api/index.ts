import express from "express";
import dotenv from "dotenv";
import { GoogleGenAI, ThinkingLevel } from "@google/genai";

// Load environment variables
dotenv.config();

const app = express();
app.use(express.json({ limit: "10mb" }));

// Helper sleep function
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ==========================================
// Robin Key Manager & Rotation Engine
// ==========================================
interface ApiKeyInfo {
  name: string;
  key: string;
  status: "Ready" | "Busy" | "Cooling Down" | "Disabled" | "Error";
  cooldownEnd: number;
  failureCount: number;
  lastUsed: number;
  errorMessage?: string;
}

interface CustomKeyState {
  key: string;
  maskedKey: string;
  status: "Ready" | "Cooling Down" | "Disabled";
  cooldownEnd: number;
  failureCount: number;
  lastUsed: number;
  errorMessage?: string;
}

// Global Custom Keys state cache
const customKeyStatesMap = new Map<string, CustomKeyState>();

function parseRetryDelayMs(errMessage: string): number | null {
  const match = errMessage.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/i);
  if (match) {
    return Math.ceil(parseFloat(match[1]) * 1000);
  }
  const secMatch = errMessage.match(/(\d+(?:\.\d+)?)\s*s(?:econds?)?/i);
  if (errMessage.includes("RESOURCE_EXHAUSTED") || errMessage.includes("429")) {
    if (secMatch) return Math.ceil(parseFloat(secMatch[1]) * 1000);
    return 10000;
  }
  return null;
}

function isQuotaError(errMessage: string): boolean {
  return (
    errMessage.includes("RESOURCE_EXHAUSTED") ||
    errMessage.includes("429") ||
    errMessage.includes("Quota exceeded") ||
    errMessage.includes("rate limit")
  );
}

function isPermanentKeyError(errMessage: string): boolean {
  return (
    errMessage.includes("API key not valid") ||
    errMessage.includes("API_KEY_INVALID") ||
    errMessage.includes("PERMISSION_DENIED") ||
    errMessage.includes("RESOURCE_PROJECT_INVALID")
  );
}

function getCustomKeyState(keyString: string): CustomKeyState {
  const key = keyString.trim();
  const maskedKey = key ? `${key.slice(0, 4)}...${key.slice(-4)}` : "None";
  let state = customKeyStatesMap.get(key);
  if (!state) {
    state = {
      key,
      maskedKey,
      status: "Ready",
      cooldownEnd: 0,
      failureCount: 0,
      lastUsed: 0,
    };
    customKeyStatesMap.set(key, state);
  }
  const now = Date.now();
  if (state.status === "Cooling Down" && now >= state.cooldownEnd) {
    state.status = "Ready";
    state.cooldownEnd = 0;
    state.errorMessage = undefined;
  }
  return state;
}

function recordCustomKeyError(state: CustomKeyState, errMessage: string): void {
  state.failureCount += 1;
  state.errorMessage = errMessage;
  const now = Date.now();

  if (isPermanentKeyError(errMessage)) {
    state.status = "Disabled";
    state.cooldownEnd = Infinity;
    console.warn(`[ROBIN-CUSTOM] Key ${state.maskedKey} permanently disabled.`);
    return;
  }

  const retryDelay = parseRetryDelayMs(errMessage);
  if (retryDelay !== null) {
    state.status = "Cooling Down";
    state.cooldownEnd = now + retryDelay + 2000;
  } else if (isQuotaError(errMessage)) {
    state.status = "Cooling Down";
    const backoff = Math.min(60000, Math.max(10000, state.failureCount * 10000));
    state.cooldownEnd = now + backoff;
  } else {
    state.status = "Cooling Down";
    state.cooldownEnd = now + 10000;
  }
  console.warn(`[ROBIN-CUSTOM] Key ${state.maskedKey} cooling down until +${Math.ceil((state.cooldownEnd - now) / 1000)}s.`);
}

function recordCustomKeySuccess(state: CustomKeyState): void {
  state.status = "Ready";
  state.errorMessage = undefined;
}

export class RobinKeyManager {
  private keys: ApiKeyInfo[] = [];
  private rrCursor: number = 0;

  constructor() {}

  public initializeFromEnv(): void {
    const existingMap = new Map<string, ApiKeyInfo>();
    for (const k of this.keys) {
      existingMap.set(k.name, k);
    }

    const newKeys: ApiKeyInfo[] = [];

    if (process.env.GEMINI_API_KEY) {
      const existing = existingMap.get("GEMINI_API_KEY");
      newKeys.push(
        existing || {
          name: "GEMINI_API_KEY",
          key: process.env.GEMINI_API_KEY,
          status: "Ready",
          cooldownEnd: 0,
          failureCount: 0,
          lastUsed: 0,
        }
      );
    }

    for (const envName in process.env) {
      if (envName.startsWith("GEMINI_API_KEY_") && process.env[envName]) {
        const val = process.env[envName] || "";
        const existing = existingMap.get(envName);
        newKeys.push(
          existing || {
            name: envName,
            key: val,
            status: "Ready",
            cooldownEnd: 0,
            failureCount: 0,
            lastUsed: 0,
          }
        );
      }
    }

    this.keys = newKeys;
    console.log(`[ROBIN] Initialized with ${this.keys.length} server API key(s).`);
  }

  private refreshStatuses(): void {
    const now = Date.now();
    for (const info of this.keys) {
      if (info.status === "Cooling Down" && now >= info.cooldownEnd) {
        info.status = "Ready";
        info.cooldownEnd = 0;
        info.errorMessage = undefined;
      }
    }
  }

  public getNextReadyKey(): ApiKeyInfo | null {
    this.refreshStatuses();
    if (this.keys.length === 0) return null;

    const len = this.keys.length;
    for (let i = 0; i < len; i++) {
      const idx = (this.rrCursor + i) % len;
      const candidate = this.keys[idx];
      if (candidate.status === "Ready") {
        this.rrCursor = (idx + 1) % len;
        candidate.lastUsed = Date.now();
        return candidate;
      }
    }
    return null;
  }

  public recordError(keyInfo: ApiKeyInfo, errMessage: string): void {
    keyInfo.failureCount += 1;
    keyInfo.errorMessage = errMessage;
    const now = Date.now();

    if (isPermanentKeyError(errMessage)) {
      keyInfo.status = "Disabled";
      keyInfo.cooldownEnd = Infinity;
      console.warn(`[ROBIN] Server key ${keyInfo.name} permanently disabled (invalid key / permission error).`);
      return;
    }

    const retryDelay = parseRetryDelayMs(errMessage);
    if (retryDelay !== null) {
      keyInfo.status = "Cooling Down";
      keyInfo.cooldownEnd = now + retryDelay + 2000;
    } else if (isQuotaError(errMessage)) {
      keyInfo.status = "Cooling Down";
      const backoff = Math.min(60000, Math.max(10000, keyInfo.failureCount * 10000));
      keyInfo.cooldownEnd = now + backoff;
    } else {
      keyInfo.status = "Cooling Down";
      keyInfo.cooldownEnd = now + 10000;
    }
    console.warn(`[ROBIN] Server key ${keyInfo.name} cooling down until +${Math.ceil((keyInfo.cooldownEnd - now) / 1000)}s.`);
  }

  public recordSuccess(keyInfo: ApiKeyInfo): void {
    keyInfo.status = "Ready";
    keyInfo.errorMessage = undefined;
  }

  public getKeysStatusMatrix() {
    this.refreshStatuses();
    const now = Date.now();
    return this.keys.map((info) => {
      let currentStatus = info.status;
      let timeRemaining = 0;
      if (info.status === "Cooling Down") {
        if (now >= info.cooldownEnd) {
          currentStatus = "Ready";
        } else {
          timeRemaining = Math.ceil((info.cooldownEnd - now) / 1000);
        }
      }
      return {
        name: info.name,
        maskedKey: info.key ? `${info.key.slice(0, 4)}...${info.key.slice(-4)}` : "None",
        status: currentStatus,
        timeRemaining,
        failureCount: info.failureCount,
        lastUsed: info.lastUsed ? new Date(info.lastUsed).toISOString() : "Never",
        errorMessage: info.errorMessage,
      };
    });
  }

  public getKeysCount(): number {
    return this.keys.length;
  }
}

const robinServerManager = new RobinKeyManager();
robinServerManager.initializeFromEnv();

// ==========================================
// Spintax Helper: Parser/Resolver for Previews
// ==========================================
function resolveSpintax(text: string, previewNum: number): string {
  let resolved = text;
  const maxIterations = 500;
  let iteration = 0;
  let blockCounter = 0;

  while (iteration < maxIterations) {
    const match = resolved.match(/\{([^{}]+)\}/);
    if (!match) break;

    const fullMatch = match[0];
    const rawOptions = match[1].split("|").map(o => o.trim()).filter(o => o.length > 0);
    // Remove duplicate options
    const options = Array.from(new Set(rawOptions));
    if (options.length === 0) options.push("");

    // Calculate index with offset so preview 1, 2, and 3 vary even for 2-option blocks
    let offset = previewNum - 1;
    if (previewNum === 3 && options.length === 2) {
      offset = blockCounter % 2 === 0 ? 1 : 0;
    }

    const chosenIndex = (blockCounter + offset) % options.length;
    const replacement = options[chosenIndex] || options[0] || "";
    resolved = resolved.replace(fullMatch, replacement);
    blockCounter++;
    iteration++;
  }

  return resolved;
}

// Deterministic post-processing for AI punctuation artifacts
function sanitizeSpintaxText(text: string): string {
  // Replace em dash (—) and en dash (–) with comma
  let cleaned = text.replace(/\s*[—–]\s*/g, ", ");
  // Fix double commas if created
  cleaned = cleaned.replace(/,\s*,/g, ",");
  return cleaned;
}

// Document-level rolling style memory tracker
interface StyleMemory {
  rhetoricalPatternCount: number;
  kamiCount: number;
  totalWordCount: number;
}

function buildStyleMemoryNote(memory: StyleMemory): string {
  if (memory.totalWordCount < 50) return "";
  const kamiDensity = memory.totalWordCount > 0 ? memory.kamiCount / memory.totalWordCount : 0;
  const notes: string[] = [];

  if (memory.rhetoricalPatternCount >= 1) {
    notes.push("Pola kontras 'bukan X, melainkan Y' / 'bukan sekadar' sudah pernah dipakai di paragraf sebelumnya. Hindari memakainya lagi di paragraf ini, gunakan konstruksi lain (seperti 'selain itu', 'karena itu', atau kalimat deklaratif biasa).");
  }

  if (kamiDensity > 0.03) {
    notes.push("Kata 'kami' sudah cukup padat dipakai di paragraf sebelumnya. Kurangi frekuensinya di paragraf ini, variasikan dengan nama perusahaan, 'tim kami', atau kalimat pasif.");
  }

  if (notes.length === 0) return "";
  return "\n\nCATATAN GAYA DOKUMEN (dari paragraf-paragraf sebelumnya, agar tidak monoton):\n- " + notes.join("\n- ");
}

function updateStyleMemory(memory: StyleMemory, text: string) {
  const words = text.split(/\s+/).filter(Boolean);
  memory.totalWordCount += words.length;

  const rhetoricalMatches = (text.match(/bukan\s+(?:sekadar|hanya|cuma)|melainkan/gi) || []).length;
  memory.rhetoricalPatternCount += rhetoricalMatches;

  const kamiMatches = (text.match(/\bkami\b/gi) || []).length;
  memory.kamiCount += kamiMatches;
}

// ==========================================
// System Instruction & Validation Helpers
// ==========================================

function buildSystemInstruction(protectedKeywords: string[], fileType: string): string {
  const keywordsString = protectedKeywords.length > 0 ? protectedKeywords.join(", ") : "None";
  return `You are an expert SEO Content Writer and AI Spintax Specialist.
Your task is to convert the provided paragraph of text into high-quality, human-friendly Contextual Spintax.

### ATURAN KERAS (wajib dipatuhi tanpa pengecualian):

HARD RULE 1 — HUMAN-READABLE: Every resolved version of the output (any combination of chosen options) must read as natural, fluent, human-friendly text. Never produce awkward, robotic, or grammatically broken sentences just to create variation.

HARD RULE 2 — FULL COVERAGE: Every single sentence in the input, without exception, must be converted into a spintax block. This applies equally to long paragraphs, short paragraphs, single-sentence paragraphs, CTAs, contact/closing lines, and list-style statements. Returning any sentence as plain, unspun text is NEVER allowed, regardless of how short or simple it is.

HARD RULE 3 — SENTENCE-LEVEL GRANULARITY ONLY: The unit of spintax is the FULL SENTENCE, never a single word and never a sub-sentence phrase/clause. For every sentence in the input:
   - Produce exactly ONE spintax block per sentence: \`{variasi kalimat 1|variasi kalimat 2|variasi kalimat 3}\`.
   - Each option inside the block must be a complete, independently readable rewrite of that whole sentence (not a word, not a synonym swap, not a partial clause).
   - Each block must contain 2 to 3 sentence-level variations. Do not go below 2 or above 3.
   - Do NOT split one sentence into multiple smaller spintax blocks. Do NOT wrap only part of a sentence (e.g. just the opening clause) while leaving the rest of that same sentence unspun outside the block — the entire sentence's text must live inside the single block's options.
   - Do NOT perform word-by-word synonym replacement. Each option is a full alternative phrasing of the entire sentence, natural and elegant to read.

### Aturan Pendukung:
A. FORMAT: Use standard spintax format \`{option1|option2|option3}\`. Never produce nested spintax (a \`{...}\` block inside another \`{...}\` block).
B. PRESERVE MEANING: Keep the original meaning, facts, names, numbers, and important information exactly. Do not add or remove facts, or change context.
C. KEYWORD PROTECTION:
   The following keywords are strictly protected: [${keywordsString}]
   These protected keywords MUST remain exactly as-is in every option of every block. Do NOT translate them, do NOT replace them with synonyms, do NOT change their spelling, casing, or word order.
   Protected keywords must NEVER appear as one of multiple options inside a spin block alongside a synonym or alternative phrasing — they must appear identically across every option of the sentence's block.
D. NO AI-STYLE PUNCTUATION: Never use the em dash (—) or en dash (–) to connect clauses. Rewrite using a comma, period, colon, or a natural connecting word instead. This applies to every option inside every block.
E. HTML/MARKDOWN PROTECTION (Input Type: ${fileType}):
   - If the input contains HTML tags (e.g. <h1>, <strong>, <a>, <img ...>, etc.) or Markdown syntax (e.g. #, **, *, [text](url), etc.), you MUST preserve all tags, attributes, and syntax symbols exactly, outside the spun sentence text.
   - Only spin the sentence text itself. Do NOT spin or alter the tags, tag attributes (like href, src, etc.), or Markdown syntax symbols.
F. PARAGRAPH STRUCTURE: Return the entire paragraph with the spintax embedded, keeping the original paragraph structure and sentence order intact. Do not add extra comments, markdown formatting around the output, or explanations. Only return the processed text.
G. RHETORICAL VARIETY: Do not rely on the same contrastive sentence pattern (e.g. "bukan X, melainkan Y" / "bukan sekadar X, tapi Y") for more than one sentence's block within a single paragraph you are processing. Vary constructions across additive ("selain itu"), causal ("karena itu"), sequential ("setelah itu"), or plain declarative sentences instead.
H. OPTION LENGTH BALANCE: Within a single spintax block, keep the word count of the longest option no more than roughly 1.8x the word count of the shortest option.
I. SUBJECT VARIATION: If the source text repeatedly uses the first-person plural pronoun ("kami"/"we") as the sentence subject, vary it occasionally across options within a block — e.g. alternate between "kami", the company name, "tim kami", or a passive construction — as long as meaning and protected keywords are preserved. Do not force this if it makes the sentence unnatural.`;
}

// ------------------------------------------
// Detailed Code-Level Quality Checkers
// ------------------------------------------

// Checker 1: Detect duplicate options within a single block
function checkDuplicateOptions(text: string): string[] {
  const issues: string[] = [];
  const blockRegex = /\{([^{}]+)\}/g;
  let m: RegExpExecArray | null;

  while ((m = blockRegex.exec(text)) !== null) {
    const opts = m[1].split("|").map((o) => o.trim().toLowerCase()).filter((o) => o.length > 0);
    const unique = new Set(opts);
    if (unique.size < opts.length) {
      issues.push(`Blok spintax mengandung opsi duplikat: "{${m[1]}}"`);
    }
  }

  return issues;
}

// Checker 3: Detect option length imbalance (> 2.2x ratio)
function checkOptionLengthBalance(text: string, maxRatio = 2.2): string[] {
  const issues: string[] = [];
  const blockRegex = /\{([^{}]+)\}/g;
  let m: RegExpExecArray | null;

  while ((m = blockRegex.exec(text)) !== null) {
    const opts = m[1].split("|").map((o) => o.trim()).filter((o) => o.length > 0);
    const counts = opts.map((o) => o.split(/\s+/).filter(Boolean).length).filter((c) => c > 0);
    if (counts.length < 2) continue;

    const minLen = Math.min(...counts);
    const maxLen = Math.max(...counts);

    if (minLen > 0 && maxLen / minLen > maxRatio) {
      const ratio = (maxLen / minLen).toFixed(1);
      issues.push(`Blok spintax punya opsi dengan rasio panjang ${ratio}x: "{${m[1]}}"`);
    }
  }

  return issues;
}

// Checker 4: Detect rhetorical overuse in a single chunk
function checkRhetoricalOveruse(text: string): string[] {
  const markers = ["bukan sekadar", "bukan hanya", "melainkan"];
  let count = 0;
  for (const marker of markers) {
    const regex = new RegExp(marker, "gi");
    count += (text.match(regex) || []).length;
  }
  if (count > 1) {
    return [`Pola kontras "bukan/melainkan" muncul ${count}x dalam satu chunk, sebaiknya maksimal 1x.`];
  }
  return [];
}

// Post-generation validation
function validateSpintaxOutput(
  original: string,
  output: string,
  protectedKeywords: string[],
  fileType: string
): { ok: boolean; issues: string[] } {
  const issues: string[] = [];

  // 1. Check balanced braces
  const openBraces = (output.match(/\{/g) || []).length;
  const closeBraces = (output.match(/\}/g) || []).length;
  if (openBraces !== closeBraces) {
    issues.push(`Sintaks spintax tidak seimbang (jumlah '{' (${openBraces}) dan '}' (${closeBraces}) tidak sama).`);
  }

  // 2. Mandatory spintax coverage check
  if (original.length > 30 && !output.includes("{")) {
    issues.push("Paragraf tidak mengandung blok spintax sama sekali (0 variasi).");
  }

  // 3. Check protected keywords presence & fixed position outside spintax blocks
  const unspunText = output.replace(/\{[^{}]+\}/g, "");
  for (const kw of protectedKeywords) {
    if (kw.trim().length > 0) {
      if (!output.includes(kw)) {
        issues.push(`Kata kunci terproteksi "${kw}" tidak ditemukan pada hasil spintax.`);
      } else if (!unspunText.includes(kw)) {
        issues.push(`Kata kunci terproteksi "${kw}" diletakkan di dalam opsi spintax {option1|option2}, bukan sebagai teks tetap.`);
      }
    }
  }

  // 4. Check HTML tags preservation
  if (fileType === "html") {
    const htmlTagRegex = /<[a-zA-Z][^>]*>/g;
    const origTags = (original.match(htmlTagRegex) || []).length;
    const outTags = (output.match(htmlTagRegex) || []).length;

    if (origTags > 0 && outTags < origTags) {
      const dropRatio = (origTags - outTags) / origTags;
      if (dropRatio > 0.1 || (origTags - outTags) >= 2) {
        issues.push(`Jumlah tag HTML berkurang dari ${origTags} menjadi ${outTags}.`);
      }
    }
  }

  // 5. Code-Level Quality Checkers (Duplicates, Imbalance, Rhetorical overuse)
  const dupIssues = checkDuplicateOptions(output);
  const lenIssues = checkOptionLengthBalance(output);
  const rhetoricalIssues = checkRhetoricalOveruse(output);

  issues.push(...dupIssues, ...lenIssues, ...rhetoricalIssues);

  return {
    ok: issues.length === 0,
    issues,
  };
}

// Smart Chunking Helper
function splitParagraphs(text: string, fileType: string): string[] {
  // 1. Initial split by double newlines
  const initialChunks = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const refinedChunks: string[] = [];

  for (const chunk of initialChunks) {
    if (fileType === "html") {
      // Split by top-level HTML block element boundaries if multiple exist
      const blockTagRegex = /<\/(?:p|h[1-6]|li|div|section|article|header|footer|aside|blockquote)>/gi;
      const matches = Array.from(chunk.matchAll(blockTagRegex));

      if (matches.length > 1) {
        let lastIndex = 0;
        for (let i = 0; i < matches.length; i++) {
          const matchEnd = matches[i].index! + matches[i][0].length;
          const subBlock = chunk.slice(lastIndex, matchEnd).trim();
          if (subBlock.length > 0) {
            refinedChunks.push(subBlock);
          }
          lastIndex = matchEnd;
        }
        const remaining = chunk.slice(lastIndex).trim();
        if (remaining.length > 0) {
          refinedChunks.push(remaining);
        }
      } else {
        refinedChunks.push(chunk);
      }
    } else {
      refinedChunks.push(chunk);
    }
  }

  // 2. Enforce hard max length limit per chunk (~4000 chars)
  const finalChunks: string[] = [];
  const MAX_CHUNK_LEN = 4000;

  for (const chunk of refinedChunks) {
    if (chunk.length <= MAX_CHUNK_LEN) {
      finalChunks.push(chunk);
    } else {
      // Split long chunk by sentence endings, punctuation or linebreaks
      const sentences = chunk
        .split(/(?<=[.!?]\s+|\n|<\/p>|<\/div>)/g)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      let currentSub = "";
      for (const sentence of sentences) {
        if ((currentSub + " " + sentence).length > MAX_CHUNK_LEN && currentSub.length > 0) {
          finalChunks.push(currentSub.trim());
          currentSub = sentence;
        } else {
          currentSub = currentSub ? currentSub + " " + sentence : sentence;
        }
      }
      if (currentSub.trim().length > 0) {
        finalChunks.push(currentSub.trim());
      }
    }
  }

  return finalChunks;
}

// Concurrency worker queue
async function processWithConcurrencyLimit<T, R>(
  items: T[],
  limit: number,
  processFn: (item: T, index: number) => Promise<R>
): Promise<Array<{ status: "fulfilled"; value: R } | { status: "rejected"; reason: any }>> {
  const results: Array<{ status: "fulfilled"; value: R } | { status: "rejected"; reason: any }> = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        const val = await processFn(items[index], index);
        results[index] = { status: "fulfilled", value: val };
      } catch (err) {
        results[index] = { status: "rejected", reason: err };
      }
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);
  return results;
}

// Classify validation issues into critical (must fix) vs soft (best-effort)
function classifyIssues(issues: string[]): { critical: string[]; soft: string[] } {
  const critical: string[] = [];
  const soft: string[] = [];
  for (const issue of issues) {
    const isCritical =
      issue.includes("tidak mengandung blok spintax sama sekali") ||
      issue.includes("tidak seimbang") ||
      issue.includes("Kata kunci terproteksi") ||
      issue.includes("Jumlah tag HTML berkurang");
    (isCritical ? critical : soft).push(issue);
  }
  return { critical, soft };
}

function buildCorrectionPrompt(base: string, criticalIssues: string[], isFinalAttempt: boolean): string {
  const urgencyNote = isFinalAttempt
    ? "PERINGATAN: INI PERCOBAAN TERAKHIR. Anda WAJIB menghasilkan minimal 1 blok spintax {opsi1|opsi2} di paragraf ini walau hanya membungkus satu klausa pendek. JANGAN kembalikan teks polos tanpa kurung kurawal apapun alasannya, termasuk karena paragrafnya pendek atau berupa CTA/kontak."
    : "Perbaiki pelanggaran berikut sebelum mengembalikan hasil.";
  return `${base}\n\nCATATAN PERBAIKAN:\n${urgencyNote}\n- ${criticalIssues.join("\n- ")}\nTulis ulang dan pastikan SEMUA aturan dipatuhi, terutama poin di atas.`;
}

const FALLBACK_SYNONYM_PAIRS: [RegExp, string[]][] = [
  [/\bKami\b/, ["Kami", "Tim kami"]],
  [/\bkami\b/, ["kami", "tim kami"]],
  [/\bJika Anda\b/, ["Jika Anda", "Bila Anda", "Apabila Anda"]],
  [/\bAnda\b/, ["Anda", "Bapak/Ibu"]],
  [/\bsedang\b/, ["sedang", "tengah"]],
  [/\bkembali\b/, ["kembali", "lagi"]],
  [/\bmenjadi\b/, ["menjadi", "sebagai"]],
];

function forceMinimalSpintaxFallback(text: string): { text: string; patched: boolean } {
  for (const [pattern, options] of FALLBACK_SYNONYM_PAIRS) {
    const match = text.match(pattern);
    if (match && match.index !== undefined) {
      const block = `{${options.join("|")}}`;
      const patched = text.slice(0, match.index) + block + text.slice(match.index + match[0].length);
      return { text: patched, patched: true };
    }
  }
  return { text, patched: false };
}

// Execution with validation and retry with issue escalation
async function executeWithValidationAndRetry(
  ai: GoogleGenAI,
  model: string,
  paragraphText: string,
  systemInstruction: string,
  protectedKeywords: string[],
  fileType: string,
  styleNote = ""
): Promise<{
  spintaxText: string;
  validationIssues: string[];
  autoPatched: boolean;
  criticalUnresolved: boolean;
}> {
  const promptContents = styleNote
    ? `"""\n${paragraphText}\n"""${styleNote}`
    : `"""\n${paragraphText}\n"""`;

  // Use ThinkingLevel.MEDIUM for the initial pass to allow mental cross-block checks
  const response = await ai.models.generateContent({
    model: model,
    contents: promptContents,
    config: {
      systemInstruction: systemInstruction,
      temperature: 0.7,
      thinkingConfig: {
        thinkingLevel: ThinkingLevel.MEDIUM,
      },
    },
  });

  const candidate = response.candidates?.[0];
  const finishReason = candidate?.finishReason;
  let spintaxText = (response.text || "").trim();

  if (finishReason && finishReason !== "STOP") {
    throw new Error(`Gemini API finishReason is "${finishReason}". Processing was incomplete or blocked.`);
  }

  if (spintaxText.length === 0) {
    throw new Error("Gemini API returned an empty text response.");
  }

  if (paragraphText.length > 50 && spintaxText.length < Math.floor(paragraphText.length * 0.25)) {
    throw new Error(`Output spintax text length (${spintaxText.length} chars) is severely truncated compared to original (${paragraphText.length} chars).`);
  }

  spintaxText = sanitizeSpintaxText(spintaxText);
  let validation = validateSpintaxOutput(paragraphText, spintaxText, protectedKeywords, fileType);
  let { critical, soft } = classifyIssues(validation.issues);

  const MAX_ATTEMPTS = 3; // 1 initial + up to 2 correction retries for critical issues
  let attempt = 1;
  let currentText = spintaxText;

  while (critical.length > 0 && attempt < MAX_ATTEMPTS) {
    attempt++;
    const isFinalAttempt = attempt === MAX_ATTEMPTS;
    const correctionPrompt = buildCorrectionPrompt(promptContents, critical, isFinalAttempt);

    try {
      console.warn(`Spintax critical issues detected (Attempt ${attempt}/${MAX_ATTEMPTS}). Retrying:`, critical);

      const retryResponse = await ai.models.generateContent({
        model: model,
        contents: correctionPrompt,
        config: {
          systemInstruction: systemInstruction,
          temperature: isFinalAttempt ? 0.4 : 0.7,
          thinkingConfig: {
            thinkingLevel: ThinkingLevel.MEDIUM,
          },
        },
      });

      const retryCandidate = retryResponse.candidates?.[0];
      if (retryCandidate?.finishReason === "STOP" && retryResponse.text?.trim()) {
        const retrySpintax = sanitizeSpintaxText(retryResponse.text.trim());
        const retryVal = validateSpintaxOutput(paragraphText, retrySpintax, protectedKeywords, fileType);
        const retryClassified = classifyIssues(retryVal.issues);

        if (retryVal.ok || retryClassified.critical.length < critical.length || retryVal.issues.length < validation.issues.length) {
          currentText = retrySpintax;
          validation = retryVal;
          critical = retryClassified.critical;
          soft = retryClassified.soft;
        }
      }
    } catch (retryErr) {
      console.warn(`Correction retry attempt ${attempt} failed:`, retryErr);
    }
  }

  // Deterministic Fallback if 0 spintax issue persists
  let autoPatched = false;
  if (critical.some((i) => i.includes("tidak mengandung blok spintax sama sekali"))) {
    const fallback = forceMinimalSpintaxFallback(currentText);
    if (fallback.patched) {
      currentText = fallback.text;
      autoPatched = true;
      critical = critical.filter((i) => !i.includes("tidak mengandung blok spintax sama sekali"));
    }
  }

  return {
    spintaxText: currentText,
    validationIssues: [...critical, ...soft],
    autoPatched,
    criticalUnresolved: critical.length > 0,
  };
}

// ==========================================
// Gemini API Generator with Robin Failover
// ==========================================
async function generateSpintaxWithFailover(
  paragraphText: string,
  protectedKeywords: string[],
  fileType: string,
  customApiKeys?: string[],
  initialKeyIndex = 0,
  styleNote = ""
): Promise<{
  spintaxText: string;
  debugLogs: any[];
  validationIssues: string[];
  autoPatched: boolean;
  criticalUnresolved: boolean;
}> {
  const model = process.env.GEMINI_MODEL || "gemini-flash-latest";
  const systemInstruction = buildSystemInstruction(protectedKeywords, fileType);

  // If custom API keys are provided, perform Robin round-robin rotation & failover among them
  if (customApiKeys && customApiKeys.length > 0) {
    const activeKeys = customApiKeys.map(k => k.trim()).filter(k => k.length > 0);
    if (activeKeys.length > 0) {
      let attempt = 0;
      const maxAttempts = activeKeys.length;
      const debugLogs: any[] = [];

      while (attempt < maxAttempts) {
        const keyIdx = (initialKeyIndex + attempt) % activeKeys.length;
        const currentKey = activeKeys[keyIdx];
        const keyState = getCustomKeyState(currentKey);

        if (keyState.status === "Disabled" || keyState.status === "Cooling Down") {
          console.warn(`[ROBIN-CUSTOM] Key ${keyIdx + 1} (${keyState.maskedKey}) is ${keyState.status}. Failing over to next key immediately.`);
          attempt++;
          continue;
        }

        keyState.lastUsed = Date.now();
        const startTime = Date.now();

        try {
          const ai = new GoogleGenAI({
            apiKey: keyState.key,
            httpOptions: {
              headers: {
                "User-Agent": "aistudio-build",
              },
            },
          });

          const { spintaxText, validationIssues, autoPatched, criticalUnresolved } = await executeWithValidationAndRetry(
            ai,
            model,
            paragraphText,
            systemInstruction,
            protectedKeywords,
            fileType,
            styleNote
          );

          recordCustomKeySuccess(keyState);
          const duration = Date.now() - startTime;

          debugLogs.push({
            time: new Date().toISOString(),
            apiKeyName: `KUNCI_PRIBADI_${keyIdx + 1}`,
            maskedKey: keyState.maskedKey,
            model,
            durationMs: duration,
            status: "Success",
            attempt: attempt + 1,
            validationIssues,
          });

          return {
            spintaxText,
            debugLogs,
            validationIssues,
            autoPatched,
            criticalUnresolved,
          };
        } catch (err: any) {
          const duration = Date.now() - startTime;
          const errMsg = err.message || "Unknown Gemini API Error";

          recordCustomKeyError(keyState, errMsg);

          debugLogs.push({
            time: new Date().toISOString(),
            apiKeyName: `KUNCI_PRIBADI_${keyIdx + 1}`,
            maskedKey: keyState.maskedKey,
            model,
            durationMs: duration,
            status: "Failover",
            error: errMsg,
            attempt: attempt + 1,
          });

          console.warn(`[ROBIN-CUSTOM] Private API Key ${keyIdx + 1} failed. Error: ${errMsg}. Failing over to next key.`);
          attempt++;
        }
      }
      throw new Error(`Semua ${maxAttempts} Kunci API Pribadi Anda gagal, disabled, atau sedang Cooling Down.`);
    }
  }

  // Default server API keys flow managed by RobinKeyManager
  const serverKeyCount = robinServerManager.getKeysCount();
  if (serverKeyCount === 0) {
    throw new Error("No Gemini API Keys are configured. Please define GEMINI_API_KEY in Settings > Secrets.");
  }

  let attempt = 0;
  const maxAttempts = serverKeyCount;
  const debugLogs: any[] = [];

  while (attempt < maxAttempts) {
    const keyInfo = robinServerManager.getNextReadyKey();
    if (!keyInfo) {
      throw new Error("All configured Gemini API keys are currently Cooling Down or Disabled due to rate limits or invalid key errors.");
    }

    const startTime = Date.now();

    try {
      const ai = new GoogleGenAI({
        apiKey: keyInfo.key,
        httpOptions: {
          headers: {
            "User-Agent": "aistudio-build",
          },
        },
      });

      const { spintaxText, validationIssues, autoPatched, criticalUnresolved } = await executeWithValidationAndRetry(
        ai,
        model,
        paragraphText,
        systemInstruction,
        protectedKeywords,
        fileType,
        styleNote
      );

      robinServerManager.recordSuccess(keyInfo);
      const duration = Date.now() - startTime;

      debugLogs.push({
        time: new Date().toISOString(),
        apiKeyName: keyInfo.name,
        maskedKey: keyInfo.key ? `${keyInfo.key.slice(0, 4)}...${keyInfo.key.slice(-4)}` : "None",
        model,
        durationMs: duration,
        status: "Success",
        attempt: attempt + 1,
        validationIssues,
      });

      return {
        spintaxText,
        debugLogs,
        validationIssues,
        autoPatched,
        criticalUnresolved,
      };
    } catch (err: any) {
      const duration = Date.now() - startTime;
      const errMsg = err.message || "Unknown Gemini API Error";

      robinServerManager.recordError(keyInfo, errMsg);

      debugLogs.push({
        time: new Date().toISOString(),
        apiKeyName: keyInfo.name,
        maskedKey: keyInfo.key ? `${keyInfo.key.slice(0, 4)}...${keyInfo.key.slice(-4)}` : "None",
        model,
        durationMs: duration,
        status: "Failover",
        error: errMsg,
        attempt: attempt + 1,
      });

      console.warn(`[ROBIN] Server API Key ${keyInfo.name} failed (Attempt ${attempt + 1}). Error: ${errMsg}. Failing over to next key.`);
      attempt++;
    }
  }

  throw new Error(`Failed to generate spintax after ${maxAttempts} attempts. All tested API keys failed or rate-limited.`);
}

// ==========================================
// API Endpoints
// ==========================================

// Get Health Check Status of API Keys
app.get("/api/keys-health", (req, res) => {
  try {
    res.json({
      status: "ok",
      keys: robinServerManager.getKeysStatusMatrix(),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Force refresh/reload keys
app.post("/api/keys-refresh", (req, res) => {
  try {
    robinServerManager.initializeFromEnv();
    res.json({
      status: "refreshed",
      keys: robinServerManager.getKeysStatusMatrix(),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Main Generation API Endpoint
app.post("/api/generate-spintax", async (req, res) => {
  const { text, keywords = [], fileType = "text", customApiKey, customApiKeys } = req.body;

  let resolvedCustomKeys: string[] = [];

  // Parse customApiKeys array if provided
  if (Array.isArray(customApiKeys)) {
    resolvedCustomKeys = customApiKeys.map(k => String(k).trim()).filter(k => k.length > 0);
  } else {
    // Fallback to checking customApiKey string (supporting comma/newline split) or header
    const rawKeyInput = (typeof customApiKey === "string" && customApiKey.trim().length > 0)
      ? customApiKey.trim()
      : (req.headers["x-custom-api-key"] as string || "").trim();

    if (rawKeyInput) {
      resolvedCustomKeys = rawKeyInput
        .split(/[\s,;\n\r]+/)
        .map(k => k.trim())
        .filter(k => k.length > 0);
    }
  }

  if (!text || typeof text !== "string") {
    return res.status(400).json({ error: "Input text is required" });
  }

  const startTime = Date.now();
  
  const formattedKeywords = Array.isArray(keywords)
    ? keywords.map((k: string) => String(k).trim()).filter((k: string) => k.length > 0)
    : [];

  const chunks = splitParagraphs(text, fileType);

  if (chunks.length === 0) {
    return res.status(400).json({ error: "Input text has no readable paragraphs or chunks" });
  }

  let partialFailures = 0;
  let autoPatchedChunks = 0;
  let criticalIssueChunks = 0;
  const allLogs: any[] = [];
  const processedChunks: string[] = [];
  const allValidationIssues: string[] = [];

  const activeKeyCount = resolvedCustomKeys.length > 0 ? resolvedCustomKeys.length : Math.max(1, robinServerManager.getKeysCount());
  // Cap worker concurrency to Math.min(activeKeyCount, 3) to prevent bursting free-tier API quotas
  const concurrencyLimit = Math.max(1, Math.min(activeKeyCount, 3));

  // Style Memory instance across chunks in this request
  const sharedStyleMemory: StyleMemory = {
    rhetoricalPatternCount: 0,
    kamiCount: 0,
    totalWordCount: 0,
  };

  const results = await processWithConcurrencyLimit(
    chunks,
    concurrencyLimit,
    async (chunk, index) => {
      if (chunk.length < 5) {
        return { spintaxText: chunk, debugLogs: [], validationIssues: [], autoPatched: false, criticalUnresolved: false };
      }
      const styleNote = buildStyleMemoryNote(sharedStyleMemory);
      const res = await generateSpintaxWithFailover(
        chunk,
        formattedKeywords,
        fileType,
        resolvedCustomKeys,
        index,
        styleNote
      );

      // Update shared style memory upon chunk completion
      updateStyleMemory(sharedStyleMemory, res.spintaxText);

      return res;
    }
  );

  // Retry rejected chunks sequentially after a short cooldown pause
  const rejectedIndices = results
    .map((res, idx) => (res.status === "rejected" ? idx : -1))
    .filter((idx) => idx !== -1);

  if (rejectedIndices.length > 0) {
    console.warn(`${rejectedIndices.length} chunk gagal di percobaan pertama, mencoba ulang secara berurutan...`);
    await sleep(5000);

    for (const idx of rejectedIndices) {
      try {
        const styleNote = buildStyleMemoryNote(sharedStyleMemory);
        const retryRes = await generateSpintaxWithFailover(
          chunks[idx],
          formattedKeywords,
          fileType,
          resolvedCustomKeys,
          idx,
          styleNote
        );
        results[idx] = { status: "fulfilled", value: retryRes };
        updateStyleMemory(sharedStyleMemory, retryRes.spintaxText);
      } catch {
        // Masih gagal, biarkan tetap "rejected" untuk ditangani oleh fallback deterministik
      }
    }
  }

  results.forEach((res, index) => {
    if (res.status === "fulfilled") {
      processedChunks.push(res.value.spintaxText);
      allLogs.push(...res.value.debugLogs);
      if (res.value.validationIssues && res.value.validationIssues.length > 0) {
        allValidationIssues.push(...res.value.validationIssues);
      }
      if (res.value.autoPatched) {
        autoPatchedChunks++;
      }
      if (res.value.criticalUnresolved) {
        criticalIssueChunks++;
      }
    } else {
      const errMsg = res.reason?.message || "Generation failed";
      const rawChunk = chunks[index];
      const fallback = forceMinimalSpintaxFallback(rawChunk);

      partialFailures++;
      processedChunks.push(fallback.text);

      if (fallback.patched) {
        autoPatchedChunks++;
      } else {
        criticalIssueChunks++;
      }

      console.error(`Chunk ${index + 1} gagal setelah semua percobaan:`, errMsg);

      allLogs.push({
        time: new Date().toISOString(),
        apiKeyName: "N/A",
        maskedKey: "N/A",
        model: process.env.GEMINI_MODEL || "gemini-flash-latest",
        durationMs: 0,
        status: "Failed-Fallback",
        error: `Paragraf/Chunk ${index + 1} gagal di-spin: ${errMsg}. ${
          fallback.patched ? "Fallback minimal spintax diterapkan." : "Teks asli digunakan tanpa modifikasi."
        }`,
        chunkIndex: index + 1,
      });
    }
  });

  const finalSpintax = processedChunks.join("\n\n");

  const previews = [
    resolveSpintax(finalSpintax, 1),
    resolveSpintax(finalSpintax, 2),
    resolveSpintax(finalSpintax, 3),
  ];

  const totalDuration = Date.now() - startTime;

  res.json({
    spintax: finalSpintax,
    previews,
    durationMs: totalDuration,
    debugLogs: allLogs,
    keysHealth: robinServerManager.getKeysStatusMatrix(),
    partialFailures,
    validationIssues: allValidationIssues,
    autoPatchedChunks,
    criticalIssueChunks,
  });
});

export default app;
