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
  Shield,
  Clock,
  ExternalLink,
  Users,
  Filter,
  Layers,
} from 'lucide-react';
import NotificationBell from '@/components/notifications/notification-bell';
import CampusRadar from '@/components/layout/campus-radar';
import { AppLogo, AppLogoMark } from '@/components/brand/logo';
export { AppLogo, AppLogoMark };

const STUDENT_NAV = [
  { href: '/', label: 'Dashboard', icon: LayoutGrid, exact: true },
  { href: '/companies', label: 'Companies', icon: Building2 },
  { href: '/search', label: 'Global Search', icon: Search },
  { href: '/calendar', label: 'Calendar', icon: CalendarDays },
  { href: '/analytics', label: 'Analytics', icon: PieChart },
  { href: '/settings', label: 'Settings', icon: SettingsIcon },
];

const ADMIN_NAV = [
  { href: '/admin', label: 'Admin Dashboard', icon: LayoutGrid, exact: true },
  { href: '/admin/drives', label: 'Placement Drives', icon: Building2, exact: false },
  { href: '/admin/users', label: 'Registered Users', icon: Users, exact: false },
  { href: '/admin/aliases', label: 'Resolution Rules', icon: Filter, exact: false },
  { href: '/admin/system', label: 'System & Deduplication', icon: Layers, exact: false },
];

interface SidebarProps {
  userName?: string | null;
  userAvatar?: string | null;
  lastSyncAt?: string | null;
  isAdmin?: boolean;
}

export default function Sidebar({
  userName,
  userAvatar,
  isAdmin,
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

  const navItems = isAdmin ? ADMIN_NAV : STUDENT_NAV;

  return (
    <aside className="fixed inset-y-0 left-0 hidden h-screen w-72 shrink-0 flex-col border-r border-zinc-800/80 bg-[#0b0b0e] lg:flex z-40 select-none">
      {/* Brand Header & In-Sidebar Notification Bell / Admin Pill */}
      <div className="flex h-16 items-center justify-between border-b border-zinc-800/80 px-4 shrink-0">
        <AppLogo />
        {isAdmin ? (
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-amber-500/10 border border-amber-500/25 text-[10px] font-mono font-bold tracking-wider text-amber-400">
            <Shield className="w-3 h-3 text-amber-400" />
            <span>ADMIN</span>
          </div>
        ) : (
          <NotificationBell align="sidebar" />
        )}
      </div>

      {/* Navigation Items */}
      <nav className="space-y-1 px-3.5 pt-3 pb-2 shrink-0">
        {navItems.map(({ href, label, icon: Icon, exact }) => {
          const isActive = exact ? pathname === href : pathname.startsWith(href);

          return (
            <Link
              key={href}
              href={href}
              prefetch={true}
              className={cn(
                'group flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-medium transition-colors duration-150',
                isActive
                  ? isAdmin
                    ? 'bg-amber-500/10 text-amber-300 font-semibold border border-amber-500/20'
                    : 'bg-zinc-800/80 text-zinc-100 font-semibold'
                  : 'text-zinc-400 hover:bg-zinc-900/80 hover:text-zinc-200'
              )}
            >
              <Icon
                className={cn(
                  'h-4 w-4 transition-colors',
                  isActive
                    ? isAdmin ? 'text-amber-400' : 'text-emerald-400'
                    : 'text-zinc-500 group-hover:text-zinc-300'
                )}
              />
              <span className="truncate">{label}</span>
              {isActive && (
                <span
                  className={cn(
                    'ml-auto h-1.5 w-1.5 rounded-full',
                    isAdmin
                      ? 'bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.6)]'
                      : 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]'
                  )}
                />
              )}
            </Link>
          );
        })}
      </nav>

      {/* Spacious area below NAV items: Admin Telemetry OR Campus Radar */}
      <div className="flex-1 px-3.5 py-2 flex flex-col justify-end overflow-y-auto">
        {isAdmin ? (
          <div className="rounded-2xl border border-amber-500/20 bg-zinc-900/60 p-3.5 backdrop-blur-sm shadow-md select-none space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs font-semibold text-zinc-200">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75 animate-ping" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
                </span>
                <span className="tracking-tight font-medium text-zinc-300">System Telemetry</span>
              </div>
              <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold uppercase tracking-wider bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                24/7 Live
              </span>
            </div>

            <div className="space-y-1.5 text-xs">
              <div className="flex items-center justify-between text-zinc-400">
                <span className="text-[11px]">Sync Pipeline</span>
                <span className="font-mono text-[11px] text-zinc-200 flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                  Daily + Pub/Sub
                </span>
              </div>
              <div className="flex items-center justify-between text-zinc-400">
                <span className="text-[11px]">Security</span>
                <span className="font-mono text-[11px] text-amber-300">RBAC Enforced</span>
              </div>
              <div className="flex items-center justify-between text-zinc-400">
                <span className="text-[11px]">Deduplication</span>
                <span className="font-mono text-[11px] text-cyan-300">Canonical Active</span>
              </div>
            </div>

            <a
              href="https://console.cron-job.org/jobs/8265126"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-between w-full px-2.5 py-1.5 rounded-lg bg-zinc-800/60 hover:bg-zinc-800 border border-zinc-700/50 text-[11px] text-zinc-300 hover:text-white transition-colors group cursor-pointer"
            >
              <span className="flex items-center gap-1.5">
                <Clock className="w-3 h-3 text-emerald-400" />
                cron-job.org Console
              </span>
              <ExternalLink className="w-3 h-3 text-zinc-500 group-hover:text-zinc-300" />
            </a>
          </div>
        ) : (
          <CampusRadar />
        )}
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
          href={isAdmin ? '/admin' : '/settings'}
          prefetch={true}
          className="flex items-center gap-2.5 min-w-0 flex-1 p-1 -m-1 rounded-xl hover:bg-zinc-800/50 transition-colors group cursor-pointer"
          title={isAdmin ? "Admin Control Center" : "Go to Settings & Profile"}
        >
          {userAvatar ? (
            <img
              src={userAvatar}
              alt={userName || 'User'}
              className={cn(
                'w-8 h-8 rounded-full object-cover shrink-0 border',
                isAdmin ? 'border-amber-500/40' : 'border-emerald-500/30'
              )}
              referrerPolicy="no-referrer"
            />
          ) : (
            <div
              className={cn(
                'flex h-8 w-8 items-center justify-center rounded-full font-mono text-xs font-bold shrink-0 border',
                isAdmin
                  ? 'border-amber-500/40 bg-amber-500/15 text-amber-300'
                  : 'border-emerald-500/30 bg-emerald-500/15 text-emerald-300'
              )}
            >
              {userName?.split(' ').map((n) => n[0]).slice(0, 2).join('').toUpperCase() || (isAdmin ? 'AD' : 'ST')}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-zinc-200 truncate group-hover:text-white transition-colors">
              {userName || (isAdmin ? 'Admin User' : 'Logged in User')}
            </p>
            {isAdmin ? (
              <p className="text-[10px] text-amber-400 font-mono truncate flex items-center gap-1 font-semibold">
                <Shield className="w-2.5 h-2.5 text-amber-400 shrink-0" />
                System Administrator
              </p>
            ) : (
              <p className="text-[10px] text-emerald-400 font-mono truncate flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shrink-0" />
                Active Session
              </p>
            )}
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
