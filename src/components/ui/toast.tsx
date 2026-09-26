'use client';

import React from 'react';
import { toast } from 'sonner';
import {
  Sparkles,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  Info,
  Calendar,
  Award,
  FileText,
  Building2,
  X,
  ArrowUpRight,
  Zap,
  Loader2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { InAppNotification } from '@/components/notifications/notification-bell';

import { AppLogoMark } from '@/components/brand/logo';

export type ToastVariant =
  | 'success'
  | 'error'
  | 'warning'
  | 'info'
  | 'shortlist'
  | 'test'
  | 'interview'
  | 'sync'
  | 'loading';

export interface ToastAction {
  label: string;
  onClick: () => void;
  url?: string;
}

export interface PremiumToastProps {
  id: string | number;
  variant?: ToastVariant;
  title: string;
  description?: string;
  action?: ToastAction;
  duration?: number;
  onClick?: () => void;
}

const VARIANT_CONFIGS: Record<
  ToastVariant,
  {
    borderColor: string;
    glowColor: string;
    dotColor: string;
  }
> = {
  shortlist: {
    borderColor: 'border-emerald-500/35 hover:border-emerald-500/50',
    glowColor: 'from-emerald-500/20 via-transparent to-transparent',
    dotColor: 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]',
  },
  test: {
    borderColor: 'border-amber-500/35 hover:border-amber-500/50',
    glowColor: 'from-amber-500/20 via-transparent to-transparent',
    dotColor: 'bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.8)]',
  },
  interview: {
    borderColor: 'border-purple-500/35 hover:border-purple-500/50',
    glowColor: 'from-purple-500/20 via-transparent to-transparent',
    dotColor: 'bg-purple-400 shadow-[0_0_8px_rgba(192,132,252,0.8)]',
  },
  success: {
    borderColor: 'border-emerald-500/35 hover:border-emerald-500/50',
    glowColor: 'from-emerald-500/20 via-transparent to-transparent',
    dotColor: 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]',
  },
  error: {
    borderColor: 'border-rose-500/40 hover:border-rose-500/60',
    glowColor: 'from-rose-500/20 via-transparent to-transparent',
    dotColor: 'bg-rose-400 shadow-[0_0_8px_rgba(244,63,94,0.8)]',
  },
  warning: {
    borderColor: 'border-amber-500/35 hover:border-amber-500/50',
    glowColor: 'from-amber-500/20 via-transparent to-transparent',
    dotColor: 'bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.8)]',
  },
  info: {
    borderColor: 'border-zinc-800 hover:border-zinc-700',
    glowColor: 'from-emerald-500/10 via-transparent to-transparent',
    dotColor: 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]',
  },
  sync: {
    borderColor: 'border-emerald-500/30 hover:border-emerald-500/45',
    glowColor: 'from-emerald-500/20 via-transparent to-transparent',
    dotColor: 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]',
  },
  loading: {
    borderColor: 'border-amber-500/35 hover:border-amber-500/50',
    glowColor: 'from-amber-500/20 via-transparent to-transparent',
    dotColor: 'bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.8)]',
  },
};

/**
 * PremiumToast Component
 * Uniform fixed size (360px x 66px), clean AppLogoMark, no cluttering badges,
 * clean title & short description, dismiss button, and click-to-open interaction.
 */
