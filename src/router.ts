/**
 * router.ts — automatic dynamic model routing for omp / Pi Agent.
 *
 * Classifies each user turn's INTENT in `before_agent_start` and switches the
 * active model + reasoning tier accordingly — no "use model X" needed from
 * the user. Routes purely through configured model ROLES (`@plan`, `@slow`,
 * `@default`, `@tiny`), so it adapts to whatever models you've assigned to
 * those roles in your own `models.yml` / `config.yml` — nothing here is tied
 * to a specific model family or vendor.
 *
 *   plan (interactive)  -> @plan    max thinking   + blueprint directive
 *   plan (headless)     -> @slow    high thinking  + rigor directive   (top-tier planning
 *                                                                        models can refuse
 *                                                                        or behave oddly when
 *                                                                        run non-interactively;
 *                                                                        this avoids that path)
 *   heavy                -> @slow    high thinking
 *   default               -> @default inherited thinking (defers to your own default policy)
 *   trivial                -> @tiny    low thinking
 *
 * If the plan-tier model errors out mid-run, the router falls back to the
 * `@slow` role (or a configured alternative) for the rest of the session.
 *
 * Tunable without editing code via `~/.omp/agent/router.config.json`
 * (deep-merged over the defaults below).
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";

export type Tier = "plan" | "heavy" | "default" | "trivial";

export interface TierRoute {
	/** Model spec: a role alias (e.g. `@plan`) or an explicit `provider/id`. */
	model: string;
	thinking: ThinkingLevel;
}

export interface RouterConfig {
	enabled: boolean;
	tiers: {
		planInteractive: TierRoute;
		planHeadless: TierRoute;
		heavy: TierRoute;
		default: TierRoute;
		trivial: TierRoute;
	};
	/** Where interactive plan-tier falls back if the plan model errors mid-run. */
	planFallback: TierRoute;
}

export interface Decision {
	tier: Tier;
	reason: string;
}

const DEFAULT_CONFIG: RouterConfig = {
	enabled: true,
	tiers: {
		planInteractive: { model: "@plan", thinking: "max" },
		planHeadless: { model: "@slow", thinking: "high" },
		heavy: { model: "@slow", thinking: "high" },
		default: { model: "@default", thinking: "inherit" },
		trivial: { model: "@tiny", thinking: "low" },
	},
	planFallback: { model: "@slow", thinking: "high" },
};

const BLUEPRINT_DIRECTIVE =
	"[router: PLAN mode] Produce an architect-grade blueprint before implementing: restate the real objective, list ordered steps with the files each touches, call out risks and load-bearing assumptions, and give a binary/observable success criterion per step. Do not start editing until the plan is laid out.";
const RIGOR_DIRECTIVE =
	"[router: PLAN mode, headless] Apply architect-grade rigor on this tier: frame the real objective, verify every load-bearing assumption against live state (not memory), decompose into steps each with its own verification, adversarially challenge your own key conclusions, and close with binary/observable success criteria.";

function loadConfig(): RouterConfig {
	const path = join(homedir(), ".omp", "agent", "router.config.json");
	if (!existsSync(path)) return DEFAULT_CONFIG;
	try {
		const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (raw === null || typeof raw !== "object") return DEFAULT_CONFIG;
		const over = raw as Partial<RouterConfig>;
		return {
			enabled: typeof over.enabled === "boolean" ? over.enabled : DEFAULT_CONFIG.enabled,
			tiers: { ...DEFAULT_CONFIG.tiers, ...(over.tiers ?? {}) },
			planFallback: over.planFallback ?? DEFAULT_CONFIG.planFallback,
		};
	} catch {
		return DEFAULT_CONFIG;
	}
}

const PLAN_RE =
	/\b(plan|planning|architect|architecture|blueprint|roadmap|strateg(?:y|ize|ise)|design (?:a|an|the|our|this|some))\b|\bhow (?:should|do|would|can|might|could) (?:we|i|you)\b|\bfigure out how\b|\bthink through\b|\bcome up with\b|\blay out\b|\bscope (?:out|this)\b|\bwhat.?s the (?:best )?(?:approach|plan|strategy|design)\b/i;
const HEAVY_RE =
	/\b(?:refactor|re-?architect|migrat(?:e|ion)|overhaul|rewrite|redesign|consolidat(?:e|ion))\b|\bacross the (?:codebase|repo|repository|project|code ?base)\b|\b(?:every|all)(?: the)? (?:files?|modules?|callers?|call ?sites?|endpoints?|components?)\b/i;
const RISK_RE =
	/\b(?:security|auth(?:entication|orization)?|credential|secret|token|password|payment|billing|invoice|financ(?:e|ial)|database|schema|infra(?:structure)?|deploy(?:ment)?|production)\b/i;
const TRIVIAL_RE =
	/\b(?:typo|rename|reword|reformat|format|prettier|lint|whitespace|indent|docstring)\b|^\s*(?:what|where|which|who|explain|describe|show|list|find|read|open|print|cat|echo)\b/i;
const FILE_RE = /[\w./-]+\.(?:ts|tsx|js|jsx|py|go|rs|md|json|ya?ml|sh|c|cc|cpp|h|hpp|java|rb|php|css|html?)\b/gi;

