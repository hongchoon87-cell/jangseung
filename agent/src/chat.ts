import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import * as z from "zod/v4";

import { config } from "./config.ts";
import type { Engine } from "./engine.ts";
import { loadJson, saveJson } from "./store.ts";
import type { Settings } from "./types.ts";
import { publicState } from "./view.ts";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  at: number;
}

export interface ChatResult {
  reply: string;
  /** Settings that changed as a result of this message. */
  applied: Array<{ label: string; from: string; to: string; note?: string }>;
  source: "llm" | "built-in";
}

const MAX_HISTORY = 24;
const history: ChatMessage[] = loadJson<ChatMessage[]>("chat.json", []).slice(-MAX_HISTORY);

export function chatHistory(): readonly ChatMessage[] {
  return history;
}

const ChatSchema = z.object({
  reply: z.string().describe("What to say to the owner, in the owner's language."),
  settings_change: z
    .object({
      paused: z.boolean().nullable(),
      risk_appetite: z.enum(["conservative", "balanced", "aggressive"]).nullable(),
      position_size_percent: z.number().nullable().describe("Size of one buy as a percentage of NAV."),
      max_trades_per_day: z.number().nullable(),
      min_minutes_between_trades: z.number().nullable(),
      target_assets: z.array(z.enum(["WHSK", "WETH", "WBTC"])).nullable(),
      strategies: z.array(z.enum(["basis", "trend"])).nullable(),
    })
    .nullable()
    .describe("Only when the owner asked for a change. Set the fields to change and leave the rest null."),
});

const SYSTEM_PROMPT = `You are the conversational interface of an automated trading agent. You talk with the owner of a smart-contract vault on HSK Chain whose funds the agent trades on HSKSwap. The owner uses this chat to see how things stand and to adjust how the agent behaves.

Each message from the owner arrives with a <state> block: a JSON snapshot of the vault, the market, the limits in force and the agent's recent decisions, taken a moment ago. It is your only source of facts. Quote figures from it with their units. If something the owner asks about is not in the snapshot, say so plainly instead of estimating.

What the owner can change through you, and how:
- Pausing or resuming the agent, the risk appetite (conservative, balanced, aggressive), the size of one buy as a percentage of NAV, how many buys a day, the minimum minutes between buys, which assets to trade, and which strategies run ("basis" trades the price gap between the DEX and the exchange; "trend" follows moving averages).
- When the owner asks for one of these, put the new values in settings_change and say in your reply what you are changing. Change only what was asked.
- These are preferences that sit inside the vault's on-chain policy (state.portfolio.policy). A preference can make the agent more careful than the policy but never less. If the owner asks for more than the policy allows, set the value to the policy's limit and explain that going further needs an on-chain policy change signed with the owner's own key, which this agent does not hold.

What you cannot do: place a trade on request, move funds, or change the on-chain policy. Trades come only from the agent's pipeline (rule, verification gate, judgment, vault). If the owner asks for a direct trade, say that and point to the nearest setting instead.

When explaining a decision, use the record in state.decisions: what the rule saw, what the gate measured, the judgment and its rationale, and what happened on-chain. A decision whose outcome is "rejected" was stopped by the gate, "vetoed" was stopped by the judgment step, and "dry-run" was simulated without sending a transaction.

Keep replies short and concrete, in plain sentences without Markdown tables or headings. Answer in the language the owner writes in. Mode "dry-run" means no transactions are being sent; mention it when it matters to the answer.`;

const LABELS: Record<keyof Settings, { ko: string; en: string }> = {
  paused: { ko: "일시정지", en: "Paused" },
  riskAppetite: { ko: "위험 성향", en: "Risk appetite" },
  positionSizeBps: { ko: "1회 매수 크기", en: "Buy size" },
  maxTradesPerDay: { ko: "하루 매수 횟수", en: "Buys per day" },
  minMinutesBetweenTrades: { ko: "매수 간 최소 간격(분)", en: "Minutes between buys" },
  targetAssets: { ko: "대상 자산", en: "Target assets" },
  strategies: { ko: "전략", en: "Strategies" },
};

function show(key: keyof Settings, value: Settings[keyof Settings]): string {
  if (key === "positionSizeBps") return `${(value as number) / 100}%`;
  if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : "-";
  return String(value);
}

/** Applies a change through the engine and reports exactly what ended up different. */
function applyChange(engine: Engine, patch: Partial<Settings>, korean: boolean): ChatResult["applied"] {
  const before = engine.state.settings;
  const { settings: after } = engine.updateSettings(patch);
  const applied: ChatResult["applied"] = [];

  for (const key of Object.keys(patch) as (keyof Settings)[]) {
    if (patch[key] === undefined) continue;
    const from = show(key, before[key]);
    const to = show(key, after[key]);
    const requested = show(key, patch[key] as Settings[keyof Settings]);
    const capped = requested !== to;
    if (from === to && !capped) continue;
    applied.push({
      label: LABELS[key][korean ? "ko" : "en"],
      from,
      to,
      note: capped
        ? korean
          ? `요청 ${requested}, 온체인 한도 안에서 ${to} 적용`
          : `asked for ${requested}; ${to} applied inside the on-chain limit`
        : undefined,
    });
  }
  return applied;
}

