
import * as chrono from "chrono-node";

const TIME_ZONE = "Asia/Kolkata";

export interface TemporalRange {
  startDate: string;
  endDate: string;
  description: string;
}

function getLocalDate(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function addDays(dateString: string, days: number): string {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function resolveTemporalRange(
  input: string,
  referenceDate = new Date()
): TemporalRange | null {
  const today = getLocalDate(referenceDate);
  const normalized = input.toLowerCase().trim();

  // Current calendar day
  if (normalized === "today") {
    return {
      startDate: today,
      endDate: today,
      description: "Today"
    };
  }

  // Previous calendar day
  if (normalized === "yesterday") {
    const date = addDays(today, -1);

    return {
      startDate: date,
      endDate: date,
      description: "Yesterday"
    };
  }

  if (normalized === "tomorrow") {
    const date = addDays(today, 1);

    return {
      startDate: date,
      endDate: date,
      description: "Tomorrow"
    };
  }

  // Previous Monday to Sunday
  if (normalized === "last week") {
    const current = new Date(`${today}T00:00:00Z`);
    const day = current.getUTCDay();
    const daysSinceMonday = (day + 6) % 7;

    const thisMonday = addDays(today, -daysSinceMonday);
    const lastMonday = addDays(thisMonday, -7);
    const lastSunday = addDays(thisMonday, -1);

    return {
      startDate: lastMonday,
      endDate: lastSunday,
      description: "Last week"
    };
  }

  // Current Monday through today
  if (normalized === "this week") {
    const current = new Date(`${today}T00:00:00Z`);
    const day = current.getUTCDay();
    const daysSinceMonday = (day + 6) % 7;

    return {
      startDate: addDays(today, -daysSinceMonday),
      endDate: today,
      description: "This week"
    };
  }

  // Parse expressions such as:
  // 3 November, last Tuesday, 10 November 2026
  const reference = new Date(`${today}T12:00:00+05:30`);

  const results = chrono.parse(input, reference, {
    forwardDate: false
  });

  if (results.length === 0) {
    return null;
  }

  const parsedDate = results[0].start.date();
  const resolvedDate = getLocalDate(parsedDate);

  return {
    startDate: resolvedDate,
    endDate: resolvedDate,
    description: input
  };
}

// Convert an India-local calendar date into a UTC SQL timestamp.
export function localDateToUtc(date: string): string {
  return new Date(`${date}T00:00:00+05:30`)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
}
