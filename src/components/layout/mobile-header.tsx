'use client';

import {
  RefreshCw,
  LogOut,
  MessageSquare,
  Shield,
} from 'lucide-react';
import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { timeAgo, cn } from '@/lib/utils';
import NotificationBell from '@/components/notifications/notification-bell';
import { AppLogoMark } from '@/components/brand/logo';
import { useSync } from '@/context/sync-context';

export interface MobileHeaderProps {
  userName: string | null;
  userAvatar: string | null;
  lastSyncAt?: string | null;
  isAdmin?: boolean;
}

/**
 * MobileHeader
 * Rendered on mobile & tablet viewports (< 1024px).
 * On desktop (>= 1024px), navigation and sync telemetry live in the sidebar.
 */
export default function MobileHeader({ userName, userAvatar, isAdmin }: MobileHeaderProps) {
  const router = useRouter();
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [mounted, setMounted] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);

  const {
    isSyncing,
    syncProgress,
    progressPercent,
    lastSyncAt: currentLastSyncAt,
    startSync,
  } = useSync();

  useEffect(() => {
    setMounted(true);
  }, []);

  // Close profile dropdown when clicking outside or pressing Escape
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent | TouchEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(event.target as Node)) {
        setShowUserMenu(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShowUserMenu(false);
      }
    };

    if (showUserMenu) {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('touchstart', handleClickOutside);
      document.addEventListener('keydown', handleEscape);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('touchstart', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [showUserMenu]);

  // Keyboard shortcut Cmd+K / Ctrl+K to jump to search
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        router.push('/search');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [router]);

  const handleLogout = async () => {
    await fetch('/api/auth/disconnect', { method: 'DELETE' });
    window.location.href = '/login';
  };

  return (
    <>
      <header className="relative lg:hidden flex items-center justify-between h-12 px-3.5 sm:px-6 md:px-12 bg-[#09090b]/90 backdrop-blur-xl border-b border-zinc-800/80 sticky top-0 z-50 w-full min-w-0 max-w-full">
        {/* Left: Mobile logo — show only clean logo mark on mobile phones, full title on sm+ */}
        <div className="flex items-center gap-2 lg:hidden min-w-0 shrink-0">
          <Link href={isAdmin ? "/admin" : "/"} className="flex items-center gap-2 min-w-0 group" title="Where's My Offer?">
            <AppLogoMark size={28} className="shrink-0 transition-transform group-hover:scale-105" />
            <span className="hidden sm:inline-flex font-display text-xs sm:text-sm font-bold tracking-tight text-zinc-100 truncate">
              Where&apos;s My Offer<span className="text-emerald-400 font-extrabold ml-0.5 drop-shadow-[0_0_6px_rgba(52,211,153,0.55)]">?</span>
            </span>
          </Link>
        </div>

        {/* Right: Actions */}
        <div className="flex items-center gap-2 sm:gap-3 shrink-0 ml-auto">
          {!isAdmin && (
            <>
              {isSyncing ? (
                <div className="flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2 sm:px-2.5 py-1 text-xs select-none">
                  <RefreshCw className="h-3 w-3 text-emerald-400 animate-spin shrink-0" />
                  <span className="font-mono text-[11px] text-emerald-300 font-medium">
                    {syncProgress?.totalPagesCount && syncProgress.totalPagesCount > 1
                      ? `P${(syncProgress.currentPageIndex ?? 0) + 1}/${syncProgress.totalPagesCount} · ${syncProgress.processedMessages}/${syncProgress.totalMessages}`
                      : syncProgress?.totalMessages
                      ? `${syncProgress.processedMessages}/${syncProgress.totalMessages}`
                      : 'Syncing…'}
                  </span>
                </div>
              ) : (
                <button
                  onClick={() => startSync(false)}
                  disabled={isSyncing}
                  className="flex items-center gap-1.5 rounded-lg border border-zinc-800/80 bg-zinc-900/60 px-2 sm:px-2.5 py-1 text-xs text-zinc-400 hover:text-zinc-200 hover:border-zinc-700 transition-all cursor-pointer select-none shrink-0"
                  title={
                    mounted && currentLastSyncAt
                      ? `All inboxes caught up (${timeAgo(currentLastSyncAt)}) · Click to sync`
                      : 'Click to sync Gmail inboxes'
                  }
                  aria-label="Sync status"
                >
                  <span className="relative flex h-1.5 w-1.5 shrink-0">
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
                  </span>
                  <RefreshCw className="h-3 w-3 text-zinc-400 shrink-0" />
                  <span className="font-mono text-[11px] text-zinc-300">Sync</span>
                </button>
              )}

              {/* Mobile Notification Bell (only for students) */}
              <NotificationBell />
            </>
          )}

          {/* User avatar & dropdown */}
          <div className="relative" ref={userMenuRef}>
            <button
              onClick={() => setShowUserMenu(!showUserMenu)}
              className={cn(
                "flex items-center gap-2 p-0.5 rounded-full transition-all cursor-pointer",
                isAdmin ? "hover:ring-2 hover:ring-amber-500/40" : "hover:ring-2 hover:ring-emerald-500/40"
              )}
              aria-label="User profile menu"
            >
              {userAvatar ? (
                <img
                  src={userAvatar}
                  alt={userName || (isAdmin ? 'Admin' : 'User')}
                  className={cn(
                    "w-7 h-7 rounded-full object-cover border",
                    isAdmin ? "border-amber-500/40" : "border-violet-500/30"
                  )}
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className={cn(
                  "flex h-7 w-7 items-center justify-center rounded-full font-mono text-[11px] font-bold border",
                  isAdmin
                    ? "border-amber-500/40 bg-amber-500/15 text-amber-300"
                    : "border-violet-500/30 bg-violet-500/15 text-violet-300"
                )}>
                  {userName?.split(' ').map((n) => n[0]).slice(0, 2).join('').toUpperCase() || (isAdmin ? 'AD' : 'ST')}
                </div>
              )}
            </button>

            {/* Dropdown menu */}
            {showUserMenu && (
              <>
                <div
                  className="fixed inset-0 z-40"
                  onClick={() => setShowUserMenu(false)}
                />
                <div className="absolute right-0 top-full mt-2 w-52 bg-[#12121c]/95 backdrop-blur-2xl border border-zinc-800 rounded-2xl shadow-2xl z-50 py-1.5 animate-fade-in divide-y divide-zinc-800/80">
                  {/* User Profile Header */}
                  <div className="px-4 py-2.5">
                    <p className="text-xs font-semibold text-white truncate">
                      {userName || (isAdmin ? 'Administrator' : 'Logged in Student')}
                    </p>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className={cn("w-1.5 h-1.5 rounded-full", isAdmin ? "bg-amber-400" : "bg-emerald-400")} />
                      <span className="text-[10px] text-zinc-400 font-mono">
                        {isAdmin ? 'System Administrator' : 'Active Campus Session'}
                      </span>
                    </div>
                  </div>

                  {/* Non-admin links */}
                  {!isAdmin && (
                    <div className="p-1.5 space-y-0.5">
                      <Link
                        href="/feedback"
                        onClick={() => setShowUserMenu(false)}
                        className="flex items-center gap-2.5 w-full px-3 py-2 text-xs font-semibold text-zinc-300 hover:text-white hover:bg-zinc-800/60 rounded-xl transition-all group cursor-pointer"
                      >
                        <MessageSquare className="w-4 h-4 text-emerald-400 group-hover:scale-110 transition-transform duration-200" />
                        <span>Feedback & Bug Report</span>
                      </Link>
                    </div>
                  )}

                  {/* Sign Out (Only item for Admin, or bottom item for students) */}
                  <div className="p-1.5">
                    <button
                      onClick={handleLogout}
                      className="flex items-center gap-2.5 w-full px-3 py-2 text-xs font-semibold text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded-xl transition-all cursor-pointer"
                    >
                      <LogOut className="w-4 h-4" />
                      Sign Out
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Ambient Progress Line */}
        {syncProgress && (
          <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-zinc-800/60 overflow-hidden pointer-events-none">
            <div
              className="h-full bg-gradient-to-r from-emerald-500 to-teal-300 transition-all duration-300 shadow-[0_0_8px_rgba(16,185,129,0.8)]"
              style={{ width: `${Math.max(progressPercent, 5)}%` }}
            />
          </div>
        )}
      </header>
    </>
  );
}
