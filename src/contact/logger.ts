export type LogLevel = 'info' | 'warn' | 'error';
export type Logger = (level: LogLevel, message: string, data?: Record<string, unknown>) => void;

/** One JSON object per line, which Workers Logs and most log shippers index field by field. */
export const consoleLogger: Logger = (level, message, data = {}) => {
  const line = JSON.stringify({ level, message, ...data });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
};
