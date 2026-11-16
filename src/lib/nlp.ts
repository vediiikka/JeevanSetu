/**
 * Lightweight, explainable NLP for road-disruption text.
 *
 * This is deliberately rule/keyword based (no external model, no fabricated
 * accuracy claims): every decision is traceable to the keywords that fired, and
 * the result carries a confidence score plus a needsReview flag.
 */

export type NlpResult = {
  category: string;
  severity: string;
  roadName: string | null;
  direction: string;
  startsAt: Date | null;
  endsAt: Date | null;
  confidence: number;
  matchedKeywords: string[];
  ambiguity: string[];
  needsReview: boolean;
  summary: string;
};

const CATEGORY_RULES: { category: string; patterns: RegExp[]; weight: number }[] = [
  {
    category: "closure",
    weight: 1.2,
    patterns: [/fully closed/i, /complete(ly)? clos/i, /road (is )?closed/i, /closed for (traffic|public)/i, /no entry/i, /all traffic (stopped|blocked)/i, /blocked completely/i],
  },
  {
    category: "accident",
    weight: 1.1,
    patterns: [/accident/i, /collision/i, /crash/i, /hit[- ]and[- ]run/i, /overturned/i, /two[- ]wheeler/i, /truck (hit|collision)/i, /casualt/i],
  },
  {
    category: "metro_work",
    weight: 1.15,
    patterns: [/metro/i, /girder/i, /pier work/i, /viaduct/i, /tunnel work/i, /underground (work|construction)/i],
  },
  {
    category: "construction",
    weight: 1,
    patterns: [/construction/i, /road ?work/i, /resurfac/i, /asphalt/i, /re-?lay/i, /paving/i, /expansion work/i, /flyover (repair|work)/i, /work in progress/i],
  },
  {
    category: "drainage",
    weight: 1,
    patterns: [/drainage/i, /storm water/i, /sewer/i, /nala/i, /culvert/i],
  },
  {
    category: "pipeline",
    weight: 1,
    patterns: [/pipeline/i, /water line/i, /gas line/i, /pipe repair/i, /leak(age)?/i],
  },
  {
    category: "waterlogging",
    weight: 1.1,
    patterns: [/water ?log/i, /flood/i, /knee[- ]deep/i, /water on (the )?road/i, /inundat/i, /heavy rain/i, /rain ?water/i, /waterlogging/i],
  },
  {
    category: "damaged_road",
    weight: 1,
    patterns: [/pothole/i, /damaged road/i, /broken road/i, /cave[d]? ?in/i, /sinking/i, /crater/i, /road collapse/i, /unsafe road/i],
  },
  {
    category: "diversion",
    weight: 0.9,
    patterns: [/diversion/i, /diverted/i, /detour/i, /re-?routed/i, /traffic (is )?diverted/i],
  },
  {
    category: "public_event",
    weight: 0.85,
    patterns: [/public event/i, /procession/i, /rally/i, /marathon/i, /festival/i, /\bfair\b/i, /concert/i, /exhibition/i, /bandobast/i, /political (event|meeting)/i],
  },
  {
    category: "traffic",
    weight: 0.7,
    patterns: [/traffic jam/i, /congestion/i, /slow moving/i, /heavy traffic/i, /snarl/i, /gridlock/i, /long queue/i],
  },
];

const SEVERITY_RULES: { severity: string; patterns: RegExp[] }[] = [
  { severity: "critical", patterns: [/fully closed/i, /completely blocked/i, /no entry/i, /all traffic stopped/i, /road (has )?cave[d]? ?in/i, /collapse/i, /stampede/i, /multiple casualties/i, /\bdead\b/i, /fire/i] },
  { severity: "high", patterns: [/blocked/i, /closed/i, /severe/i, /knee[- ]deep/i, /deep water/i, /accident/i, /injur/i, /trapped/i, /unsafe/i] },
  { severity: "moderate", patterns: [/partial/i, /one lane/i, /single lane/i, /slow/i, /diversion/i, /construction/i, /repair/i, /work in progress/i, /water ?log/i] },
];

