import { type gmail_v1 } from 'googleapis';

export interface HistoryResult {
  messageIds: string[];
  deletedMessageIds: string[];
  latestHistoryId: string | null;
  historyExpired: boolean;
}

/**
 * Fetches message IDs whose content or labels changed since `startHistoryId`.
 * If startHistoryId is invalid or expired (404/400), returns historyExpired: true.
 */
export async function fetchHistoryChanges(
  gmail: gmail_v1.Gmail,
  startHistoryId: string
): Promise<HistoryResult> {
  const messageIds = new Set<string>();
  const deletedMessageIds = new Set<string>();
  let latestHistoryId = startHistoryId;
  let pageToken: string | undefined;

  try {
    do {
      const response = await gmail.users.history.list({
        userId: 'me',
        startHistoryId,
        maxResults: 100,
        pageToken,
        historyTypes: ['messageAdded', 'labelAdded', 'labelRemoved', 'messageDeleted'],
      });

      if (response.data.historyId) {
        latestHistoryId = response.data.historyId;
      }

      if (response.data.history) {
        for (const record of response.data.history) {
          if (record.messagesAdded) {
            for (const item of record.messagesAdded) {
              if (item.message?.id) {
                messageIds.add(item.message.id);
              }
            }
          }
          if (record.labelsAdded) {
            for (const item of record.labelsAdded) {
              if (item.message?.id) messageIds.add(item.message.id);
            }
          }
          if (record.labelsRemoved) {
            for (const item of record.labelsRemoved) {
              if (item.message?.id) messageIds.add(item.message.id);
            }
          }
          if (record.messagesDeleted) {
            for (const item of record.messagesDeleted) {
              if (item.message?.id) deletedMessageIds.add(item.message.id);
            }
          }
        }
      }

      pageToken = response.data.nextPageToken || undefined;
    } while (pageToken);

    return {
      messageIds: Array.from(messageIds),
      deletedMessageIds: Array.from(deletedMessageIds),
      latestHistoryId,
      historyExpired: false,
    };
  } catch (err: unknown) {
    const errorObj = err as { code?: number; status?: number; message?: string };
    const statusCode = errorObj.code || errorObj.status;

    // 404 or 400 means historyId is too old (past 30 days) or invalid
    if (statusCode === 404 || statusCode === 400 || (errorObj.message && errorObj.message.includes('HistoryId'))) {
      console.warn(`History ID ${startHistoryId} expired or invalid. Falling back to full search.`);
      const profile = await getProfileHistoryId(gmail);
      return {
        messageIds: [],
        deletedMessageIds: [],
        latestHistoryId: profile,
        historyExpired: true,
      };
    }

    throw err;
  }
}

/**
 * Gets the current historyId of the mailbox from profile.
 */
export async function getProfileHistoryId(gmail: gmail_v1.Gmail): Promise<string | null> {
  try {
    const profile = await gmail.users.getProfile({ userId: 'me' });
    return profile.data.historyId || null;
  } catch (err) {
    console.error('Failed to fetch profile historyId:', err);
    return null;
  }
}
