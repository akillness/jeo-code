/**
 * GoalFlow Spec-First & Coding Workflow for jeo-code
 *
 * Models the full jeo-code lifecycle:
 *   - Spec-first mode: intake -> deep_interview (HITL / auto) -> ralplan -> approve_gate (HITL / auto) -> team -> ultragoal -> END
 *   - Coding mode:     intake -> coding_agent (Karpathy Core Loop + Middlewares + Jev Guard) -> END
 *
 * Pure TypeScript, zero native dependencies.
 */

import * as crypto from "node:crypto";
import {
  runAgentLoop,
  KARPATHY_DISCIPLINE,
  type AgentLoopOptions,
  type AgentLoopResult,
  type ToolHandler,
} from "../engine";
import type { Message } from "../loop";
import { readWorkflowState } from "../state";
import { runDeepInterviewEngine } from "../../commands/deep-interview";
import { runRalplanEngine } from "../../commands/ralplan";
import { approvePlan } from "../../commands/approve";
import { runTeamEngine } from "../../commands/team";
import { runUltragoalEngine } from "../../commands/ultragoal";
import {
  command,
  InterruptError,
  type NodeOutput,
  type ReviewRecord,
} from "./types";
import {
  START,
  END,
  AgentBaseNode,
  FunctionNode,
  type NodeContext,
} from "./node";
import {
  createDynamicContextMiddleware,
  createEntryGuardMiddleware,
  createJevRuntimeGuardMiddleware,
  createMetricsMiddleware,
  createTraceCallbackMiddleware,
  type AgentMiddleware,
  type TracePayload,
} from "./middleware";
import { StateGraph, type CompiledWorkflow } from "./graph";

export type JeoWorkflowMode = "spec-first" | "coding";

export interface StageOutcome {
  ok: boolean;
  reason?: string;
}

export interface JeoWorkflowState extends Record<string, unknown> {
  prompt: string;
  cwd: string;
  model?: string;
  workflow: JeoWorkflowMode;
  autoApprove: boolean;
  interviewAnswers: string[];
  seedPath?: string;
  planPath?: string;
  planApproved?: boolean;
  planFeedback?: string;
  stageResults: Record<string, StageOutcome>;
  finalOutput?: string;
  error?: string;
}

export function createInitialJeoWorkflowState(opts: {
  prompt: string;
  cwd?: string;
  model?: string;
  workflow?: JeoWorkflowMode;
  autoApprove?: boolean;
  interviewAnswers?: string[];
}): JeoWorkflowState {
  return {
    prompt: opts.prompt,
    cwd: opts.cwd ?? process.cwd(),
    model: opts.model,
    workflow: opts.workflow ?? "spec-first",
    autoApprove: opts.autoApprove ?? false,
    interviewAnswers: opts.interviewAnswers ?? [],
    stageResults: {},
  };
}

export interface JeoWorkflowRunners {
  deepInterview?: (opts: {
    cwd: string;
    prompt: string;
    auto: boolean;
    answers: string[];
    signal?: AbortSignal;
  }) => Promise<{
    ok: boolean;
    reason?: string;
    seedPath?: string;
    question?: string;
  }>;
  ralplan?: (opts: {
    cwd: string;
    feedback?: string;
    signal?: AbortSignal;
  }) => Promise<{
    ok: boolean;
    reason?: string;
    planPath?: string;
    summary?: string;
  }>;
  approve?: (opts: {
    cwd: string;
    planPath: string;
  }) => Promise<{
    ok: boolean;
    reason?: string;
  }>;
  team?: (opts: {
    cwd: string;
    signal?: AbortSignal;
  }) => Promise<{
    ok: boolean;
    reason?: string;
  }>;
  ultragoal?: (opts: {
    cwd: string;
    signal?: AbortSignal;
  }) => Promise<{
    ok: boolean;
    reason?: string;
    reportPath?: string;
  }>;
  codingLoop?: (history: Message[], opts: AgentLoopOptions) => Promise<AgentLoopResult>;
}

