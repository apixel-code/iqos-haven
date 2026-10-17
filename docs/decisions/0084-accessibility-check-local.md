# 0084 — Accessibility and preview check: local part

- Date: 2026-10-17
- Status: accepted (the real-device and live-preview part waits for BI-15 and a staging URL)
- Step(s): 120 (follows ADRs 0026, 0082 and 0083)

## Context

Step 120 asks for an actual link-preview and browser/mobile accessibility check: previews must disclose no product data, and keyboard use, dialogs, form errors and the mobile sheets must work. Acceptance UI-01 says "on agreed devices". There is no staging host yet (BI-06 is answered, but nothing is provisioned), and no device list has been agreed. The real-platform part therefore cannot run now. Everything that does not need a real device or a public URL can, and should, run before it.

## Decision

**Local part, in Chromium on the built apps and the real API:**

- **`scripts/browser-qa/a11y-storefront.mjs`:**
  - axe-core (WCAG 2.1 A/AA) on 13 shopper pages, the cart sheet and the menu sheet, at 360px and 1280px, plus the unverified age-check page. Serious and critical violations fail; the rest are listed.
  - Keyboard-only: choose an option, add, the sheet takes and keeps focus, Escape returns it, the sheet's link leads to the cart. Then checkout with errors: an alert summary takes focus and links to every invalid field, each with its error text. Then the menu sheet.
- **`scripts/browser-qa/a11y-admin.mjs`:**
  - axe-core on sign-in, home, all 16 sections, an order detail and the new-order form, at 1366px light and dark and at 390px.
  - Keyboard: sign-in, a refused sign-in announced as an alert, the notification panel opened and closed with Escape.
- **Link previews** keep their existing local proof: `scripts/check-age-preview.mjs` (step 57) fetches every public and restricted URL with the Facebook, WhatsApp and other preview user agents and finds no product data.

**What the check found, and the fixes:**

- **Contrast:** storefront `--ink-3` (#6b767d, from the prototype) was 4.2:1 on the page background and 3.9:1 on `--surface-2`. It is now #5f6a71 (5.0:1 and 4.7:1). This is the one intended visual change from the prototype.
- **Cart link name:** the header Cart link's `aria-label` ("Cart, 1 item") did not contain its visible text. Its name is now built from the visible "Cart" and count, plus hidden words ("Cart 1 item", "Cart, empty").
- **Dialog reopen race:** in the cart sheet and the menu, a dialog's `close` event arrives after it has closed. An add pressed straight after Escape could set the sheet to "closed" just after it reopened. Each open request now has a revision, and a late close event is ignored while the dialog is open.
- **Orders tab list:** the admin's "Delayed only" toggle (ADR 0081) sat inside `role="tablist"`, which may hold only tabs. It now sits beside it.
- **Notification panel:** it did not close with Escape. It now does, from the bell or inside the panel, and focus returns to the bell.

**What stays open:** the device and platform list is BI-15. When staging exists, the same two scripts run against it. Then real iOS and Android devices with VoiceOver and TalkBack, real Safari and Firefox, and real preview fetchers on the staging URL. Step 120 is done only after that.

## Consequences

- A shopper or staff member using only a keyboard, or a screen reader that relies on correct roles and names, is served by every page scanned; regressions are caught by two repeatable scripts.
- Automated rules find only part of the accessibility problems. Real devices and assistive technology remain the decisive check.
