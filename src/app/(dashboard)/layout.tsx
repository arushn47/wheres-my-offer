import { requireSession } from '@/lib/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import Sidebar from '@/components/layout/sidebar';
import MobileHeader from '@/components/layout/mobile-header';
import MobileNav from '@/components/layout/mobile-nav';
import ChatAssistant from '@/components/shared/chat-assistant';
import { SyncProvider } from '@/context/sync-context';

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireSession();

  // Fetch last sync time & admin status
  const supabase = createAdminClient();
  const [{ data: accounts }, { data: userRecord }] = await Promise.all([
    supabase
      .from('gmail_accounts')
      .select('last_sync_at')
      .eq('user_id', session.userId)
      .eq('is_connected', true)
      .order('last_sync_at', { ascending: false })
      .limit(1),
    supabase
      .from('users')
      .select('role')
      .eq('id', session.userId)
      .maybeSingle(),
  ]);

  const lastSyncAt = accounts?.[0]?.last_sync_at || null;
  const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  const isAdmin = Boolean(userRecord?.role === 'admin' || (session.email && adminEmails.includes(session.email.toLowerCase())));

  return (
    <SyncProvider initialLastSyncAt={lastSyncAt}>
      <div className="min-h-screen bg-bg-primary relative w-full max-w-full overflow-x-clip">
        <Sidebar
          userName={session.name}
          userAvatar={session.avatar}
          lastSyncAt={lastSyncAt}
          isAdmin={isAdmin}
        />
        <div className="flex-1 flex flex-col min-w-0 lg:pl-72 w-full max-w-full">
          <MobileHeader
            userName={session.name}
            userAvatar={session.avatar}
            lastSyncAt={lastSyncAt}
            isAdmin={isAdmin}
          />
          <main className="flex-1 px-4 sm:px-6 md:px-8 lg:px-10 xl:px-12 py-3 sm:py-3.5 lg:py-4 pb-28 lg:pb-4 min-w-0 w-full">
            {children}
          </main>
        </div>
        <MobileNav isAdmin={isAdmin} />
        {!isAdmin && <ChatAssistant />}
      </div>
    </SyncProvider>
  );
}
