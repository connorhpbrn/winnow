// Structured JSON logger. Lines go to stderr so the CLI can print brief JSON to
// stdout cleanly. Every model call is logged with role / token counts / latency
// (spec Section 17: log every model call for cost tracking).

type Fields = Record<string, unknown>;

function emit(level: string, msg: string, fields?: Fields): void {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields });
  process.stderr.write(line + '\n');
}

export interface ModelCallLog {
  role: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  costUsd?: number;
  ok: boolean;
}

export const log = {
  info: (msg: string, fields?: Fields) => emit('info', msg, fields),
  warn: (msg: string, fields?: Fields) => emit('warn', msg, fields),
  error: (msg: string, fields?: Fields) => emit('error', msg, fields),
  debug: (msg: string, fields?: Fields) => {
    if (process.env.WINNOW_DEBUG) emit('debug', msg, fields);
  },
  model: (u: ModelCallLog) => emit('model', 'model_call', u as unknown as Fields),
};
