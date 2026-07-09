import React, { useState } from "react";
import { KeyHealth, DebugLog } from "../types";
import { motion, AnimatePresence } from "motion/react";
import { 
  Cpu, 
  RotateCw, 
  CheckCircle2, 
  AlertTriangle, 
  Clock, 
  XCircle, 
  Terminal, 
  ChevronDown, 
  ChevronUp,
  Zap
} from "lucide-react";

interface KeyHealthPanelProps {
  keys: KeyHealth[];
  logs: DebugLog[];
  onRefresh: () => void;
  isRefreshing: boolean;
}

export default function KeyHealthPanel({ keys, logs, onRefresh, isRefreshing }: KeyHealthPanelProps) {
  const [isOpen, setIsOpen] = useState(false);

  const getStatusBadge = (status: KeyHealth["status"]) => {
    switch (status) {
      case "Ready":
        return (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
            Ready
          </span>
        );
      case "Cooling Down":
        return (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200">
            <Clock className="h-3 w-3 animate-spin" />
            Cooldown
          </span>
        );
      case "Error":
      case "Disabled":
        return (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium bg-rose-50 text-rose-700 border border-rose-200">
            <XCircle className="h-3 w-3" />
            {status}
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium bg-slate-50 text-slate-700 border border-slate-200">
            {status}
          </span>
        );
    }
  };

  return (
    <div id="key-health-panel-container" className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm mt-6">
      <div
        id="toggle-panel-button"
        onClick={() => setIsOpen(!isOpen)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            setIsOpen(!isOpen);
          }
        }}
        role="button"
        tabIndex={0}
        className="w-full flex items-center justify-between px-5 py-4 bg-slate-50 hover:bg-slate-100/80 transition-colors text-left cursor-pointer focus:outline-none"
      >
        <div className="flex items-center gap-2.5">
          <Cpu className="h-5 w-5 text-slate-500" />
          <div>
            <h3 className="font-semibold text-slate-800 font-display">Multi-API Key Rotation Status</h3>
            <p className="text-xs text-slate-500">
              Active rotation across {keys.filter(k => k.status === "Ready").length} / {keys.length} loaded Gemini API Keys
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            id="refresh-keys-button"
            onClick={(e) => {
              e.stopPropagation();
              onRefresh();
            }}
            disabled={isRefreshing}
            className="p-1.5 rounded-md hover:bg-slate-200 text-slate-500 disabled:opacity-50 transition-colors cursor-pointer"
            title="Reload API Keys status"
          >
            <RotateCw className={`h-4 w-4 ${isRefreshing ? "animate-spin text-indigo-600" : ""}`} />
          </button>
          {isOpen ? <ChevronUp className="h-5 w-5 text-slate-400" /> : <ChevronDown className="h-5 w-5 text-slate-400" />}
        </div>
      </div>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            id="key-health-panel-content"
            initial={{ height: 0 }}
            animate={{ height: "auto" }}
            exit={{ height: 0 }}
            transition={{ duration: 0.25 }}
            className="overflow-hidden border-t border-slate-100"
          >
            <div className="p-5 space-y-6">
              {/* Key status grid */}
              <div>
                <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3">Loaded Secrets / Status Matrix</h4>
                {keys.length === 0 ? (
                  <div className="text-sm text-slate-500 bg-slate-50 rounded-lg p-4 text-center border border-dashed border-slate-200">
                    No API keys initialized. Define <code className="bg-slate-100 px-1 py-0.5 rounded text-rose-600 font-mono">GEMINI_API_KEY</code> or <code className="bg-slate-100 px-1 py-0.5 rounded text-rose-600 font-mono">GEMINI_API_KEY_1, _2...</code> in your Environment Secrets.
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm text-slate-700">
                      <thead>
                        <tr className="border-b border-slate-100 text-slate-400 text-xs font-semibold">
                          <th className="pb-2">API Key Alias</th>
                          <th className="pb-2">Signature</th>
                          <th className="pb-2">Health Status</th>
                          <th className="pb-2 text-right">Cooldown</th>
                          <th className="pb-2 text-right">Last Request</th>
                          <th className="pb-2 text-right">Fails</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {keys.map((k) => (
                          <tr key={k.name} className="hover:bg-slate-50/50">
                            <td className="py-2.5 font-medium text-slate-900 font-mono text-xs">{k.name}</td>
                            <td className="py-2.5 text-slate-500 font-mono text-xs">{k.maskedKey}</td>
                            <td className="py-2.5">{getStatusBadge(k.status)}</td>
                            <td className="py-2.5 text-right font-mono text-xs text-amber-600">
                              {k.timeRemaining > 0 ? `${k.timeRemaining}s` : "—"}
                            </td>
                            <td className="py-2.5 text-right text-xs text-slate-500">
                              {k.lastUsed !== "Never" ? new Date(k.lastUsed).toLocaleTimeString() : "Never"}
                            </td>
                            <td className="py-2.5 text-right font-mono text-xs">
                              {k.failureCount > 0 ? (
                                <span className="text-rose-600 font-bold">{k.failureCount}</span>
                              ) : (
                                <span className="text-slate-400">0</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Console log history */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                    <Terminal className="h-3.5 w-3.5" />
                    Rotation & Failover Logs (Developer Mode)
                  </h4>
                  <span className="text-slate-400 text-xs">Only visible for debugging</span>
                </div>
                
                {logs.length === 0 ? (
                  <div className="bg-slate-900 text-slate-400 font-mono text-xs rounded-lg p-4 text-center border border-slate-800">
                    Console idle. Trigger a "Generate Spintax" request to view real-time API rotation and timing metrics.
                  </div>
                ) : (
                  <div className="bg-slate-950 text-slate-300 font-mono text-xs rounded-lg p-3 max-h-[220px] overflow-y-auto space-y-2 border border-slate-900 shadow-inner">
                    {logs.map((log, i) => (
                      <div 
                        key={i} 
                        className={`p-2 rounded border leading-relaxed ${
                          log.status === "Success" 
                            ? "bg-emerald-950/20 border-emerald-900/30 text-emerald-300" 
                            : "bg-amber-950/30 border-amber-900/30 text-amber-300"
                        }`}
                      >
                        <div className="flex items-center justify-between font-bold mb-1">
                          <span className="flex items-center gap-1">
                            {log.status === "Success" ? <CheckCircle2 className="h-3 w-3 text-emerald-400" /> : <AlertTriangle className="h-3 w-3 text-amber-400" />}
                            [{log.status}] Attempt #{log.attempt}
                          </span>
                          <span className="text-[10px] text-slate-500">{new Date(log.time).toLocaleTimeString()}</span>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-1 mt-1 text-slate-400">
                          <div><span className="text-slate-500">Key:</span> {log.apiKeyName} ({log.maskedKey})</div>
                          <div><span className="text-slate-500">Model:</span> {log.model}</div>
                          <div><span className="text-slate-500">Duration:</span> {log.durationMs}ms</div>
                          {log.error && (
                            <div className="col-span-1 md:col-span-2 text-rose-300 bg-rose-950/20 px-1.5 py-0.5 rounded mt-1 border border-rose-900/20">
                              <span className="font-bold">Error:</span> {log.error}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
