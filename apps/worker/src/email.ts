import {
  PermanentEffectError,
  type EmailAdapter,
  type EmailMessage,
  type EmailSendResult,
} from "@ih/application";
import type { WorkerEnv } from "@ih/config";
import type { Logger } from "@ih/logger";
import nodemailer, { type Transporter } from "nodemailer";

/**
 * SMTP adapter (Mailpit locally; the approved provider once BI-07 is decided). SMTP has no
 * idempotency key, so delivery is at least once: the delivery key is sent as Message-ID and
 * X-IH-Delivery-Key so duplicates can be recognised and reconciled (docs/email-delivery.md).
 */
export class SmtpEmailAdapter implements EmailAdapter {
  private readonly transporter: Transporter;
  private readonly messageIdDomain: string;

  constructor(options: {
    host: string;
    port: number;
    secure: boolean;
    from: string;
    user?: string | undefined;
    password?: string | undefined;
  }) {
    const local = ["localhost", "127.0.0.1", "::1", "mailpit"].includes(options.host.toLowerCase());
    this.transporter = nodemailer.createTransport({
      host: options.host,
      port: options.port,
      secure: options.secure,
      // Without implicit TLS, insist on STARTTLS for any real relay so credentials and
      // content never travel in cleartext; only a local sink may be plain SMTP.
      requireTLS: !options.secure && (!local || Boolean(options.user)),
      ...(options.user && options.password
        ? { auth: { user: options.user, pass: options.password } }
        : {}),
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
    });
    this.messageIdDomain = (options.from.split("@")[1] ?? "localhost").slice(0, 100);
  }

  async send(message: EmailMessage, signal: AbortSignal): Promise<EmailSendResult> {
    if (signal.aborted) throw new Error("Email send aborted");
    const messageId = `<${message.deliveryKey}@${this.messageIdDomain}>`;
    try {
      const info = await this.transporter.sendMail({
        from: message.from,
        bcc: [...message.bcc],
        subject: message.subject,
        text: message.text,
        html: message.html,
        messageId,
        headers: { "X-IH-Delivery-Key": message.deliveryKey },
      });
      return {
        // Our own Message-ID always contains the full delivery key (bounded length).
        receipt: "smtp:" + messageId,
        accepted: info.accepted?.length ?? 0,
        rejected: info.rejected?.length ?? 0,
      };
    } catch (error) {
      // 5xx = the server refused definitively; anything else (4xx, network) is retried.
      // 530/535 are our own authentication/configuration problem: retry until it is fixed.
      const code = (error as { responseCode?: unknown }).responseCode;
      if (typeof code === "number" && code >= 500 && code < 600 && code !== 530 && code !== 535)
        throw new PermanentEffectError("SMTP_REJECTED");
      throw error;
    }
  }

  close(): void {
    this.transporter.close();
  }
}

/** Resend's batch endpoint accepts at most this many emails per request. */
const RESEND_BATCH_LIMIT = 100;

/** Retryable provider failure; only a status-derived code is ever stored or logged. */
export class EmailProviderTransientError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/**
 * Resend HTTP adapter (ADR 0004). One email per recipient (no Bcc) through the batch endpoint,
 * with our delivery key as the Idempotency-Key: Resend answers a retry with the same payload
 * from its 24-hour idempotency store instead of sending again.
 */
export class ResendEmailAdapter implements EmailAdapter {
  constructor(private readonly options: { apiKey: string; apiUrl: string; timeoutMs?: number }) {}

  async send(message: EmailMessage, signal: AbortSignal): Promise<EmailSendResult> {
    // Sorted so a retry produces a byte-identical request (and identical chunks) even if the
    // planner returns the same recipients in another order; otherwise Resend answers 409.
    const recipients = [...message.bcc].sort();
    const ids: string[] = [];
    for (let start = 0; start < recipients.length; start += RESEND_BATCH_LIMIT) {
      const chunk = recipients.slice(start, start + RESEND_BATCH_LIMIT);
      // Keys stay stable per chunk because the recipient set (and so its order) is stable.
      const key =
        recipients.length > RESEND_BATCH_LIMIT
          ? `${message.deliveryKey}-${start / RESEND_BATCH_LIMIT}`
          : message.deliveryKey;
      const response = await fetch(`${this.options.apiUrl.replace(/\/$/, "")}/emails/batch`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": key,
        },
        body: JSON.stringify(
          chunk.map((to) => ({
            from: message.from,
            to: [to],
            subject: message.subject,
            text: message.text,
            html: message.html,
            headers: { "X-IH-Delivery-Key": message.deliveryKey },
          })),
        ),
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.options.timeoutMs ?? 15_000)]),
      });
      if (!response.ok) throw await resendError(response);
      const body = (await response.json()) as { data?: Array<{ id?: unknown }> };
      const chunkIds = (body.data ?? [])
        .map((item) => item.id)
        .filter((id) => typeof id === "string");
      // An incomplete success body is ambiguous, not a rejection: retry under the same key.
      if (chunkIds.length !== chunk.length)
        throw new EmailProviderTransientError("RESEND_BAD_BODY");
      ids.push(...(chunkIds as string[]));
    }
    const first = (ids[0] ?? "none").slice(0, 100);
    return {
      receipt: `resend:${first}${ids.length > 1 ? `+${ids.length - 1}` : ""}`,
      accepted: ids.length,
      rejected: Math.max(0, recipients.length - ids.length),
    };
  }
}

