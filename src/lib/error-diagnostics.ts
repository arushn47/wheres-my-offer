type DiagnosticValue = string | number | boolean | Diagnostic | DiagnosticValue[];
interface Diagnostic { [key: string]: DiagnosticValue }

function read(value: object, key: string): unknown {
  try { return Reflect.get(value, key); } catch { return undefined; }
}

function safeText(value: string, limit = 2000): string {
  return value
    .replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [REDACTED]')
    .replace(/\b(access_token|refresh_token|client_secret|api_key|apikey|authorization)\b(["']?\s*[:=]\s*["']?)[^\s&"',;}]+/gi, '$1$2[REDACTED]')
    .slice(0, limit);
}

/** Select error fields explicitly: Google errors also carry request headers,
 * OAuth tokens and mail payloads in config/response, which must not be logged. */
export function describeError(value: unknown): Diagnostic {
  const seen = new WeakSet<object>();
  function visit(error: unknown, depth: number): Diagnostic {
    if (error === null || typeof error !== 'object') {
      return { message: safeText(String(error)) };
    }
    if (seen.has(error)) return { message: '[Circular error]' };
    if (depth > 3) return { message: '[Nested error truncated]' };
    seen.add(error);
    const diagnostic: Diagnostic = {};
    for (const key of ['name', 'code', 'status', 'statusCode', 'message', 'details', 'hint', 'reason', 'domain']) {
      const field = read(error, key);
      if (typeof field === 'string') diagnostic[key] = safeText(field);
      else if (typeof field === 'number' || typeof field === 'boolean') diagnostic[key] = field;
    }
    const errors = read(error, 'errors');
    if (Array.isArray(errors)) diagnostic.errors = errors.slice(0, 5).map(item => visit(item, depth + 1));
    const cause = read(error, 'cause');
    if (cause !== undefined) diagnostic.cause = visit(cause, depth + 1);
    const response = read(error, 'response');
    if (response && typeof response === 'object') {
      const data = read(response, 'data');
      const responseError = data && typeof data === 'object' ? read(data, 'error') : undefined;
      const status = read(response, 'status');
      const responseDiagnostic: Diagnostic = {};
      if (typeof status === 'number') responseDiagnostic.status = status;
      if (responseError !== undefined) responseDiagnostic.error = visit(responseError, depth + 1);
      // OAuth error responses use error_description alongside error.
      const description = data && typeof data === 'object' ? read(data, 'error_description') : undefined;
      if (typeof description === 'string') responseDiagnostic.error_description = safeText(description);
      if (Object.keys(responseDiagnostic).length) diagnostic.response = responseDiagnostic;
    }
    const stack = read(error, 'stack');
    if (typeof stack === 'string') diagnostic.stack = safeText(stack, 6000);
    if (!Object.keys(diagnostic).length) diagnostic.message = 'Unknown object error';
    return diagnostic;
  }
  return visit(value, 0);
}

export function diagnosticMessage(diagnostic: Diagnostic): string {
  return typeof diagnostic.message === 'string' && diagnostic.message
    ? diagnostic.message
    : JSON.stringify(diagnostic);
}

/** The existing inbox RPC stores at most 2,000 characters. Keep valid JSON and
 * prioritize provider fields over stacks (full bounded stacks remain in logs). */
export function diagnosticForStorage(diagnostic: Diagnostic): string {
  function compact(value: DiagnosticValue, limit: number): DiagnosticValue {
    if (typeof value === 'string') return value.length > limit ? `${value.slice(0, limit)}…` : value;
    if (Array.isArray(value)) return value.map(item => compact(item, limit));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'stack')
        .map(([key, field]) => [key, compact(field, limit)]));
    }
    return value;
  }
  for (const limit of [2000, 500, 120, 32]) {
    const text = JSON.stringify(compact(diagnostic, limit));
    if (text.length <= 2000) return text;
  }
  return JSON.stringify({ message: diagnosticMessage(diagnostic).slice(0, 1000), truncated: true });
}
