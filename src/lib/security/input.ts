import { z } from 'zod';

export const feedbackInput = z.object({
  category: z.enum(['bug', 'feature', 'sync_issue', 'general']).default('general'),
  severity: z.enum(['low', 'normal', 'high', 'critical']).default('normal'),
  subject: z.string().trim().min(1).max(200),
  message: z.string().trim().min(1).max(10_000),
  metadata: z.object({
    path: z.string().max(2048).optional(), referrer: z.string().max(2048).optional(),
    screen: z.string().max(64).optional(), userAgent: z.string().max(1024).optional(),
    os: z.string().max(128).optional(), browser: z.string().max(128).optional(),
  }).default({}),
});

export const applicationStatusInput = z.object({
  status: z.enum(['eligible', 'registration_open', 'applied', 'registered', 'not_applied', 'withdrawn', 'declined', 'shortlisted', 'not_shortlisted', 'not_shortlisted_post_ppt', 'ppt', 'ppt_scheduled', 'ppt_ongoing', 'ppt_completed', 'test', 'test_scheduled', 'test_ongoing', 'test_completed', 'interview', 'interview_scheduled', 'interview_ongoing', 'interview_completed', 'selected', 'offer', 'offer_received', 'offered', 'rejected', 'rejected_test', 'test_eliminated', 'rejected_interview', 'interview_eliminated']),
  role: z.string().trim().max(300).nullable().optional(),
  ctc: z.string().trim().max(300).nullable().optional(),
  location: z.string().trim().max(500).nullable().optional(),
  notes: z.string().trim().max(5000).nullable().optional(),
  placement_drive_id: z.uuid().nullable().optional(), application_id: z.uuid().nullable().optional(),
});

export const notificationPreferencesInput = z.object({
  browserPushEnabled: z.boolean().optional(), inAppEnabled: z.boolean().optional(),
  notifyStatusChange: z.boolean().optional(), notifyShortlist: z.boolean().optional(),
  notifyTests: z.boolean().optional(), notifyInterviews: z.boolean().optional(),
  notifyPpt: z.boolean().optional(), notifyNewJds: z.boolean().optional(), notifyReminders: z.boolean().optional(),
  reminderEventTypes: z.array(z.enum(['online_test', 'coding_test', 'technical_interview', 'hr_interview', 'final_interview', 'ppt', 'registration_deadline'])).max(7).optional(),
  reminderLeadTimeMins: z.array(z.number().int().min(1).max(10080)).max(10).optional(),
}).strict();
