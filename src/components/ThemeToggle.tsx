"use client";

import { useEffect, useSyncExternalStore } from "react";
import { getTheme, setTheme, subscribeToTheme } from "@/lib/theme";

export default function ThemeToggle() {
  const theme = useSyncExternalStore(subscribeToTheme, getTheme, () => "light");

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  const toggleTheme = () => {
    const nextTheme = theme === "light" ? "dark" : "light";
    setTheme(nextTheme);
  };

  const nextThemeLabel = theme === "light" ? "dark" : "light";

  return (
    <button
      type="button"
      className="theme-toggle"
      aria-label={`Switch to ${nextThemeLabel} mode`}
      aria-pressed={theme === "dark"}
      title={`Switch to ${nextThemeLabel} mode`}
      onClick={toggleTheme}
    >
      {theme === "light" ? (
        <svg aria-hidden="true" viewBox="0 0 20 20" fill="none">
          <path d="M16.4 12.7A6.8 6.8 0 0 1 7.3 3.6a6.8 6.8 0 1 0 9.1 9.1Z" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M13.5 3.2v3.2M11.9 4.8h3.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      ) : (
        <svg aria-hidden="true" viewBox="0 0 20 20" fill="none">
          <circle cx="10" cy="10" r="3.3" stroke="currentColor" strokeWidth="1.7" />
          <path d="M10 1.8v2M10 16.2v2M18.2 10h-2M3.8 10h-2m14-5.8-1.4 1.4M5.6 14.4l-1.4 1.4m11.6 0-1.4-1.4M5.6 5.6 4.2 4.2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        </svg>
      )}
      <span>{theme === "light" ? "Dark" : "Light"}</span>
    </button>
  );
}