const ROAD_GAZETTEER = [
  "SG Highway",
  "S G Highway",
  "Ashram Road",
  "SP Ring Road",
  "S P Ring Road",
  "132 Feet Ring Road",
  "Ring Road",
  "Gandhinagar Main Road",
  "Ahmedabad – Gandhinagar Highway",
  "Ahmedabad – Vadodara Expressway",
  "Vadodara – Surat Expressway",
  "Ahmedabad – Rajkot Highway",
  "Vadodara Ring Road",
  "Vadodara – Halol Road",
  "Vadodara – Anand Road",
  "Surat Ring Road",
  "Surat – Navsari Road",
  "Surat – Bardoli Road",
  "Rajkot Ring Road",
  "Rajkot – Kotda Sangani Road",
  "Rajkot – Jasdan Road",
  "University Road",
  "Paldi",
  "Shahibaug",
  "Navrangpura",
  "Maninagar",
  "Naroda",
  "Vastral",
  "Nikol",
  "Odhav",
  "Kathwada",
  "Prahladnagar",
  "Mansi Circle",
  "Kankaria",
  "Adajan",
  "Vesu",
  "Udhna",
  "Gotri",
  "Alkapuri",
  "Sector 21",
  "GIFT City",
  "Kudasan",
  "Halol",
  "Anand",
  "Navsari",
  "Bardoli",
  "Kotda Sangani",
  "Jasdan",
  "Chotila",
  "Limbdi",
];

const DIRECTION_RULES: { direction: string; patterns: RegExp[] }[] = [
  { direction: "northbound", patterns: [/north ?bound/i, /towards (gandhinagar|north)/i] },
  { direction: "southbound", patterns: [/south ?bound/i, /towards (vadodara|surat|south)/i] },
  { direction: "eastbound", patterns: [/east ?bound/i, /towards (east|rajkot)/i] },
  { direction: "westbound", patterns: [/west ?bound/i, /towards (west)/i] },
];

function parseClock(hour: string | undefined, minute: string | undefined, meridiem: string | undefined): number | null {
  if (!hour) return null;
  let h = Number(hour);
  const m = minute ? Number(minute) : 0;
  if (meridiem) {
    const upper = meridiem.toLowerCase();
    if (upper === "pm" && h < 12) h += 12;
    if (upper === "am" && h === 12) h = 0;
  }
  if (!Number.isFinite(h) || h > 23 || m > 59) return null;
  return h * 60 + m;
}

