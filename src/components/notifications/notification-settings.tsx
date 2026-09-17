'use client';

import { useState, useEffect } from 'react';
import {
  Bell,
  Sparkles,
  FileText,
  Award,
  Calendar,
  Building2,
  Clock,
  Send,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Smartphone,
  Timer,
  Check,
  Zap,
} from 'lucide-react';
import { usePushNotifications } from '@/hooks/use-push-notifications';
import { cn } from '@/lib/utils';
import type { NotificationPreferences } from '@/lib/notifications/preferences';
import { DEFAULT_PREFERENCES } from '@/lib/notifications/preferences';
import { appToast } from '@/lib/toast';
import { Switch } from '@/components/ui/switch';

const REMINDER_EVENT_OPTIONS = [
  {
    id: 'test',
    label: 'Tests & Assessments',
    desc: 'Hackerrank, Mettl, Codility & exams',
    types: ['online_test', 'coding_test'],
  },
  {
    id: 'interview',
    label: 'Interviews & Rounds',
    desc: 'Technical, HR & panel links',
    types: ['technical_interview', 'hr_interview', 'final_interview'],
  },
  {
    id: 'ppt',
    label: 'Pre-Placement Talks',
    desc: 'Corporate presentations & briefings',
    types: ['ppt'],
  },
  {
    id: 'deadline',
    label: 'Registration Deadlines',
    desc: 'CDC portal & NeoPAT cut-offs',
    types: ['registration_deadline'],
  },
];

const LEAD_TIME_OPTIONS = [
  { minutes: 1440, label: '24h before' },
  { minutes: 120, label: '2h before' },
  { minutes: 60, label: '1h before' },
  { minutes: 30, label: '30m before' },
  { minutes: 15, label: '15m before' },
];

