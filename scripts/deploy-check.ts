// Runs the deployment script up to the point where it would send its first transaction:
// addresses, balances, pools, cost. Nothing is sent.
//
//   npm run deploy:check
process.env.DEPLOY_CHECK_ONLY = "1";
await import("./deploy.ts");
