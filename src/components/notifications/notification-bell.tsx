'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  Bell,
  CheckCheck,
  Building2,
  Calendar,
  Sparkles,
  Award,
  FileText,
  Clock,
  CheckCircle2,
  Trash2,
  X,
} from 'lucide-react';
import { cn, timeAgo } from '@/lib/utils';
import { usePushNotifications } from '@/hooks/use-push-notifications';
import { appToast } from '@/lib/toast';

export interface InAppNotification {
  id: string;
  type: string;
  title: string;
  message?: string;
  body?: string;
  link?: string;
  company_id?: string;
  is_read: boolean;
  created_at: string;
}

export interface NotificationBellProps {
  align?: 'right' | 'sidebar';
  triggerToasts?: boolean;
}

// Module-level cache to guarantee no duplicate toasts and deduplicate network requests across multiple mounted bell instances
const globalToastedNotificationIds = new Set<string>();
const globalKnownNotificationIds = new Set<string>();
let globalHasLoadedInitial = false;
let activeFetchPromise: Promise<{ notifications: InAppNotification[]; unreadCount: number } | null> | null = null;
let lastFetchTimestamp = 0;
let cachedNotificationData: { notifications: InAppNotification[]; unreadCount: number } | null = null;
const FETCH_THROTTLE_MS = 15000; // Throttle background requests to at most once per 15s

