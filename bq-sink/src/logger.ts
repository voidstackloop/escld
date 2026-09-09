type LogFields = Record<string, unknown>;

function write(level: "info" | "warn" | "error", message: string, fields: LogFields): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...fields,
  };
  const line = JSON.stringify(entry, jsonReplacer);
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

export interface Logger {
  info: (message: string, fields?: LogFields) => void;
  warn: (message: string, fields?: LogFields) => void;
  error: (message: string, fields?: LogFields) => void;
  child: (fields: LogFields) => Logger;
}

function createLogger(baseFields: LogFields): Logger {
  return {
    info: (message, fields = {}) => write("info", message, { ...baseFields, ...fields }),
    warn: (message, fields = {}) => write("warn", message, { ...baseFields, ...fields }),
    error: (message, fields = {}) => write("error", message, { ...baseFields, ...fields }),
    child: (fields) => createLogger({ ...baseFields, ...fields }),
  };
}

export const logger: Logger = createLogger({});
