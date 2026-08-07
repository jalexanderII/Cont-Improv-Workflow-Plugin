// Stands in for the copy bootstrap.sh writes into a project's
// .cursor/workflows/ directory, so the templates typecheck where they live.
// Type-only: nothing here is imported at runtime.
export type {
  AgentRecord,
  AgentStatus,
  WorkflowAgentOptions,
  WorkflowContext,
  WorkflowMeta,
  WorkflowModule,
} from "../runtime/public-types.js";
