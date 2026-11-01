import { escapedHtml, HtmlFragment, type HtmlBuilder } from "./template";

/**
 * The branded shell every Iqos Haven email shares (storefront tokens: chrome #0e1116, ink
 * #12161b, saffron #f2b233, Poppins with system fallbacks). Email-safe on purpose: one table
 * layout with inline styles, no web fonts or images to load, a hidden preheader, a bulletproof
 * button with the link also written out, and dark text on white so it survives dark-mode
 * inversion. Every caller-supplied value goes through the escaping builder; `body` is HTML the
 * template itself built with that builder. Each element opens and closes inside one template
 * literal (the formatter would otherwise close it early).
 */
export interface EmailLayout {
  /** Inbox preview line (hidden in the message). */
  readonly preheader: string;
  readonly heading: string;
  /** Already-escaped HTML from the template's `html` builder. */
  readonly body: string;
  readonly action?: { readonly label: string; readonly url: string };
  /** Small print under the card, e.g. why the reader got the message. */
  readonly footnote: string;
}

const FONT = "Poppins, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export function brandedEmail(html: HtmlBuilder, layout: EmailLayout): string {
  const action = layout.action
    ? html`<table role="presentation" cellpadding="0" cellspacing="0" style="margin:28px 0 8px">
          <tr>
            <td style="border-radius:10px;background:#12161b">
              <a
                href="${layout.action.url}"
                style="display:inline-block;padding:14px 28px;font-family:${FONT};font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px"
                >${layout.action.label}</a
              >
            </td>
          </tr>
        </table>
        <p
          style="margin:16px 0 0;font-family:${FONT};font-size:12px;line-height:18px;color:#5f6a71"
        >
          If the button does not work, copy this link into your browser:<br />
          <a href="${layout.action.url}" style="color:#1f7a99;word-break:break-all"
            >${layout.action.url}</a
          >
        </p>`
    : "";
  const content = new HtmlFragment(layout.body + action);
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light" />
        <title>${layout.heading}</title>
      </head>
      <body style="margin:0;padding:0;background:#f2f4f5">
        <span style="display:none;max-height:0;overflow:hidden;opacity:0;color:#f2f4f5"
          >${layout.preheader}</span
        >
        <table
          role="presentation"
          width="100%"
          cellpadding="0"
          cellspacing="0"
          style="background:#f2f4f5"
        >
          <tr>
            <td align="center" style="padding:24px 12px">
              <table
                role="presentation"
                width="100%"
                cellpadding="0"
                cellspacing="0"
                style="max-width:600px"
              >
                <tr>
                  <td style="background:#0e1116;border-radius:16px 16px 0 0;padding:22px 32px">
                    <span
                      style="font-family:${FONT};font-size:18px;font-weight:700;letter-spacing:3px;color:#ffffff"
                      >IQOS HAVEN</span
                    ><span style="font-family:${FONT};font-size:18px;font-weight:700;color:#f2b233"
                      >.</span
                    >
                  </td>
                </tr>
                <tr>
                  <td
                    style="background:#ffffff;border-radius:0 0 16px 16px;padding:32px;border:1px solid #d9dfe1;border-top:0"
                  >
                    <h1
                      style="margin:0 0 16px;font-family:${FONT};font-size:22px;line-height:30px;font-weight:600;color:#12161b"
                    >
                      ${layout.heading}
                    </h1>
                    <div style="font-family:${FONT};font-size:15px;line-height:24px;color:#47525a">
                      ${content}
                    </div>
                  </td>
                </tr>
                <tr>
                  <td
                    style="padding:20px 32px 0;font-family:${FONT};font-size:12px;line-height:18px;color:#5f6a71;text-align:center"
                  >
                    ${layout.footnote}<br />Iqos Haven · iqoshaven.com · This is an automated
                    message; replies are not read.
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
    </html>`;
}

/** A two-column facts table (label → value) inside a branded email body. */
export function factsTable(
  html: HtmlBuilder,
  rows: ReadonlyArray<readonly [string, string]>,
): string {
  const cell = (i: number) => (i ? "border-top:1px solid #e9edee;" : "");
  const body = new HtmlFragment(
    rows
      .map(
        ([label, value], i) =>
          html`<tr>
            <td
              style="padding:10px 16px;font-family:${FONT};font-size:13px;color:#5f6a71;${cell(i)}width:40%"
            >
              ${label}
            </td>
            <td
              style="padding:10px 16px;font-family:${FONT};font-size:14px;font-weight:600;color:#12161b;${cell(i)}"
            >
              ${value}
            </td>
          </tr>`,
      )
      .join(""),
  );
  return html`<table
    role="presentation"
    width="100%"
    cellpadding="0"
    cellspacing="0"
    style="margin:20px 0;border:1px solid #d9dfe1;border-radius:10px;border-collapse:separate"
  >
    ${body}
  </table>`;
}

/**
 * Ops alert body for Apixel's on-call mailbox (step 125): the plain alert lines in the branded
 * shell, kept monospaced so keys and times stay readable.
 */
export function opsAlertHtml(heading: string, text: string): string {
  return brandedEmail(escapedHtml, {
    preheader: heading,
    heading,
    body: escapedHtml`<pre
      style="margin:0;white-space:pre-wrap;font-family:'JetBrains Mono',Menlo,Consolas,monospace;font-size:13px;line-height:20px;color:#12161b"
    >${text}</pre
    >`,
    footnote: "Sent to OPS_ALERT_RECIPIENTS by the Iqos Haven worker's monitor.",
  });
}
