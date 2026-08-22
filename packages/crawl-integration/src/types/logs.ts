export type LogLevel = 0 | 1 | 2;

export const LOG_LEVEL_NAMES: Record<LogLevel, string> = {
  0: "error",
  1: "info",
  2: "debug",
};

export type LogLine = {
  id?: string;
  category?: string;
  message: string;
  level?: LogLevel;
  timestamp?: string;
  auxiliary?: {
    [key: string]: {
      value: string;
      type: "object" | "string" | "html" | "integer" | "float" | "boolean";
    };
  };
};

export type Logger = (logLine: LogLine) => void;
