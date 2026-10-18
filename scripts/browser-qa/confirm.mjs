// The admin's confirmation dialog (parity G-A13, ADR 0097) replaced window.confirm: these
// helpers answer it in a browser pass.
//   autoConfirm(page)        — accepts every confirmation from now on, as soon as it appears
//                              (what `page.on("dialog", (d) => d.accept())` did before).
//   answerConfirm(page, yes) — waits for the next confirmation and accepts or cancels it.
const OK = "dialog.layer-host[open] [data-confirm-ok]";
const CANCEL = "dialog.layer-host[open] [data-confirm-cancel]";

function acceptInPage(selector) {
  const press = () => document.querySelector(selector)?.click();
  // `document`, not `documentElement`: an init script runs before the root element exists.
  new MutationObserver(() => setTimeout(press, 0)).observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["open"],
  });
}

export async function autoConfirm(page) {
  // For pages opened from now on, and for the page already open.
  await page.addInitScript(acceptInPage, OK);
  await page.evaluate(acceptInPage, OK).catch(() => undefined);
}

export async function answerConfirm(page, yes) {
  const button = page.locator(yes ? OK : CANCEL);
  await button.waitFor();
  await button.click();
  await page
    .locator("dialog.layer-host[open] [data-confirm-ok]")
    .waitFor({ state: "detached" })
    .catch(() => undefined);
}
