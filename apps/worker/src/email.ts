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
  if (!env.EMAIL_SEND_ENABLED || !env.SMTP_HOST || !env.EMAIL_FROM) {
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
    { smtpHost: env.SMTP_HOST, allowlistEntries: env.EMAIL_RECIPIENT_ALLOWLIST.length },
    "email sending enabled",
  );
  return {
    adapter: env.EMAIL_RECIPIENT_ALLOWLIST.length
      ? new AllowlistEmailAdapter(smtp, env.EMAIL_RECIPIENT_ALLOWLIST)
      : smtp,
    close: () => smtp.close(),
  };
}