export interface CreateJeoWorkflowOptions {
  runners?: JeoWorkflowRunners;
  middlewares?: AgentMiddleware[];
  tools?: Record<string, ToolHandler>;
  qevUrl?: string;
  jevGuard?: boolean;
  contextWindow?: number;
  maxSteps?: number;
  onTrace?: (trace: TracePayload) => void;
}

function defaultRunners(): Required<Omit<JeoWorkflowRunners, "codingLoop">> & {
  codingLoop: (history: Message[], opts: AgentLoopOptions) => Promise<AgentLoopResult>;
} {
  return {
    async deepInterview({ cwd, prompt, auto, answers, signal }) {
      const combinedPrompt =
        answers.length > 0
          ? `${prompt}\n\n[Clarification Responses]\n${answers.map((a, i) => `${i + 1}. ${a}`).join("\n")}`
          : prompt;
      const lines: string[] = [];
      const res = await runDeepInterviewEngine({
        args: auto ? ["--auto", combinedPrompt] : [combinedPrompt],
        cwd,
        signal,
        io: { output: (line: string) => lines.push(line) },
      });
      const diState = await readWorkflowState("deep-interview", cwd);
      return {
        ok: res.ok,
        reason: res.reason ?? lines.join("\n"),
        seedPath: diState?.seed_path ?? ".jeo/seed.json",
      };
    },
    async ralplan({ cwd, feedback, signal }) {
      if (feedback?.trim()) {
        const diState = await readWorkflowState("deep-interview", cwd);
        if (diState?.seed_path) {
          const fs = await import("node:fs/promises");
          const path = await import("node:path");
          const seedFullPath = path.resolve(cwd, diState.seed_path);
          try {
            const existing = await fs.readFile(seedFullPath, "utf-8");
            const note = `\n# Reviewer Modification Feedback\n# ${feedback.trim().replace(/\r?\n/g, " ")}\n`;
            if (!existing.includes(feedback.trim())) {
              await fs.writeFile(seedFullPath, existing + note, "utf-8");
            }
          } catch {
            // Seed file is optional in synthetic test fixtures
          }
        }
      }
      const lines: string[] = [];
      const res = await runRalplanEngine({
        cwd,
        signal,
        io: { output: (line: string) => lines.push(line) },
      });
      const rpState = await readWorkflowState("ralplan", cwd);
      return {
        ok: res.ok,
        reason: res.reason ?? lines.join("\n"),
        planPath: rpState?.plan_path ?? "plan/current.json",
        summary: lines.slice(-10).join("\n"),
      };
    },
    async approve({ cwd, planPath }) {
      const res = await approvePlan(planPath, cwd);
      return {
        ok: res.ok,
        reason: res.message,
      };
    },
    async team({ cwd, signal }) {
      const lines: string[] = [];
      const res = await runTeamEngine({
        cwd,
        signal,
        io: { output: (line: string) => lines.push(line) },
      });
      return {
        ok: res.ok,
        reason: res.reason ?? lines.join("\n"),
      };
    },
    async ultragoal({ cwd, signal }) {
      const lines: string[] = [];
      const res = await runUltragoalEngine({
        cwd,
        signal,
        io: { output: (line: string) => lines.push(line) },
      });
      return {
        ok: res.ok,
        reason: res.reason ?? lines.join("\n"),
      };
    },
    codingLoop: runAgentLoop,
  };
}

class JeoCodingAgentNode extends AgentBaseNode<JeoWorkflowState, string> {
  buildPrompt(state: JeoWorkflowState): string {
    return state.prompt;
  }

  buildSystemPrompt(): string {
    return (
      `You are jeo-code executing a local GoalFlow coding run.\n\n` +
      `${KARPATHY_DISCIPLINE}`
    );
  }

