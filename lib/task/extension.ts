import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { clearTaskSessionBinding, type TaskSessionBinding } from "./binding";
import { getTaskStore } from "./store";

function activeBinding(binding: TaskSessionBinding): { runId: string; capability: string } {
  if (!binding.runId || !binding.capability) {
    throw new Error("No active Pi Task run is bound to this conversation");
  }
  getTaskStore().assertRunCapability(binding.runId, binding.capability);
  return { runId: binding.runId, capability: binding.capability };
}

function taskContext(binding: TaskSessionBinding): string {
  const detail = getTaskStore().getTaskDetail(binding.taskId);
  return [
    `Pi Task ID: ${detail.id}`,
    `Title: ${detail.title}`,
    `Goal: ${detail.goal}`,
    `Acceptance criteria: ${detail.acceptanceCriteria}`,
    `Expected output: ${detail.expectedOutput}`,
    `Project root: ${detail.project.rootPath}`,
    detail.recoveryNote ? `Latest return/recovery note: ${detail.recoveryNote}` : "",
  ].filter(Boolean).join("\n");
}

export function createTaskExtension(binding: TaskSessionBinding): InlineExtension {
  return {
    name: "pi-task",
    factory: (pi) => {
      pi.on("before_agent_start", (event) => {
        if (!binding.runId || !binding.capability) return;
        const context = taskContext(binding);
        return {
          systemPrompt: `${event.systemPrompt}\n\n## Active Pi Task\n${context}\n\n` +
            "Use read_task before implementation. Work only inside the project root. " +
            "If a business decision or missing input blocks progress, use request_task_input. " +
            "After implementation, verify the real artifact and call submit_task_review with changes, verification, unverified items, and risks. " +
            "Do not claim that the task is done: only the user can accept a submitted review.",
        };
      });

      pi.registerTool({
        name: "read_task",
        label: "读取 Pi Task",
        description: "Read the active Pi Task contract, latest return request, runs, artifacts, and review history.",
        parameters: Type.Object({}),
        async execute() {
          activeBinding(binding);
          const detail = getTaskStore().getTaskDetail(binding.taskId);
          const result = {
            id: detail.id,
            title: detail.title,
            goal: detail.goal,
            acceptanceCriteria: detail.acceptanceCriteria,
            expectedOutput: detail.expectedOutput,
            status: detail.status,
            version: detail.version,
            projectRoot: detail.project.rootPath,
            recoveryNote: detail.recoveryNote,
            previousReviews: detail.reviews.map((review) => ({
              status: review.status,
              summary: review.summary,
              rejectionReason: review.rejectionReason,
              risks: review.risks,
            })),
          };
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            details: { taskId: detail.id, status: detail.status },
          };
        },
      });

      pi.registerTool({
        name: "request_task_input",
        label: "请求人工决定",
        description: "Pause the active task and ask the user for a business decision or missing input.",
        parameters: Type.Object({
          question: Type.String({ description: "Specific question the user must answer" }),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
          const { runId, capability } = activeBinding(binding);
          getTaskStore().markRunWaitingUser(runId, capability, params.question);
          const answer = await ctx.ui.input(`Pi Task 需要你决定：${params.question}`, "请输入决定或补充信息");
          if (answer === undefined || !answer.trim()) {
            return {
              content: [{ type: "text", text: "The user did not answer. Stop this run and leave a clear explanation." }],
              details: { taskId: binding.taskId, waiting: true },
            };
          }
          getTaskStore().resumeRun(runId, answer);
          return {
            content: [{ type: "text", text: `User response: ${answer}` }],
            details: { taskId: binding.taskId, waiting: false },
          };
        },
      });

      pi.registerTool({
        name: "submit_task_review",
        label: "提交任务验收",
        description: "Submit verified Pi Task artifacts for human review. This does not mark the task done.",
        parameters: Type.Object({
          summary: Type.String({ description: "Concise result summary" }),
          changes: Type.String({ description: "Files or outputs changed and what changed" }),
          verification: Type.String({ description: "Checks performed and their actual results" }),
          unverified: Type.Optional(Type.String({ description: "Anything not verified" })),
          risks: Type.Optional(Type.String({ description: "Remaining risks, or 'None'" })),
          artifacts: Type.Array(Type.Object({
            path: Type.String({ description: "Absolute path or path relative to the project root" }),
            kind: Type.Optional(Type.String({ description: "Artifact type, such as markdown, spreadsheet, or code" })),
            verification: Type.String({ description: "Artifact-specific verification result" }),
          }), { minItems: 1, maxItems: 20 }),
        }),
        async execute(_toolCallId, params) {
          const { runId, capability } = activeBinding(binding);
          const detail = getTaskStore().submitReview(runId, capability, {
            summary: params.summary,
            changes: params.changes,
            verification: params.verification,
            unverified: params.unverified,
            risks: params.risks,
            artifacts: params.artifacts,
          });
          clearTaskSessionBinding(binding);
          return {
            content: [{
              type: "text",
              text: `Task ${detail.id} was submitted for human review with ${detail.artifacts.length} recorded artifact(s). Do not mark it done.`,
            }],
            details: { taskId: detail.id, status: detail.status, artifactCount: detail.artifacts.length },
          };
        },
      });

      pi.on("agent_settled", (_event, ctx) => {
        if (!binding.runId || !binding.capability) return;
        const runId = binding.runId;
        const run = getTaskStore().getRun(runId);
        if (run.status === "starting" || run.status === "running" || run.status === "waiting_user") {
          getTaskStore().failRun(
            runId,
            "Agent stopped without submitting a review; resume in the same conversation",
            true,
          );
          ctx.ui.notify("Agent 未提交验收，本轮已标记为中断", "warning");
        }
        clearTaskSessionBinding(binding);
      });
    },
  };
}
