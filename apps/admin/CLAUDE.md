# apps/admin — Admin UI

- UI hides what the user can't do, but the API is the enforcer. Always handle 403 and field-filtered responses gracefully.
- Session cookie `__Host-ih_admin` (same-origin via gateway). No tokens in localStorage.
- Every mutation sends the expected `version`; show a conflict state on 409 with reload option.
- Order status UI: Pending → Confirmed → Processing → Out for Delivery → Delivered, or Cancelled. Cash collection is a separate action/button — never implied by Delivered.
- Coupons: percentage only. No fixed/brand-scoped types. Soft delete (trash/restore), never hard delete except Owner purge where architecture allows.
- WhatsApp: `wa.me` links are "opened", never "sent/confirmed".
- Charts/analytics show only real API data. Empty state when there is none.
- Prototype reference: `docs/prototypes/admin.html` via `docs/prototype-map.md`. Ignore demo-only code: `rng`, `mkOrder`, `simulateOrder`, `loginAs`, `applyDev`, `flowRun`/coach tour, `guideView`.
- Light/dark theme tokens exist in the prototype (`:root[data-theme="dark"]`) — keep both.