function classify(prompt: string): Decision {
	const text = prompt
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`[^`]*`/g, " ")
		.trim();
	const words = text.split(/\s+/).filter(Boolean).length;
	const fileMentions = (text.match(FILE_RE) ?? []).length;

	if (PLAN_RE.test(text)) return { tier: "plan", reason: "planning/architecture language" };
	if (HEAVY_RE.test(text)) return { tier: "heavy", reason: "multi-file / refactor / migration scope" };
	if (RISK_RE.test(text)) return { tier: "heavy", reason: "security / infra / money sensitivity" };
	if (fileMentions >= 3) return { tier: "heavy", reason: `${fileMentions} files referenced` };
	if (TRIVIAL_RE.test(text) && words <= 14) return { tier: "trivial", reason: "short utility/lookup ask" };
	return { tier: "default", reason: "general implementation (workhorse)" };
}

export default function router(pi: ExtensionAPI): void {
	const config = loadConfig();

	// Session-scoped state.
	let routingOn = config.enabled;
	let forcedTier: Tier | undefined;
	let planTierFailed = false;
	let lastDecision = "none yet";

	function setStatus(ctx: ExtensionContext, text: string): void {
		try {
			ctx.ui.setStatus("route", `⟐ ${text}`);
		} catch {}
	}

	function resolveRoute(tier: Tier, hasUI: boolean): { route: TierRoute; label: string } {
		switch (tier) {
			case "plan":
				if (!hasUI) return { route: config.tiers.planHeadless, label: "plan(headless)" };
				if (planTierFailed) return { route: config.planFallback, label: "plan(fallback)" };
				return { route: config.tiers.planInteractive, label: "plan" };
			case "heavy":
				return { route: config.tiers.heavy, label: "heavy" };
			case "trivial":
				return { route: config.tiers.trivial, label: "trivial" };
			default:
				return { route: config.tiers.default, label: "default" };
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		routingOn = config.enabled;
		forcedTier = undefined;
		planTierFailed = false;
		setStatus(ctx, routingOn ? "auto (idle)" : "off");
	});

	pi.on(
		"before_agent_start",
		async (event: BeforeAgentStartEvent, ctx): Promise<BeforeAgentStartEventResult | void> => {
			if (!routingOn) {
				setStatus(ctx, "off (manual)");
				return;
			}
			const prompt = String(event.prompt ?? "");
			if (!prompt.trim() || prompt.trimStart().startsWith("/")) return;

			const decision: Decision = forcedTier
				? { tier: forcedTier, reason: "forced via /route" }
				: classify(prompt);
			const { route, label } = resolveRoute(decision.tier, ctx.hasUI);

			const model = ctx.models.resolve(route.model);
			if (!model) {
				lastDecision = `${label}: could not resolve "${route.model}" — is that role configured?`;
				setStatus(ctx, lastDecision);
				pi.logger.warn(`[router] unresolved model spec: ${route.model}`);
				return;
			}

			const ok = await pi.setModel(model);
			if (ok) {
				try {
					pi.setThinkingLevel(route.thinking);
				} catch (err) {
					pi.logger.warn(`[router] setThinkingLevel(${route.thinking}) failed: ${String(err)}`);
				}
			}
			const modelLabel = `${model.provider}/${model.id}`;
			lastDecision = `${label} → ${modelLabel} · ${route.thinking} · ${decision.reason}${ok ? "" : " (setModel FAILED)"}`;
			setStatus(ctx, `${label} → ${modelLabel} ${route.thinking}`);
			pi.logger.info(`[router] ${lastDecision}`);

			if (decision.tier === "plan") {
				const directive = ctx.hasUI ? BLUEPRINT_DIRECTIVE : RIGOR_DIRECTIVE;
				return { systemPrompt: [...ctx.getSystemPrompt(), directive] };
			}
		},
	);

	// If the plan-tier model errors mid-run, fall back for the rest of the session.
	pi.on("auto_retry_start", async (_event, ctx) => {
		const current = ctx.models.current();
		const planModel = ctx.models.resolve(config.tiers.planInteractive.model);
		const isOnPlanModel = current && planModel && current.provider === planModel.provider && current.id === planModel.id;
		if (!isOnPlanModel || planTierFailed) return;
		planTierFailed = true;
		const fallback = ctx.models.resolve(config.planFallback.model);
		if (fallback) {
			await pi.setModel(fallback);
			try {
				pi.setThinkingLevel(config.planFallback.thinking);
			} catch {}
			setStatus(ctx, "plan(fallback) — plan-tier model failed");
			pi.logger.warn("[router] plan-tier model failed mid-run — falling back for this session.");
			try {
				ctx.ui.notify("Plan-tier model failed — routing planning to the fallback role for this session.", "warn");
			} catch {}
		}
	});

	pi.registerCommand("route", {
		description: "Control automatic model routing: on|off|auto|plan|heavy|default|trivial|why|status",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const cmd = args.trim().toLowerCase();
			const notify = (m: string): void => {
				try {
					ctx.ui.notify(m, "info");
				} catch {}
			};
			switch (cmd) {
				case "off":
					routingOn = false;
					setStatus(ctx, "off (manual)");
					notify("Auto-routing OFF. Model stays as-is until `/route on`.");
					return;
				case "on":
				case "auto":
					routingOn = true;
					forcedTier = undefined;
					setStatus(ctx, "auto (idle)");
					notify("Auto-routing ON (intent-classified per turn).");
					return;
				case "plan":
				case "heavy":
				case "default":
				case "trivial":
					routingOn = true;
					forcedTier = cmd;
					notify(`Routing PINNED to "${cmd}" tier until \`/route auto\`.`);
					return;
				case "why":
					notify(`Last routing decision: ${lastDecision}`);
					return;
				default:
					notify(
						`Routing: ${routingOn ? (forcedTier ? `pinned=${forcedTier}` : "auto") : "off"}${planTierFailed ? " · plan-fallback-active" : ""}. Last: ${lastDecision}`,
					);
					return;
			}
		},
	});
}
