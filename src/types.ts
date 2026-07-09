export type FileType = "text" | "html" | "markdown";

export interface KeyHealth {
  name: string;
  maskedKey: string;
  status: "Ready" | "Busy" | "Cooling Down" | "Disabled" | "Error";
  timeRemaining: number; // in seconds
  failureCount: number;
  lastUsed: string;
  errorMessage?: string;
}

export interface DebugLog {
  time: string;
  apiKeyName: string;
  maskedKey: string;
  model: string;
  durationMs: number;
  status: "Success" | "Failover" | "Error";
  error?: string;
  attempt: number;
}

export interface GenerateResponse {
  spintax: string;
  previews: string[];
  durationMs: number;
  debugLogs: DebugLog[];
  keysHealth: KeyHealth[];
}
