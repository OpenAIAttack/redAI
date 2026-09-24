import type { ReactNode } from 'react';
import { SessionProvider } from '../../components/SessionProvider';
import { AppShell } from '../../components/AppShell';

/** Layout for every authenticated screen: gate the session, then render the shell. */
export default function AuthenticatedLayout({ children }: { children: ReactNode }): JSX.Element {
  return (
    <SessionProvider>
      <AppShell>{children}</AppShell>
    </SessionProvider>
  );
}
