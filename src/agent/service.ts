import { defaultStrategyDefinition } from "../rules/schema";

type RuleListItem = {
  version: number;
  name: string;
  active: boolean;
};

type RulesetDetail = {
  version: number;
  name: string;
  active: boolean;
  config: any;
} | null;

type BacktestRunResult = {
  runId: string;
  reused?: boolean;
};

type CreateStrategyAction = {
  type: "create_strategy";
  reason: string;
  name: string;
  activate: boolean;
  strategy: any;
  runBacktest: {
    enabled: boolean;
    tickers: string[];
    startDate: string | null;
    endDate: string | null;
  };
};

type UpdateStrategyAction = {
  type: "update_strategy";
  reason: string;
  version: number | null;
  name: string;
  activate: boolean | null;
  strategy: any;
  runBacktest: {
    enabled: boolean;
    tickers: string[];
    startDate: string | null;
    endDate: string | null;
  };
};

type ToggleStrategyAction = {
  type: "toggle_strategy";
  reason: string;
  version: number | null;
  active: boolean;
};

type AddWatchlistAction = {
  type: "add_watchlist";
  reason: string;
  symbols: string[];
};

type RemoveWatchlistAction = {
  type: "remove_watchlist";
  reason: string;
  symbols: string[];
};

type RunBacktestAction = {
  type: "run_backtest";
  reason: string;
  strategyVersion: number | null;
  tickers: string[];
  startDate: string | null;
  endDate: string | null;
};

type AgentAction =
  | CreateStrategyAction
  | UpdateStrategyAction
  | ToggleStrategyAction
  | AddWatchlistAction
  | RemoveWatchlistAction
  | RunBacktestAction;

type AgentPlan = {
  summary: string;
  assistantMessage: string;
  assumptions: string[];
  warnings: string[];
  actions: AgentAction[];
};

type AgentExecutionResult = {
  type: AgentAction["type"];
  status: "planned" | "success" | "error";
  message: string;
  version?: number;
  runId?: string;
  symbols?: string[];
};

export type AgentRunRequest = {
  message: string;
  dryRun?: boolean;
  mode?: "chat" | "strategy";
  history?: Array<{ role: "user" | "assistant"; text: string }>;
};

export type AiOperatorServiceDeps = {
  getRules: () => any;
  listRulesets: () => RuleListItem[];
  getRulesetByVersion: (version: number) => RulesetDetail;
  getWatchlist: () => string[];
  addSymbol: (symbol: string) => void | Promise<void>;
  removeSymbol: (symbol: string) => void | Promise<void>;
  saveRules: (name: string, config: any, changedBy?: string) => { version?: number } | number;
  updateRuleset: (version: number, name: string, config: any, changedBy?: string) => any;
  setRulesetActive: (version: number, active: boolean) => any;
  createBacktestRun: (cfg: any) => BacktestRunResult;
  listBacktestRuns?: (opts: { limit: number; strategyVersion?: number }) => any[];
};

function uniqueUpperSymbols(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return Array.from(
    new Set(
      input
        .map((value) => String(value || "").trim().toUpperCase())
        .filter((value) => /^[A-Z0-9.\-]{1,15}$/.test(value))
    )
  );
}

function safeString(value: unknown, fallback = ""): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text || fallback;
}

