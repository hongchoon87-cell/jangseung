import { connect } from "./chain.ts";
import { config } from "./config.ts";
import { createEngine } from "./engine.ts";
import { startServer } from "./server.ts";

async function main(): Promise<void> {
  if (!config.vault) {
    console.error("VAULT_ADDRESS is not set. Deploy a vault first (npm run deploy:fork or deploy:hsk) and put its address in .env.");
    process.exit(1);
  }

  const clients = await connect();
  console.log(`Chain ${clients.chain.id} via ${config.rpcUrl}`);
  console.log(`Vault ${config.vault}`);
  console.log(
    config.dryRun
      ? "Mode: dry-run. Decisions are made and simulated, no transaction is sent."
      : `Mode: live. Trading as ${clients.account?.address}.`,
  );
  console.log(
    config.llm.enabled
      ? `Judgment: ${config.llm.model} (effort ${config.llm.effort}), rule fallback after ${config.llm.timeoutMs} ms.`
      : "Judgment: rules only. Set ANTHROPIC_API_KEY to add the Claude judgment step.",
  );

  const engine = createEngine(clients, config.vault);
  startServer(engine);
  engine.start();

  const shutdown = () => {
    engine.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
