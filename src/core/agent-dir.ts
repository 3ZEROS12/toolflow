import * as os from "node:os";
import * as path from "node:path";

/**
 * Single resolver for the Pi agent directory.
 *
 * `taxonomy` honored `PI_CODING_AGENT_DIR`/`PI_CONFIG_DIR`/`PI_AGENT_DIR` while
 * `PromptsManager` honored only `PI_AGENT_DIR`, so a user overriding the newer variables got
 * prompts and taxonomy written into two different `~/.pi` trees (and test isolation via those
 * variables could not protect prompt writes).
 */
export function getPiAgentDir(): string {
  return (
    process.env.PI_CODING_AGENT_DIR ||
    process.env.PI_CONFIG_DIR ||
    process.env.PI_AGENT_DIR ||
    path.join(os.homedir(), ".pi", "agent")
  );
}

/** True when an environment override points the agent dir somewhere explicit. */
export function hasExplicitAgentDir(): boolean {
  return Boolean(
    process.env.PI_CODING_AGENT_DIR || process.env.PI_CONFIG_DIR || process.env.PI_AGENT_DIR
  );
}
