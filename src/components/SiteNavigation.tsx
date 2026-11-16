"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV = [
  { href: "/patient", label: "Patient" },
  { href: "/driver", label: "Driver" },
  { href: "/admin", label: "Admin" },
];

export default function SiteNavigation() {
  const pathname = usePathname();
  const menuRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    menuRef.current?.removeAttribute("open");
  }, [pathname]);

  return (
    <details ref={menuRef} className="site-nav-menu">
      <summary className="site-nav-trigger">
        Portals
        <svg aria-hidden="true" viewBox="0 0 16 16" fill="none">
          <path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </summary>
      <div className="site-nav-dropdown" aria-label="Choose a portal">
        {NAV.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="site-nav-link"
            aria-current={pathname === item.href ? "page" : undefined}
            onClick={() => menuRef.current?.removeAttribute("open")}
          >
            {item.label}
          </Link>
        ))}
      </div>
    </details>
  );
}
