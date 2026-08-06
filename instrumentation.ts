type PiTaskStartupGlobal = typeof globalThis & {
  __piTaskStartupReconciled?: boolean;
};

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { configureHttpDispatcher } = await import("@/lib/http-dispatcher");
  configureHttpDispatcher();

  const globals = globalThis as PiTaskStartupGlobal;
  if (globals.__piTaskStartupReconciled) return;
  globals.__piTaskStartupReconciled = true;
  const { getTaskStore } = await import("@/lib/task/store");
  const count = getTaskStore().reconcileActiveRuns();
  if (count > 0) {
    console.warn(`[pi-task] reconciled ${count} interrupted run(s) after startup`);
  }
}
