import React, { useState, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { 
  FileText, 
  Code, 
  Hash, 
  Plus, 
  Trash2, 
  Play, 
  Check, 
  Copy, 
  Download, 
  Sparkles, 
  RefreshCw, 
  AlertCircle, 
  Eye, 
  Lock,
  X,
  Zap,
  Info
} from "lucide-react";
import { FileType, KeyHealth, DebugLog, GenerateResponse } from "./types";
import KeyHealthPanel from "./components/KeyHealthPanel";

// Sample articles depending on file type for quick testing
const SAMPLES: Record<FileType, string> = {
  text: "Kami menyediakan jasa pembuatan website profesional. Dengan tim berpengalaman selama bertahun-tahun, kami siap membantu bisnis Anda tumbuh secara digital di era modern ini. Hubungi kami sekarang untuk konsultasi gratis mengenai kebutuhan sistem digital Anda.",
  html: "<h1>Jasa Pembuatan Website Terbaik</h1>\n<p>Kami menyediakan jasa <strong>pembuatan website profesional</strong> untuk UMKM dan Perusahaan.</p>\n<p>Dapatkan penawaran harga menarik di <a href='https://example.com'>Website Resmi Kami</a> sekarang juga!</p>",
  markdown: "# Jasa Pembuatan Website Terbaik\n\nKami menyediakan jasa **pembuatan website profesional** untuk UMKM dan Perusahaan.\n\n- Desain Responsif\n- Gratis Domain & Hosting\n- SEO Friendly\n\nHubungi kami di [Situs Resmi](https://example.com) sekarang juga!"
};

export default function App() {
  // Custom API Keys state
  const [customApiKeys, setCustomApiKeys] = useState<string[]>(() => {
    try {
      const stored = localStorage.getItem("custom_gemini_api_keys");
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) {
          return parsed.map(k => String(k).trim()).filter(Boolean);
        }
      }
    } catch (e) {
      // ignore
    }
    const single = localStorage.getItem("custom_gemini_api_key") || "";
    return single ? [single.trim()] : [];
  });

  const [newKeyInput, setNewKeyInput] = useState("");

  const handleAddKey = (keyString: string) => {
    if (!keyString.trim()) return;
    // Support pasting multiple keys split by comma, semicolon, space, or newline
    const keysToAdd = keyString
      .split(/[\s,;\n\r]+/)
      .map(k => k.trim())
      .filter(k => k.length > 0 && !customApiKeys.includes(k));

    if (keysToAdd.length > 0) {
      const updated = [...customApiKeys, ...keysToAdd];
      setCustomApiKeys(updated);
      localStorage.setItem("custom_gemini_api_keys", JSON.stringify(updated));
      localStorage.setItem("custom_gemini_api_key", updated[0] || "");
    }
    setNewKeyInput("");
  };

  const handleRemoveKey = (indexToRemove: number) => {
    const updated = customApiKeys.filter((_, idx) => idx !== indexToRemove);
    setCustomApiKeys(updated);
    localStorage.setItem("custom_gemini_api_keys", JSON.stringify(updated));
    localStorage.setItem("custom_gemini_api_key", updated[0] || "");
  };

  const handleClearAllKeys = () => {
    setCustomApiKeys([]);
    localStorage.removeItem("custom_gemini_api_keys");
    localStorage.removeItem("custom_gemini_api_key");
  };

  // Input states
  const [inputText, setInputText] = useState("");
  const [fileType, setFileType] = useState<FileType>("text");
  const [keywordInput, setKeywordInput] = useState("");
  const [protectedKeywords, setProtectedKeywords] = useState<string[]>([]);
  
  // Output states
  const [spintaxResult, setSpintaxResult] = useState("");
  const [previews, setPreviews] = useState<string[]>([]);
  const [activePreviewTab, setActivePreviewTab] = useState(0);
  
  // App states
  const [isGenerating, setIsGenerating] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [durationMs, setDurationMs] = useState<number | null>(null);
  
  // API Keys status state
  const [keysHealth, setKeysHealth] = useState<KeyHealth[]>([]);
  const [debugLogs, setDebugLogs] = useState<DebugLog[]>([]);
  const [isRefreshingKeys, setIsRefreshingKeys] = useState(false);

  // Copy status indicators
  const [copiedSpintax, setCopiedSpintax] = useState(false);
  const [copiedPreview, setCopiedPreview] = useState(false);

  // Load initial health status on mount
  useEffect(() => {
    fetchKeysHealth();
  }, []);

  const fetchKeysHealth = async () => {
    setIsRefreshingKeys(true);
    try {
      const res = await fetch("/api/keys-health");
      const data = await res.json();
      if (data.keys) {
        setKeysHealth(data.keys);
      }
    } catch (err) {
      console.error("Failed to load keys health:", err);
    } finally {
      setIsRefreshingKeys(false);
    }
  };

  const refreshKeysOnServer = async () => {
    setIsRefreshingKeys(true);
    try {
      const res = await fetch("/api/keys-refresh", { method: "POST" });
      const data = await res.json();
      if (data.keys) {
        setKeysHealth(data.keys);
      }
    } catch (err) {
      console.error("Failed to refresh keys on server:", err);
    } finally {
      setIsRefreshingKeys(false);
    }
  };

  const handleAddKeyword = () => {
    const trimmed = keywordInput.trim();
    if (trimmed && !protectedKeywords.includes(trimmed)) {
      setProtectedKeywords([...protectedKeywords, trimmed]);
      setKeywordInput("");
    }
  };

  const handleRemoveKeyword = (kw: string) => {
    setProtectedKeywords(protectedKeywords.filter((k) => k !== kw));
  };

  const handleKeyDownKeyword = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      handleAddKeyword();
    }
  };

  const handleClear = () => {
    setInputText("");
    setSpintaxResult("");
    setPreviews([]);
    setProtectedKeywords([]);
    setKeywordInput("");
    setErrorMessage(null);
    setDurationMs(null);
  };

  const handleInjectSample = () => {
    setInputText(SAMPLES[fileType]);
    setErrorMessage(null);
  };

  const handleGenerate = async () => {
    if (!inputText.trim()) {
      setErrorMessage("Please input an article to generate spintax.");
      return;
    }

    setIsGenerating(true);
    setErrorMessage(null);
    setSpintaxResult("");
    setPreviews([]);

    try {
      const response = await fetch("/api/generate-spintax", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: inputText,
          keywords: protectedKeywords,
          fileType: fileType,
          customApiKeys: customApiKeys,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Gagal menghubungi Google Gemini API. Silakan coba kembali.");
      }

      setSpintaxResult(data.spintax);
      setPreviews(data.previews || []);
      setDurationMs(data.durationMs);
      if (data.debugLogs) {
        setDebugLogs(data.debugLogs);
      }
      if (data.keysHealth) {
        setKeysHealth(data.keysHealth);
      }
    } catch (err: any) {
      setErrorMessage(err.message || "Gagal menghubungi Google Gemini API. Silakan coba kembali.");
    } finally {
      setIsGenerating(false);
    }
  };

  // Export functions
  const handleCopySpintax = async () => {
    if (!spintaxResult) return;
    try {
      await navigator.clipboard.writeText(spintaxResult);
      setCopiedSpintax(true);
      setTimeout(() => setCopiedSpintax(false), 2000);
    } catch (err) {
      console.error("Copy failed:", err);
    }
  };

  const handleCopyPreview = async (text: string) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedPreview(true);
      setTimeout(() => setCopiedPreview(false), 2000);
    } catch (err) {
      console.error("Copy failed:", err);
    }
  };

  const downloadTxt = () => {
    const blob = new Blob([spintaxResult], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `spintax_article_${fileType}.txt`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const downloadCsv = () => {
    const escapeCsv = (str: string) => `"${str.replace(/"/g, '""')}"`;
    const csvContent = "Original,Spintax\n" + escapeCsv(inputText) + "," + escapeCsv(spintaxResult);
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "spintax_article.csv";
    link.click();
    URL.revokeObjectURL(url);
  };

  const downloadHtml = () => {
    const blob = new Blob([spintaxResult], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "spintax_article.html";
    link.click();
    URL.revokeObjectURL(url);
  };

  const downloadMarkdown = () => {
    const blob = new Blob([spintaxResult], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "spintax_article.md";
    link.click();
    URL.revokeObjectURL(url);
  };

  const countWords = (text: string) => {
    const trimmed = text.trim();
    return trimmed ? trimmed.split(/\s+/).length : 0;
  };

  return (
    <div id="main-container" className="min-h-screen bg-slate-50/50 text-slate-800 font-sans selection:bg-brand-light selection:text-brand">
      {/* Dynamic Alert Banner if API Keys are missing */}
      {keysHealth.length === 0 && customApiKeys.length === 0 && !isRefreshingKeys && (
        <div id="no-api-key-banner" className="bg-amber-500 text-white px-4 py-2.5 text-center text-sm font-medium flex items-center justify-center gap-2 shadow-sm">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>No Gemini API Keys configured. Please add keys to continue. Go to <b>Settings &gt; Secrets</b> to declare <code className="bg-amber-600/50 px-1.5 py-0.5 rounded font-mono text-xs text-white">GEMINI_API_KEY</code> or input your own API Key below.</span>
        </div>
      )}

      {/* Header section */}
      <header id="app-header" className="border-b border-slate-200/80 bg-white shadow-xs sticky top-0 z-10 backdrop-blur-md bg-white/90">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="bg-brand p-2 rounded-xl text-white shadow-md shadow-brand/15">
              <Sparkles className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900 font-display">
                AI Contextual Spintax Generator
              </h1>
              <p className="text-xs sm:text-sm text-slate-500">
                Generate Human-Friendly, Context-Aware Spintax for SEO
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="inline-flex items-center gap-1 bg-slate-100 border border-slate-200/80 rounded-full px-3 py-1 text-xs font-semibold text-slate-600 font-mono">
              <Lock className="h-3.5 w-3.5 text-slate-400" />
              Model: {process.env.GEMINI_MODEL || "gemini-3.5-flash"}
            </div>
          </div>
        </div>
      </header>

      {/* Main content grid */}
      <main id="app-main-content" className="max-w-7xl mx-auto px-4 sm:px-6 mt-8">
        
        {/* Custom API Key Input Card - Sleek and modern multi-key manager */}
        <div className="mb-8 bg-white border border-slate-200 rounded-2xl shadow-xs p-5">
          <div className="flex flex-col gap-5">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-100 pb-4">
              <div className="flex items-center gap-3">
                <div className="bg-brand-light text-brand p-2 rounded-xl shrink-0">
                  <Lock className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="font-bold text-slate-900 text-sm md:text-base font-display flex flex-wrap items-center gap-2">
                    Kunci API Gemini Pribadi Anda ({customApiKeys.length})
                    <span className="text-[10px] bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-full font-semibold">Bypass &amp; Rotasi Otomatis</span>
                  </h3>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Masukkan satu atau beberapa kunci API Anda sendiri. Sistem akan merotasi secara bergantian saat permintaan spintax diproses.
                  </p>
                </div>
              </div>
              {customApiKeys.length > 0 && (
                <button
                  onClick={handleClearAllKeys}
                  className="text-xs text-rose-500 hover:text-rose-600 font-medium hover:underline flex items-center gap-1 cursor-pointer"
                >
                  <Trash2 className="h-3.5 w-3.5" /> Hapus Semua Kunci
                </button>
              )}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
              {/* Left Column: Key Adder */}
              <div className="lg:col-span-5 flex flex-col gap-3">
                <div className="relative">
                  <input
                    type="password"
                    placeholder="Masukkan API Key Gemini Anda (AIzaSy...)"
                    value={newKeyInput}
                    onChange={(e) => setNewKeyInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        handleAddKey(newKeyInput);
                      }
                    }}
                    className="w-full pl-4 pr-12 py-3 bg-slate-50 border border-slate-200 hover:border-slate-300 focus:border-brand focus:bg-white rounded-xl text-xs sm:text-sm font-mono focus:outline-hidden transition-all shadow-inner"
                  />
                  <Lock className="absolute right-4 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-300 pointer-events-none" />
                </div>
                <div className="flex items-center justify-between gap-3">
                  <p className="text-[10px] text-slate-400">
                    * Tips: Bisa paste banyak kunci sekaligus (dipisah koma/baris baru).
                  </p>
                  <button
                    onClick={() => handleAddKey(newKeyInput)}
                    disabled={!newKeyInput.trim()}
                    className="shrink-0 bg-brand hover:bg-brand-dark disabled:bg-slate-100 disabled:text-slate-400 text-white text-xs font-semibold px-4 py-2 rounded-lg transition-colors cursor-pointer flex items-center gap-1 shadow-sm"
                  >
                    <Plus className="h-3.5 w-3.5" /> Tambahkan
                  </button>
                </div>
              </div>

              {/* Right Column: Key List */}
              <div className="lg:col-span-7">
                {customApiKeys.length === 0 ? (
                  <div className="border border-dashed border-slate-200 bg-slate-50/50 rounded-xl p-6 text-center">
                    <p className="text-xs text-slate-400 font-medium font-display">Belum ada Kunci API pribadi yang ditambahkan.</p>
                    <p className="text-[10px] text-slate-400 mt-0.5">Permintaan Anda akan menggunakan rotasi server bawaan.</p>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2 max-h-[140px] overflow-y-auto pr-1">
                    {customApiKeys.map((key, idx) => (
                      <div 
                        key={idx} 
                        className="flex items-center gap-2 bg-slate-50 border border-slate-200/80 rounded-xl px-3 py-1.5 text-xs font-mono shadow-2xs hover:bg-slate-100/80 transition-all group"
                      >
                        <span className="text-[10px] bg-slate-200 text-slate-700 w-4 h-4 flex items-center justify-center rounded-full font-bold">
                          {idx + 1}
                        </span>
                        <span className="text-slate-600 font-semibold">
                          {key.slice(0, 4)}...{key.slice(-4)}
                        </span>
                        <button
                          onClick={() => handleRemoveKey(idx)}
                          className="text-slate-400 hover:text-rose-500 p-0.5 rounded-md hover:bg-slate-200/50 transition-colors cursor-pointer"
                          title="Hapus Kunci Ini"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {customApiKeys.length > 0 && (
                  <p className="text-[10px] text-emerald-600 font-semibold mt-3 flex items-center gap-1 pl-1">
                    <Check className="h-3 w-3" /> Menggunakan {customApiKeys.length} Kunci API Pribadi secara bergantian untuk request berikutnya!
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          
          {/* LEFT PANEL - INPUT ARTIKEL */}
          <div id="left-panel-input" className="bg-white border border-slate-200 rounded-2xl shadow-xs p-6 flex flex-col space-y-6">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-slate-900 font-display flex items-center gap-2">
                <FileText className="h-5 w-5 text-brand" />
                Input Artikel
              </h2>
              <button
                id="inject-sample-btn"
                onClick={handleInjectSample}
                className="text-xs font-semibold text-brand hover:text-brand-hover bg-brand-light hover:bg-brand-muted/70 px-3 py-1.5 rounded-lg transition-colors"
              >
                Gunakan Artikel Contoh
              </button>
            </div>

            {/* Document Format Selector */}
            <div>
              <label className="block text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">
                Format Input
              </label>
              <div className="grid grid-cols-3 gap-2 bg-slate-100 p-1 rounded-xl border border-slate-200/50">
                {(["text", "html", "markdown"] as FileType[]).map((type) => (
                  <button
                    key={type}
                    onClick={() => {
                      setFileType(type);
                      // Auto-update sample if the user switches formats and text is empty or a sample
                      if (!inputText || Object.values(SAMPLES).includes(inputText)) {
                        setInputText(SAMPLES[type]);
                      }
                    }}
                    className={`flex items-center justify-center gap-1.5 py-2.5 rounded-lg text-sm font-semibold transition-all ${
                      fileType === type
                        ? "bg-white text-slate-900 shadow-xs border border-slate-200/40"
                        : "text-slate-500 hover:text-slate-950 hover:bg-slate-50/50"
                    }`}
                  >
                    {type === "text" && <FileText className="h-4 w-4" />}
                    {type === "html" && <Code className="h-4 w-4" />}
                    {type === "markdown" && <Hash className="h-4 w-4" />}
                    <span className="capitalize">{type === "text" ? "Plain Text" : type}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Main Textarea */}
            <div className="relative">
              <textarea
                id="input-article-textarea"
                rows={12}
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                placeholder={`Tempel artikel Anda di sini (${fileType === "text" ? "Plain Text" : fileType === "html" ? "HTML" : "Markdown"})...`}
                className="w-full bg-slate-50/50 border border-slate-200 hover:border-slate-300 focus:border-brand focus:bg-white rounded-xl p-4 text-slate-900 placeholder-slate-400 focus:outline-hidden transition-all font-sans text-sm leading-relaxed shadow-inner"
              />
              <div className="absolute bottom-3 right-3 flex items-center gap-3 bg-white/90 backdrop-blur-xs px-2.5 py-1 rounded-md text-xs font-mono text-slate-400 border border-slate-100">
                <span>{countWords(inputText)} kata</span>
                <span>•</span>
                <span>{inputText.length} karakter</span>
              </div>
            </div>

            {/* Keyword Protection Tag Input */}
            <div className="bg-slate-50/70 border border-slate-200/80 rounded-xl p-4">
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs font-bold uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
                  <Lock className="h-3.5 w-3.5 text-slate-400" />
                  Keyword Protection
                </label>
                <span className="text-[10px] text-slate-400 font-medium">Jangan putar kata-kata ini</span>
              </div>
              
              <div className="flex gap-2">
                <input
                  id="keyword-protection-input"
                  type="text"
                  value={keywordInput}
                  onChange={(e) => setKeywordInput(e.target.value)}
                  onKeyDown={handleKeyDownKeyword}
                  placeholder="Ketik keyword lalu tekan Enter atau koma..."
                  className="flex-1 bg-white border border-slate-200 hover:border-slate-300 focus:border-brand rounded-lg px-3 py-2 text-sm focus:outline-hidden transition-all placeholder:text-slate-400"
                />
                <button
                  id="add-keyword-btn"
                  onClick={handleAddKeyword}
                  className="bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold px-4 py-2 rounded-lg text-sm transition-colors flex items-center gap-1 border border-slate-200"
                >
                  <Plus className="h-4 w-4" />
                  Tambah
                </button>
              </div>

              {/* Tag Chips Container */}
              <div className="flex flex-wrap gap-1.5 mt-3">
                {protectedKeywords.length === 0 ? (
                  <p className="text-xs text-slate-400 italic py-1">Belum ada keyword yang dilindungi.</p>
                ) : (
                  protectedKeywords.map((kw) => (
                    <span
                      key={kw}
                      className="inline-flex items-center gap-1 bg-white border border-brand-light text-brand text-xs font-medium px-2.5 py-1 rounded-lg shadow-2xs"
                    >
                      {kw}
                      <button
                        onClick={() => handleRemoveKeyword(kw)}
                        className="text-slate-400 hover:text-brand-hover hover:bg-brand-light p-0.5 rounded transition-all"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))
                )}
              </div>
            </div>

            {/* Error Message Box */}
            <AnimatePresence>
              {errorMessage && (
                <motion.div
                  id="error-message-box"
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  className="p-4 bg-rose-50 border border-rose-200 rounded-xl text-rose-700 text-sm flex items-start gap-2.5"
                >
                  <AlertCircle className="h-5 w-5 text-rose-500 shrink-0 mt-0.5" />
                  <div>
                    <h4 className="font-semibold text-rose-800">Error Gagal Generate</h4>
                    <p className="text-rose-700 mt-0.5 leading-relaxed">{errorMessage}</p>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Action Buttons */}
            <div className="flex gap-3 pt-2">
              <button
                id="generate-spintax-btn"
                onClick={handleGenerate}
                disabled={isGenerating || !inputText.trim()}
                className="flex-1 bg-brand hover:bg-brand-hover disabled:bg-brand/50 text-white font-semibold py-3 px-6 rounded-xl shadow-md hover:shadow-lg disabled:shadow-none transition-all flex items-center justify-center gap-2 text-base"
              >
                {isGenerating ? (
                  <>
                    <RefreshCw className="h-5 w-5 animate-spin" />
                    Generating...
                  </>
                ) : (
                  <>
                    <Play className="h-5 w-5 fill-current" />
                    Generate Spintax
                  </>
                )}
              </button>
              <button
                id="clear-all-btn"
                onClick={handleClear}
                disabled={isGenerating}
                className="bg-slate-100 hover:bg-slate-200/80 text-slate-700 disabled:opacity-50 font-semibold px-5 py-3 rounded-xl transition-all border border-slate-200"
              >
                Hapus
              </button>
            </div>
          </div>

          {/* RIGHT PANEL - OUTPUT SPINTAX */}
          <div id="right-panel-output" className="bg-white border border-slate-200 rounded-2xl shadow-xs p-6 flex flex-col space-y-6">
            <h2 className="text-lg font-bold text-slate-900 font-display flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-brand" />
              Output Spintax
            </h2>

            {!spintaxResult && !isGenerating ? (
              // Idle state mockup
              <div id="output-idle-state" className="flex-1 flex flex-col items-center justify-center text-center p-8 border border-dashed border-slate-200 rounded-xl bg-slate-50/50 min-h-[400px]">
                <div className="p-4 bg-brand-light text-brand rounded-2xl shadow-inner mb-4">
                  <Sparkles className="h-8 w-8" />
                </div>
                <h3 className="font-bold text-slate-800 text-base">Hasil Spintax Kosong</h3>
                <p className="text-slate-500 text-sm max-w-sm mt-2 leading-relaxed">
                  Tempel artikel Anda, atur format serta kata kunci yang ingin dilindungi, lalu tekan tombol <b>Generate Spintax</b> untuk memulai.
                </p>
              </div>
            ) : isGenerating ? (
              // Loading/Generating mockup state
              <div id="output-generating-state" className="flex-1 flex flex-col items-center justify-center text-center p-8 border border-dashed border-brand-muted rounded-xl bg-brand-light/50 min-h-[400px]">
                <div className="relative mb-6">
                  <div className="h-16 w-16 rounded-full border-4 border-brand-light border-t-brand animate-spin" />
                  <Sparkles className="h-6 w-6 text-brand absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 animate-bounce" />
                </div>
                <h3 className="font-bold text-slate-800 text-base">Melakukan Smart Contextual Rewrite...</h3>
                <p className="text-brand font-semibold text-xs mt-1 animate-pulse uppercase tracking-wider">Sedang Memproses Paragraf</p>
                <div className="mt-4 max-w-xs text-xs text-slate-400 space-y-1 leading-relaxed">
                  <p>• Memahami makna kalimat utuh...</p>
                  <p>• Melindungi struktur tag format {fileType}...</p>
                  <p>• Mempertahankan kata kunci SEO penting...</p>
                </div>
              </div>
            ) : (
              // Full output panel with actions
              <div id="output-full-view" className="flex-1 flex flex-col space-y-6">
                
                {/* Spintax Article Box */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                      Spintax Valid Format {"{...|...}"}
                    </span>
                    {durationMs !== null && (
                      <span className="text-xs bg-brand-light text-brand px-2.5 py-0.5 rounded-full font-semibold">
                        Selesai dalam {(durationMs / 1000).toFixed(2)} detik
                      </span>
                    )}
                  </div>
                  
                  <textarea
                    id="output-spintax-textarea"
                    rows={8}
                    readOnly
                    value={spintaxResult}
                    className="w-full bg-slate-900 text-brand-light border border-slate-950 focus:outline-hidden rounded-xl p-4 text-sm font-mono leading-relaxed shadow-inner"
                  />

                  {/* Export Options Action Bar - OPTIMIZED FOR A SINGLE ROW */}
                  <div className="flex md:flex-nowrap flex-wrap gap-1.5 mt-2.5 overflow-x-auto pb-1 select-none no-scrollbar">
                    <button
                      id="copy-spintax-btn"
                      onClick={handleCopySpintax}
                      className="flex-1 min-w-[110px] bg-brand hover:bg-brand-hover text-white font-semibold py-2 px-3 rounded-lg text-[11px] transition-colors flex items-center justify-center gap-1.5 shrink-0"
                    >
                      {copiedSpintax ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                      {copiedSpintax ? "Copied!" : "Copy"}
                    </button>
                    
                    <button
                      id="export-txt-btn"
                      onClick={downloadTxt}
                      className="flex-1 min-w-[85px] bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200 font-semibold py-2 px-2.5 rounded-lg text-[11px] transition-colors flex items-center justify-center gap-1 shrink-0"
                    >
                      <Download className="h-3.5 w-3.5" />
                      TXT
                    </button>

                    <button
                      id="export-csv-btn"
                      onClick={downloadCsv}
                      className="flex-1 min-w-[85px] bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200 font-semibold py-2 px-2.5 rounded-lg text-[11px] transition-colors flex items-center justify-center gap-1 shrink-0"
                    >
                      <Download className="h-3.5 w-3.5" />
                      CSV
                    </button>

                    <button
                      id="export-html-btn"
                      onClick={downloadHtml}
                      className="flex-1 min-w-[85px] bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200 font-semibold py-2 px-2.5 rounded-lg text-[11px] transition-colors flex items-center justify-center gap-1 shrink-0"
                    >
                      <Download className="h-3.5 w-3.5" />
                      HTML
                    </button>

                    <button
                      id="export-md-btn"
                      onClick={downloadMarkdown}
                      className="flex-1 min-w-[85px] bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200 font-semibold py-2 px-2.5 rounded-lg text-[11px] transition-colors flex items-center justify-center gap-1 shrink-0"
                    >
                      <Download className="h-3.5 w-3.5" />
                      Markdown
                    </button>
                  </div>
                </div>

                {/* Real-time resolved Previews Section */}
                <div className="border-t border-slate-100 pt-6">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-1.5">
                      <Eye className="h-4 w-4 text-brand" />
                      <h3 className="text-sm font-bold text-slate-900 font-display">Spun Articles Real Previews</h3>
                    </div>
                    <span className="text-xs text-slate-400">Pilih pratinjau acak untuk melihat hasil unik</span>
                  </div>

                  {/* Tabs for Previews */}
                  <div className="flex gap-1.5 bg-slate-100 p-1 rounded-xl border border-slate-200/60 mb-3">
                    {[1, 2, 3].map((num, idx) => (
                      <button
                        key={num}
                        onClick={() => setActivePreviewTab(idx)}
                        className={`flex-1 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                          activePreviewTab === idx
                            ? "bg-white text-brand shadow-3xs font-bold"
                            : "text-slate-500 hover:text-slate-800"
                        }`}
                      >
                        Preview {num}
                      </button>
                    ))}
                  </div>

                  {/* Render the Active Preview */}
                  <div className="relative bg-slate-50 border border-slate-200 rounded-xl p-4 min-h-[160px] max-h-[300px] overflow-y-auto">
                    <pre className="text-slate-700 text-sm whitespace-pre-wrap font-sans leading-relaxed">
                      {previews[activePreviewTab] || "Generating previews..."}
                    </pre>

                    {previews[activePreviewTab] && (
                      <div className="sticky bottom-0 right-0 flex justify-end pt-3">
                        <button
                          id="copy-preview-btn"
                          onClick={() => handleCopyPreview(previews[activePreviewTab])}
                          className="bg-white hover:bg-slate-100 text-slate-700 border border-slate-200 font-semibold py-1.5 px-3 rounded-lg text-xs shadow-2xs transition-colors flex items-center gap-1"
                        >
                          {copiedPreview ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5 text-slate-400" />}
                          {copiedPreview ? "Copied!" : "Salin Preview"}
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                {/* Explanation about spintax resolution */}
                <div className="flex gap-2 bg-brand-light/50 border border-brand-muted p-3 rounded-xl text-xs text-brand-hover leading-relaxed">
                  <Info className="h-4.5 w-4.5 text-brand shrink-0 mt-0.5" />
                  <p>
                    Setiap pratinjau di atas diselesaikan secara instan menggunakan parser kami. Anda dapat menyalin dan menggunakan artikel ini secara langsung, atau menggunakan kode spintax di atas di sistem SEO Anda.
                  </p>
                </div>

              </div>
            )}
          </div>
          
        </div>

        {/* Multi-API Key Manager Health component */}
        <KeyHealthPanel
          keys={keysHealth}
          logs={debugLogs}
          onRefresh={refreshKeysOnServer}
          isRefreshing={isRefreshingKeys}
        />
      </main>

      {/* Simple Footer */}
      <footer id="app-footer" className="mt-12 py-5 border-t border-slate-200/60 text-center">
        <p className="text-xs text-slate-400">
          &copy; {new Date().getFullYear()} Karya Prajurit Digital. Hak Cipta Dilindungi.
        </p>
      </footer>
    </div>
  );
}
