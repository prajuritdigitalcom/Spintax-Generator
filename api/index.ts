import express from "express";
import dotenv from "dotenv";
import { GoogleGenAI, ThinkingLevel } from "@google/genai";

// Load environment variables
dotenv.config();

const app = express();
app.use(express.json({ limit: "10mb" }));

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

  // Reset keys that completed their cooldown
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
    throw new Error("All configured Gemini API keys are currently Cooling Down due to rate-limiting or quota errors.");
  }

  // Sort by lastUsed (ascending) for balanced load-distribution (Least Recently Used)
  readyKeys.sort((a, b) => a.lastUsed - b.lastUsed);
  const chosen = readyKeys[0];
  chosen.lastUsed = now;
  return chosen;
}

// Mark key as cooling down on failure
function markKeyCooldown(info: ApiKeyInfo, errMessage: string) {
  info.status = "Cooling Down";
  info.cooldownEnd = Date.now() + 10 * 60 * 1000; // 10 minutes cooldown
  info.failureCount += 1;
  info.errorMessage = errMessage;
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
    const options = match[1].split("|");

    // Pick option deterministically based on previewNum (1, 2, 3) and block occurrence counter
    // Ensures Preview 1, 2, and 3 are distinct whenever options >= 3
    const chosenIndex = (previewNum - 1 + blockCounter) % options.length;
    const replacement = options[chosenIndex] || options[0] || "";
    resolved = resolved.replace(fullMatch, replacement);
    blockCounter++;
    iteration++;
  }

  return resolved;
}

// ==========================================
// System Instruction & Validation Helpers
// ==========================================

// Single prompt source for spintax rules
function buildSystemInstruction(protectedKeywords: string[], fileType: string): string {
  const keywordsString = protectedKeywords.length > 0 ? protectedKeywords.join(", ") : "None";
  return `You are an expert SEO Content Writer and AI Spintax Specialist.
Your task is to convert the provided paragraph of text into high-quality, human-friendly Contextual Spintax.

### Core Rules:
1. FORMAT: Use the standard spintax format \`{variation1|variation2|...}\`. Never produce nested spintax (a \`{...}\` block inside another \`{...}\` block). Each spintax block must contain plain text options only.
2. CONTEXTUAL REWRITE: Do NOT perform simple word-by-word synonym replacement. Rewrite complete sentences or logical phrases so the output reads naturally, flows elegantly, and is highly engaging for humans.
3. SMART VARIATION: Automatically decide the number of variations:
   - Simple sentences: 2 variations.
   - Medium-complexity sentences: 3 variations.
   - High-complexity sentences: 4 variations.
   - Prioritize readability and quality. If generating too many variations makes it sound robotic or unnatural, reduce the number of variations.
4. PRESERVE MEANING: Keep the original meaning, facts, names, numbers, and important information exactly. Do not add or remove facts, or change context.
5. KEYWORD PROTECTION:
   The following keywords are strictly protected: [${keywordsString}]
   These protected keywords MUST remain exactly as-is. Do NOT translate them, do NOT replace them with synonyms, do NOT change their spelling, casing, or word order.
6. HTML/MARKDOWN PROTECTION (Input Type: ${fileType}):
   - If the input contains HTML tags (e.g. <h1>, <strong>, <a>, <img ...>, etc.) or Markdown syntax (e.g. #, **, *, [text](url), etc.), you MUST preserve all tags, attributes, and syntax symbols exactly.
   - Only spin the text inside the HTML elements or Markdown structures. Do NOT spin or alter the tag tags themselves, tag attributes (like href, src, etc.), or Markdown syntax symbols.
7. PARAGRAPH STRUCTURE: Return the entire paragraph with the spintax embedded, keeping the original paragraph structure intact. Do not add extra comments, markdown formatting around the output, or explanations. Only return the processed text.`;
}

