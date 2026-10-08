/** A deleted message is terminal for its saved queue entry, unlike quota/network failures. */
export async function readGmailMessageIfPresent<T>(read: () => Promise<T>): Promise<T | null> {
  try { return await read(); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 404) return null;
    throw error;
  }
}
