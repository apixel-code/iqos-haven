# 0058 — Admin customer views and order WhatsApp messages

- Date: 2026-10-15
- Status: accepted
- Step(s): 90

## Context

Roadmap step 90: customer history and spend views, and order WhatsApp templates. Done condition: Staff see operational fields only; the Owner sees the financial summary; a `wa.me` link is never marked as a confirmed send. Architecture: customers have no accounts and are grouped by phone; "Customer operational contact and order history" is Owner and Staff, "Customer aggregate spend and customer export" is Owner only; `wa.me` templates escape content and opening a link does not establish that a message was sent. BI-09 (WhatsApp number and wording) is open: placeholder wording until the client provides it.

## Decision

**Customers.** `GET /v1/admin/customers` and `GET /v1/admin/customers/:id`, both `customers.read`, `private, no-store`.

- The list holds customers with at least one order, newest customer first by keyset (25 per page, up to 100). Search matches the name, or the phone by digits when at least three are typed (leading zeros ignored, so "050 123…" finds "+97150123…"). Each row: name, phone, order count, last order, the area of the latest order.
- The detail adds the first and last order, cancelled count, up to 10 saved addresses (newest first) and up to 50 orders (number, status, cash status, total, time). The order history needs `orders.read` as well; without it the list is empty.
- **Spend is Owner only** (`customers.financial_read`, checked per request in the database read; the field is absent otherwise) and has two labelled bases, never one mixed number: booked = all orders not cancelled; delivered = Delivered orders. Collected cash stays per order (ADR 0055).

**Order WhatsApp messages.** `GET /v1/admin/orders/:id/whatsapp` (`customers.read` and `orders.read`): the customer's number and two ready messages, "order confirmation" and "status update". They use the Owner's templates from Settings (placeholders `{{store_name}}`, `{{order_number}}`, `{{status}}`, `{{total}}`, `{{support_phone}}`, as the settings contract allows) or built-in placeholder wording, marked `placeholder: true`, until BI-09. Values are plain text kept on one line; the text is URL-encoded into `https://wa.me/<digits>?text=…`. The admin shows the message editable, then "Open WhatsApp" in a new tab. **Nothing is sent or recorded**: no audit, no event, no "sent" state; the help text says so.

**Not taken from the prototype:** synthetic customers, spend shown to every role, "favourite products", the customer CSV export (Owner export is a reports step), the "Demo number" help text, first-name and area placeholders (not in the settings contract).

## Consequences

- Staff can still see an order's total in the order list and history; only per-customer aggregates are Owner-only.
- Changing the template wording is a Settings change by the Owner; the placeholder set is fixed by the settings contract.
- A customer whose orders were all placed by staff is listed like any other: the phone is the identity.
