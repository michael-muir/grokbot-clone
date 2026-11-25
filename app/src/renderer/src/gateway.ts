// Renderer-side gateway calls: unwraps main's result objects into values, or throws a GatewayCallError.
import type { CallName, Calls } from "../../shared/ipc.ts";

export class GatewayCallError extends Error {
  /** The gateway's HTTP status, or 0 when the gateway wasn't reached. */
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function call<K extends CallName>(name: K, ...args: Calls[K]["args"]): Promise<Calls[K]["result"]> {
  const result = await window.desktop.call(name, ...args);
  if (!result.ok) throw new GatewayCallError(result.error.message, result.error.status);
  return result.value;
}