function builtInReply(engine: Engine, message: string, korean: boolean): ChatResult {
  const state = publicState(engine.state);
  let applied: ChatResult["applied"] = [];
  if (/(멈춰|멈추|중지|정지|일시정지|\bpause\b|\bstop\b)/i.test(message)) {
    applied = applyChange(engine, { paused: true }, korean);
  } else if (/(재개|다시 시작|계속해|\bresume\b|\bstart\b)/i.test(message)) {
    applied = applyChange(engine, { paused: false }, korean);
  }

  const p = state.portfolio;
  const held = p?.positions.filter((x) => x.balance !== "0") ?? [];
  const last = state.decisions[0];
  const lines = korean
    ? [
        p
          ? `순자산 ${p.navUsdt} USDT, 시작 이후 ${p.performancePct}%, 고점 대비 낙폭 ${(p.drawdownBps / 100).toFixed(2)}%. 오늘 매수 ${p.buysToday}/${p.effective.maxTradesPerDay}회.`
          : "아직 금고 상태를 읽지 못했습니다.",
        held.length > 0
          ? `보유: ${held.map((x) => `${x.asset} ${x.valueUsdt} USDT (${x.unrealizedBps} bps)`).join(", ")}.`
          : "보유 포지션이 없습니다.",
        last ? `최근 판단: ${last.asset} ${last.kind} → ${last.outcome}.` : "아직 판단 기록이 없습니다.",
        engine.state.settings.paused ? "에이전트는 일시정지 상태입니다." : "에이전트는 동작 중입니다.",
        "Claude API 키가 없어 정해진 요약만 답합니다. 키를 설정하면 자유롭게 묻고 설정을 바꿀 수 있습니다. 지금은 '멈춰'와 '재개'만 알아듣습니다.",
      ]
    : [
        p
          ? `NAV ${p.navUsdt} USDT, ${p.performancePct}% since start, drawdown ${(p.drawdownBps / 100).toFixed(2)}%. ${p.buysToday} of ${p.effective.maxTradesPerDay} buys used today.`
          : "The vault has not been read yet.",
        held.length > 0
          ? `Holding: ${held.map((x) => `${x.asset} ${x.valueUsdt} USDT (${x.unrealizedBps} bps)`).join(", ")}.`
          : "No open positions.",
        last ? `Latest decision: ${last.asset} ${last.kind} → ${last.outcome}.` : "No decisions recorded yet.",
        engine.state.settings.paused ? "The agent is paused." : "The agent is running.",
        "No Claude API key is configured, so this is a fixed summary. With a key you can ask anything and change settings in plain language. For now only 'pause' and 'resume' are understood.",
      ];
  return { reply: lines.join("\n"), applied, source: "built-in" };
}

let client: Anthropic | undefined;

function remember(role: ChatMessage["role"], content: string): void {
  history.push({ role, content, at: Date.now() });
  while (history.length > MAX_HISTORY) history.shift();
  saveJson("chat.json", history);
}

/**
 * Answers one message from the owner. A single model call receives the current state and
 * returns the reply plus, when asked, a settings change. The change is applied by code,
 * clamped to the on-chain policy, and what really changed is reported next to the reply.
 */
export async function chat(engine: Engine, message: string): Promise<ChatResult> {
  const korean = /[ㄱ-힝]/.test(message);
  // The API requires the conversation to open with a user turn; trimming can leave a reply first.
  const firstUser = history.findIndex((m) => m.role === "user");
  const earlier = (firstUser === -1 ? [] : history.slice(firstUser)).map((m) => ({ role: m.role, content: m.content }));
  remember("user", message);

  let result: ChatResult;
  if (!config.llm.enabled) {
    result = builtInReply(engine, message, korean);
  } else {
    try {
      client ??= new Anthropic();
      const response = await client.beta.messages.parse(
        {
          model: config.llm.model,
          max_tokens: 16000,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          thinking: { type: "adaptive" },
          output_config: { effort: "low", format: betaZodOutputFormat(ChatSchema) },
          system: SYSTEM_PROMPT,
          messages: [
            ...earlier,
            {
              role: "user",
              content: [
                { type: "text", text: `<state>\n${JSON.stringify(publicState(engine.state))}\n</state>` },
                { type: "text", text: message },
              ],
            },
          ],
        },
        { timeout: 60_000 },
      );

      const parsed = response.parsed_output;
      if (response.stop_reason === "refusal" || !parsed) {
        result = builtInReply(engine, message, korean);
      } else {
        const c = parsed.settings_change;
        const patch: Partial<Settings> = {};
        if (c) {
          if (c.paused !== null) patch.paused = c.paused;
          if (c.risk_appetite !== null) patch.riskAppetite = c.risk_appetite;
          if (c.position_size_percent !== null) patch.positionSizeBps = Math.round(c.position_size_percent * 100);
          if (c.max_trades_per_day !== null) patch.maxTradesPerDay = c.max_trades_per_day;
          if (c.min_minutes_between_trades !== null) patch.minMinutesBetweenTrades = c.min_minutes_between_trades;
          if (c.target_assets !== null) patch.targetAssets = c.target_assets;
          if (c.strategies !== null) patch.strategies = c.strategies;
        }
        const applied = Object.keys(patch).length > 0 ? applyChange(engine, patch, korean) : [];
        result = { reply: parsed.reply.trim(), applied, source: "llm" };
      }
    } catch (error) {
      const reason =
        error instanceof Anthropic.AuthenticationError
          ? korean
            ? "Claude API 인증에 실패했습니다. 키를 확인해 주세요."
            : "Claude API credentials were rejected. Check the key."
          : error instanceof Anthropic.RateLimitError
            ? korean
              ? "Claude API 요청 한도에 걸렸습니다. 잠시 뒤 다시 시도해 주세요."
              : "The Claude API rate limit was hit. Try again shortly."
            : korean
              ? `Claude API 호출에 실패했습니다 (${(error as Error).message.split("\n")[0]}).`
              : `The Claude API call failed (${(error as Error).message.split("\n")[0]}).`;
      const fallback = builtInReply(engine, message, korean);
      result = { ...fallback, reply: `${reason}\n\n${fallback.reply}` };
    }
  }

  remember("assistant", result.reply);
  return result;
}