export default function NotificationBell({
  align = 'right',
  triggerToasts = align !== 'sidebar',
}: NotificationBellProps) {
  const router = useRouter();
  const routerRef = useRef(router);
  routerRef.current = router;
  const triggerToastsRef = useRef(triggerToasts);
  triggerToastsRef.current = triggerToasts;

  const [isOpen, setIsOpen] = useState(false);
  const [notifications, setNotifications] = useState<InAppNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const {
    isSupported: isPushSupported,
    permission: pushPermission,
    isSubscribed: isPushSubscribed,
    subscribeToPush,
    loading: pushLoading,
  } = usePushNotifications();

  // Fetch notifications from API with request deduplication and throttling
  const fetchNotifications = useCallback(async (force = false) => {
    try {
      const now = Date.now();
      if (!force && cachedNotificationData && (now - lastFetchTimestamp < FETCH_THROTTLE_MS)) {
        setNotifications(cachedNotificationData.notifications);
        setUnreadCount(cachedNotificationData.unreadCount);
        return;
      }

      if (!activeFetchPromise) {
        activeFetchPromise = (async () => {
          try {
            const res = await fetch('/api/notifications');
            if (res.ok) {
              const data = await res.json();
              lastFetchTimestamp = Date.now();
              cachedNotificationData = {
                notifications: data.notifications || [],
                unreadCount: data.unreadCount || 0,
              };
              return cachedNotificationData;
            }
          } catch (err) {
            console.error('Failed to load notifications:', err);
          } finally {
            activeFetchPromise = null;
          }
          return null;
        })();
      }

      const result = await activeFetchPromise;
      if (!result) return;

      const incoming: InAppNotification[] = result.notifications;

      // Only trigger toast for brand new unread notification if this instance is designated to handle toasts
      if (triggerToastsRef.current && globalHasLoadedInitial) {
        const brandNew = incoming.filter(
          (n) =>
            !n.is_read &&
            !globalKnownNotificationIds.has(n.id) &&
            !globalToastedNotificationIds.has(n.id)
        );

        if (brandNew.length > 0) {
          const latest = brandNew[0];
          globalToastedNotificationIds.add(latest.id);
          appToast.notification(latest, (url) => routerRef.current.push(url));
          routerRef.current.refresh();
        }
      } else {
        globalHasLoadedInitial = true;
      }

      // Keep track of known notification IDs globally
      incoming.forEach((n) => globalKnownNotificationIds.add(n.id));

      setNotifications(incoming);
      setUnreadCount(result.unreadCount);
    } catch (err) {
      console.error('Failed to load notifications:', err);
    }
  }, []);

  // Instant listener for notification creation events + focus + visibility, with periodic fallback
  useEffect(() => {
    fetchNotifications();

    const handleRefresh = () => {
      fetchNotifications(true);
    };

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        fetchNotifications(false);
      }
    };

    const handleFocus = () => {
      fetchNotifications(false);
    };

    window.addEventListener('wmo:refresh_notifications', handleRefresh);
    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibility);

    // Periodic fallback polling (every 60 seconds)
    const interval = setInterval(() => fetchNotifications(false), 60000);

    return () => {
      clearInterval(interval);
      window.removeEventListener('wmo:refresh_notifications', handleRefresh);
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [fetchNotifications]);

  // Close dropdown on outside click, touch, or Escape key
  useEffect(() => {
    function handleClickOutside(event: MouseEvent | TouchEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('touchstart', handleClickOutside);
      document.addEventListener('keydown', handleKeyDown);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('touchstart', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  // Mark all as read with keepalive and optimistic state
  const handleMarkAllRead = async () => {
    setNotifications((prev) => prev.map((n) => ({ ...n, is_read: true })));
    setUnreadCount(0);
    if (cachedNotificationData) {
      cachedNotificationData = {
        notifications: cachedNotificationData.notifications.map((n) => ({ ...n, is_read: true })),
        unreadCount: 0,
      };
    }
    try {
      await fetch('/api/notifications', { method: 'POST', keepalive: true });
    } catch (err) {
      console.error('Failed to mark all as read:', err);
    }
  };

  // Mark single notification as read without navigating
  const handleMarkSingleRead = async (id: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, is_read: true } : n))
    );
    setUnreadCount((c) => Math.max(0, c - 1));
    if (cachedNotificationData) {
      cachedNotificationData = {
        notifications: cachedNotificationData.notifications.map((n) => (n.id === id ? { ...n, is_read: true } : n)),
        unreadCount: Math.max(0, cachedNotificationData.unreadCount - 1),
      };
    }
    try {
      await fetch(`/api/notifications/${id}/read`, { method: 'PATCH', keepalive: true });
    } catch (err) {
      console.error('Failed to mark notification read:', err);
    }
  };

  // Clear all marked-as-read notifications
  const handleClearRead = async () => {
    setNotifications((prev) => prev.filter((n) => !n.is_read));
    if (cachedNotificationData) {
      const remaining = cachedNotificationData.notifications.filter((n) => !n.is_read);
      cachedNotificationData = {
        notifications: remaining,
        unreadCount: remaining.length,
      };
    }
    try {
      await fetch('/api/notifications?readOnly=true', { method: 'DELETE', keepalive: true });
    } catch (err) {
      console.error('Failed to clear read notifications:', err);
    }
  };

  // Delete/dismiss a single notification
  const handleDeleteSingle = async (id: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    const target = notifications.find((n) => n.id === id);
    if (target && !target.is_read) {
      setUnreadCount((c) => Math.max(0, c - 1));
    }
    setNotifications((prev) => prev.filter((n) => n.id !== id));
    if (cachedNotificationData) {
      const remaining = cachedNotificationData.notifications.filter((n) => n.id !== id);
      cachedNotificationData = {
        notifications: remaining,
        unreadCount: remaining.filter((n) => !n.is_read).length,
      };
    }
    try {
      await fetch(`/api/notifications/${id}`, { method: 'DELETE', keepalive: true });
    } catch (err) {
      console.error('Failed to delete notification:', err);
    }
  };

  // Mark individual notification as read and navigate
  const handleNotificationClick = async (notif: InAppNotification) => {
    if (!notif.is_read) {
      setNotifications((prev) =>
        prev.map((n) => (n.id === notif.id ? { ...n, is_read: true } : n))
      );
      setUnreadCount((c) => Math.max(0, c - 1));
      if (cachedNotificationData) {
        cachedNotificationData = {
          notifications: cachedNotificationData.notifications.map((n) =>
            n.id === notif.id ? { ...n, is_read: true } : n
          ),
          unreadCount: Math.max(0, cachedNotificationData.unreadCount - 1),
        };
      }
      try {
        fetch(`/api/notifications/${notif.id}/read`, { method: 'PATCH', keepalive: true }).catch(console.error);
      } catch (err) {
        console.error('Failed to mark notification read:', err);
      }
    }

    setIsOpen(false);

    if (notif.link) {
      router.push(notif.link);
    } else if (notif.company_id) {
      router.push(`/companies/${notif.company_id}`);
    }
  };

  const getNotificationIcon = (type: string) => {
    switch (type) {
      case 'shortlist_match':
        return <Sparkles className="w-4 h-4 text-emerald-400" />;
      case 'test_scheduled':
        return <FileText className="w-4 h-4 text-amber-400" />;
      case 'interview_scheduled':
        return <Award className="w-4 h-4 text-purple-400" />;
      case 'ppt_scheduled':
        return <Calendar className="w-4 h-4 text-blue-400" />;
      case 'deadline_approaching':
        return <Clock className="w-4 h-4 text-amber-400" />;
      case 'status_change':
        return <CheckCircle2 className="w-4 h-4 text-cyan-400" />;
      case 'new_company':
        return <Building2 className="w-4 h-4 text-indigo-400" />;
      default:
        return <Bell className="w-4 h-4 text-zinc-400" />;
    }
  };

  return (
    <div className="relative" ref={dropdownRef}>
      {/* Bell Button */}
      <button
        onClick={() => {
          setIsOpen(!isOpen);
          if (!isOpen) fetchNotifications();
        }}
        className={cn(
          "relative p-2 rounded-lg text-text-tertiary hover:text-text-primary hover:bg-bg-surface-hover transition-all cursor-pointer",
          isOpen && "bg-white/10 text-text-primary"
        )}
        aria-label="Notifications"
      >
        <Bell className="w-4 h-4" />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 bg-accent text-white text-[10px] font-bold rounded-full flex items-center justify-center shadow-lg shadow-accent/40 animate-pulse">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {/* Notification Dropdown Panel */}
      {isOpen && (
        <>
          {/* Backdrop for outside tap dismiss on touch viewports */}
          <div
            className="fixed inset-0 z-40 bg-black/40 lg:hidden"
            onClick={() => setIsOpen(false)}
          />

          <div
            className={cn(
              "bg-[#111113] border border-white/10 rounded-2xl shadow-2xl z-50 overflow-hidden animate-fade-in flex flex-col",
              align === 'sidebar'
                ? "fixed top-3 left-[19rem] w-96 max-w-[calc(100vw-20.5rem)] max-h-[calc(100dvh-2rem)]"
                : "fixed inset-x-2.5 top-14 sm:absolute sm:inset-x-auto sm:top-full sm:right-0 sm:mt-2 sm:w-96 max-h-[calc(100dvh-5rem)]"
            )}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 bg-white/[0.02] shrink-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-white">Recent Alerts</span>
                {unreadCount > 0 ? (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-accent/20 text-accent border border-accent/30">
                    {unreadCount} new
                  </span>
                ) : (
                  <span className="text-[11px] text-zinc-500">
                    Last 7 days
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2">
                {unreadCount > 0 && (
                  <button
                    onClick={handleMarkAllRead}
                    className="flex items-center gap-1 text-xs text-zinc-400 hover:text-white transition-colors cursor-pointer px-1.5 py-0.5 rounded hover:bg-white/5"
                    title="Mark all read"
                  >
                    <CheckCheck className="w-3.5 h-3.5 text-emerald-400" />
                    <span className="text-[11px]">Mark read</span>
                  </button>
                )}
                {notifications.some((n) => n.is_read) && (
                  <button
                    onClick={handleClearRead}
                    className="flex items-center gap-1 text-xs text-zinc-400 hover:text-rose-400 transition-colors cursor-pointer px-1.5 py-0.5 rounded hover:bg-rose-500/10"
                    title="Delete read alerts"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span className="text-[11px]">Clear read</span>
                  </button>
                )}
              </div>
            </div>

            {/* Live Push Notifications Enablement Banner */}
            {isPushSupported && !isPushSubscribed && pushPermission !== 'denied' && (
              <div className="mx-3 my-2.5 p-2.5 rounded-xl border border-emerald-500/30 bg-emerald-500/[0.08] flex items-center justify-between gap-2.5 shrink-0">
                <div className="flex items-start gap-2 min-w-0">
                  <div className="p-1 rounded-md bg-emerald-500/20 text-emerald-400 shrink-0 mt-0.5">
                    <Bell className="w-3.5 h-3.5" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs font-bold text-zinc-100 leading-tight">Live Shortlist Alerts</p>
                    <p className="text-[10px] text-zinc-400 mt-0.5 leading-tight">Get instant push alerts on phone & desktop when CDC releases test lists.</p>
                  </div>
                </div>
                <button
                  onClick={async (e) => {
                    e.stopPropagation();
                    await subscribeToPush();
                  }}
                  disabled={pushLoading}
                  className="shrink-0 px-2.5 py-1 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-bold text-[11px] transition-colors cursor-pointer disabled:opacity-50"
                >
                  {pushLoading ? '...' : 'Enable'}
                </button>
              </div>
            )}

            {/* List of Recent Notifications */}
            <div className="flex-1 overflow-y-auto divide-y divide-white/5 overscroll-contain">
              {notifications.length === 0 ? (
                <div className="p-8 text-center space-y-2">
                  <div className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center mx-auto text-zinc-500">
                    <Bell className="w-5 h-5" />
                  </div>
                  <p className="text-sm font-medium text-zinc-300">All caught up!</p>
                  <p className="text-xs text-zinc-500 max-w-[220px] mx-auto">
                    Shortlist matches, test schedules, and updates from the last 7 days appear here.
                  </p>
                </div>
              ) : (
                notifications.map((notif) => (
                  <div
                    key={notif.id}
                    onClick={() => handleNotificationClick(notif)}
                    className={cn(
                      'flex items-start gap-3 p-3.5 hover:bg-white/[0.04] transition-colors cursor-pointer text-left group relative',
                      !notif.is_read && 'bg-accent/[0.03]'
                    )}
                  >
                    <div className="w-8 h-8 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                      {getNotificationIcon(notif.type)}
                    </div>

                    <div className="flex-1 min-w-0 space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <p
                          className={cn(
                            'text-xs font-semibold truncate',
                            notif.is_read ? 'text-zinc-300' : 'text-white'
                          )}
                        >
                          {notif.title}
                        </p>

                        <div className="relative flex items-center justify-end w-12 h-4 shrink-0">
                          {/* Small crisp green dot on far right (fades out on hover) */}
                          {!notif.is_read && (
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 absolute right-1 transition-opacity duration-150 group-hover:opacity-0 pointer-events-none" />
                          )}

                          {/* On hover: action buttons fade in with exact fixed height (zero height jump) */}
                          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-150 pointer-events-none group-hover:pointer-events-auto">
                            {!notif.is_read && (
                              <button
                                type="button"
                                onClick={(e) => handleMarkSingleRead(notif.id, e)}
                                title="Mark as read"
                                className="w-4 h-4 p-0 flex items-center justify-center rounded text-zinc-400 hover:text-emerald-400 hover:bg-emerald-500/15 transition-colors cursor-pointer"
                              >
                                <CheckCircle2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={(e) => handleDeleteSingle(notif.id, e)}
                              title="Delete"
                              className="w-4 h-4 p-0 flex items-center justify-center rounded text-zinc-400 hover:text-rose-400 hover:bg-rose-500/15 transition-colors cursor-pointer"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      </div>

                      <p className="text-xs text-zinc-400 line-clamp-2 leading-relaxed">
                        {notif.body || notif.message}
                      </p>

                      <div className="flex items-center gap-1 text-[10px] text-zinc-500 pt-0.5">
                        <Clock className="w-3 h-3" />
                        <span suppressHydrationWarning>{timeAgo(notif.created_at)}</span>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Footer */}
            <div className="px-4 py-2.5 border-t border-white/10 bg-white/[0.01] flex items-center justify-between text-[11px] text-zinc-500 shrink-0">
              <div className="flex items-center gap-1.5">
                <Clock className="w-3 h-3 text-zinc-500" />
                <span>Auto-cleared after 7 days</span>
              </div>
              {notifications.length > 0 && (
                <span className="text-zinc-500">
                  {notifications.length} {notifications.length === 1 ? 'alert' : 'alerts'}
                </span>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
