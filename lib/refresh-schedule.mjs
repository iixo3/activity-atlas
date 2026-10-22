const PARIS_TIME_ZONE = "Europe/Paris";
const formatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: PARIS_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function zonedParts(date) {
  return Object.fromEntries(
    formatter.formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
}

function parisInstant(year, month, day, hour) {
  const targetAsUtc = Date.UTC(year, month - 1, day, hour, 0, 0);
  let candidate = targetAsUtc;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = zonedParts(new Date(candidate));
    const representedAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    candidate += targetAsUtc - representedAsUtc;
  }
  return new Date(candidate);
}

/** Return the next 08:00 or 16:00 Paris wall-clock run strictly after now.
 * @param {Date} now
 */
export function nextParisRefresh(now = new Date()) {
  const local = zonedParts(now);
  for (const hour of [8, 16]) {
    const candidate = parisInstant(local.year, local.month, local.day, hour);
    if (candidate.getTime() > now.getTime()) return candidate;
  }
  const tomorrow = new Date(Date.UTC(local.year, local.month - 1, local.day + 1));
  return parisInstant(
    tomorrow.getUTCFullYear(),
    tomorrow.getUTCMonth() + 1,
    tomorrow.getUTCDate(),
    8,
  );
}

export { PARIS_TIME_ZONE };
