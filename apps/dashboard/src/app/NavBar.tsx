'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/pipeline', label: 'Pipeline' },
  { href: '/matches', label: 'Matches' },
  { href: '/profile', label: 'Profile' },
];

export function NavBar() {
  const pathname = usePathname();
  if (pathname === '/login') return null;

  return (
    <nav className="navbar">
      <span className="navbar-brand">JobSwitch AI</span>
      <div className="navbar-links">
        {LINKS.map((link) => (
          <Link key={link.href} href={link.href} className={pathname.startsWith(link.href) ? 'active' : ''}>
            {link.label}
          </Link>
        ))}
      </div>
    </nav>
  );
}
