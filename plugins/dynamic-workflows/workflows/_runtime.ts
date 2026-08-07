// Type-only shim for workflows bundled with this plugin. Mirrors the copy
// bootstrap.sh writes into a project, so bundled and user workflows are
// authored identically. Nothing here is imported at runtime.
export type {
  AgentRecord,
  AgentStatus,
  WorkflowAgentOptions,
  WorkflowContext,
  WorkflowMeta,
  WorkflowModule,
} from "../skills/authoring-workflows/runtime/public-types.js";
