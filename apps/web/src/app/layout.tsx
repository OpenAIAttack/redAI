import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import './style.css';
export const metadata = {
  title: 'redAI · Không gian làm việc',
  description: 'Không gian kiểm thử riêng của bạn',
};
export default async function Layout({ children }: { children: ReactNode }) {
  await headers(); // Dynamic rendering gives every response a fresh CSP nonce.
  return (
    <html lang="vi">
      <body>{children}</body>
    </html>
  );
}
