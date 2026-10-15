"use client";

import { useEffect } from "react";

/**
 * Keeps the page's fragment through the age question (step 94). A review link carries its
 * token in the fragment, which the server never sees. Putting it on the accept form's action
 * makes the browser keep it on the redirect back after accepting (a Location without a fragment
 * inherits the request's). Without script the question still works; the link is just opened
 * again from the message.
 */
export function KeepFragment({ formId }: { formId: string }) {
  useEffect(() => {
    const { hash } = window.location;
    const form = document.getElementById(formId);
    if (hash.length > 1 && hash.length <= 512 && form instanceof HTMLFormElement)
      form.action = form.getAttribute("action")! + hash;
  }, [formId]);
  return null;
}