function safeNullableDate(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function safeNullableVersion(value: unknown): number | null {
  const version = Number(value);
  return Number.isFinite(version) && version > 0 ? Math.floor(version) : null;
}

function defaultDateWindow() {
  const end = new Date();
  const start = new Date(end.getTime());
  start.setDate(start.getDate() - 90);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

function normalizeBacktestShape(raw: any) {
  const fallback = defaultDateWindow();
  return {
    enabled: Boolean(raw?.enabled),
    tickers: uniqueUpperSymbols(raw?.tickers),
    startDate: safeNullableDate(raw?.startDate) ?? fallback.startDate,
    endDate: safeNullableDate(raw?.endDate) ?? fallback.endDate,
  };
}

function fallbackPlan(message: string): AgentPlan {
  return {
    summary: "No strategy actions were created.",
    assistantMessage: `I need a bit more context before I should build a strategy from "${message.slice(0, 120)}".`,
    assumptions: [],
    warnings: ["No actions were taken automatically."],
    actions: [],
  };
}

function normalizePlan(raw: any, message: string): AgentPlan {
  if (!raw || typeof raw !== "object") return fallbackPlan(message);

  const actionsRaw = Array.isArray(raw.actions) ? raw.actions : [];
  const actions: AgentAction[] = [];

  for (const item of actionsRaw) {
    const type = safeString(item?.type);

    if (type === "create_strategy") {
      actions.push({
        type,
        reason: safeString(item?.reason, "Create a new strategy."),
        name: safeString(item?.name, "AI Strategy"),
        activate: Boolean(item?.activate),
        strategy: item?.strategy ?? defaultStrategyDefinition("break_retest", safeString(item?.name, "AI Strategy")),
        runBacktest: normalizeBacktestShape(item?.runBacktest),
      });
      continue;
    }

    if (type === "update_strategy") {
      actions.push({
        type,
        reason: safeString(item?.reason, "Update an existing strategy."),
        version: safeNullableVersion(item?.version),
        name: safeString(item?.name, "Updated Strategy"),
        activate: typeof item?.activate === "boolean" ? item.activate : null,
        strategy: item?.strategy ?? defaultStrategyDefinition("break_retest", safeString(item?.name, "Updated Strategy")),
        runBacktest: normalizeBacktestShape(item?.runBacktest),
      });
      continue;
    }

    if (type === "toggle_strategy") {
      actions.push({
        type,
        reason: safeString(item?.reason, "Toggle a strategy."),
        version: safeNullableVersion(item?.version),
        active: Boolean(item?.active),
      });
      continue;
    }

    if (type === "add_watchlist") {
      actions.push({
        type,
        reason: safeString(item?.reason, "Add watchlist symbols."),
        symbols: uniqueUpperSymbols(item?.symbols),
      });
      continue;
    }

    if (type === "remove_watchlist") {
      actions.push({
        type,
        reason: safeString(item?.reason, "Remove watchlist symbols."),
        symbols: uniqueUpperSymbols(item?.symbols),
      });
      continue;
    }

    if (type === "run_backtest") {
      const normalized = normalizeBacktestShape(item);
      actions.push({
        type,
        reason: safeString(item?.reason, "Run a backtest."),
        strategyVersion: safeNullableVersion(item?.strategyVersion),
        tickers: normalized.tickers,
        startDate: normalized.startDate,
        endDate: normalized.endDate,
      });
    }
  }

  return {
    summary: safeString(raw.summary, "Prepared an AI operator plan."),
    assistantMessage: safeString(raw.assistantMessage, "Here is the plan I prepared."),
    assumptions: Array.isArray(raw.assumptions)
      ? raw.assumptions.map((item: unknown) => safeString(item)).filter(Boolean)
      : [],
    warnings: Array.isArray(raw.warnings)
      ? raw.warnings.map((item: unknown) => safeString(item)).filter(Boolean)
      : [],
    actions,
  };
}

function extractOutputText(payload: any): string {
  const outputs = Array.isArray(payload?.output) ? payload.output : [];
  const textParts: string[] = [];

  for (const item of outputs) {
    if (item?.type !== "message" || !Array.isArray(item?.content)) continue;
    for (const content of item.content) {
      if (content?.type === "output_text" && typeof content?.text === "string") {
        textParts.push(content.text);
      }
      if (content?.type === "refusal" && typeof content?.refusal === "string") {
        throw new Error(content.refusal);
      }
    }
  }

  if (!textParts.length) throw new Error("AI model returned no output text");
  return textParts.join("\n").trim();
}

export class AiOperatorService {
  constructor(private deps: AiOperatorServiceDeps) {}

  status() {
    const apiKey = process.env.AGENT_OPENAI_API_KEY || process.env.OPENAI_API_KEY || "";
    return {
      configured: Boolean(apiKey),
      model: process.env.AGENT_OPENAI_MODEL || "gpt-4o-mini",
      baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    };
  }

  private buildContext(message: string, history: Array<{ role: "user" | "assistant"; text: string }> = []) {
    const rulesets = (this.deps.listRulesets() || []).slice(0, 12).map((item) => {
      const detail = this.deps.getRulesetByVersion(Number(item.version));
      return {
        version: Number(item.version),
        name: String(item.name || `v${item.version}`),
        active: Boolean(item.active),
        timeframeMin: Number(detail?.config?.timeframeMin || 0),
        setupType: String(detail?.config?.setupType || ""),
        direction: String(detail?.config?.direction || ""),
      };
    });

    const activeRules = this.deps.getRules?.() || null;
    const watchlist = (this.deps.getWatchlist() || []).slice(0, 30);
    let recentRuns: any[] = [];
    try {
      recentRuns = this.deps.listBacktestRuns ? this.deps.listBacktestRuns({ limit: 6 }) : [];
    } catch {
      recentRuns = [];
    }

    return {
      today: new Date().toISOString().slice(0, 10),
      request: message,
      history: history.slice(-12),
      watchlist,
      activeRules: activeRules
        ? {
            version: Number(activeRules.version || 0),
            name: String(activeRules.name || ""),
            config: activeRules.config || null,
          }
        : null,
      rulesets,
      recentBacktests: (recentRuns || []).slice(0, 6),
      capabilities: [
        "create_strategy",
        "update_strategy",
        "toggle_strategy",
        "add_watchlist",
        "remove_watchlist",
        "run_backtest",
      ],
      constraints: [
        "Only operate on application state. Never suggest source-code edits.",
        "Use YYYY-MM-DD dates.",
        "Strategies must fit the app's existing schema.",
        "Prefer conservative defaults when the user goal is underspecified.",
      ],
    };
  }

  private async callResponsesApi(args: { systemPrompt: string; userPrompt: string; json?: boolean }) {
    const apiKey = process.env.AGENT_OPENAI_API_KEY || process.env.OPENAI_API_KEY || "";
    if (!apiKey) {
      throw new Error("Missing OPENAI_API_KEY or AGENT_OPENAI_API_KEY");
    }

    const baseUrl = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
    const model = process.env.AGENT_OPENAI_MODEL || "gpt-4o-mini";

    const response = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: [
          {
            role: "system",
            content: [{ type: "input_text", text: args.systemPrompt }],
          },
          {
            role: "user",
            content: [{ type: "input_text", text: args.userPrompt }],
          },
        ],
        ...(args.json
          ? {
              text: {
                format: {
                  type: "json_object",
                },
              },
            }
          : {}),
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`OpenAI request failed (${response.status}): ${detail.slice(0, 300)}`);
    }

    return response.json();
  }

  private async answerQuestion(message: string, history: Array<{ role: "user" | "assistant"; text: string }> = []) {
    const context = this.buildContext(message, history);
    const systemPrompt = [
      "You are a helpful trading friend inside a trading strategy platform.",
      "Default behavior is conversational and read-only.",
      "Answer questions about the market, existing strategies, watchlist, backtests, and what the platform can do.",
      "Use the platform context you are given, and be honest when the platform does not have enough information.",
      "Do not create, update, activate, or backtest anything in chat mode.",
      "Keep the tone supportive and practical.",
    ].join(" ");

    const payload = await this.callResponsesApi({
      systemPrompt,
      userPrompt: JSON.stringify(context),
      json: false,
    });
    const text = extractOutputText(payload);

    return {
      ok: true,
      mode: "chat" as const,
      dryRun: true,
      model: this.status().model,
      summary: "Trading friend reply",
      assistantMessage: text,
      assumptions: [],
      warnings: [],
      actions: [],
      results: [],
    };
  }

  private async decideChatAction(message: string, history: Array<{ role: "user" | "assistant"; text: string }> = []) {
    const context = this.buildContext(message, history);
    const systemPrompt = [
      "You are a helpful trading friend inside a trading strategy platform.",
      "Default behavior is conversational and read-only.",
      "However, if the user's latest message clearly asks you to make a change, run a backtest, edit a strategy, update the watchlist, or otherwise act inside the platform, you may return actions.",
      "Only return actions when the user is explicitly asking you to do something inside the platform.",
      "If the user is just asking a question or brainstorming, leave actions empty.",
      "Never activate a strategy automatically unless the user explicitly asks you to activate or enable it.",
      "Any strategy creation or adjustment should remain draft-first and should include a backtest before use.",
      "Return JSON only.",
      "Use this JSON shape exactly:",
      '{"summary":"string","assistantMessage":"string","assumptions":["string"],"warnings":["string"],"actions":[{"type":"create_strategy|update_strategy|toggle_strategy|add_watchlist|remove_watchlist|run_backtest","reason":"string","name":"string","version":1,"active":true,"activate":false,"symbols":["AAPL"],"strategy":{},"strategyVersion":1,"tickers":["AAPL"],"startDate":"2026-01-01","endDate":"2026-03-31","runBacktest":{"enabled":true,"tickers":["AAPL"],"startDate":"2026-01-01","endDate":"2026-03-31"}}]}',
      "When creating or updating strategies, produce a complete strategy object matching the app schema.",
      "If adjusting an existing strategy, prefer update_strategy over create_strategy unless the user asked for a separate version.",
    ].join(" ");

    const payload = await this.callResponsesApi({
      systemPrompt,
      userPrompt: JSON.stringify(context),
      json: true,
    });
    const rawText = extractOutputText(payload);

    try {
      return normalizePlan(JSON.parse(rawText), message);
    } catch {
      return {
        summary: "Trading friend reply",
        assistantMessage: rawText,
        assumptions: [],
        warnings: [],
        actions: [],
      } satisfies AgentPlan;
    }
  }

  private async plan(message: string, history: Array<{ role: "user" | "assistant"; text: string }> = []): Promise<AgentPlan> {
    const context = this.buildContext(message, history);

    const systemPrompt = [
      "You are the strategy builder inside a trading strategy app.",
      "Return JSON only.",
      "Only create actions when the user is clearly asking to build, modify, or test a strategy.",
      "If the request lacks enough detail to safely create a strategy, return zero actions and explain what is missing.",
      "Never activate a strategy automatically.",
      "Any strategy you create should be treated as a draft and should be backtested before use.",
      "Do not suggest editing source files, HTML, CSS, or JavaScript.",
      "Use this JSON shape exactly:",
      '{"summary":"string","assistantMessage":"string","assumptions":["string"],"warnings":["string"],"actions":[{"type":"create_strategy|update_strategy|toggle_strategy|add_watchlist|remove_watchlist|run_backtest","reason":"string","name":"string","version":1,"active":true,"activate":false,"symbols":["AAPL"],"strategy":{},"strategyVersion":1,"tickers":["AAPL"],"startDate":"2026-01-01","endDate":"2026-03-31","runBacktest":{"enabled":true,"tickers":["AAPL"],"startDate":"2026-01-01","endDate":"2026-03-31"}}]}',
      "For fields that do not apply, use null, false, empty arrays, or omit them.",
      "When creating strategies, produce a complete strategy object that matches the current app schema.",
      "When dates or tickers are not specified, choose sensible defaults based on the existing watchlist and the last 90 days.",
    ].join(" ");

    const payload = await this.callResponsesApi({
      systemPrompt,
      userPrompt: JSON.stringify(context),
      json: true,
    });
    const rawText = extractOutputText(payload);

    try {
      return normalizePlan(JSON.parse(rawText), message);
    } catch {
      return fallbackPlan(message);
    }
  }

  private async executePlan(args: {
    mode: "chat" | "strategy";
    dryRun: boolean;
    plan: AgentPlan;
  }) {
    const { mode, dryRun, plan } = args;
    const results: AgentExecutionResult[] = [];
    let latestCreatedVersion: number | null = null;

    for (const action of plan.actions) {
      if (action.type === "create_strategy") {
        if (dryRun) {
          results.push({
            type: action.type,
            status: "planned",
            message: `Would create strategy "${action.name}".`,
          });
          continue;
        }

        try {
          const saved = this.deps.saveRules(action.name, action.strategy, "ai-operator");
          const version = typeof saved === "number" ? saved : Number(saved?.version || 0);
          latestCreatedVersion = version > 0 ? version : null;

          results.push({
            type: action.type,
            status: "success",
            version,
            message: `Created strategy "${action.name}" as v${version}.`,
          });

          if (action.activate && version > 0) {
            this.deps.setRulesetActive(version, true);
            results.push({
              type: "toggle_strategy",
              status: "success",
              version,
              message: `Activated strategy v${version}.`,
            });
          }

          if (action.runBacktest.enabled && version > 0) {
            const tickers = action.runBacktest.tickers.length
              ? action.runBacktest.tickers
              : (this.deps.getWatchlist() || []).slice(0, 8);
            const run = this.deps.createBacktestRun({
              tickers,
              timeframe: "1m",
              startDate: action.runBacktest.startDate,
              endDate: action.runBacktest.endDate,
              strategyVersion: version,
              strategyName: action.name,
            });
            results.push({
              type: "run_backtest",
              status: "success",
              version,
              runId: run.runId,
              message: `Queued backtest ${run.runId} for strategy v${version}.`,
            });
          }
        } catch (error: any) {
          results.push({
            type: action.type,
            status: "error",
            message: error?.message || "Failed to create strategy.",
          });
        }

        continue;
      }

      if (action.type === "update_strategy") {
        const version = this.resolveStrategyVersion(action.version, latestCreatedVersion);
        if (!version) {
          results.push({
            type: action.type,
            status: "error",
            message: "No strategy version was available to update.",
          });
          continue;
        }

        if (dryRun) {
          results.push({
            type: action.type,
            status: "planned",
            version,
            message: `Would update strategy v${version} to "${action.name}".`,
          });
          continue;
        }

        try {
          this.deps.updateRuleset(version, action.name, action.strategy, "ai-operator");
          results.push({
            type: action.type,
            status: "success",
            version,
            message: `Updated strategy v${version}.`,
          });

          if (action.activate != null) {
            this.deps.setRulesetActive(version, action.activate);
            results.push({
              type: "toggle_strategy",
              status: "success",
              version,
              message: `${action.activate ? "Activated" : "Deactivated"} strategy v${version}.`,
            });
          }

          if (action.runBacktest.enabled) {
            const tickers = action.runBacktest.tickers.length
              ? action.runBacktest.tickers
              : (this.deps.getWatchlist() || []).slice(0, 8);
            const run = this.deps.createBacktestRun({
              tickers,
              timeframe: "1m",
              startDate: action.runBacktest.startDate,
              endDate: action.runBacktest.endDate,
              strategyVersion: version,
              strategyName: action.name,
            });
            results.push({
              type: "run_backtest",
              status: "success",
              version,
              runId: run.runId,
              message: `Queued backtest ${run.runId} for strategy v${version}.`,
            });
          }
        } catch (error: any) {
          results.push({
            type: action.type,
            status: "error",
            version,
            message: error?.message || "Failed to update strategy.",
          });
        }

        continue;
      }

      if (action.type === "toggle_strategy") {
        const version = this.resolveStrategyVersion(action.version, latestCreatedVersion);
        if (!version) {
          results.push({
            type: action.type,
            status: "error",
            message: "No strategy version was available to toggle.",
          });
          continue;
        }

        if (dryRun) {
          results.push({
            type: action.type,
            status: "planned",
            version,
            message: `Would ${action.active ? "activate" : "deactivate"} strategy v${version}.`,
          });
          continue;
        }

        try {
          this.deps.setRulesetActive(version, action.active);
          results.push({
            type: action.type,
            status: "success",
            version,
            message: `${action.active ? "Activated" : "Deactivated"} strategy v${version}.`,
          });
        } catch (error: any) {
          results.push({
            type: action.type,
            status: "error",
            version,
            message: error?.message || "Failed to toggle strategy.",
          });
        }

        continue;
      }

      if (action.type === "add_watchlist" || action.type === "remove_watchlist") {
        if (dryRun) {
          results.push({
            type: action.type,
            status: "planned",
            symbols: action.symbols,
            message: `Would ${action.type === "add_watchlist" ? "add" : "remove"} ${action.symbols.join(", ")} ${action.symbols.length === 1 ? "symbol" : "symbols"}.`,
          });
          continue;
        }

        try {
          for (const symbol of action.symbols) {
            if (action.type === "add_watchlist") await Promise.resolve(this.deps.addSymbol(symbol));
            else await Promise.resolve(this.deps.removeSymbol(symbol));
          }
          results.push({
            type: action.type,
            status: "success",
            symbols: action.symbols,
            message: `${action.type === "add_watchlist" ? "Added" : "Removed"} ${action.symbols.join(", ")} ${action.symbols.length === 1 ? "symbol" : "symbols"}.`,
          });
        } catch (error: any) {
          results.push({
            type: action.type,
            status: "error",
            symbols: action.symbols,
            message: error?.message || "Failed to update watchlist.",
          });
        }

        continue;
      }

      if (action.type === "run_backtest") {
        const version = this.resolveStrategyVersion(action.strategyVersion, latestCreatedVersion);
        if (!version) {
          results.push({
            type: action.type,
            status: "error",
            message: "No strategy version was available for backtesting.",
          });
          continue;
        }

        if (dryRun) {
          results.push({
            type: action.type,
            status: "planned",
            version,
            message: `Would queue a backtest for strategy v${version}.`,
          });
          continue;
        }

        try {
          const ruleset = this.deps.getRulesetByVersion(version);
          const tickers = action.tickers.length ? action.tickers : (this.deps.getWatchlist() || []).slice(0, 8);
          const run = this.deps.createBacktestRun({
            tickers,
            timeframe: "1m",
            startDate: action.startDate,
            endDate: action.endDate,
            strategyVersion: version,
            strategyName: ruleset?.name || `v${version}`,
          });
          results.push({
            type: action.type,
            status: "success",
            version,
            runId: run.runId,
            message: `Queued backtest ${run.runId} for strategy v${version}.`,
          });
        } catch (error: any) {
          results.push({
            type: action.type,
            status: "error",
            version,
            message: error?.message || "Failed to queue backtest.",
          });
        }
      }
    }

    return {
      ok: true,
      mode,
      dryRun,
      model: this.status().model,
      summary: plan.summary,
      assistantMessage: plan.assistantMessage,
      assumptions: plan.assumptions,
      warnings: plan.warnings,
      actions: plan.actions,
      results,
    };
  }

  private resolveStrategyVersion(version: number | null, latestCreatedVersion: number | null): number | null {
    if (version && this.deps.getRulesetByVersion(version)) return version;
    if (latestCreatedVersion && this.deps.getRulesetByVersion(latestCreatedVersion)) return latestCreatedVersion;

    const active = (this.deps.listRulesets() || []).find((item) => item.active);
    return active ? Number(active.version) : null;
  }

  async run(request: AgentRunRequest) {
    const message = safeString(request.message);
    if (!message) throw new Error("message required");

    const mode = request.mode === "strategy" ? "strategy" : "chat";
    const dryRun = Boolean(request.dryRun);
    const history: Array<{ role: "user" | "assistant"; text: string }> = Array.isArray(request.history)
      ? request.history
          .map((item): { role: "user" | "assistant"; text: string } => ({
            role: item?.role === "assistant" ? "assistant" : "user",
            text: safeString(item?.text),
          }))
          .filter((item) => item.text)
      : [];
    if (mode === "chat") {
      const decision = await this.decideChatAction(message, history);
      const hasActions = Array.isArray(decision.actions) && decision.actions.length > 0;
      return hasActions
        ? this.executePlan({ mode, dryRun: false, plan: decision })
        : this.answerQuestion(message, history);
    }

    const plan = await this.plan(message, history);
    for (const action of plan.actions) {
      if (action.type === "create_strategy" || action.type === "update_strategy") {
        action.activate = false;
        if (!action.runBacktest.enabled) {
          action.runBacktest.enabled = true;
        }
      }
    }
    return this.executePlan({ mode, dryRun, plan });
  }
}