  buildCommand(
    state: JeoWorkflowState,
    output: string,
    loopResult: AgentLoopResult,
  ): NodeOutput<JeoWorkflowState> {
    return command<JeoWorkflowState>({
      update: {
        finalOutput: output,
        stageResults: {
          ...state.stageResults,
          coding_agent: { ok: loopResult.done, reason: output },
        },
        ...(loopResult.done ? {} : { error: output }),
      },
      goto: END,
    });
  }
}

export function createJeoWorkflow(
  opts?: CreateJeoWorkflowOptions,
): CompiledWorkflow<JeoWorkflowState> {
  const base = defaultRunners();
  const runners = {
    deepInterview: opts?.runners?.deepInterview ?? base.deepInterview,
    ralplan: opts?.runners?.ralplan ?? base.ralplan,
    approve: opts?.runners?.approve ?? base.approve,
    team: opts?.runners?.team ?? base.team,
    ultragoal: opts?.runners?.ultragoal ?? base.ultragoal,
    codingLoop: opts?.runners?.codingLoop ?? base.codingLoop,
  };

  const defaultMiddlewares: AgentMiddleware[] = [
    createEntryGuardMiddleware(),
    ...(opts?.jevGuard !== false
      ? [
          createJevRuntimeGuardMiddleware({
            qevUrl: opts?.qevUrl,
            enabled: opts?.jevGuard ?? true,
          }),
        ]
      : []),
    ...(opts?.contextWindow
      ? [createDynamicContextMiddleware({ contextWindow: opts.contextWindow })]
      : []),
    createMetricsMiddleware(),
    ...(opts?.onTrace ? [createTraceCallbackMiddleware(opts.onTrace)] : []),
    ...(opts?.middlewares ?? []),
  ];

  const graph = new StateGraph<JeoWorkflowState>();

  // 1. Intake Node
  graph.addNode(
    new FunctionNode<JeoWorkflowState>({
      id: "intake",
      title: "Workflow Intake & Router",
      handler: (state) => {
        if (!state.prompt || !state.prompt.trim()) {
          return command<JeoWorkflowState>({
            update: {
              error: "Prompt cannot be empty",
              finalOutput: "[ERROR] Prompt cannot be empty",
            },
            goto: END,
          });
        }
        return {
          stageResults: {
            ...state.stageResults,
            intake: { ok: true, reason: `Routed to ${state.workflow}` },
          },
        };
      },
    }),
  );

  graph.addConditionalEdges(
    "intake",
    (state) => (state.workflow === "coding" ? "coding_agent" : "deep_interview"),
    {
      coding_agent: "coding_agent",
      deep_interview: "deep_interview",
    },
  );

  // 2. Deep Interview Node (Spec-first Stage 1, with HITL interrupt/resume)
  graph.addNode(
    new FunctionNode<JeoWorkflowState>({
      id: "deep_interview",
      title: "Socratic Deep Interview",
      handler: async (state, ctx: NodeContext<JeoWorkflowState>) => {
        const resumeReview = ctx.resumeValue as ReviewRecord | undefined;
        let answers = [...(state.interviewAnswers ?? [])];

        if (resumeReview) {
          if (resumeReview.decision === "reject") {
            return command<JeoWorkflowState>({
              update: {
                finalOutput: "Deep interview cancelled by user.",
                stageResults: {
                  ...state.stageResults,
                  deep_interview: { ok: false, reason: "Rejected by user" },
                },
              },
              goto: END,
            });
          }
          const userAnswer = resumeReview.input ?? resumeReview.feedback;
          if (userAnswer && userAnswer.trim()) {
            answers.push(userAnswer.trim());
          }
        } else if (!state.autoApprove && answers.length === 0) {
          throw new InterruptError({
            interruptId: `int-di-${crypto.randomUUID().slice(0, 8)}`,
            nodeId: "deep_interview",
            kind: "interview_question",
            prompt: `Clarify scope and constraints for: "${state.prompt}"`,
            data: {
              originalPrompt: state.prompt,
              cwd: state.cwd,
            },
            allowedDecisions: ["approve", "modify", "reject"],
          });
        }

        const res = await runners.deepInterview({
          cwd: state.cwd,
          prompt: state.prompt,
          auto: state.autoApprove || answers.length > 0,
          answers,
          signal: ctx.signal,
        });

        if (!res.ok) {
          return command<JeoWorkflowState>({
            update: {
              interviewAnswers: answers,
              error: res.reason ?? "Deep interview failed",
              finalOutput: res.reason ?? "Deep interview failed",
              stageResults: {
                ...state.stageResults,
                deep_interview: { ok: false, reason: res.reason },
              },
            },
            goto: END,
          });
        }

        ctx.emit("messages", {
          text: `[deep-interview] Seed frozen at ${res.seedPath ?? ".jeo/seed.json"}\n`,
        });

        return command<JeoWorkflowState>({
          update: {
            interviewAnswers: answers,
            seedPath: res.seedPath ?? ".jeo/seed.json",
            stageResults: {
              ...state.stageResults,
              deep_interview: { ok: true, reason: res.reason },
            },
          },
          goto: "ralplan",
        });
      },
    }),
  );

  // 3. Ralplan Node (Spec-first Stage 2: Planner / Architect / Critic)
  graph.addNode(
    new FunctionNode<JeoWorkflowState>({
      id: "ralplan",
      title: "Ralplan Consensus Blueprint",
      handler: async (state, ctx) => {
        const res = await runners.ralplan({
          cwd: state.cwd,
          feedback: state.planFeedback,
          signal: ctx.signal,
        });

        if (!res.ok) {
          return command<JeoWorkflowState>({
            update: {
              error: res.reason ?? "Ralplan failed",
              finalOutput: res.reason ?? "Ralplan failed",
              stageResults: {
                ...state.stageResults,
                ralplan: { ok: false, reason: res.reason },
              },
            },
            goto: END,
          });
        }

        const planPath = res.planPath ?? "plan/current.json";
        ctx.emit("messages", {
          text: `[ralplan] Consensus plan generated at ${planPath}\n`,
        });

        return command<JeoWorkflowState>({
          update: {
            planPath,
            stageResults: {
              ...state.stageResults,
              ralplan: { ok: true, reason: res.reason },
            },
          },
          goto: "approve_gate",
        });
      },
    }),
  );

  // 4. Approve Gate Node (Spec-first Stage 3: HITL Approval or autoApprove)
  graph.addNode(
    new FunctionNode<JeoWorkflowState>({
      id: "approve_gate",
      title: "Plan Approval Gate",
      handler: async (state, ctx) => {
        const planPath = state.planPath ?? "plan/current.json";
        const resumeReview = ctx.resumeValue as ReviewRecord | undefined;

        if (!state.autoApprove && !resumeReview) {
          throw new InterruptError({
            interruptId: `int-ap-${crypto.randomUUID().slice(0, 8)}`,
            nodeId: "approve_gate",
            kind: "plan_approval",
            prompt: `Approve execution plan at '${planPath}'?`,
            data: {
              planPath,
              seedPath: state.seedPath,
            },
            allowedDecisions: ["approve", "modify", "reject"],
          });
        }

        if (resumeReview) {
          if (resumeReview.decision === "reject") {
            return command<JeoWorkflowState>({
              update: {
                planApproved: false,
                finalOutput: `Plan '${planPath}' rejected by user.`,
                stageResults: {
                  ...state.stageResults,
                  approve_gate: { ok: false, reason: "Plan rejected by user" },
                },
              },
              goto: END,
            });
          }
          if (resumeReview.decision === "modify") {
            return command<JeoWorkflowState>({
              update: {
                planApproved: false,
                planFeedback:
                  resumeReview.feedback ??
                  resumeReview.input ??
                  "Revise plan per reviewer feedback",
                stageResults: {
                  ...state.stageResults,
                  approve_gate: {
                    ok: true,
                    reason: "Requested plan modification",
                  },
                },
              },
              goto: "ralplan",
            });
          }
        }

        const approval = await runners.approve({
          cwd: state.cwd,
          planPath,
        });

        if (!approval.ok) {
          return command<JeoWorkflowState>({
            update: {
              planApproved: false,
              error: approval.reason ?? "Plan approval gate failed",
              finalOutput: approval.reason ?? "Plan approval gate failed",
              stageResults: {
                ...state.stageResults,
                approve_gate: { ok: false, reason: approval.reason },
              },
            },
            goto: END,
          });
        }

        ctx.emit("messages", {
          text: `[approve] Plan '${planPath}' approved.\n`,
        });

        return command<JeoWorkflowState>({
          update: {
            planApproved: true,
            stageResults: {
              ...state.stageResults,
              approve_gate: { ok: true, reason: approval.reason },
            },
          },
          goto: "team",
        });
      },
    }),
  );

  // 5. Team Node (Spec-first Stage 4: Multi-agent Plan Execution)
  graph.addNode(
    new FunctionNode<JeoWorkflowState>({
      id: "team",
      title: "Team Multi-Agent Execution",
      handler: async (state, ctx) => {
        const res = await runners.team({
          cwd: state.cwd,
          signal: ctx.signal,
        });

        if (!res.ok) {
          return command<JeoWorkflowState>({
            update: {
              error: res.reason ?? "Team execution failed",
              finalOutput: res.reason ?? "Team execution failed",
              stageResults: {
                ...state.stageResults,
                team: { ok: false, reason: res.reason },
              },
            },
            goto: END,
          });
        }

        ctx.emit("messages", {
          text: `[team] Plan tasks executed.\n`,
        });

        return command<JeoWorkflowState>({
          update: {
            stageResults: {
              ...state.stageResults,
              team: { ok: true, reason: res.reason },
            },
          },
          goto: "ultragoal",
        });
      },
    }),
  );

  // 6. Ultragoal Node (Spec-first Stage 5: Durable Acceptance Criteria Verification)
  graph.addNode(
    new FunctionNode<JeoWorkflowState>({
      id: "ultragoal",
      title: "Ultragoal Acceptance Verification",
      handler: async (state, ctx) => {
        const res = await runners.ultragoal({
          cwd: state.cwd,
          signal: ctx.signal,
        });

        const summaryText =
          res.reason ??
          (res.ok
            ? "Spec-first workflow verified and completed."
            : "Ultragoal verification failed.");

        ctx.emit("messages", {
          text: `[ultragoal] ${summaryText}\n`,
        });

        return command<JeoWorkflowState>({
          update: {
            finalOutput: summaryText,
            ...(res.ok ? {} : { error: summaryText }),
            stageResults: {
              ...state.stageResults,
              ultragoal: { ok: res.ok, reason: summaryText },
            },
          },
          goto: END,
        });
      },
    }),
  );

  // 7. Direct Karpathy Coding Agent Node
  graph.addNode(
    new JeoCodingAgentNode({
      id: "coding_agent",
      title: "Karpathy Coding Core Loop",
      middlewares: defaultMiddlewares,
      loopRunner: runners.codingLoop,
      cwd: (s) => s.cwd,
      model: (s) => s.model,
      maxSteps: opts?.maxSteps,
      maxHistoryTokens: opts?.contextWindow
        ? Math.max(1024, Math.floor(opts.contextWindow * 0.7))
        : undefined,
      tools: opts?.tools,
    }),
  );

  graph.addEdge(START, "intake");

  return graph.compile({
    name: "jeo-goalflow",
    recursionLimit: 30,
    maxConcurrency: 6,
  });
}
