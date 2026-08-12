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
// Multi API Key Manager & Rotation State
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

const apiKeys: ApiKeyInfo[] = [];

// Shared in-memory map tracking custom keys -> timestamp when it becomes usable again
const customKeysCooldownMap = new Map<string, number>();

function initializeApiKeys() {
  apiKeys.length = 0; // Clear existing

  console.log("[VERCEL DIAGNOSTIC] Process Env Keys present:", Object.keys(process.env).filter(k => k.includes("KEY") || k.includes("GEMINI")));
  
  // Read standard GEMINI_API_KEY
  if (process.env.GEMINI_API_KEY) {
    console.log("[VERCEL DIAGNOSTIC] Found main GEMINI_API_KEY. Length:", process.env.GEMINI_API_KEY.length);
    apiKeys.push({
      name: "GEMINI_API_KEY",
      key: process.env.GEMINI_API_KEY,
      status: "Ready",
      cooldownEnd: 0,
      failureCount: 0,
      lastUsed: 0,
    });
  } else {
    console.log("[VERCEL DIAGNOSTIC] GEMINI_API_KEY is not defined in process.env");
  }

  // Scan all environment variables with GEMINI_API_KEY_ prefix
  for (const envName in process.env) {
    if (envName.startsWith("GEMINI_API_KEY_") && process.env[envName]) {
      const val = process.env[envName] || "";
      console.log(`[VERCEL DIAGNOSTIC] Found rotation key ${envName}. Length:`, val.length);
      apiKeys.push({
        name: envName,
        key: val,
        status: "Ready",
        cooldownEnd: 0,
        failureCount: 0,
        lastUsed: 0,
      });
    }
  }

  console.log(`[VERCEL DIAGNOSTIC] Initialized API Key Manager with ${apiKeys.length} total keys.`);
}

// Initial sync
initializeApiKeys();

// Parsing & Rate-limit helpers
function parseRetryDelayMs(errMessage: string): number | null {
  const match = errMessage.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/i);
  if (match) {
    return Math.ceil(parseFloat(match[1]) * 1000);
  }
  const secMatch = errMessage.match(/(\d+(?:\.\d+)?)\s*s(?:econds?)?/i);
  if (errMessage.includes("RESOURCE_EXHAUSTED") || errMessage.includes("429")) {
    if (secMatch) return Math.ceil(parseFloat(secMatch[1]) * 1000);
    return 10000; // default 10s wait if quota error
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
    errMessage.includes("PERMISSION_DENIED")
  );
}

// Retrieve key matrix for health checks
function getKeysStatusMatrix() {
  const now = Date.now();
  return apiKeys.map((info) => {
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
      timeRemaining, // in seconds
      failureCount: info.failureCount,
      lastUsed: info.lastUsed ? new Date(info.lastUsed).toISOString() : "Never",
      errorMessage: info.errorMessage,
    };
  });
}

// Select the best API key based on least recently used among all Ready keys
function getBestApiKey(): ApiKeyInfo {
  const now = Date.now();

  // Reset keys that completed their cooldown (unless Disabled)
  for (const info of apiKeys) {
    if (info.status === "Cooling Down" && now >= info.cooldownEnd) {
      info.status = "Ready";
      info.cooldownEnd = 0;
      info.errorMessage = undefined;
    }
  }

  // Find all Ready keys
  const readyKeys = apiKeys.filter((k) => k.status === "Ready");
  if (readyKeys.length === 0) {
    if (apiKeys.length === 0) {
      throw new Error("No Gemini API Keys are configured. Please define GEMINI_API_KEY in Settings > Secrets.");
    }
    throw new Error("All configured Gemini API keys are currently Cooling Down or Disabled due to rate-limiting or invalid key errors.");
  }

  // Sort by lastUsed (ascending) for balanced load-distribution (Least Recently Used)
  readyKeys.sort((a, b) => a.lastUsed - b.lastUsed);
  const chosen = readyKeys[0];
  chosen.lastUsed = now;
  return chosen;
}

// Mark server key as cooling down or disabled
function markKeyCooldown(info: ApiKeyInfo, errMessage: string) {
  info.failureCount += 1;
  info.errorMessage = errMessage;

  if (isPermanentKeyError(errMessage)) {
    info.status = "Disabled";
    info.cooldownEnd = Infinity;
    return;
  }

  const retryDelay = parseRetryDelayMs(errMessage);
  if (retryDelay !== null) {
    info.status = "Cooling Down";
    info.cooldownEnd = Date.now() + retryDelay + 5000;
  } else if (isQuotaError(errMessage)) {
    info.status = "Cooling Down";
    info.cooldownEnd = Date.now() + 15000;
  } else {
    info.status = "Cooling Down";
    info.cooldownEnd = Date.now() + 2 * 60 * 1000;
  }
}

