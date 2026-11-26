// Runs the backtest with Claude as the judgment step. Takes ANTHROPIC_API_KEY from .env or
// .env.testnet without printing it, gives Claude more time than the live agent does, then
// hands over to run.ts with the same arguments.
//
//   npm run backtest:claude -- report llm basis-only-llm --cap-usd 15
//   npm run backtest:claude -- report llm basis-only-llm --repeats 3 --cap-usd 25
//
// Calls cost money. The cap stops the run before it is passed; answers already received are
// kept in each run's judgments.jsonl and replayed for free when the run is started again.
import { readEnvValue } from "../scripts/lib/env-file.ts";

if (!process.env.ANTHROPIC_API_KEY) {
  for (const file of [".env", ".env.testnet"]) {
    const key = readEnvValue(file, "ANTHROPIC_API_KEY");
    if (key) {
      process.env.ANTHROPIC_API_KEY = key;
      break;
    }
  }
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("No ANTHROPIC_API_KEY in .env or .env.testnet. Store one with: npm run agent:set-api-key");
  process.exit(1);
}
// The live agent gives up after 40 seconds and lets the rule decide. A backtest can wait.
process.env.LLM_TIMEOUT_MS ??= "120000";
process.env.LLM_MODE ??= "on";

await import("./run.ts");
