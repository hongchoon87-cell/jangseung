# Jangseung (장승): an AI trading agent that cannot break its own rules

<img src="docs/logo.png" alt="Jangseung logo" width="96" align="right">

An AI agent trades on HSKSwap for you, and a smart contract on HSK Chain decides how far it
is allowed to go. The AI proposes each trade; the vault contract enforces the trade size,
position size, slippage, stop-loss and drawdown limits on-chain, whatever the AI says.

Built for the HSK Chain Horizon Hackathon Seoul, Track 1 (AI Agent Trading).
Demo video (3 min, a live run on the HSK testnet): https://www.youtube.com/watch?v=xZlqgqsSegQ
A *jangseung* is the carved guardian post at the entrance of a Korean village.
한국어 기획 문서: [docs/기획서.md](docs/기획서.md)

## Status

| Part | State |
|---|---|
| `AgentVault` contract | Written. 50 unit tests and 10 tests against the real HSKSwap pools on mainnet forks pass. Two faults the backtest found are fixed (see [Backtest](#backtest)). |
| Agent pipeline (rules, gate, execution) | Written. 70 unit tests pass. Ran end to end on a local mainnet fork: buys, a stop-loss after a 10% sell-off, limits and settings. |
| Testnet demo | **Deployed on the HSK Chain testnet on 2026-11-25**, source verified, keeper and agent running in live mode with test tokens. A fall we staged in the demo pool the same day left the agent's buy and the vault's stop-loss on-chain. Rehearsed first on a local fork of the testnet: demo market, vault, deposit, a buy, a staged 10% fall, the stop-loss. Addresses and transactions in [Run it on the HSK Chain testnet](#run-it-on-the-hsk-chain-testnet). |
| Dashboard and chat | Written. Checked in a browser against the fork. |
| Claude judgment and chat | **Run against the API on the testnet on 2026-11-25** with `claude-opus-5-5`: three judgments (a buy cut to 40% of the proposed size, two take-profit approvals) and four chat requests. See [Claude on the testnet](#claude-on-the-testnet-2026-11-25). Backtested on the held-back period on 2026-11-26: it kept positions about half as large, which cut the loss of the chosen configuration from −0.42% to about −0.15% over three runs and made no difference on the live defaults. See [Claude as the judgment step](#claude-as-the-judgment-step). |
| Mainnet deployment | **Not done yet.** The submission runs on the testnet, which the hackathon accepts. Teams selected for the demo day must deploy to mainnet, as the organisers repeated in their AMA on 2026-11-27, and winners must deploy to claim a prize. If this project is selected, the vault goes to mainnet before the demo. The deployment was rehearsed on a mainnet fork and the scripts are ready; the owner's wallet needs about 3 HSK for gas. |
| Backtest with baselines | Done, 82 tests. **It does not show a profit**: +1.53% on the period used to choose the configuration, −0.42% on the period held back. Full write-up in [docs/백테스트_결과.md](docs/백테스트_결과.md) (Korean). |

## How it works

```
 exchanges (HashKey Global, Gate, KuCoin, MEXC) ──┐
 HSKSwap pools (spot, TWAP, liquidity) ───────────┤
                                                  ▼
 1. Rules        propose a trade when a price pattern appears
 2. Gate         re-checks it against live quotes: fresh data, real fill price,
                 gain after fees, impact and gas, the vault's limits
 3. Judgment     Claude approves, reduces or vetoes, and says why
                 (falls back to the rule if the model is slow or unavailable)
 4. AgentVault   enforces every limit again on-chain, then swaps on HSKSwap
```

Each buy or sell the agent decides carries the hash of its full decision record (rule trigger, gate
measurements, judgment and rationale), so the reasoning kept off-chain can be checked
against what was executed. A stop-loss, which anyone can call, is marked `STOP_LOSS`
instead.

### What the vault enforces

The owner deposits USDT and can withdraw or exit at any time. The agent key can only swap
between USDT and listed assets, and never withdraw.

| Limit | What it stops |
|---|---|
| Max trade size (share of NAV) | One oversized bet |
| Max position per asset, max total exposure | Concentration |
| Max slippage against the pool's TWAP | Bad fills, sandwiching, a pool pushed around within a block |
| Cooldown and daily buy count | Churning |
| Stop-loss per position | Anyone may sell a position that fell past the limit, so it works with the agent offline. A position too large for the pool is sold over several calls, each inside the slippage limit |
| Drawdown breaker | Buying halts once NAV per share falls too far below its peak; anyone may then flatten positions, in parts if need be |
| Re-entry lockout | Buying straight back after a stop-loss |
| Price history of each pool | Listing an asset enlarges the pool's oracle when it is too short for the TWAP window, so trading cannot erase the history the vault values itself with |

All values are priced with the pool's time-weighted average price, so a price moved inside
one block cannot trip or dodge a limit. The fork tests show this on the real WHSK/USDT
pool: right after a 10% sell-off the stop-loss cannot be forced, and once the lower price
has held for the TWAP window anyone can trigger it.

With a compromised or mistaken agent, what it can lose per day by trading badly is bounded,
relative to the TWAP, by `buys per day × max trade size × 2 × max slippage`: 2.4% of NAV
with the default policy (12 buys, 10% each, 1% slippage on the way in and out). The
drawdown breaker stops new buys altogether at the configured drawdown. Market losses on
positions already held are bounded by the exposure cap and the stop-loss.

### What the agent adds

- **Reference price by consensus.** A single exchange can be thin: during development
  HashKey Global's HSK book was 150 bps wide. The agent takes the median of the exchanges
  whose own spread is tight (HashKey Global, Gate, KuCoin, MEXC, LBank), and refuses to
  trade when fewer than two qualify.
- **Positions sized to what the pool can take back.** The vault refuses any sale that
  fills more than its slippage limit under the TWAP, so a position worth more than about
  0.6% of the pool's depth cannot be sold in one transaction. The agent builds a position
  only up to half of that and splits a sale that does not fit.
- **A gate for false opportunities.** Stale or disagreeing reference prices, a gap smaller
  than two pool fees plus gas, a pool too thin for the size, and gaps too large to be
  believable are all rejected before any transaction is built.
- **Two rule families.** *Gap*: buy when the DEX is cheaper than the exchanges by more than
  the full round-trip cost, sell into a premium. *Trend*: follow moving averages, capped by
  round-trip cost. Exits come first: early stop, take-profit, premium, broken trend.
- **Judgment with a fallback.** Claude sees the candidate, the gate's numbers, the
  portfolio and recent decisions, and can approve, reduce or veto. It can never raise the
  size, and a slow or failed call falls back to the rule so trading never stalls.

### Talking to it

The dashboard at `http://127.0.0.1:8787` shows NAV, positions, limits, market data and
every decision with its checks. The chat answers from the live state and changes
preferences in plain language: buy size, trades per day, time between trades, risk
appetite, target assets, strategies, pause and resume. Preferences only ever tighten the
on-chain policy. Asking for more than the vault allows is capped at the vault's limit and
explained; raising the policy itself needs the owner's signature.

## Track 1 requirements

| Requirement | Where |
|---|---|
| Monitor markets, analyse on-chain data, find signals, execute autonomously | `agent/src/market.ts`, `signals.ts`, `gate.ts`, `executor.ts` |
| Spot arbitrage and spread opportunities | DEX against exchange consensus, in `signals.ts` and `gate.ts` |
| Strict risk controls and stop-loss | `contracts/AgentVault.sol` |
| Conversational interface for positions, P&L and settings | `agent/src/chat.ts`, `agent/web/index.html` |
| Built on HSK Chain with HSKSwap | Every swap and every TWAP comes from HSKSwap pools |

## Backtest

The pipeline was replayed over the WHSK/USDT pool's history: every swap and liquidity
change since the pool was created (26,432 events from the chain) and 5-minute candles from
three exchanges. The rules, the gate, the sizing step and the order they run in are the
live code; only the chain, the exchanges and the vault are replaced, the vault by a
TypeScript copy of the contract.

Results after pool fees, price impact and gas, for a 1,000 USDT vault with the default policy:

| | Development, 2026-04-22 to 08-31 | Report, 2026-09-01 to 11-23 |
|---|---|---|
| Hold USDT | 0.00% | 0.00% |
| Hold HSK with 30% of the vault | −10.66% | −7.33% |
| Hold HSK with all of it | −35.55% | −24.43% |
| Rules alone | −2.46% | −0.96% |
| Rules + gate | +0.66% | −0.71% |
| Rules + gate + sizing | +0.69% | −0.57% |
| Gap rules only (chosen on development) | **+1.53%**, 11 round trips | **−0.42%**, 13 round trips |
| Largest drawdown of the chosen configuration | 0.22% | 0.84% |

What this does and does not show:

- **No profit claim.** The configuration was chosen on the first period and lost on the
  second, which was run once with everything frozen. With 24 round trips in total the
  result cannot be told apart from zero.
- **Losses stayed small** while HSK fell by a third and then a quarter.
- **The gate helped in both periods** (3.1 and 0.25 points better than the rules alone),
  and **the trend rules lost after costs in both**.
- The loss in the second period came from the exchange price falling while positions
  were held (11 of 13), and from one position that could not be sold for six days because
  the pool's liquidity provider withdrew almost everything.

How it was kept honest:

- The replay was checked against the chain: the fork tests' measured swap amounts to the
  wei, 26,261 of the pool's own 26,377 swaps reproduced exactly, and price, liquidity,
  TWAP and QuoterV2 quotes compared at 200 random past blocks.
- A test deletes or corrupts everything after a period and requires every earlier
  decision to stay identical.
- The periods are split by date; the second was run once, and the code hash in its
  results matches the one recorded when the configuration was frozen
  (`backtest/results/freeze.json`).

The backtest also found design problems, which mattered more than the returns. All three
are fixed:

1. *Agent.* A position built to the vault's 30% cap could not be sold in a shallow pool
   and sat for days. The first run's best result was that stuck position meeting a rally.
   The agent now sizes positions to what the pool can take back.
2. *Contract.* `triggerStopLoss` sold the whole position in one swap under the same 1%
   limit, so it could not fire for a position too large for the pool. It now takes an
   amount, and with 0 sells as much as fits (`maxSellNow`). On a mainnet fork, a position
   worth 16,048 USDT at its stop was closed by anyone in seven calls for 15,363 USDT; the
   amount the contract computed was accepted by the real pool and 30% more was refused.
3. *Contract.* A pool whose oracle keeps a single observation, as the WHSK pool did until
   2026-10-26, made every buy revert, and listing the asset gave no warning. Listing now
   enlarges the oracle to one observation per 2-second block of the TWAP window, plus one.
   On a fork of 2026-10-25 the same buy goes through.

`test/AgentVaultLimitsFork.t.sol` checks 2 and 3 against the real pool. After the contract
changed, both periods were run again: every result is identical to the frozen run, because
in this history the agent's own exits always came before the vault's stop-loss.

What a contract cannot fix: if the pool's liquidity provider withdraws, nothing can be
sold until liquidity returns, in parts or otherwise.

### Claude as the judgment step

On 2026-11-26 the judgment step was run with Claude (`claude-opus-5-5`, the same prompt
and input as the live agent) in place of the rule-based sizing. It ran on the second
period only: the model's training data runs to June 2026 and overlaps the first. What
would be run and what was expected was written down beforehand
(`backtest/results/freeze-llm.json`), and the runner refuses any other code. Each
configuration ran three times, because the model's answers vary.

| | Rule-based sizing | Claude, three runs |
|---|---|---|
| Gap rules only (chosen) | −0.42% | −0.12%, −0.17%, −0.15% |
| Gap and trend rules (live defaults) | −0.57% | −0.53%, −0.57%, −0.48% |

- **Claude kept positions small.** It took the first buy in most opportunities
  (18 to 21 of 23 to 25), then refused most of the repeat buys the rules propose every
  10 minutes while a gap stays open, citing a position already held on a gap that had not
  closed. It never blocked a sale.
- **That halved the pool fees** (9.83 to 4.69–5.23 USDT on the chosen configuration) and
  the largest drawdown (0.84% to 0.36–0.44%). Profit per round trip barely changed, and
  the trend buys it let through did worse than the rule's.
- **No claim beyond that.** In a period where the strategy lost, smaller positions lose
  less; whether the same caution would cost profit in a period like the first cannot be
  tested with this model. One period and 11 to 19 round trips per run are too few to call
  the difference significant.
- Six runs made 886 judgments for $19.32, about $0.022 each, with no failed call. The
  answers are stored with the results, so a run replays without the API and gives the
  same numbers.

```bash
npm run backtest -- development    # every experiment on the first period
npm run backtest -- report         # the same on the second
npm run backtest:check             # data quality; add "-- chain" to compare with the chain
npm run backtest:fetch             # download the history again (block range is pinned)
npm run backtest:claude -- report llm basis-only-llm --cap-usd 15   # Claude as the judgment
#                                    step; costs money, replays stored answers for free
```

## Run it on a local fork

Requires Node.js 22 or newer. Nothing here touches mainnet or real funds.

```bash
npm install
npm run build          # compile the contract and export its ABI to the agent

npm run fork           # terminal 1: fork HSK Chain mainnet on 127.0.0.1:8545
npm run fork:setup     # terminal 2: deploy a vault and deposit 500 test USDT
npm run agent:fork     # terminal 2: start the agent, then open http://127.0.0.1:8787
```

To watch it react, play the outside market from a third terminal
(PowerShell: `$env:MOVE="dump"; $env:AMOUNT="30000"; npm run fork:move`):

```bash
MOVE=dump AMOUNT=30000 npm run fork:move     # push WHSK about 1% under the exchanges
MOVE=dump AMOUNT=300000 npm run fork:move    # a 10% sell-off
MOVE=wait SECONDS=300 npm run fork:move      # let the TWAP catch up: the stop-loss fires
```

Start the fork with `FORK_LATEST=1` to fork the current block, so pool prices line up with
live exchange prices.

## Run it on the HSK Chain testnet

The hackathon accepts a testnet deployment for the submission, and the testnet is where the
agent can trade for real without real money.

HSKSwap has an official testnet deployment (chain id 133; the developer page of
app.hskswap.com lists its addresses), but its pools trade at prices unrelated to the market.
On 2026-11-25 one WHSK cost 54 test USDT in one pool and 78 in another, against 0.08 USDT on
mainnet. The agent checks every trade against exchange prices, so on those pools it would
refuse everything.

The demo therefore brings a market of its own: two valueless tokens
(`contracts/testnet/TestToken.sol`) in a pool created on the official testnet HSKSwap
contracts. The pool starts at the price and depth of the real WHSK/USDT pool on mainnet,
and a keeper moves it whenever that pool trades. Between mainnet trades the agent's own
price impact stays in place, the same assumption the backtest makes. The vault and the
agent are the code that runs on mainnet; only the addresses differ. Gas costs 1 gwei on the
testnet and 500 on mainnet, so the agent weighs trades at the mainnet price
(`ASSUME_GAS_PRICE_GWEI` in `.env.testnet`).

What is deployed (explorer: `https://testnet-explorer.hskchain.net/address/<address>`):

| | Address |
|---|---|
| `AgentVault` | `0xd5bfcD4523E8adDDD63d1b7A0a1F1352f56F768F` |
| Demo pool (test WHSK / test USDT, 0.3%) | `0x2d13c92696d34249461aA1fd71e7d0cF7E046A7A` |
| Test WHSK (`tWHSK`) | `0x1F0B361ed9456d0A791215544bce4C3941760A9D` |
| Test USDT (`tUSDT`) | `0x9bE0a9bde26B0c89F5592A29Bf426687F475A074` |

All three contracts are exact matches on Sourcify
(`https://sourcify.dev/server/repo-ui/133/<address>`). The testnet explorer shows them as
verified too. For the vault it holds a copy in which the OpenZeppelin and Uniswap library
files have their comments removed, because that explorer refuses requests over 100 KB; our
own three files are there unchanged, and the copy compiles to the deployed bytecode.

### The staged fall of 2026-11-25

The mainnet pool was quiet (no swap in the 8.6 hours after the demo went up) and the agent
had turned down the three entries it saw, so we staged a fall to put a buy and a stop-loss
on record. The three price moves are ours, made with the market key while the keeper was
stopped. The buy and the stop-loss are the running agent's and the vault's. Times are KST
(UTC+9).

| Time | Who | What | Transaction |
|---|---|---|---|
| 10:50:04 | market key, staged | Sold 42,163 test WHSK: price 0.080816 → 0.079523 (−1.60%), 235 bps under the exchanges | [`0x73df8eb4…`](https://testnet-explorer.hskchain.net/tx/0x73df8eb4ab0f8e2e5e9c51df32bb73f4eda5c735c9cefc5e53c66b553aad4275) |
| 10:50:20 | agent, through the vault | All 11 gate checks passed (net edge 166 bps, 25 needed). Bought 626.79 test WHSK for 50 test USDT | [`0xd305cca7…`](https://testnet-explorer.hskchain.net/tx/0xd305cca790e8fdf8fbd77b1c57a1839a3a6729992225726df5475a3bb9681524) |
| 10:50:38 | market key, staged | Sold 283,907 test WHSK: price 0.079542 → 0.071588 (−10.00%) | [`0x3f0a68be…`](https://testnet-explorer.hskchain.net/tx/0x3f0a68be1ee97b239f1cfba70543cafbe986cd82c4b295153f11469687043944) |
| 10:55:50 | agent, calling the vault's `triggerStopLoss` | The whole position sold for 44.73 test USDT, a loss of 5.27 (10.5% of the 50 paid). Buying the asset is locked for an hour | [`0xfdde04a4…`](https://testnet-explorer.hskchain.net/tx/0xfdde04a4672faf08bb9fc9202b8d8a13a03765c5a61853f8cb7ef199f78c8d69) |
| 10:56:10 | market key, staged | Pool returned to the mainnet pool's price, 0.080821 | [`0xd7d61484…`](https://testnet-explorer.hskchain.net/tx/0xd7d614840e6bd4649e4f11ce02851997593ece7a99cc945a03d2ff4f028ddbe1) |

Two refusals in between are part of the record. At 10:50:54 the rules proposed a second buy
and the gate turned it down: it came 24 seconds after the first (900 are required), and a
gap of 1,205 bps is past the 400 bps the agent treats as a fault. At 10:53:17 the position
was through the 5% stop-loss and the agent called `triggerStopLoss`, which the vault refused
with `NoRoomToSell`: the price was still far under the 5-minute TWAP, and nothing could be
sold inside the 1% slippage limit. The sale went through 5 minutes 12 seconds after the
fall, once the TWAP had followed.

The vault's net asset value went from 1,000 to 994.73 test USDT. That loss comes from the
fall we staged, not from the strategy.

The keeper has since followed the mainnet pool on its own. At 12:18:30 it moved the demo
pool from 0.080821 to 0.080799 (−2.6 bps) after the price on mainnet changed
([`0x5d587962…`](https://testnet-explorer.hskchain.net/tx/0x5d5879628bf4fac288b1c868f4997318945a8bd9eb9d2ec91d12a9b08ef0891b)).

### Claude on the testnet, 2026-11-25

That evening the agent was restarted with a Claude API key (`claude-opus-5-5`, effort
medium) and we staged a 2.4% dip, again with the keeper stopped. Times are KST.

| Time | Who | What | Transaction |
|---|---|---|---|
| 20:52:54 | market key, staged | Sold 63,638 test WHSK: price 0.080799 → 0.078860 (−2.40%), 254 bps under the exchanges | [`0x9f24f5ad…`](https://testnet-explorer.hskchain.net/tx/0x9f24f5adefc182e70d7be2eeda2720167c5f02fe20944d163481b80630b22256) |
| 20:53:10 | agent, through the vault | All 11 gate checks passed (net edge 186 bps). Claude cut the buy to 40%: 19.89 test USDT for 251.51 test WHSK | [`0x56b7a138…`](https://testnet-explorer.hskchain.net/tx/0x56b7a13876ac3c3082d9abd4d16539c2a9c0977e7d822509ad86f7077541a421) |
| 20:53:40 | market key, staged | Pool returned to the mainnet pool's price, 0.080793 | [`0xfc1d3da5…`](https://testnet-explorer.hskchain.net/tx/0xfc1d3da5190b0a37f37a7b3b71e34d3f8fb1eb85ec30eb8bb204ba812a6270a4) |
| 20:58:32 | agent, through the vault | Take-profit at +201 bps, approved by Claude. **Reverted, out of gas** (see below) | [`0xc94271fb…`](https://testnet-explorer.hskchain.net/tx/0xc94271fb991ac5095801859fbca8b20779a079e5dec5c3fd02b304fcccba8af3) |
| 21:04:44 | agent, through the vault | Take-profit at +214 bps, approved by Claude: 251.51 test WHSK sold for 20.26 test USDT, a gain of 0.36 | [`0x88ff25b7…`](https://testnet-explorer.hskchain.net/tx/0x88ff25b79e5f474e2ca3963f98c1f87fd87a37d2d72ceb51c5ea2ea80a0e114e) |

Claude's reason for the smaller buy, as stored in the decision record whose hash is in the
transaction:

> The gap is real and the exchanges are steady and slightly rising (+48 bps over the last
> hour, venues only 20 bps apart), so the 186 bps net edge is credible and the data is clean.
> But the same WHSK basis entry about 10 hours ago, with a 235 bps gap, hit the hard stop
> within six minutes for -5.27 USDT. The DEX has also just dropped about 209 bps below its
> 5-minute TWAP, which points to active selling in a thin pool that could push the gap wider
> before it closes. I am taking the trade at 40% size to keep exposure to a repeat of that
> loss small.

The first sale ran out of gas at exactly its estimated limit of 193,359. In the block it
landed in, the same call needed 221,303. The vault's TWAP lookup searches the pool's price
history, about 28,000 gas, unless the newest entry is older than the window, and that
changed 8 seconds after the sale's block. The estimate matches the later, cheaper case: on
this testnet a pending call sees a block time 12 seconds past the latest block. The
executor now sends 1.5 times the estimate plus 50,000 gas (`gasLimitFor` in
`agent/src/executor.ts`); gas that is not used is not charged. None of the fork runs had
hit this.

The chat was asked four things in Korean and answered each from the live state: a status
summary; a smaller buy size, which it applied (5% to 3%); a buy size of 50%, which it set
to the vault's 10% limit, explaining that more needs an on-chain policy change signed with
the owner's key; and a direct order to buy, which it declined, pointing to the pipeline.

A judgment took 3 to 10 seconds and 2,700 to 2,900 input tokens, about 0.02 USD. The 0.36
gained comes from the dip we staged, like the loss before it.

To set up a demo of your own:

```bash
npm run testnet:keys              # three testnet-only keys in .env.testnet; prints their addresses
#                                   then request test HSK for the market address at
#                                   https://faucet.hskchain.net/faucet (captcha; one request
#                                   a day brought 0.1 HSK, the setup needs about 0.015)
npm run testnet:setup             # demo market, vault, deposit of 1,000 test USDT
npm run testnet:verify            # publish the sources on Sourcify and the explorer
npm run agent:set-api-key         # optional: Claude judgment and chat. Asks for the key at a
#                                   hidden prompt and stores it in .env.testnet
npm run testnet:keeper            # terminal 1: keep the demo pool at the mainnet price
npm run agent:testnet             # terminal 2: the agent, dashboard on http://127.0.0.1:8788
npm run testnet:move -- dump 10   # stage a 10% fall (stop the keeper first, or it undoes it)
```

`testnet:setup` runs three steps that can also be run one by one and again after an
interruption: `testnet:market`, `testnet:deploy` (waits until the new pool is one TWAP
window old), `testnet:fund`. All of it cost 0.015 test HSK (15 million gas at 1 gwei).

The three keys (market, owner, agent) are made for the testnet and sit in `.env.testnet`,
which git ignores. The mainnet owner key is never used there. To rehearse without touching
the testnet, start `npm run testnet:fork` and use the `testnet:fork:*` commands and
`agent:testnet:fork`.

What the testnet run shows is that the vault and the agent work on-chain together. It says
nothing about profit: the only other trader in the demo pool is our own keeper.

## Deploy to HSK Chain mainnet

Not done yet. The submission runs on the testnet. Teams selected for the demo day must
deploy their contracts to mainnet, and winners must deploy to claim a prize, so if this
project is selected the vault goes to mainnet before the demo. Everything below is ready
for that step.

Mainnet costs real money. Deploying needs HSK for gas in the owner's wallet: about 2.3 HSK
at the current 500 gwei (4.5 million gas for the contract, 0.12 million to list WHSK),
measured on a fork of mainnet. Putting USDT in the vault is optional and is not a fee: it
stays the owner's and can be withdrawn at any time, but trading can lose part of it.

Settings live in `.env`, which the scripts read, so the commands are the same in
PowerShell and bash:

```bash
npm run agent:new-key                        # fresh trading key for the agent, stored in .env; prints its address only
npx hardhat keystore set HSK_DEPLOYER_KEY    # the owner's key, encrypted by Hardhat; asks for it and for a password
npm run deploy:check                         # addresses, balances, pools and cost. Sends nothing
npm run deploy:hsk                           # deploys, lists the assets, writes VAULT_ADDRESS to .env
npm run verify:hsk                           # publishes the source on Sourcify and the explorer
npm run deposit:hsk                          # optional; set AMOUNT_USDT in .env first
npm run agent                                # DRY_RUN=1 in .env keeps it from sending trades
```

In Windows PowerShell, write `npm.cmd` and `npx.cmd` if the shell refuses to run `npm`
or `npx` ("running scripts is disabled on this system").

`deploy:hsk` can be run again after an interruption. It finds the vault it already
deployed, also when the connection dropped right after the transaction went out, and
carries on from there instead of deploying a second one.

The agent's key can only swap inside the vault's limits. It needs a little HSK for gas
and nothing else: a buy costs about 0.16 HSK. See [.env.example](.env.example) for every
setting and the default policy.

## Tests

```bash
npm test               # contract unit tests against a mock DEX, and the testnet demo token
npm run test:fork      # contract against real HSKSwap pools, mainnet forks pinned to fixed blocks
npm run test:agent     # agent logic: signals, gate, sizing, settings, hashing
npm run test:backtest  # pool replay, vault copy, no look-ahead, accounting, the Claude arm's cap and replay
npm run typecheck
```

Measured on the fork at block 30,581,400: buying 100 USDT of WHSK returns 1,233.60 WHSK,
and a round trip returns 99.40 USDT (two 0.3% fees). In the fork runs a buy used 280,000
to 320,000 gas and a stop-loss sale about 223,000.

## Limitations

- No profit is promised. The backtest shows none, and a few days of small live trades
  would not prove anything either.
- Claude's judgment was backtested on one period only, because the model's training data
  overlaps the other one, and over 11 to 19 round trips per run. What it changed there
  was position size, not the choice of trades.
- The strategy is long-only and unhedged, so it carries the direction of HSK's price.
- If the pool's liquidity provider withdraws, a position cannot be sold until liquidity
  returns. It happened for six days in October 2026.
- The contract is unaudited hackathon code. Use small amounts.
- The vault is not on mainnet yet. What has run on-chain so far ran on the testnet and on
  forks of mainnet.
- The testnet demo trades test tokens in a pool that only our keeper and our agent trade in.
  The trades recorded there on 2026-11-25 followed price moves we staged.
  It was rehearsed on a local fork of the testnet and then deployed; there is no
  pinned-block Solidity test against the testnet the way there is for mainnet.
- Closing a large position by stop-loss takes several calls, about one TWAP window apart
  when nobody else trades, and the price can fall further meanwhile.
- The vault assumes 2-second blocks when it sizes a pool's price history, which is HSK
  Chain's block time. A much longer TWAP window needs many more observations (1,801 for
  one hour), which may be more than one transaction can pay for; enlarge the pool in
  steps first.
- The backtest covers WHSK only, decides every 5 minutes where the live agent decides
  every 30 seconds, and rebuilds the exchange reference from trades because no order
  books are available for the past.
- The WETH and WBTC pools are thin and trade rarely. Their TWAP is cheaper to move than
  the WHSK pool's, so the default target is WHSK only.
- The TWAP window must fit the pools' observation history (240 slots today). The vault
  rejects a window the pools cannot serve; the owner can always exit regardless.
- Rule and gate texts in the decision log are in English; the dashboard chrome is Korean
  and English.

## Roadmap

In order. Each step answers one of the limitations above.

1. **Mainnet.** Deploy `AgentVault` to HSK Chain mainnet and verify its source with the
   scripts in [Deploy to HSK Chain mainnet](#deploy-to-hsk-chain-mainnet). If the project
   is selected for the demo day, this is done before the demo.
2. **A record from the real market.** Run the agent from a small vault against the real
   WHSK/USDT pool, so that the decision log, the refusals and the trades come from the
   market itself instead of a demo pool that only our keeper moves.
3. **Strategy on evidence.** The trend rules lost after costs in both backtest periods, so
   they are reviewed before they trade real funds. Re-run the backtest as the pool's
   history grows, and repeat the Claude comparison on periods after the model's training
   data.
4. **An external audit** of `AgentVault` before anyone but its owner deposits.
5. **More assets, less direction.** List more assets as HSKSwap pools deepen, and limit the
   long-only exposure, for example with a hedge once HSK Chain offers one.
6. **The vault for other agents.** The limits live in the contract, not in our agent, so any
   agent that trades for someone else can run behind the same vault. Package it with its
   tests and deployment scripts for other builders.

## Layout

```
contracts/      AgentVault.sol, TWAP library, router interface, testnet/TestToken.sol
deployments/    what was deployed where (written by the deploy scripts)
test/           Solidity tests (unit with mocks, fork against HSKSwap)
agent/src/      market data, signals, gate, judgment, executor, engine, chat, server
agent/web/      dashboard
agent/test/     agent unit tests
backtest/       history fetcher, pool replay, vault copy, engine, experiments, tests
backtest/data/  the history itself (3.4 MB) with a hash of every file
backtest/results/  results of both periods and the freeze record
scripts/        deploy, deposit, fork helpers, testnet demo market and keeper
docs/           plan and backtest write-up (Korean), logo
```

## License

GPL-2.0-or-later, see [LICENSE](LICENSE). The TWAP maths builds on Uniswap V3 core libraries
under that licence.
