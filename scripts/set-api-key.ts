// Stores a Claude API key in an env file without showing it. The key is pasted at a hidden
// prompt, so it never appears on screen, in the shell history or in a chat.
//
//   npm run agent:set-api-key                  # into .env.testnet, for the testnet demo
//   npm run agent:set-api-key -- .env          # into .env, for mainnet
//
// Before saving, the script asks the API for its model list. That call is free and shows
// whether the key is accepted. It cannot show whether the account has credits: only the
// first judgment or chat message does.
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";

import Anthropic from "@anthropic-ai/sdk";

import { setEnvValue } from "./lib/env-file.ts";

const files = process.argv.slice(2);
if (files.length === 0) files.push(".env.testnet");
for (const file of files) {
  if (!existsSync(file)) {
    console.error(`${file} does not exist. Create it first: see the README.`);
    process.exit(1);
  }
}

/** Reads one line from the terminal without echoing it. */
function askHidden(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  const silent = new Writable({ write: (_chunk, _encoding, done) => done() });
  const rl = createInterface({ input: process.stdin, output: silent, terminal: true });
  return new Promise((resolve) => {
    rl.question("", (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

const key = await askHidden("Paste the Claude API key and press Enter (it is not shown): ");
if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key)) {
  console.error("That does not look like a Claude API key: it should start with sk-ant-. Nothing was saved.");
  process.exit(1);
}

let checked = "";
try {
  const page = await new Anthropic({ apiKey: key }).models.list({ limit: 1 }, { timeout: 20_000, maxRetries: 1 });
  checked = `The API accepted the key${page.data[0] ? ` (it lists ${page.data[0].id})` : ""}.`;
} catch (error) {
  if (error instanceof Anthropic.AuthenticationError) {
    console.error("The API rejected the key. Nothing was saved. Check the key in the Console and run this again.");
    process.exit(1);
  }
  checked = `The key could not be checked (${(error as Error).message.split("\n")[0]}). It was saved anyway.`;
}

for (const file of files) setEnvValue(file, "ANTHROPIC_API_KEY", key);
console.log(`Saved to ${files.join(" and ")} (${key.length} characters, not shown).`);
console.log(checked);
console.log("Whether the account has credits shows on the first judgment or chat message. Restart the agent to use the key.");
