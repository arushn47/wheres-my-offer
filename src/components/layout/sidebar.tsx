'use client';

import { useState, useRef, useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { cn, timeAgo } from '@/lib/utils';
import {
  LayoutGrid,
  Building2,
  CalendarDays,
  PieChart,
  Settings as SettingsIcon,
  Search,
  LogOut,
} from 'lucide-react';
import NotificationBell from '@/components/notifications/notification-bell';
import CampusRadar from '@/components/layout/campus-radar';
import { AppLogo, AppLogoMark } from '@/components/brand/logo';
export { AppLogo, AppLogoMark };

const NAV = [
  { href: '/', label: 'Dashboard', icon: LayoutGrid, exact: true },
  { href: '/companies', label: 'Companies', icon: Building2 },
  { href: '/search', label: 'Global Search', icon: Search },
  { href: '/calendar', label: 'Calendar', icon: CalendarDays },
  { href: '/analytics', label: 'Analytics', icon: PieChart },
  { href: '/settings', label: 'Settings', icon: SettingsIcon },
];

interface SidebarProps {
  userName?: string | null;
  userAvatar?: string | null;
  lastSyncAt?: string | null;
}

export default function Sidebar({
  userName,
  userAvatar,
}: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
      window.location.href = '/login';
    } catch {
      window.location.href = '/login';
    }
  };

  return (
    <aside className="fixed inset-y-0 left-0 hidden h-screen w-72 shrink-0 flex-col border-r border-zinc-800/80 bg-[#0b0b0e] lg:flex z-40 select-none">
      {/* Brand Header & In-Sidebar Notification Bell */}
      <div className="flex h-16 items-center justify-between border-b border-zinc-800/80 px-4 shrink-0">
        <AppLogo />
        <NotificationBell align="sidebar" />
      </div>

      {/* Navigation Items */}
      <nav className="space-y-1 px-3.5 pt-3 pb-2 shrink-0">
        {NAV.map(({ href, label, icon: Icon, exact }) => {
          const isActive = exact ? pathname === href : pathname.startsWith(href);

          return (
            <Link
              key={href}
              href={href}
              prefetch={true}
              className={cn(
                'group flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-medium transition-colors duration-150',
                isActive
                  ? 'bg-zinc-800/80 text-zinc-100 font-semibold'
                  : 'text-zinc-400 hover:bg-zinc-900/80 hover:text-zinc-200'
              )}
            >
              <Icon
                className={cn(
                  'h-4 w-4 transition-colors',
                  isActive ? 'text-emerald-400' : 'text-zinc-500 group-hover:text-zinc-300'
                )}
              />
              <span className="truncate">{label}</span>
              {isActive && (
                <span className="ml-auto h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]" />
              )}
            </Link>
          );
        })}
      </nav>

      {/* Spacious area below NAV items: Live Placement Radar & Sync Station */}
      <div className="flex-1 px-3.5 py-2 flex flex-col justify-end overflow-y-auto">
        <CampusRadar />
      </div>

      {/* Support & Legal Links */}
      <div className="px-4 py-2 border-t border-zinc-800/60 flex items-center justify-between text-[10px] font-mono text-zinc-500 shrink-0 select-none">
        <Link href="/feedback" className="hover:text-zinc-300 transition-colors">
          Feedback
        </Link>
        <span className="text-zinc-700">·</span>
        <Link href="/privacy" className="hover:text-zinc-300 transition-colors">
          Privacy Policy
        </Link>
        <span className="text-zinc-700">·</span>
        <Link href="/terms" className="hover:text-zinc-300 transition-colors">
          Terms
        </Link>
      </div>

      {/* User Profile Footer Card */}
      <div className="border-t border-zinc-800/80 p-3 shrink-0 flex items-center justify-between gap-2.5">
        <Link
          href="/settings"
          prefetch={true}
          className="flex items-center gap-2.5 min-w-0 flex-1 p-1 -m-1 rounded-xl hover:bg-zinc-800/50 transition-colors group cursor-pointer"
          title="Go to Settings & Profile"
        >
          {userAvatar ? (
            <img
              src={userAvatar}
              alt={userName || 'User'}
              className="w-8 h-8 rounded-full border border-emerald-500/30 object-cover shrink-0"
              referrerPolicy="no-referrer"
            />
          ) : (
            <div className="flex h-8 w-8 items-center justify-center rounded-full border border-emerald-500/30 bg-emerald-500/15 font-mono text-xs font-bold text-emerald-300 shrink-0">
              {userName?.split(' ').map((n) => n[0]).slice(0, 2).join('').toUpperCase() || 'ST'}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-zinc-200 truncate group-hover:text-white transition-colors">
              {userName || 'Logged in User'}
            </p>
            <p className="text-[10px] text-emerald-400 font-mono truncate flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shrink-0" />
              Active Session
            </p>
          </div>
        </Link>

        <button
          type="button"
          onClick={handleLogout}
          className="flex items-center justify-center h-8 w-8 rounded-lg text-zinc-500 hover:text-rose-400 hover:bg-rose-500/10 active:scale-95 transition-all cursor-pointer shrink-0"
          title="Sign Out"
        >
          <LogOut className="w-4 h-4" />
        </button>
      </div>
    </aside>
  );
}