export function parseTimeWindow(text: string, now = new Date()): { startsAt: Date | null; endsAt: Date | null } {
  const base = new Date(now);
  const range = text.match(
    /(?:from\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:to|till|until|upto|-|–)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i,
  );
  if (range) {
    const startMinutes = parseClock(range[1], range[2], range[3]);
    const endMinutes = parseClock(range[4], range[5], range[6] ?? range[3]);
    if (startMinutes !== null && endMinutes !== null) {
      const startsAt = new Date(base);
      startsAt.setHours(Math.floor(startMinutes / 60), startMinutes % 60, 0, 0);
      const endsAt = new Date(startsAt);
      endsAt.setHours(Math.floor(endMinutes / 60), endMinutes % 60, 0, 0);
      if (endsAt.getTime() <= startsAt.getTime()) endsAt.setDate(endsAt.getDate() + 1);
      return { startsAt, endsAt };
    }
  }

  const until = text.match(/(?:till|until|upto|up to)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (until) {
    const minutes = parseClock(until[1], until[2], until[3]);
    if (minutes !== null) {
      const endsAt = new Date(base);
      endsAt.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
      if (endsAt.getTime() <= base.getTime()) endsAt.setDate(endsAt.getDate() + 1);
      return { startsAt: base, endsAt };
    }
  }

  const duration = text.match(/for\s+(\d+)\s*(hour|hours|day|days|week|weeks)/i);
  if (duration) {
    const amount = Number(duration[1]);
    const unit = duration[2].toLowerCase();
    const ms = unit.startsWith("hour") ? amount * 3600_000 : unit.startsWith("day") ? amount * 86_400_000 : amount * 7 * 86_400_000;
    return { startsAt: base, endsAt: new Date(base.getTime() + ms) };
  }

  return { startsAt: base, endsAt: null };
}

export function extractRoadName(text: string): string | null {
  const upper = text.toUpperCase();
  const highway = upper.match(/\b(?:NH|SH|NE)[-\s]?(\d{1,3})\b/);
  if (highway) return `${highway[0].replace(/[\s-]/g, "-").toUpperCase()}`;

  let best: string | null = null;
  for (const candidate of ROAD_GAZETTEER) {
    if (text.toLowerCase().includes(candidate.toLowerCase())) {
      if (!best || candidate.length > best.length) best = candidate;
    }
  }
  return best;
}

export function extractDirection(text: string): string {
  for (const rule of DIRECTION_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(text))) return rule.direction;
  }
  const fromTo = text.match(/from\s+([A-Za-z ]{3,20}?)\s+to\s+([A-Za-z ]{3,20})/i);
  if (fromTo) return `${fromTo[1].trim()} → ${fromTo[2].trim()}`;
  return "both";
}

export function extractDisruption(
  text: string,
  options: { sourceReliability?: "high" | "medium" | "low"; hintCategory?: string; hintSeverity?: string; now?: Date } = {},
): NlpResult {
  const now = options.now ?? new Date();
  const scores = new Map<string, number>();
  const matchedKeywords: string[] = [];

  for (const rule of CATEGORY_RULES) {
    let hits = 0;
    for (const pattern of rule.patterns) {
      const match = text.match(pattern);
      if (match) {
        hits += 1;
        matchedKeywords.push(match[0].toLowerCase());
      }
    }
    if (hits > 0) scores.set(rule.category, hits * rule.weight);
  }

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const ambiguity = ranked.filter(([, score]) => score >= (ranked[0]?.[1] ?? 0) * 0.75).map(([category]) => category);
  let category = options.hintCategory ?? ranked[0]?.[0] ?? "other";
  if (!options.hintCategory && ranked.length === 0) category = "other";

  let severity = options.hintSeverity ?? "moderate";
  if (!options.hintSeverity) {
    for (const rule of SEVERITY_RULES) {
      if (rule.patterns.some((pattern) => pattern.test(text))) {
        severity = rule.severity;
        break;
      }
    }
  }

  const roadName = extractRoadName(text);
  const direction = extractDirection(text);
  const { startsAt, endsAt } = parseTimeWindow(text, now);

  const reliabilityBase = options.sourceReliability === "high" ? 0.78 : options.sourceReliability === "low" ? 0.45 : 0.62;
  let confidence = reliabilityBase;
  if (roadName) confidence += 0.09;
  if (ranked.length > 0) confidence += 0.07;
  if (startsAt && endsAt) confidence += 0.05;
  if (direction !== "both") confidence += 0.03;
  if (ambiguity.length > 1) confidence -= 0.08;
  if (category === "other") confidence -= 0.12;
  confidence = Math.max(0.05, Math.min(0.97, Number(confidence.toFixed(2))));

  const needsReview = confidence < 0.7 || !roadName;

  return {
    category,
    severity,
    roadName,
    direction,
    startsAt,
    endsAt,
    confidence,
    matchedKeywords: [...new Set(matchedKeywords)].slice(0, 8),
    ambiguity,
    needsReview,
    summary: `${category.replace(/_/g, " ")} · ${severity} severity · ${roadName ?? "road not identified"} · confidence ${(confidence * 100).toFixed(0)}%`,
  };
}
