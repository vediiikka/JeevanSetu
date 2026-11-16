"use client";

import type { ReactNode } from "react";

const TONES: Record<string, string> = {
  red: "border-red-500/40 bg-red-500/15 text-red-300",
  amber: "border-amber-500/40 bg-amber-500/15 text-amber-300",
  green: "border-emerald-500/40 bg-emerald-500/15 text-emerald-300",
  blue: "border-sky-500/40 bg-sky-500/15 text-sky-300",
  slate: "border-slate-600/50 bg-slate-700/30 text-slate-300",
};

export function Badge({
  children,
  tone = "slate",
  className = "",
}: {
  children: ReactNode;
  tone?: "red" | "amber" | "green" | "blue" | "slate";
  className?: string;
}) {
  return <span className={`pill ${TONES[tone] ?? TONES.slate} ${className}`}>{children}</span>;
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`card ${className}`}>{children}</div>;
}

export function SectionTitle({
  title,
  subtitle,
  right,
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-300">{title}</h2>
        {subtitle ? <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p> : null}
      </div>
      {right}
    </div>
  );
}

export function StatCard({
  label,
  value,
  hint,
  tone = "slate",
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: "red" | "amber" | "green" | "blue" | "slate";
}) {
  const accent: Record<string, string> = {
    red: "text-red-400",
    amber: "text-amber-400",
    green: "text-emerald-400",
    blue: "text-sky-400",
    slate: "text-slate-200",
  };
  return (
    <div className="card card-pad">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{label}</p>
      <p className={`mt-1 text-2xl font-bold tabular-nums ${accent[tone]}`}>{value}</p>
      {hint ? <p className="mt-0.5 text-[11px] text-slate-500">{hint}</p> : null}
    </div>
  );
}

export function Spinner({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-slate-400">
      <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-slate-600 border-t-red-500" />
      {label}
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-700 bg-slate-900/40 px-4 py-8 text-center">
      <p className="text-sm font-semibold text-slate-300">{title}</p>
      {hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}

export function Alert({ tone = "amber", children }: { tone?: "red" | "amber" | "green" | "blue"; children: ReactNode }) {
  const map: Record<string, string> = {
    red: "border-red-500/40 bg-red-500/10 text-red-200",
    amber: "border-amber-500/40 bg-amber-500/10 text-amber-200",
    green: "border-emerald-500/40 bg-emerald-500/10 text-emerald-200",
    blue: "border-sky-500/40 bg-sky-500/10 text-sky-200",
  };
  return <div className={`rounded-lg border px-3 py-2 text-xs leading-relaxed ${map[tone]}`}>{children}</div>;
}

export function KeyValue({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-slate-800/60 py-1.5 last:border-0">
      <span className="text-xs text-slate-400">{label}</span>
      <span className="text-right text-xs font-semibold text-slate-200">{value}</span>
    </div>
  );
}

export function ProgressSteps({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="flex flex-wrap items-center gap-2 text-[11px]">
      {steps.map((step, index) => {
        const state = index < current ? "done" : index === current ? "active" : "todo";
        return (
          <li key={step} className="flex items-center gap-2">
            <span
              className={`grid h-5 w-5 place-items-center rounded-full border text-[10px] font-bold ${
                state === "done"
                  ? "border-emerald-500/60 bg-emerald-500/20 text-emerald-300"
                  : state === "active"
                    ? "border-red-500/70 bg-red-500/20 text-red-300"
                    : "border-slate-700 bg-slate-800/60 text-slate-500"
              }`}
            >
              {state === "done" ? "✓" : index + 1}
            </span>
            <span className={state === "todo" ? "text-slate-500" : "text-slate-300"}>{step}</span>
            {index < steps.length - 1 ? <span className="text-slate-700">→</span> : null}
          </li>
        );
      })}
    </ol>
  );
}
