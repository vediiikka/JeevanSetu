export type Theme = "light" | "dark";

const STORAGE_KEY = "jeevansetu-theme";
const CHANGE_EVENT = "jeevansetu-theme-change";

export function getTheme(): Theme {
  if (typeof window === "undefined") return "light";
  return window.localStorage.getItem(STORAGE_KEY) === "dark" ? "dark" : "light";
}

export function subscribeToTheme(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) onChange();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}

export function setTheme(theme: Theme): void {
  window.localStorage.setItem(STORAGE_KEY, theme);
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  window.dispatchEvent(new Event(CHANGE_EVENT));
}