export function PremiumToast({
  id,
  variant = 'info',
  title,
  description,
  action,
  onClick,
}: PremiumToastProps) {
  const config = VARIANT_CONFIGS[variant] || VARIANT_CONFIGS.info;

  const handleClick = () => {
    if (action?.onClick) {
      action.onClick();
      toast.dismiss(id);
    } else if (onClick) {
      onClick();
      toast.dismiss(id);
    }
  };

  const isClickable = Boolean(action?.onClick || onClick);

  return (
    <div
      data-premium-toast=""
      onClick={handleClick}
      className={cn(
        'relative w-[360px] h-[66px] flex items-center gap-3 px-3.5 rounded-xl border shadow-xl transition-all duration-200 select-none overflow-hidden',
        'bg-[#0d0d11]/95 backdrop-blur-2xl',
        config.borderColor,
        isClickable && 'cursor-pointer hover:bg-[#121218] hover:border-zinc-700'
      )}
    >
      {/* Subtle ambient radial glow in corner */}
      <div
        className={cn(
          'pointer-events-none absolute -top-6 -left-6 h-20 w-20 rounded-full bg-gradient-to-br blur-xl opacity-40',
          config.glowColor
        )}
      />

      {/* App Logo Mark with micro status dot or spinner */}
      <div className="relative shrink-0 flex items-center justify-center">
        <AppLogoMark size={28} className="shadow-md" />
        {variant === 'loading' ? (
          <span className="absolute -bottom-1 -right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-[#0d0d11] ring-2 ring-[#0d0d11]">
            <Loader2 className="h-2.5 w-2.5 text-amber-400 animate-spin" />
          </span>
        ) : (
          <span
            className={cn(
              'absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full ring-2 ring-[#0d0d11]',
              config.dotColor
            )}
          />
        )}
      </div>

      {/* Content Area: Title & Short Desc */}
      <div className="min-w-0 flex-1 flex flex-col justify-center">
        <h4 className="font-display text-[13px] font-semibold text-zinc-100 tracking-tight truncate leading-tight">
          {title}
        </h4>
        {description && (
          <p className="text-xs text-zinc-400 truncate mt-0.5 leading-normal">
            {description}
          </p>
        )}
      </div>

      {/* Dismiss Cross */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          toast.dismiss(id);
        }}
        className="shrink-0 rounded-lg p-1.5 text-zinc-500 hover:bg-white/10 hover:text-zinc-200 transition-colors cursor-pointer"
        title="Close"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

// ============================================
// Public Toast API (appToast)
// ============================================

export const appToast = {
  /**
   * Active loading / progress notification
   */
  loading: (
    title: string,
    description?: string,
    action?: ToastAction,
    duration = Infinity,
    toastId?: string | number
  ) => {
    return toast.custom(
      (id) => (
        <PremiumToast
          id={id}
          variant="loading"
          title={title}
          description={description}
          action={action}
        />
      ),
      { id: toastId, duration }
    );
  },

  /**
   * Dismiss a toast by id, or all toasts
   */
  dismiss: (id?: string | number) => {
    if (id !== undefined) {
      toast.dismiss(id);
    } else {
      toast.dismiss();
    }
  },

  /**
   * Shortlist cracked alert
   */
  shortlist: (
    title: string,
    options?: {
      description?: string;
      company?: string;
      action?: ToastAction;
      duration?: number;
    }
  ) => {
    return toast.custom(
      (id) => (
        <PremiumToast
          id={id}
          variant="shortlist"
          title={title}
          description={options?.description}
          action={options?.action}
        />
      ),
      { duration: options?.duration ?? Infinity }
    );
  },

  /**
   * OA / Assessment / Test scheduled alert
   */
  test: (
    title: string,
    options?: {
      description?: string;
      company?: string;
      action?: ToastAction;
      duration?: number;
    }
  ) => {
    return toast.custom(
      (id) => (
        <PremiumToast
          id={id}
          variant="test"
          title={title}
          description={options?.description}
          action={options?.action}
        />
      ),
      { duration: options?.duration ?? Infinity }
    );
  },

  /**
   * Interview round alert
   */
  interview: (
    title: string,
    options?: {
      description?: string;
      company?: string;
      action?: ToastAction;
      duration?: number;
    }
  ) => {
    return toast.custom(
      (id) => (
        <PremiumToast
          id={id}
          variant="interview"
          title={title}
          description={options?.description}
          action={options?.action}
        />
      ),
      { duration: options?.duration ?? Infinity }
    );
  },

  /**
   * Success notification
   */
  success: (
    title: string,
    description?: string,
    action?: ToastAction,
    duration = 5000,
    toastId?: string | number
  ) => {
    return toast.custom(
      (id) => (
        <PremiumToast
          id={id}
          variant="success"
          title={title}
          description={description}
          action={action}
        />
      ),
      { id: toastId, duration }
    );
  },

  /**
   * Error notification
   */
  error: (
    title: string,
    description?: string,
    action?: ToastAction,
    duration = 7000,
    toastId?: string | number
  ) => {
    return toast.custom(
      (id) => (
        <PremiumToast
          id={id}
          variant="error"
          title={title}
          description={description}
          action={action}
        />
      ),
      { id: toastId, duration }
    );
  },

  /**
   * Warning notification
   */
  warning: (
    title: string,
    description?: string,
    action?: ToastAction,
    duration = 6000,
    toastId?: string | number
  ) => {
    return toast.custom(
      (id) => (
        <PremiumToast
          id={id}
          variant="warning"
          title={title}
          description={description}
          action={action}
        />
      ),
      { id: toastId, duration }
    );
  },

  /**
   * General info notification
   */
  info: (
    title: string,
    description?: string,
    action?: ToastAction,
    duration = 5000,
    toastId?: string | number
  ) => {
    return toast.custom(
      (id) => (
        <PremiumToast
          id={id}
          variant="info"
          title={title}
          description={description}
          action={action}
        />
      ),
      { id: toastId, duration }
    );
  },

  /**
   * Sync complete or background radar update
   */
  sync: (
    title: string,
    description?: string,
    action?: ToastAction,
    duration = 6000,
    toastId?: string | number
  ) => {
    return toast.custom(
      (id) => (
        <PremiumToast
          id={id}
          variant="sync"
          title={title}
          description={description}
          action={action}
        />
      ),
      { id: toastId, duration }
    );
  },

  /**
   * Dynamically formats any InAppNotification into the right premium toast variant!
   */
  notification: (
    notif: InAppNotification,
    routerNavigate?: (url: string) => void
  ) => {
    let variant: ToastVariant = 'info';

    switch (notif.type) {
      case 'shortlist_match':
        variant = 'shortlist';
        break;
      case 'test_scheduled':
        variant = 'test';
        break;
      case 'interview_scheduled':
        variant = 'interview';
        break;
      case 'ppt_scheduled':
        variant = 'info';
        break;
      case 'new_company':
        variant = 'sync';
        break;
      case 'status_change':
        variant = 'success';
        break;
      default:
        variant = 'info';
    }

    const actionUrl = notif.link || (notif.company_id ? `/companies/${notif.company_id}` : undefined);
    const action: ToastAction | undefined =
      actionUrl && routerNavigate
        ? {
            label: 'View',
            onClick: () => routerNavigate(actionUrl),
          }
        : undefined;

    return toast.custom(
      (id) => (
        <PremiumToast
          id={id}
          variant={variant}
          title={notif.title}
          description={notif.body || notif.message}
          action={action}
        />
      ),
      { id: `notif-${notif.id}`, duration: Infinity }
    );
  },
};
