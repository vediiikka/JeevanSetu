import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import Image from "next/image";
import ThemeToggle from "@/components/ThemeToggle";
import SiteNavigation from "@/components/SiteNavigation";
import "./globals.css";

export const metadata: Metadata = {
  title: "JeevanSetu",
  description:
    "Emergency ambulance routing for Gujarat with live traffic, road disruptions, hospital suitability and dynamic re-routing.",
  icons: {
    icon: "/brand/jeevansetu-mark.png",
    shortcut: "/brand/jeevansetu-mark.png",
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <header className="site-header sticky top-0 z-30 border-b border-slate-800/80 bg-slate-950/85 backdrop-blur">
          <div className="site-header-inner mx-auto flex w-full max-w-[1600px] flex-wrap items-center gap-3 px-4 py-2 xl:px-8">
            <Link href="/" aria-label="JeevanSetu home" className="brand-link">
              <Image
                src="/brand/jeevansetu-wordmark.png"
                alt="JeevanSetu"
                width={200}
                height={67}
                priority
                unoptimized
                className="site-wordmark site-wordmark-light"
              />
              <Image
                src="/brand/jeevansetu-wordmark-dark.png"
                alt="JeevanSetu"
                width={200}
                height={67}
                priority
                unoptimized
                className="site-wordmark site-wordmark-dark"
              />
            </Link>
            <nav aria-label="Main navigation" className="ml-auto flex items-center gap-1">
              <SiteNavigation />
              <Link href="/patient" className="btn btn-emergency btn-sm ml-1">
                Emergency
              </Link>
              <ThemeToggle />
            </nav>
          </div>
        </header>
        <main className="site-main mx-auto w-full max-w-[1600px] px-4 py-6 xl:px-8">{children}</main>
        <footer className="site-footer mx-auto w-full max-w-[1600px] px-4 pb-8 pt-4 text-[11px] leading-relaxed text-slate-500 xl:px-8">
          जीवनSetu · Demonstration build for Gujarat. Hospitals, ambulances, drivers, road network and disruptions are
          clearly-labelled demo data — no live bed availability, government feed or real vehicle telemetry is used.
        </footer>
      </body>
    </html>
  );
}
