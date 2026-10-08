import { Injectable } from "@nestjs/common";
import type { DomainEvent } from "@ih/contracts";
import { PrismaOutboxWriter, type Tx } from "@ih/db";

/**
 * Publishes catalogue events inside the caller's unit of work (`withTransaction`), next to the
 * business mutation and its audit entry. Delivery happens after commit via the relay.
 */
@Injectable()
export class OutboxService {
  private readonly writer = new PrismaOutboxWriter();

  async publish(tx: Tx, event: DomainEvent): Promise<string> {
    return this.writer.publish(tx, event);
  }
}