// Lightweight post-generation validation
function validateSpintaxOutput(
  original: string,
  output: string,
  protectedKeywords: string[],
  fileType: string
): { ok: boolean; issues: string[] } {
  const issues: string[] = [];

  // Check protected keywords presence
  for (const kw of protectedKeywords) {
    if (kw.trim().length > 0) {
      if (!output.includes(kw)) {
        issues.push(`Kata kunci terproteksi "${kw}" tidak ditemukan pada hasil spintax.`);
      }
    }
  }

  // Check HTML tags preservation
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

  // 2. Enforce hard max length limit per chunk (~6000 chars)
  const finalChunks: string[] = [];
  const MAX_CHUNK_LEN = 6000;

  for (const chunk of refinedChunks) {
    if (chunk.length <= MAX_CHUNK_LEN) {
      finalChunks.push(chunk);
    } else {
      // Split long chunk by sentence endings or linebreaks
      const sentences = chunk
        .split(/(?<=\. |\n|<\/p>|<\/div>)/)
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
  // Use "gemini-flash-latest" as the resilient model default
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

          // Config with systemInstruction, explicit temperature, maxOutputTokens, and low thinking level
          const response = await ai.models.generateContent({
            model: model,
            contents: `"""\n${paragraphText}\n"""`,
            config: {
              systemInstruction: systemInstruction,
              temperature: 0.7,
              maxOutputTokens: Math.min(8192, Math.max(1024, paragraphText.length * 4)),
              // Low thinking level to optimize latency and cost for contextual spintax rewriting
              thinkingConfig: {
                thinkingLevel: ThinkingLevel.LOW,
              },
            },
          });

          const candidate = response.candidates?.[0];
          const finishReason = candidate?.finishReason;
          const spintaxText = (response.text || "").trim();
          const duration = Date.now() - startTime;

          // Check if blocked or finishReason is not STOP or output is empty/truncated
          if (finishReason && finishReason !== "STOP") {
            throw new Error(`Gemini API finishReason is "${finishReason}". Processing was incomplete or blocked.`);
          }

          if (spintaxText.length === 0) {
            throw new Error("Gemini API returned an empty text response.");
          }

          if (paragraphText.length > 50 && spintaxText.length < Math.floor(paragraphText.length * 0.25)) {
            throw new Error(`Output spintax text length (${spintaxText.length} chars) is severely truncated compared to original (${paragraphText.length} chars).`);
          }

          const validation = validateSpintaxOutput(paragraphText, spintaxText, protectedKeywords, fileType);

          debugLogs.push({
            time: new Date().toISOString(),
            apiKeyName: `KUNCI_PRIBADI_${keyIdx + 1}`,
            maskedKey,
            model,
            durationMs: duration,
            status: "Success",
            attempt: attempt + 1,
            validationIssues: validation.issues,
          });

          return {
            spintaxText,
            debugLogs,
            validationIssues: validation.issues,
          };
        } catch (err: any) {
          const duration = Date.now() - startTime;
          const errMsg = err.message || "Unknown Gemini API Error";
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

      const response = await ai.models.generateContent({
        model: model,
        contents: `"""\n${paragraphText}\n"""`,
        config: {
          systemInstruction: systemInstruction,
          temperature: 0.7,
          maxOutputTokens: Math.min(8192, Math.max(1024, paragraphText.length * 4)),
          // Low thinking level to optimize latency and cost for contextual spintax rewriting
          thinkingConfig: {
            thinkingLevel: ThinkingLevel.LOW,
          },
        },
      });

      const candidate = response.candidates?.[0];
      const finishReason = candidate?.finishReason;
      const spintaxText = (response.text || "").trim();
      const duration = Date.now() - startTime;

      // Check if blocked or finishReason is not STOP or output is empty/truncated
      if (finishReason && finishReason !== "STOP") {
        throw new Error(`Gemini API finishReason is "${finishReason}". Processing was incomplete or blocked.`);
      }

      if (spintaxText.length === 0) {
        throw new Error("Gemini API returned an empty text response.");
      }

      if (paragraphText.length > 50 && spintaxText.length < Math.floor(paragraphText.length * 0.25)) {
        throw new Error(`Output spintax text length (${spintaxText.length} chars) is severely truncated compared to original (${paragraphText.length} chars).`);
      }

      const validation = validateSpintaxOutput(paragraphText, spintaxText, protectedKeywords, fileType);

      debugLogs.push({
        time: new Date().toISOString(),
        apiKeyName: keyInfo.name,
        maskedKey: keyInfo.key ? `****${keyInfo.key.slice(-4)}` : "None",
        model,
        durationMs: duration,
        status: "Success",
        attempt: attempt + 1,
        validationIssues: validation.issues,
      });

      return {
        spintaxText,
        debugLogs,
        validationIssues: validation.issues,
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
    const currentKeysCount = apiKeys.length;
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

  // Use Promise.allSettled so one chunk failure doesn't abort other successful chunks
  const results = await Promise.allSettled(
    chunks.map(async (chunk, index) => {
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
    })
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
