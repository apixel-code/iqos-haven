import type { DomainEvent } from "@ih/contracts";

/**
 * Port implemented by the persistence layer. `tx` is the caller's open unit of work: the event
 * and its required effects commit or roll back together with the business mutation.
 * Returns the stable event ID.
 */
export interface EventWriter<TTx> {
  publish(tx: TTx, event: DomainEvent): Promise<string>;
}
