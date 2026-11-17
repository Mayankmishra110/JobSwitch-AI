import type { Metadata, Viewport } from 'next';
import { NavBar } from './NavBar';
import './globals.css';

export const metadata: Metadata = {
  title: 'JobSwitch AI',
  description: 'Your job search, tracked end to end.',
  manifest: '/manifest.webmanifest',
};

export const viewport: Viewport = {
  themeColor: '#0f172a',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <NavBar />
        <div className="page-body">{children}</div>
        <script
          // Registered inline, not in a separate client component, so it
          // runs once per real page load rather than re-running on every
          // client-side navigation - a service worker registration is
          // idempotent but there is no reason to repeat it.
          dangerouslySetInnerHTML={{
            __html: `
              if ('serviceWorker' in navigator) {
                window.addEventListener('load', () => {
                  navigator.serviceWorker.register('/sw.js').catch(() => {});
                });
              }
            `,
          }}
        />
      </body>
    </html>
  );
}
