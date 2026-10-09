// Inspect a clone so the route's JSON parser still receives the original body.
export async function bodyWithinLimit(request: Request, maximumBytes: number): Promise<boolean> {
  const length = request.headers.get('content-length');
  if (length && Number(length) > maximumBytes) return false;
  const reader = request.clone().body?.getReader();
  if (!reader) return true;
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return true;
      size += value.byteLength;
      if (size > maximumBytes) {
        // Cancellation of a tee may wait for the original stream; don't await it.
        void reader.cancel().catch(() => {});
        return false;
      }
    }
  } catch { return false; }
  finally { reader.releaseLock(); }
}
