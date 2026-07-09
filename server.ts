import express from "express";
import path from "path";
import dotenv from "dotenv";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";

// Load environment variables
dotenv.config();

const app = express();
app.use(express.json({ limit: "10mb" }));

const PORT = 3000;

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

  // Read standard GEMINI_API_KEY
  if (process.env.GEMINI_API_KEY) {
    apiKeys.push({
      name: "GEMINI_API_KEY",
      key: process.env.GEMINI_API_KEY,
      status: "Ready",
      cooldownEnd: 0,
      failureCount: 0,
      lastUsed: 0,
    });
  }

  // Scan all environment variables with GEMINI_API_KEY_ prefix
  for (const envName in process.env) {
    if (envName.startsWith("GEMINI_API_KEY_") && process.env[envName]) {
      apiKeys.push({
        name: envName,
        key: process.env[envName] || "",
        status: "Ready",
        cooldownEnd: 0,
        failureCount: 0,
        lastUsed: 0,
      });
    }
  }

  console.log(`Initialized API Key Manager with ${apiKeys.length} keys.`);
}

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
function resolveSpintax(text: string, index: number): string {
  let resolved = text;
  const maxIterations = 500;
  let iteration = 0;

  while (iteration < maxIterations) {
    const match = resolved.match(/\{([^{}]+)\}/);
    if (!match) break;

    const fullMatch = match[0];
    const options = match[1].split("|");

    // Pick option deterministically using a combination of the index and pseudo-random choice
    // to ensure Preview 1, 2, and 3 are distinct but repeatable/diverse
    const chosenIndex = (index + Math.floor(Math.random() * options.length)) % options.length;
    const replacement = options[chosenIndex] || "";
    resolved = resolved.replace(fullMatch, replacement);
    iteration++;
  }

  return resolved;
}

// ==========================================
// Gemini API Generator with Failover
// ==========================================
async function generateSpintaxWithFailover(
  paragraphText: string,
  protectedKeywords: string[],
  fileType: string
): Promise<{ spintaxText: string; debugLogs: any[] }> {
  const maxAttempts = Math.min(4, Math.max(3, apiKeys.length));
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
    const model = process.env.GEMINI_MODEL || "gemini-3.5-flash";
    const keywordsString = protectedKeywords.length > 0 ? protectedKeywords.join(", ") : "None";

    try {
      const ai = new GoogleGenAI({
        apiKey: keyInfo.key,
        httpOptions: {
          headers: {
            "User-Agent": "aistudio-build",
          },
        },
      });

      const prompt = `You are an expert SEO Content Writer and AI Spintax Specialist.
Your task is to convert the provided paragraph of text into high-quality, human-friendly Contextual Spintax.

### Core Rules:
1. FORMAT: Use the standard spintax format \`{variation1|variation2|...}\`. Do not nested-spin unless absolutely necessary.
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
7. PARAGRAPH STRUCTURE: Return the entire paragraph with the spintax embedded, keeping the original paragraph structure intact. Do not add extra comments, markdown formatting around the output, or explanations. Only return the processed text.

Input Paragraph:
"""
${paragraphText}
"""`;

      const response = await ai.models.generateContent({
        model: model,
        contents: prompt,
      });

      const spintaxText = response.text || "";
      const duration = Date.now() - startTime;

      debugLogs.push({
        time: new Date().toISOString(),
        apiKeyName: keyInfo.name,
        maskedKey: keyInfo.key ? `****${keyInfo.key.slice(-4)}` : "None",
        model,
        durationMs: duration,
        status: "Success",
        attempt: attempt + 1,
      });

      return {
        spintaxText: spintaxText.trim(),
        debugLogs,
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
    // Re-sync in case the user updated environment variables on the fly
    // (AI Studio can reload them, let's look at process.env again)
    const currentKeysCount = apiKeys.length;
    let hasChanged = false;
    
    // Simple check if process.env keys match our list length or names
    if (process.env.GEMINI_API_KEY && !apiKeys.some(k => k.name === "GEMINI_API_KEY")) {
      hasChanged = true;
    }
    for (const envName in process.env) {
      if (envName.startsWith("GEMINI_API_KEY_") && process.env[envName] && !apiKeys.some(k => k.name === envName)) {
        hasChanged = true;
      }
    }

    if (hasChanged) {
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
  const { text, keywords = [], fileType = "text" } = req.body;

  if (!text || typeof text !== "string") {
    return res.status(400).json({ error: "Input text is required" });
  }

  const startTime = Date.now();
  
  // Format keywords array: clean up spaces and filter empty
  const formattedKeywords = Array.isArray(keywords)
    ? keywords.map((k: string) => k.trim()).filter((k: string) => k.length > 0)
    : [];

  // Paragraph processing: Split by double newlines or single newlines
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  if (paragraphs.length === 0) {
    return res.status(400).json({ error: "Input text has no readable paragraphs" });
  }

  const allLogs: any[] = [];
  const processedParagraphs: string[] = [];

  try {
    // Process paragraphs in parallel to speed up 1,000 / 2,000 word articles
    // and distribute requests among multiple keys!
    const results = await Promise.all(
      paragraphs.map(async (paragraph, index) => {
        // Skip short symbols or elements
        if (paragraph.length < 5) {
          return { spintaxText: paragraph, debugLogs: [] };
        }
        
        try {
          const result = await generateSpintaxWithFailover(paragraph, formattedKeywords, fileType);
          return result;
        } catch (err: any) {
          console.error(`Paragraph ${index} failed:`, err);
          throw new Error(`Failed on paragraph ${index + 1}: ${err.message}`);
        }
      })
    );

    // Merge spintax paragraphs and collect logs
    results.forEach((res) => {
      processedParagraphs.push(res.spintaxText);
      allLogs.push(...res.debugLogs);
    });

    const finalSpintax = processedParagraphs.join("\n\n");

    // Generate 3 unique previews
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
    });
  } catch (err: any) {
    res.status(500).json({
      error: err.message || "An unexpected error occurred during spintax generation.",
      debugLogs: allLogs,
      keysHealth: getKeysStatusMatrix(),
    });
  }
});

// Serve frontend static assets & fallback to SPA routing
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    // Development mode
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // Production mode
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`AI Contextual Spintax Generator running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
