export interface NotificationPreferences {
  userId: string;
  browserPushEnabled: boolean;
  inAppEnabled: boolean;
  notifyStatusChange: boolean;
  notifyShortlist: boolean;
  notifyTests: boolean;
  notifyInterviews: boolean;
  notifyPpt: boolean;
  notifyNewJds: boolean;
  notifyReminders: boolean;
  reminderEventTypes: string[];
  reminderLeadTimeMins: number[];
}

export const DEFAULT_PREFERENCES: Omit<NotificationPreferences, 'userId'> = {
  browserPushEnabled: true,
  inAppEnabled: true,
  notifyStatusChange: true,
  notifyShortlist: true,
  notifyTests: true,
  notifyInterviews: true,
  notifyPpt: true,
  notifyNewJds: true,
  notifyReminders: true,
  reminderEventTypes: [
    'online_test',
    'coding_test',
    'technical_interview',
    'hr_interview',
    'final_interview',
    'ppt',
    'registration_deadline',
  ],
  reminderLeadTimeMins: [1440, 120, 15],
};

