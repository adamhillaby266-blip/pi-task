export type TaskDecisionOptionSelection = {
  decisionId: string;
  question: string;
  option: string;
};

export type TaskDecisionOptionSendResult =
  | "sent"
  | "busy"
  | "draft_present"
  | "tools_disabled"
  | "invalid";

export function buildTaskDecisionOptionMessage(selection: TaskDecisionOptionSelection): string {
  return [
    `关于任务约定中的决定：“${selection.question.trim()}”`,
    `我的选择：“${selection.option.trim()}”`,
    "",
    "请据此更新当前任务约定并解决这项决定。这次点击只用于回答该决定，不直接开始执行，也不替代约定中的后续确认门。",
  ].join("\n");
}
