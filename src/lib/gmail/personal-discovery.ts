import type { gmail_v1 } from 'googleapis';
import { fetchMessageIds, getPlacementSearchQuery } from './client';
import { fetchHistoryChanges, getProfileHistoryId } from './history';

/** Full season discovery is reserved for initial setup or an expired cursor. */
export async function discoverPersonalMessages(
  gmail: gmail_v1.Gmail,
  lastHistoryId: string | null,
  onFetchBatch?: (count: number) => void
): Promise<{ messageIds: string[]; nextHistoryId: string | null }> {
  let baseline: string | null;
  if (lastHistoryId) {
    const history = await fetchHistoryChanges(gmail, lastHistoryId, { addedOnly: true });
    if (!history.historyExpired) {
      const deleted = new Set(history.deletedMessageIds);
      return { messageIds: history.messageIds.filter(id => !deleted.has(id)), nextHistoryId: history.latestHistoryId };
    }
    baseline = history.latestHistoryId;
  } else baseline = await getProfileHistoryId(gmail);
  if (!baseline) throw new Error('Unable to capture Gmail history checkpoint before discovery');

  // Capture the high-water mark before discovery so mail arriving during the
  // scan remains visible to the next incremental run.
  const messageIds = await fetchMessageIds(gmail, getPlacementSearchQuery('personal'), 2500, onFetchBatch);
  return { messageIds, nextHistoryId: baseline };
}
