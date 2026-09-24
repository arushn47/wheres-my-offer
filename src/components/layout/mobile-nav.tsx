'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import {
  LayoutGrid,
  Building2,
  CalendarDays,
  PieChart,
  Settings as SettingsIcon,
  Search,
  Shield,
  Users,
  Filter,
  Layers,
} from 'lucide-react';

const studentNavItems = [
  { label: 'Dashboard', href: '/', icon: LayoutGrid, exact: true },
  { label: 'Companies', href: '/companies', icon: Building2 },
  { label: 'Search', href: '/search', icon: Search },
  { label: 'Calendar', href: '/calendar', icon: CalendarDays },
  { label: 'Analytics', href: '/analytics', icon: PieChart },
  { label: 'Settings', href: '/settings', icon: SettingsIcon },
];

const adminNavItems = [
  { label: 'Overview', href: '/admin', icon: LayoutGrid, exact: true },
  { label: 'Drives', href: '/admin/drives', icon: Building2, exact: false },
  { label: 'Users', href: '/admin/users', icon: Users, exact: false },
  { label: 'Rules', href: '/admin/aliases', icon: Filter, exact: false },
  { label: 'System', href: '/admin/system', icon: Layers, exact: false },
];

export interface MobileNavProps {
  isAdmin?: boolean;
}

export default function MobileNav({ isAdmin }: MobileNavProps) {
  const pathname = usePathname();
  const navItems = isAdmin ? adminNavItems : studentNavItems;

  return (
    <nav className="lg:hidden fixed inset-x-0 bottom-0 z-50 flex items-stretch border-t border-zinc-800/80 bg-[#0b0b0e] safe-area-pb select-none">
      <div className="flex items-center justify-around w-full h-14 px-1 max-w-lg mx-auto">
        {navItems.map((item) => {
          const isActive = item.exact
            ? pathname === item.href
            : pathname.startsWith(item.href);

          return (
            <Link
              key={item.href}
              href={item.href}
              prefetch={true}
              className={cn(
                'flex flex-1 flex-col items-center justify-center py-1 text-[10px] font-medium transition-all select-none',
                isActive
                  ? isAdmin ? 'text-amber-400 font-semibold' : 'text-emerald-400 font-semibold'
                  : 'text-zinc-500 hover:text-zinc-300'
              )}
            >
              <item.icon
                className={cn(
                  'h-4 w-4 transition-transform',
                  isActive && (isAdmin ? 'scale-110 text-amber-400' : 'scale-110 text-emerald-400')
                )}
              />
              <span className="mt-0.5">{item.label}</span>
              {isActive && (
                <span
                  className={cn(
                    'h-1 w-1 rounded-full mt-0.5',
                    isAdmin
                      ? 'bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.8)]'
                      : 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.8)]'
                  )}
                />
              )}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
