"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export interface NavItem {
  href: string;
  label: string;
}

/** The tabs under the header. The current one is marked for screen readers too. */
export default function NavLinks({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  return (
    <nav className="mx-auto flex w-full max-w-7xl gap-1 overflow-x-auto px-4" aria-label="Sections">
      {items.map((item) => {
        const active = pathname === item.href || (item.href !== "/" && pathname.startsWith(`${item.href}/`));
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`rounded-t-lg px-3 py-2 text-sm whitespace-nowrap ${
              active ? "bg-canvas font-semibold text-navy" : "text-white/80 hover:bg-white/10"
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