// Shared cooldown for custom API keys
function getCustomKeyCooldown(key: string): number {
  const until = customKeysCooldownMap.get(key) || 0;
  const now = Date.now();
  return until > now ? until - now : 0;
}

function markCustomKeyCooldown(key: string, errMessage: string) {
  if (isPermanentKeyError(errMessage)) {
    customKeysCooldownMap.set(key, Date.now() + 24 * 60 * 60 * 1000); // 24h
    return;
  }
  const retryDelay = parseRetryDelayMs(errMessage);
  if (retryDelay !== null) {
    customKeysCooldownMap.set(key, Date.now() + retryDelay + 5000);
  } else if (isQuotaError(errMessage)) {
    customKeysCooldownMap.set(key, Date.now() + 15000);
  } else {
    customKeysCooldownMap.set(key, Date.now() + 60000);
  }
}

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

// ==========================================
// System Instruction & Validation Helpers
// ==========================================

function buildSystemInstruction(protectedKeywords: string[], fileType: string): string {
  const keywordsString = protectedKeywords.length > 0 ? protectedKeywords.join(", ") : "None";
  return `You are an expert SEO Content Writer and AI Spintax Specialist.
Your task is to convert the provided paragraph of text into high-quality, human-friendly Contextual Spintax.

### Core Rules:
1. FORMAT: Use standard spintax format \`{variation1|variation2|...}\`. Never produce nested spintax (a \`{...}\` block inside another \`{...}\` block). Each spintax block must contain plain text options only.
2. CONTEXTUAL REWRITE: Do NOT perform simple word-by-word synonym replacement. Rewrite complete sentences or logical phrases so the output reads naturally, flows elegantly, and is highly engaging for humans.
3. SMART VARIATION: Automatically decide the number of variations (minimum 2 variations per block, 3 for medium complexity, 4 for high complexity). Never generate 0 or 1 variation.
4. PRESERVE MEANING: Keep the original meaning, facts, names, numbers, and important information exactly. Do not add or remove facts, or change context.
5. KEYWORD PROTECTION:
   The following keywords are strictly protected: [${keywordsString}]
   These protected keywords MUST remain exactly as-is. Do NOT translate them, do NOT replace them with synonyms, do NOT change their spelling, casing, or word order.
   ADDITIONAL RULE: Protected keywords must NEVER be placed as one of multiple options inside a {option1|option2} spin block alongside a synonym or alternative phrasing. They must appear as fixed, unspun plain text at their original position, identical across every possible resolution of the spintax.
6. NO AI-STYLE PUNCTUATION: Never use the em dash (—) or en dash (–) to connect clauses. Rewrite using a comma, period, colon, or a natural connecting word instead. This applies to every variation inside every spintax block.
7. MANDATORY SPINTAX COVERAGE: Every paragraph/chunk you receive MUST be converted into spintax. Do not return any paragraph as plain, unspun text. Minimum 2 variations per spintax block, even for short or simple sentences, even when the paragraph contains technical terminology or product lists — vary the surrounding sentence structure while keeping technical terms fixed inside each option.
8. HTML/MARKDOWN PROTECTION (Input Type: ${fileType}):
   - If the input contains HTML tags (e.g. <h1>, <strong>, <a>, <img ...>, etc.) or Markdown syntax (e.g. #, **, *, [text](url), etc.), you MUST preserve all tags, attributes, and syntax symbols exactly.
   - Only spin the text inside the HTML elements or Markdown structures. Do NOT spin or alter the tag tags themselves, tag attributes (like href, src, etc.), or Markdown syntax symbols.
9. PARAGRAPH STRUCTURE: Return the entire paragraph with the spintax embedded, keeping the original paragraph structure intact. Do not add extra comments, markdown formatting around the output, or explanations. Only return the processed text.`;
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

// Execution with validation and 1x correction retry
async function executeWithValidationAndRetry(
  ai: GoogleGenAI,
  model: string,
  paragraphText: string,
  systemInstruction: string,
  protectedKeywords: string[],
  fileType: string
): Promise<{ spintaxText: string; validationIssues: string[] }> {
  const tokenBudget = Math.min(16384, Math.max(2048, paragraphText.length * 6));

  const response = await ai.models.generateContent({
    model: model,
    contents: `"""\n${paragraphText}\n"""`,
    config: {
      systemInstruction: systemInstruction,
      temperature: 0.7,
      maxOutputTokens: tokenBudget,
      thinkingConfig: {
        thinkingLevel: ThinkingLevel.LOW,
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

  // If validation failed, attempt 1x correction retry with escalated ThinkingLevel.MEDIUM
  if (!validation.ok) {
    try {
      console.warn("Spintax validation issues detected. Attempting 1x correction retry:", validation.issues);
      const correctionPrompt = `"""\n${paragraphText}\n"""\n\nCATATAN PERBAIKAN: Hasil sebelumnya melanggar aturan berikut:\n- ${validation.issues.join("\n- ")}\nTulis ulang dan pastikan SEMUA aturan dipatuhi, terutama poin yang dilanggar ini.`;

      const retryResponse = await ai.models.generateContent({
        model: model,
        contents: correctionPrompt,
        config: {
          systemInstruction: systemInstruction,
          temperature: 0.7,
          maxOutputTokens: tokenBudget,
          thinkingConfig: {
            thinkingLevel: ThinkingLevel.MEDIUM,
          },
        },
      });

      const retryCandidate = retryResponse.candidates?.[0];
      if (retryCandidate?.finishReason === "STOP" && retryResponse.text?.trim()) {
        const retrySpintax = sanitizeSpintaxText(retryResponse.text.trim());
        const retryVal = validateSpintaxOutput(paragraphText, retrySpintax, protectedKeywords, fileType);
        if (retryVal.ok || retryVal.issues.length < validation.issues.length) {
          spintaxText = retrySpintax;
          validation = retryVal;
        }
      }
    } catch (retryErr) {
      console.warn("Correction retry failed, proceeding with initial output:", retryErr);
    }
  }

  return {
    spintaxText,
    validationIssues: validation.issues,
  };
}

// ==========================================
// Gemini API Generator with Failover
// ==========================================
async function generateSpintaxWithFailover(
  paragraphText: string,
  protectedKeywords: string[],
  fileType: string,
  customApiKeys?: string[],
  initialKeyIndex = 0
): Promise<{ spintaxText: string; debugLogs: any[]; validationIssues: string[] }> {
  const model = process.env.GEMINI_MODEL || "gemini-flash-latest";
  const systemInstruction = buildSystemInstruction(protectedKeywords, fileType);

  // If custom API keys are provided, perform round-robin rotation & failover among them
  if (customApiKeys && customApiKeys.length > 0) {
    const activeKeys = customApiKeys.map(k => k.trim()).filter(k => k.length > 0);
    if (activeKeys.length > 0) {
      let attempt = 0;
      const maxAttempts = activeKeys.length;
      const debugLogs: any[] = [];

      while (attempt < maxAttempts) {
        const keyIdx = (initialKeyIndex + attempt) % activeKeys.length;
        const currentKey = activeKeys[keyIdx];
        const maskedKey = `${currentKey.slice(0, 4)}...${currentKey.slice(-4)}`;

        // Check shared cooldown state for custom keys
        const cdRemaining = getCustomKeyCooldown(currentKey);
        if (cdRemaining > 0) {
          if (cdRemaining <= 15000) {
            await sleep(cdRemaining);
          } else {
            console.warn(`Custom API Key index ${keyIdx} is in cooldown for ${Math.ceil(cdRemaining/1000)}s. Trying next key.`);
            attempt++;
            continue;
          }
        }

        const startTime = Date.now();

        try {
          const ai = new GoogleGenAI({
            apiKey: currentKey,
            httpOptions: {
              headers: {
                "User-Agent": "aistudio-build",
              },
            },
          });

          const { spintaxText, validationIssues } = await executeWithValidationAndRetry(
            ai,
            model,
            paragraphText,
            systemInstruction,
            protectedKeywords,
            fileType
          );

          const duration = Date.now() - startTime;

          debugLogs.push({
            time: new Date().toISOString(),
            apiKeyName: `KUNCI_PRIBADI_${keyIdx + 1}`,
            maskedKey,
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
          };
        } catch (err: any) {
          const duration = Date.now() - startTime;
          const errMsg = err.message || "Unknown Gemini API Error";

          markCustomKeyCooldown(currentKey, errMsg);

          debugLogs.push({
            time: new Date().toISOString(),
            apiKeyName: `KUNCI_PRIBADI_${keyIdx + 1}`,
            maskedKey,
            model,
            durationMs: duration,
            status: "Failover",
            error: errMsg,
            attempt: attempt + 1,
          });

          const retryDelay = parseRetryDelayMs(errMsg);
          if (retryDelay && retryDelay <= 30000) {
            await sleep(Math.min(retryDelay, 30000));
          }

          console.warn(`Private API Key index ${keyIdx} failed (Attempt ${attempt + 1}). Error: ${errMsg}. Trying next private key.`);
          attempt++;
        }
      }
      throw new Error(`Semua ${maxAttempts} Kunci API Pribadi Anda gagal atau terkena rate limit.`);
    }
  }

  // Default server API keys flow
  const maxAttempts = Math.max(1, apiKeys.length);
  let attempt = 0;
  const debugLogs: any[] = [];

  while (attempt < maxAttempts) {
    let keyInfo: ApiKeyInfo;
    try {
      keyInfo = getBestApiKey();
    } catch (err: any) {
      throw new Error(`Failed to find an available API key: ${err.message}`);
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

      const { spintaxText, validationIssues } = await executeWithValidationAndRetry(
        ai,
        model,
        paragraphText,
        systemInstruction,
        protectedKeywords,
        fileType
      );

      const duration = Date.now() - startTime;

      debugLogs.push({
        time: new Date().toISOString(),
        apiKeyName: keyInfo.name,
        maskedKey: keyInfo.key ? `****${keyInfo.key.slice(-4)}` : "None",
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
      };
    } catch (err: any) {
      const duration = Date.now() - startTime;
      const errMsg = err.message || "Unknown Gemini API Error";

      markKeyCooldown(keyInfo, errMsg);

      debugLogs.push({
        time: new Date().toISOString(),
        apiKeyName: keyInfo.name,
        maskedKey: keyInfo.key ? `****${keyInfo.key.slice(-4)}` : "None",
        model,
        durationMs: duration,
        status: "Failover",
        error: errMsg,
        attempt: attempt + 1,
      });

      console.warn(`API Key ${keyInfo.name} failed (Attempt ${attempt + 1}). Error: ${errMsg}. Moving to cooldown and trying next key.`);
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
    let hasChanged = false;
    
    if (process.env.GEMINI_API_KEY && !apiKeys.some(k => k.name === "GEMINI_API_KEY")) {
      hasChanged = true;
    }
    for (const envName in process.env) {
      if (envName.startsWith("GEMINI_API_KEY_") && process.env[envName] && !apiKeys.some(k => k.name === envName)) {
        hasChanged = true;
      }
    }

    if (hasChanged) {
      console.log("[VERCEL DIAGNOSTIC] Keys change detected on the fly, re-initializing...");
      initializeApiKeys();
    }

    res.json({
      status: "ok",
      keys: getKeysStatusMatrix(),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Force refresh/reload keys
app.post("/api/keys-refresh", (req, res) => {
  try {
    initializeApiKeys();
    res.json({
      status: "refreshed",
      keys: getKeysStatusMatrix(),
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
  const allLogs: any[] = [];
  const processedChunks: string[] = [];
  const allValidationIssues: string[] = [];

  const activeKeyCount = resolvedCustomKeys.length > 0 ? resolvedCustomKeys.length : Math.max(1, apiKeys.length);
  // Cap worker concurrency to Math.min(activeKeyCount, 3) to prevent bursting free-tier API quotas
  const concurrencyLimit = Math.max(1, Math.min(activeKeyCount, 3));

  const results = await processWithConcurrencyLimit(
    chunks,
    concurrencyLimit,
    async (chunk, index) => {
      if (chunk.length < 5) {
        return { spintaxText: chunk, debugLogs: [], validationIssues: [] };
      }
      return await generateSpintaxWithFailover(
        chunk,
        formattedKeywords,
        fileType,
        resolvedCustomKeys,
        index
      );
    }
  );

  results.forEach((res, index) => {
    if (res.status === "fulfilled") {
      processedChunks.push(res.value.spintaxText);
      allLogs.push(...res.value.debugLogs);
      if (res.value.validationIssues && res.value.validationIssues.length > 0) {
        allValidationIssues.push(...res.value.validationIssues);
      }
    } else {
      // Chunk failed after all retries: use original chunk text as fallback
      partialFailures++;
      const originalChunk = chunks[index];
      processedChunks.push(originalChunk);

      const errMsg = res.reason?.message || "Generation failed";
      console.error(`Chunk ${index + 1} failed:`, errMsg);

      allLogs.push({
        time: new Date().toISOString(),
        apiKeyName: "N/A",
        maskedKey: "N/A",
        model: process.env.GEMINI_MODEL || "gemini-flash-latest",
        durationMs: 0,
        status: "Failed-Fallback",
        error: `Paragraf/Chunk ${index + 1} gagal di-spin: ${errMsg}. Teks asli digunakan sebagai fallback.`,
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
    keysHealth: getKeysStatusMatrix(),
    partialFailures,
    validationIssues: allValidationIssues,
  });
});

export default app;
