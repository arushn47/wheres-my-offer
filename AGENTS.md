# NeoTrack Agent Context & Core Architecture Rules

## ⚠️ CRITICAL KNOWLEDGE: External Background Cron Job & Google Pub/Sub
- **Provider**: [cron-job.org](https://console.cron-job.org/jobs/8265126)
- **Job Title**: `Where's My Offer Email Sync`
- **Target URL**: `https://www.wheresmyoffer.in/api/cron/sync`
- **Execution Schedule**: **Daily at 00:00** (`0 0 * * *` Asia/Kolkata)
- **Role**: Daily safety net, time-based event deadline notifications, stale page cleanup, and **crucial Gmail Pub/Sub watch renewal** (`renewExpiringWatches`).
- **Primary Delivery**: Google Cloud Pub/Sub push webhooks handle real-time incoming emails.
- **Status**: **ACTIVE IN THE BACKGROUND** (running independently of local dev or browser sessions).

### Architectural Implications (DO NOT VIOLATE):
1. **Never Run Unlocked Syncs**: Concurrency locks must always be enforced so cron and manual/pubsub syncs never collide.
2. **Per-User Concurrency Locking**:
   - `runSync(userId)` MUST check if a sync is already active for that user before doing any work.
   - If `is_syncing === true` and the lock has not expired/gone stale, subsequent cron or manual requests MUST cleanly skip without crashing, interrupting, or corrupting state.
3. **No Unchecked Browser Auto-Sync Loops**: The client topbar MUST NOT blindly fire silent syncs on a short interval (e.g. 5 mins) while a sync is already running in background or from cron.
4. **State Persistence**: Sync progress must be stored in the database (`sync_state` table) and cached, so reloads or browser restarts can seamlessly restore and inspect progress without losing context.

---

## Placement Architecture & Sync Pipeline
- **Personal Gmail**: Official NeoPAT announcements (`noreply.cdcinfo@vitstudent.ac.in`). These are the master records for company creation and registration status.
- **College Gmail**: CDC circulars, eligibility sheets, CTC tables, test/interview schedules.
- **Onboarding Requirements**: Personal Gmail + College Gmail + NeoPAT Registration ID are mandatory before sync is unlocked.
