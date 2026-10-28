const REFRESH_HOURS_UTC = [7, 15];
const REFRESH_SCHEDULE_LABEL = "07:00/15:00 UTC";

/** Return the next 07:00 or 15:00 UTC run strictly after now.
 * @param {Date} now
 */
export function nextRefresh(now = new Date()) {
  const [year, month, day] = [now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()];
  for (const hour of REFRESH_HOURS_UTC) {
    const candidate = new Date(Date.UTC(year, month, day, hour));
    if (candidate.getTime() > now.getTime()) return candidate;
  }
  return new Date(Date.UTC(year, month, day + 1, REFRESH_HOURS_UTC[0]));
}

export { REFRESH_SCHEDULE_LABEL };
