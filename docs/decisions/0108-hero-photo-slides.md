# 0108 — Hero photo slides

- Status: Accepted
- Date: 2026-11-05
- Decided by: Marina

## Context

The client supplied hero pictures: five wide ones (3584 × 1184) for computers and five square ones (2048 × 2048) for phones. They are photographs of devices with empty space on the left and no words in them.

The hero had two kinds of look:

- **Navy, lilac and coral:** coloured slides with the words and a small product picture.
- **Designed banner (ADR 0105):** the client's own picture with its words in it. It paints no eyebrow, headline or buttons, and the whole banner is one link.

Neither suits a photograph that needs the shop's own words over it. Marina chose a new look and kept the limit of three slides (`HERO_SLIDES_MAX`).

## Decision

- **Content hero v3 gains two looks**, so no version bump or migration is needed:
  - `photo-light`: a bright picture with dark text.
  - `photo-dark`: a dark picture with light text.
  - Like a banner, a photo slide needs its wide picture and may have a phone picture (`mobileImage`).
- **Store API:** the slide `style` enum gains the same two values.
- **Storefront, 720 px and wider:**
  - The photograph fills the slide at about 3 : 1 (at most 560 px tall) and is kept to the right, where the product stands.
  - The slide's eyebrow, headline, supporting text and two buttons sit on the left over a soft fade for contrast.
- **Storefront, phones:**
  - The phone picture (or the wide one, cropped square) comes first at full width.
  - The words follow on a plain panel, so they never cover the product.
  - As on the other looks, the second button is hidden below 720 px.
- **Missing picture:** if the picture is missing (not processed yet), the slide falls back to the lilac or navy look with the same text colour.
- **Admin:** the Look select gains "Photo with dark text (bright picture)" and "Photo with light text (dark picture)". A short help text appears, the picture hint asks for a 3 : 1 photo with the product on the right, and the phone picture field shows.

## Consequences

- The largest stored size of a content picture is 1600 px wide (`DERIVATIVE_SIZES.large`), so on very wide screens the photo is slightly soft, as banners already are.
- Older admin copies keep working: the new values are only accepted, never required.
- The built-storefront check (`test:age-preview`) renders a photo slide with its words, button, and wide and phone pictures. It still gives unverified visitors nothing.
