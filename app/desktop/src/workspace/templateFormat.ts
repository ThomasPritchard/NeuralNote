const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const two = (value: number) => String(value).padStart(2, "0");

export function validateTemplateFormat(format: string): string | null {
  if (Array.from(format).length > 128) return "Format cannot exceed 128 characters.";
  if (/\p{Cc}/u.test(format)) return "Format cannot contain control characters.";
  let inLiteral = false;
  for (const character of format) {
    if (character === "[" && !inLiteral) inLiteral = true;
    else if (character === "]" && inLiteral) inLiteral = false;
  }
  return inLiteral ? "Format contains an unclosed literal." : null;
}

function token(rest: string, now: Date): [string, string] | null {
  const hours = now.getHours();
  const hour12 = hours % 12 || 12;
  const ampm = hours < 12 ? "AM" : "PM";
  const values: Array<[string, string]> = [
    ["YYYY", String(now.getFullYear())],
    ["MMMM", MONTHS[now.getMonth()]],
    ["dddd", WEEKDAYS[now.getDay()]],
    ["MMM", MONTHS[now.getMonth()].slice(0, 3)],
    ["ddd", WEEKDAYS[now.getDay()].slice(0, 3)],
    ["YY", two(now.getFullYear() % 100)],
    ["MM", two(now.getMonth() + 1)],
    ["DD", two(now.getDate())],
    ["HH", two(hours)],
    ["hh", two(hour12)],
    ["mm", two(now.getMinutes())],
    ["ss", two(now.getSeconds())],
    ["M", String(now.getMonth() + 1)],
    ["D", String(now.getDate())],
    ["H", String(hours)],
    ["h", String(hour12)],
    ["A", ampm],
    ["a", ampm.toLowerCase()],
  ];
  return values.find(([candidate]) => rest.startsWith(candidate)) ?? null;
}

export function formatMomentPreview(format: string, now = new Date()): string {
  let output = "";
  let cursor = 0;
  while (cursor < format.length) {
    const rest = format.slice(cursor);
    if (rest.startsWith("[")) {
      const offset = rest.slice(1).indexOf("]");
      if (offset < 0) return output + rest;
      output += rest.slice(1, offset + 1);
      cursor += offset + 2;
      continue;
    }
    const rendered = token(rest, now);
    if (rendered) {
      output += rendered[1];
      cursor += rendered[0].length;
      continue;
    }
    const character = Array.from(rest)[0];
    output += character;
    cursor += character.length;
  }
  return output;
}
