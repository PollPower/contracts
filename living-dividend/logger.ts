type LogPayload = Record<string, unknown> | undefined;

function emit(level: 'INFO' | 'WARN' | 'ERROR', message: string, payload?: LogPayload): void {
  const timestamp = new Date().toISOString();
  if (payload && Object.keys(payload).length > 0) {
    console.log(`${timestamp} ${level} ${message} ${JSON.stringify(payload)}`);
    return;
  }
  console.log(`${timestamp} ${level} ${message}`);
}

export const logger = {
  info(message: string, payload?: LogPayload): void {
    emit('INFO', message, payload);
  },
  warn(message: string, payload?: LogPayload): void {
    emit('WARN', message, payload);
  },
  error(message: string, payload?: LogPayload): void {
    emit('ERROR', message, payload);
  },
};