/**
 * Maps a Resend error to permanent or retryable. The response message is never kept: it may
 * echo recipient addresses. Auth/permission/quota/unverified-domain (401/403) are configuration
 * faults, so they retry until fixed (or go dead after the budget and are replayed).
 */
async function resendError(response: Response): Promise<Error> {
  let name = "";
  try {
    const body = (await response.json()) as { name?: unknown };
    if (typeof body.name === "string") name = body.name;
  } catch {
    // Non-JSON error body: classify by status alone.
  }
  const status = response.status;
  if (status === 409 && name === "invalid_idempotent_request")
    return new PermanentEffectError("IDEMPOTENCY_CONFLICT");
  if ([400, 404, 405, 422].includes(status)) return new PermanentEffectError(`RESEND_${status}`);
  return new EmailProviderTransientError(`RESEND_${status}`);
}

/** EMAIL_SEND_ENABLED=false: nothing leaves the process; the effect completes with a marker. */
export class DisabledEmailAdapter implements EmailAdapter {
  async send(message: EmailMessage): Promise<EmailSendResult> {
    return { receipt: "disabled:" + message.deliveryKey, accepted: 0, rejected: 0 };
  }
}

/** Non-production safety net: only allowlisted addresses or @domains ever receive mail. */
export class AllowlistEmailAdapter implements EmailAdapter {
  constructor(
    private readonly inner: EmailAdapter,
    private readonly allowlist: readonly string[],
  ) {}

  private allowed(address: string): boolean {
    const lower = address.toLowerCase();
    return this.allowlist.some((entry) =>
      entry.startsWith("@") ? lower.endsWith(entry) : lower === entry,
    );
  }

  async send(message: EmailMessage, signal: AbortSignal): Promise<EmailSendResult> {
    const bcc = message.bcc.filter((address) => this.allowed(address));
    if (bcc.length === 0) return { receipt: "suppressed:allowlist", accepted: 0, rejected: 0 };
    return this.inner.send({ ...message, bcc }, signal);
  }
}

export function createEmailAdapter(
  env: Pick<
    WorkerEnv,
    | "EMAIL_SEND_ENABLED"
    | "EMAIL_PROVIDER"
    | "RESEND_API_KEY"
    | "RESEND_API_URL"
    | "EMAIL_FROM"
    | "SMTP_HOST"
    | "SMTP_PORT"
    | "SMTP_SECURE"
    | "SMTP_USER"
    | "SMTP_PASSWORD"
    | "EMAIL_RECIPIENT_ALLOWLIST"
  >,
  log: Logger,
): { adapter: EmailAdapter; close(): void } {
  const guard = (adapter: EmailAdapter) =>
    env.EMAIL_RECIPIENT_ALLOWLIST.length
      ? new AllowlistEmailAdapter(adapter, env.EMAIL_RECIPIENT_ALLOWLIST)
      : adapter;
  if (env.EMAIL_SEND_ENABLED && env.EMAIL_PROVIDER === "resend" && env.RESEND_API_KEY) {
    // Provider and allowlist size only: never log the key or addresses.
    log.info(
      { emailProvider: "resend", allowlistEntries: env.EMAIL_RECIPIENT_ALLOWLIST.length },
      "email sending enabled",
    );
    return {
      adapter: guard(
        new ResendEmailAdapter({ apiKey: env.RESEND_API_KEY, apiUrl: env.RESEND_API_URL }),
      ),
      close: () => undefined,
    };
  }
  if (
    !env.EMAIL_SEND_ENABLED ||
    env.EMAIL_PROVIDER !== "smtp" ||
    !env.SMTP_HOST ||
    !env.EMAIL_FROM
  ) {
    log.info("email sending disabled");
    return { adapter: new DisabledEmailAdapter(), close: () => undefined };
  }
  const smtp = new SmtpEmailAdapter({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    from: env.EMAIL_FROM,
    user: env.SMTP_USER,
    password: env.SMTP_PASSWORD,
  });
  // Host and allowlist size only: never log addresses or credentials.
  log.info(
    {
      emailProvider: "smtp",
      smtpHost: env.SMTP_HOST,
      allowlistEntries: env.EMAIL_RECIPIENT_ALLOWLIST.length,
    },
    "email sending enabled",
  );
  return { adapter: guard(smtp), close: () => smtp.close() };
}
