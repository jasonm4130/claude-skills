// Parse duration strings like "90s", "5m" into milliseconds.
const UNITS = { ms: 1, s: 1000, m: 60_000 };

export function parseDuration(input) {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m)$/.exec(String(input).trim());
  if (!m) throw new Error(`unparseable duration: ${input}`);
  return Number(m[1]) * UNITS[m[2]];
}
