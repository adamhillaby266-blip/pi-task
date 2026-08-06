export interface TaskSessionBinding {
  taskId: string;
  runId: string | null;
  capability: string | null;
}

type BindingGlobal = typeof globalThis & {
  __piTaskSessionBindings?: Map<string, TaskSessionBinding>;
};

function bindings(): Map<string, TaskSessionBinding> {
  const globals = globalThis as BindingGlobal;
  globals.__piTaskSessionBindings ??= new Map<string, TaskSessionBinding>();
  return globals.__piTaskSessionBindings;
}

export function createTaskSessionBinding(taskId: string): TaskSessionBinding {
  return { taskId, runId: null, capability: null };
}

export function registerTaskSessionBinding(sessionId: string, binding: TaskSessionBinding): void {
  bindings().set(sessionId, binding);
}

export function getTaskSessionBinding(sessionId: string): TaskSessionBinding | undefined {
  return bindings().get(sessionId);
}

export function activateTaskSessionBinding(
  sessionId: string,
  taskId: string,
  runId: string,
  capability: string,
): TaskSessionBinding {
  const binding = getTaskSessionBinding(sessionId);
  if (!binding || binding.taskId !== taskId) {
    throw new Error("Pi Session is not prepared for this task");
  }
  binding.runId = runId;
  binding.capability = capability;
  return binding;
}

export function clearTaskSessionBinding(binding: TaskSessionBinding): void {
  binding.runId = null;
  binding.capability = null;
}
