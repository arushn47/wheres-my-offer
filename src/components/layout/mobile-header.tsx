'use client';

import {
  RefreshCw,
  LogOut,
  Settings,
  MessageSquare,
} from 'lucide-react';
import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { timeAgo } from '@/lib/utils';
import NotificationBell from '@/components/notifications/notification-bell';
import { AppLogoMark } from '@/components/brand/logo';
import { useSync } from '@/context/sync-context';

export interface MobileHeaderProps {
  userName: string | null;
  userAvatar: string | null;
  lastSyncAt?: string | null;
}

/**
 * MobileHeader
 * Rendered on mobile & tablet viewports (< 1024px).
 * On desktop (>= 1024px), navigation and sync telemetry live in the sidebar.
 */
export default function MobileHeader({ userName, userAvatar }: MobileHeaderProps) {
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
        {/* Left: Mobile logo */}
        <div className="flex items-center gap-2 lg:hidden min-w-0 shrink-0">
          <Link href="/" className="flex items-center gap-2 min-w-0 group" title="Where's My Offer?">
            <AppLogoMark size={26} className="shrink-0 transition-transform group-hover:scale-105" />
            <span className="font-display text-xs sm:text-sm font-bold tracking-tight text-zinc-100 truncate">
              Where&apos;s My Offer<span className="text-emerald-400 font-extrabold ml-0.5 drop-shadow-[0_0_6px_rgba(52,211,153,0.55)]">?</span>
            </span>
          </Link>
        </div>

        {/* Right: Actions */}
        <div className="flex items-center gap-2 sm:gap-3 shrink-0 ml-auto">
          {/* Minimal Live Sync Pill */}
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

          {/* Mobile Notification Bell */}
          <NotificationBell />

          {/* User avatar & dropdown */}
          <div className="relative" ref={userMenuRef}>
            <button
              onClick={() => setShowUserMenu(!showUserMenu)}
              className="flex items-center gap-2 p-0.5 rounded-full hover:ring-2 hover:ring-emerald-500/40 transition-all cursor-pointer"
              aria-label="User profile menu"
            >
              {userAvatar ? (
                <img
                  src={userAvatar}
                  alt={userName || 'User'}
                  className="w-7 h-7 rounded-full border border-violet-500/30 object-cover"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="flex h-7 w-7 items-center justify-center rounded-full border border-violet-500/30 bg-violet-500/15 font-mono text-[11px] font-bold text-violet-300">
                  {userName?.split(' ').map((n) => n[0]).slice(0, 2).join('').toUpperCase() || 'ST'}
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
                <div className="absolute right-0 top-full mt-2 w-64 bg-[#12121c]/95 backdrop-blur-2xl border border-zinc-800 rounded-2xl shadow-2xl z-50 py-1.5 animate-fade-in divide-y divide-zinc-800/80">
                  {/* User Profile Header */}
                  <div className="px-4 py-3">
                    <p className="text-xs font-semibold text-white truncate">
                      {userName || 'Logged in User'}
                    </p>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                      <span className="text-[10px] text-zinc-400 font-mono">
                        Active Campus Session
                      </span>
                    </div>
                  </div>

                  {/* Primary Navigation / App Tools */}
                  <div className="p-1.5 space-y-0.5">
                    <Link
                      href="/settings"
                      onClick={() => setShowUserMenu(false)}
                      className="flex items-center gap-2.5 w-full px-3 py-2 text-xs font-semibold text-zinc-300 hover:text-white hover:bg-zinc-800/60 rounded-xl transition-all group cursor-pointer"
                    >
                      <Settings className="w-4 h-4 text-indigo-400 group-hover:rotate-45 transition-transform duration-200" />
                      <span>Settings</span>
                    </Link>
                    <Link
                      href="/feedback"
                      onClick={() => setShowUserMenu(false)}
                      className="flex items-center gap-2.5 w-full px-3 py-2 text-xs font-semibold text-zinc-300 hover:text-white hover:bg-zinc-800/60 rounded-xl transition-all group cursor-pointer"
                    >
                      <MessageSquare className="w-4 h-4 text-emerald-400 group-hover:scale-110 transition-transform duration-200" />
                      <span>Feedback & Bug Report</span>
                    </Link>
                  </div>

                  {/* Support & Legal Links */}
                  <div className="px-3 py-1.5 border-t border-zinc-800/60 flex items-center justify-between text-[10px] font-mono text-zinc-500 select-none">
                    <Link href="/feedback" onClick={() => setShowUserMenu(false)} className="hover:text-zinc-300 transition-colors">
                      Feedback
                    </Link>
                    <span className="text-zinc-700">·</span>
                    <Link href="/privacy" onClick={() => setShowUserMenu(false)} className="hover:text-zinc-300 transition-colors">
                      Privacy
                    </Link>
                    <span className="text-zinc-700">·</span>
                    <Link href="/terms" onClick={() => setShowUserMenu(false)} className="hover:text-zinc-300 transition-colors">
                      Terms
                    </Link>
                  </div>

                  {/* Sign Out */}
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
