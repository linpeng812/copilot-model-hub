import { ConnectionProtocol } from '../config/types';
import { ProtocolAdapter } from '../adapters/types';

/**
 * Resolves a protocol to its adapter. Adapters register themselves here as
 * they are implemented (stages 3–5). Routing a protocol with no registered
 * adapter throws a clear, user-facing error rather than failing silently.
 */
export class AdapterRouter {
  private adapters = new Map<ConnectionProtocol, ProtocolAdapter>();

  register(adapter: ProtocolAdapter): void {
    this.adapters.set(adapter.protocol, adapter);
  }

  get(protocol: ConnectionProtocol): ProtocolAdapter {
    const adapter = this.adapters.get(protocol);
    if (!adapter) {
      throw new Error(`No adapter is registered for protocol "${protocol}".`);
    }
    return adapter;
  }

  has(protocol: ConnectionProtocol): boolean {
    return this.adapters.has(protocol);
  }
}
