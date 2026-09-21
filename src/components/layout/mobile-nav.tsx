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
} from 'lucide-react';

const navItems = [
  { label: 'Dashboard', href: '/', icon: LayoutGrid, exact: true },
  { label: 'Companies', href: '/companies', icon: Building2 },
  { label: 'Search', href: '/search', icon: Search },
  { label: 'Calendar', href: '/calendar', icon: CalendarDays },
  { label: 'Analytics', href: '/analytics', icon: PieChart },
  { label: 'Settings', href: '/settings', icon: SettingsIcon },
];

export default function MobileNav() {
  const pathname = usePathname();

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
                isActive ? 'text-emerald-400 font-semibold' : 'text-zinc-500 hover:text-zinc-300'
              )}
            >
              <item.icon className={cn('h-4 w-4 transition-transform', isActive && 'scale-110 text-emerald-400')} />
              <span className="mt-0.5">{item.label}</span>
              {isActive && (
                <span className="h-1 w-1 rounded-full bg-emerald-400 mt-0.5 shadow-[0_0_6px_rgba(52,211,153,0.8)]" />
              )}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
