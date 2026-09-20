# Phase 3 Drive Identity Migration

## Runtime Rule

New live email processing is drive-scoped only when the email has an assigned
or manually assigned drive with high or medium confidence. Ambiguous, conflict,
unassigned, and low-confidence emails are stored with their assignment metadata
but do not mutate applications, statuses, events, candidate evidence, calendar
state, or notifications.

Company-only processing is reserved for explicitly identified legacy records.
It is not a fallback for new live emails.

## Deferred Issues

- Registration-deadline notifications are currently not fully idempotent across
  repeated sync runs. Future identity should be
  `(user_id, placement_drive_id, event_id, reminder_bucket)`.
- Reprocess still needs a complete drive-bucket recalculation implementation.
- Calendar UI and Google Calendar reconciliation still need drive-aware keys and
  metadata; company-name fuzzy matching is legacy-only and must not be used for
  new drive-scoped records.
- Company deduplication must preserve distinct placement drives instead of
  collapsing their operational records.
- The legacy company recalculator remains intentionally isolated for records
  without authoritative drive assignment. Drive-owned emails are processed by
  the drive-grouped recalculation path and are excluded from that legacy bucket.

## Remaining Issue

- **Deadline notification idempotency / repeated notification generation**:
  `checkAndNotifyRegistrationDeadlines()` still uses the event ID and reminder
  bucket as its current dedupe identity. Recreated deadline events can therefore
  receive new IDs and produce repeated notifications. This is intentionally not
  fixed in Phase 3. A future key should include stable drive/event identity and
  reminder bucket.