export default function NotificationSettings() {
  const {
    isSupported,
    permission,
    isSubscribed,
    isChecking,
    loading: pushLoading,
    error: pushError,
    subscribeToPush,
    unsubscribeFromPush,
  } = usePushNotifications();

  const [preferences, setPreferences] = useState<Partial<NotificationPreferences>>({
    ...DEFAULT_PREFERENCES,
  });

  const [loadingPrefs, setLoadingPrefs] = useState(true);
  const [savingPrefs, setSavingPrefs] = useState(false);
  const [testingPush, setTestingPush] = useState(false);
  const [testFeedback, setTestFeedback] = useState<{ success: boolean; message: string } | null>(null);

  // Load preferences on mount
  useEffect(() => {
    fetch('/api/notifications/preferences')
      .then((res) => res.json())
      .then((data) => {
        if (data?.preferences) {
          setPreferences(data.preferences);
        }
      })
      .catch((err) => console.error('Failed to load preferences:', err))
      .finally(() => setLoadingPrefs(false));
  }, []);

  const handleUpdatePref = async (updates: Partial<NotificationPreferences>) => {
    setPreferences((prev) => ({ ...prev, ...updates }));

    try {
      setSavingPrefs(true);
      await fetch('/api/notifications/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
    } catch (err) {
      console.error('Failed to save preference:', err);
    } finally {
      setSavingPrefs(false);
    }
  };

  const handleTogglePush = async (nextChecked: boolean) => {
    if (!nextChecked && isSubscribed) {
      await unsubscribeFromPush();
      handleUpdatePref({ browserPushEnabled: false });
    } else if (nextChecked && !isSubscribed) {
      const ok = await subscribeToPush();
      if (ok) {
        handleUpdatePref({ browserPushEnabled: true });
      }
    }
  };

  const handleSendTestNotification = async () => {
    setTestingPush(true);
    setTestFeedback(null);
    try {
      const res = await fetch('/api/notifications/test', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        const pushDelivered = data.result?.pushSent;

        // Instantly notify the bell to fetch the new notification with 0ms delay
        window.dispatchEvent(new CustomEvent('wmo:refresh_notifications'));

        setTestFeedback({
          success: true,
          message: pushDelivered
            ? 'Test notification sent! Dispatched to in-app bell & push device.'
            : 'Test alert delivered to in-app bell (browser push is inactive on this device).',
        });
      } else {
        throw new Error('Test failed');
      }
    } catch {
      appToast.error('Could not send test notification', 'Please check your connection and try again.');
      setTestFeedback({
        success: false,
        message: 'Could not send test notification.',
      });
    } finally {
      setTestingPush(false);
      setTimeout(() => setTestFeedback(null), 5000);
    }
  };

  const currentReminderTypes = preferences.reminderEventTypes || DEFAULT_PREFERENCES.reminderEventTypes;
  const currentLeadTimes = preferences.reminderLeadTimeMins || DEFAULT_PREFERENCES.reminderLeadTimeMins;

  const toggleReminderEventType = (types: string[]) => {
    const allIncluded = types.every((t) => currentReminderTypes.includes(t));
    let nextTypes: string[];
    if (allIncluded) {
      nextTypes = currentReminderTypes.filter((t) => !types.includes(t));
    } else {
      nextTypes = Array.from(new Set([...currentReminderTypes, ...types]));
    }
    handleUpdatePref({ reminderEventTypes: nextTypes });
  };

  const toggleLeadTime = (minutes: number) => {
    let nextTimes: number[];
    if (currentLeadTimes.includes(minutes)) {
      if (currentLeadTimes.length <= 1) {
        return; // Keep at least one
      }
      nextTimes = currentLeadTimes.filter((m) => m !== minutes);
    } else {
      nextTimes = [...currentLeadTimes, minutes].sort((a, b) => b - a);
    }
    handleUpdatePref({ reminderLeadTimeMins: nextTimes });
  };

  return (
    <section className="rounded-2xl border border-white/[0.07] bg-[#121217] p-4 sm:p-6 space-y-5 shadow-sm">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-emerald-500/25 bg-emerald-500/10 shrink-0">
            <Bell className="h-4 w-4 text-emerald-400" />
          </div>
          <div>
            <h2 className="font-display text-sm sm:text-base font-bold tracking-tight text-white">
              Notifications & Radar Alerts
            </h2>
            <p className="text-[11px] sm:text-xs text-zinc-400 mt-0.5">
              Instant radar pings, push alerts & countdown reminders
            </p>
          </div>
        </div>
        {savingPrefs && (
          <span className="text-[11px] text-emerald-400 flex items-center gap-1.5 font-mono">
            <Loader2 className="w-3 h-3 animate-spin" /> Saving…
          </span>
        )}
      </div>

      <div className="space-y-4">
        {/* Browser Push Master Card */}
        <div className="rounded-xl border border-white/[0.06] bg-zinc-900/50 p-3.5 sm:p-4 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="h-9 w-9 rounded-xl bg-zinc-800/80 border border-zinc-700/60 flex items-center justify-center shrink-0">
                <Smartphone className="w-4 h-4 text-emerald-400" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs sm:text-sm font-semibold text-zinc-100">
                    Browser Push Alerts
                  </span>
                  {isSubscribed && (
                    <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[9px] font-bold text-emerald-300">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" /> Live
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-zinc-400 mt-0.5 leading-snug truncate sm:whitespace-normal">
                  Alerts for test schedules, shortlists & deadlines even when closed
                </p>
              </div>
            </div>

            <div className="shrink-0 flex items-center">
              {isChecking ? (
                <Loader2 className="w-4 h-4 animate-spin text-zinc-400" />
              ) : (
                <Switch
                  checked={isSubscribed}
                  onCheckedChange={handleTogglePush}
                  disabled={pushLoading || (!isSupported && !isSubscribed)}
                  aria-label="Toggle browser push notifications"
                />
              )}
            </div>
          </div>

          {pushError && (
            <div className="flex items-center gap-2 text-[11px] text-rose-400 bg-rose-500/10 border border-rose-500/20 p-2.5 rounded-lg">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
              <span>{pushError}</span>
            </div>
          )}

          {permission === 'denied' && (
            <div className="flex items-center gap-2 text-[11px] text-amber-400 bg-amber-500/10 border border-amber-500/20 p-2.5 rounded-lg">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
              <span>Notifications blocked in browser. Click lock icon in address bar to allow.</span>
            </div>
          )}

          {/* Test Alert Action Row */}
          <div className="pt-2 border-t border-white/[0.05] flex items-center justify-between gap-2">
            <span className="text-[11px] text-zinc-500">Verify push & bell delivery:</span>
            <button
              type="button"
              onClick={handleSendTestNotification}
              disabled={testingPush}
              className="flex items-center gap-1.5 text-[11px] font-semibold text-zinc-300 hover:text-white bg-zinc-800/80 hover:bg-zinc-800 active:scale-95 px-3 py-1.5 rounded-lg border border-zinc-700/60 transition-all cursor-pointer shrink-0"
            >
              {testingPush ? (
                <Loader2 className="w-3 h-3 animate-spin text-emerald-400" />
              ) : (
                <Send className="w-3 h-3 text-zinc-400" />
              )}
              <span>Send Test Alert</span>
            </button>
          </div>

          {testFeedback && (
            <div
              className={cn(
                'flex items-center gap-2 text-[11px] p-2.5 rounded-lg animate-fade-in',
                testFeedback.success
                  ? 'text-emerald-300 bg-emerald-500/10 border border-emerald-500/20'
                  : 'text-rose-300 bg-rose-500/10 border border-rose-500/20'
              )}
            >
              {testFeedback.success ? (
                <CheckCircle2 className="w-3.5 h-3.5 shrink-0 text-emerald-400" />
              ) : (
                <AlertCircle className="w-3.5 h-3.5 shrink-0 text-rose-400" />
              )}
              <span>{testFeedback.message}</span>
            </div>
          )}
        </div>

        {/* Granular Notification Channels */}
        <div className="space-y-2">
          <div className="flex items-center justify-between px-0.5">
            <span className="font-mono text-[10px] font-bold uppercase tracking-wider text-zinc-400">
              Notification Channels
            </span>
            <span className="text-[10px] text-zinc-500 font-mono">In-App & Push</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {[
              {
                key: 'notifyShortlist' as const,
                label: 'Shortlists & Neo ID Matches',
                desc: 'When your Roll / ID appears in an Excel shortlist attachment',
                icon: Sparkles,
                color: 'text-emerald-400',
                bg: 'bg-emerald-500/10 border-emerald-500/20',
              },
              {
                key: 'notifyTests' as const,
                label: 'Assessments & Tests',
                desc: 'Online & coding test timings, slots & platform links',
                icon: FileText,
                color: 'text-amber-400',
                bg: 'bg-amber-500/10 border-amber-500/20',
              },
              {
                key: 'notifyInterviews' as const,
                label: 'Interview Schedules',
                desc: 'Technical, HR & final round slots with meeting links',
                icon: Award,
                color: 'text-purple-400',
                bg: 'bg-purple-500/10 border-purple-500/20',
              },
              {
                key: 'notifyPpt' as const,
                label: 'Pre-Placement Talks (PPT)',
                desc: 'Company presentations, orientations & briefings',
                icon: Calendar,
                color: 'text-sky-400',
                bg: 'bg-sky-500/10 border-sky-500/20',
              },
              {
                key: 'notifyStatusChange' as const,
                label: 'Status Changes & Offers',
                desc: 'Offer won, shortlisted, applied or round transitions',
                icon: CheckCircle2,
                color: 'text-cyan-400',
                bg: 'bg-cyan-500/10 border-cyan-500/20',
              },
              {
                key: 'notifyNewJds' as const,
                label: 'New Placement Circulars',
                desc: 'Newly announced hiring drives from CDC & NeoPAT',
                icon: Building2,
                color: 'text-indigo-400',
                bg: 'bg-indigo-500/10 border-indigo-500/20',
              },
            ].map(({ key, label, desc, icon: Icon, color, bg }) => {
              const isChecked = !!preferences[key];
              return (
                <div
                  key={key}
                  onClick={() => handleUpdatePref({ [key]: !isChecked })}
                  className={cn(
                    'flex items-center justify-between gap-3 p-3 rounded-xl border transition-all cursor-pointer select-none active:scale-[0.99]',
                    isChecked
                      ? 'bg-zinc-900/70 border-white/[0.08] hover:border-emerald-500/40'
                      : 'bg-zinc-900/20 border-white/[0.03] opacity-60 hover:opacity-85'
                  )}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div
                      className={cn(
                        'w-8 h-8 rounded-xl border flex items-center justify-center shrink-0',
                        bg
                      )}
                    >
                      <Icon className={cn('w-4 h-4', color)} />
                    </div>
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-zinc-100 truncate">{label}</p>
                      <p className="text-[10px] text-zinc-400 truncate mt-0.5">{desc}</p>
                    </div>
                  </div>

                  <div className="shrink-0" onClick={(e) => e.stopPropagation()}>
                    <Switch
                      size="sm"
                      checked={isChecked}
                      onCheckedChange={(val) => handleUpdatePref({ [key]: val })}
                      aria-label={`Toggle ${label}`}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Customizable Reminders Section */}
        <div className="rounded-xl border border-white/[0.06] bg-zinc-900/50 p-3.5 sm:p-4 space-y-3.5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="flex h-8 w-8 items-center justify-center rounded-xl border border-rose-500/25 bg-rose-500/10 shrink-0">
                <Timer className="h-4 w-4 text-rose-400" />
              </div>
              <div className="min-w-0">
                <h3 className="text-xs sm:text-sm font-semibold text-zinc-100 truncate">
                  Event Reminders & Lead Times
                </h3>
                <p className="text-[10px] sm:text-[11px] text-zinc-400 truncate">
                  Automatic countdown alerts before scheduled placement rounds
                </p>
              </div>
            </div>

            <div className="shrink-0">
              <Switch
                size="sm"
                checked={!!preferences.notifyReminders}
                onCheckedChange={(val) => handleUpdatePref({ notifyReminders: val })}
                aria-label="Toggle event reminders"
              />
            </div>
          </div>

          {preferences.notifyReminders && (
            <div className="space-y-3 pt-2.5 border-t border-white/[0.05] animate-fade-in">
              {/* Event Types */}
              <div>
                <p className="text-[11px] font-semibold text-zinc-300 mb-2">
                  Remind for these rounds:
                </p>
                <div className="grid grid-cols-2 gap-1.5">
                  {REMINDER_EVENT_OPTIONS.map((opt) => {
                    const isSelected = opt.types.every((t) => currentReminderTypes.includes(t));
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => toggleReminderEventType(opt.types)}
                        className={cn(
                          'flex items-center justify-between p-2 sm:p-2.5 rounded-lg border text-left transition-all cursor-pointer select-none active:scale-[0.98]',
                          isSelected
                            ? 'bg-emerald-500/10 border-emerald-500/35 text-emerald-300 shadow-sm'
                            : 'bg-zinc-900/30 border-white/[0.04] text-zinc-400 hover:text-zinc-200 hover:border-zinc-700'
                        )}
                      >
                        <div className="min-w-0 flex-1 pr-1.5">
                          <p className="text-[11px] font-semibold leading-tight truncate">{opt.label}</p>
                          <p className="text-[9px] text-zinc-500 truncate mt-0.5">{opt.desc}</p>
                        </div>
                        <div
                          className={cn(
                            'w-3.5 h-3.5 rounded flex items-center justify-center border shrink-0',
                            isSelected
                              ? 'bg-emerald-500 border-emerald-400 text-zinc-950'
                              : 'border-zinc-700 bg-zinc-800'
                          )}
                        >
                          {isSelected && <Check className="w-2.5 h-2.5 stroke-[3]" />}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Lead Time Selection */}
              <div>
                <p className="text-[11px] font-semibold text-zinc-300 mb-1.5">
                  Alert schedule:
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {LEAD_TIME_OPTIONS.map((lt) => {
                    const isSelected = currentLeadTimes.includes(lt.minutes);
                    return (
                      <button
                        key={lt.minutes}
                        type="button"
                        onClick={() => toggleLeadTime(lt.minutes)}
                        className={cn(
                          'flex items-center gap-1 px-2.5 py-1 rounded-full border text-[11px] font-mono transition-all cursor-pointer active:scale-95',
                          isSelected
                            ? 'bg-rose-500/15 border-rose-500/40 text-rose-300 font-semibold shadow-sm'
                            : 'bg-zinc-800/40 border-zinc-800 text-zinc-500 hover:text-zinc-300 hover:border-zinc-700'
                        )}
                      >
                        <Clock className="w-2.5 h-2.5 shrink-0" />
                        <span>{lt.label}</span>
                        {isSelected && <span className="w-1.5 h-1.5 rounded-full bg-rose-400 ml-0.5" />}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
