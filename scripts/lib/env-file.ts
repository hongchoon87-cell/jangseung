// Reads and sets single values in an env file without ever printing the file, so a secret
// kept there stays out of terminal output.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

function lineFor(key: string): RegExp {
  // Also matches a commented-out line such as "# AGENT_ADDRESS=   # note", so the first
  // real value replaces the placeholder in .env.example.
  return new RegExp(`^\\s*#?\\s*${key}=`);
}

/** Value of `key` in `file`, or undefined when it is missing, empty or commented out. */
export function readEnvValue(file: string, key: string): string | undefined {
  if (!existsSync(file)) return undefined;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (line.trimStart().startsWith("#") || !lineFor(key).test(line)) continue;
    const value = line.slice(line.indexOf("=") + 1).trim();
    return value === "" ? undefined : value;
  }
  return undefined;
}

/** Sets `key=value` in `file`, in place of an existing line for the key if there is one. */
export function setEnvValue(file: string, key: string, value: string): void {
  const lines = existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/) : [];
  const index = lines.findIndex((line) => lineFor(key).test(line));
  if (index >= 0) {
    lines[index] = `${key}=${value}`;
  } else {
    // The file ends in a newline, which leaves an empty last entry; add the line before it.
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    lines.push(`${key}=${value}`);
  }
  writeFileSync(file, lines.join("\n").replace(/\n*$/, "\n"));
}
