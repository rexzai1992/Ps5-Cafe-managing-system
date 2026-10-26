# Privacy: QR reservations (PDPA)

This describes the only personal data the system handles. Keep it accurate whenever reservation code changes.

## What is collected and why

When a customer scans a TV's QR code and reserves it, they enter a **Malaysian mobile number** and must tick a consent box
before the server accepts it. The number is used **only** so staff can contact that customer about that booking (for example
"your TV is ready" or "your hold is about to expire"). It is never used for marketing, analytics, accounts or membership.

Nothing else about the customer is collected: no name, no email, no device identifier. The booking page stores a random
reservation token in that phone's browser so the customer can see their booking status after a refresh.

## Who can see it

- Staff signed in to the dashboard see the full number on the reserved TV, with a tap-to-call link.
- The TV's own screen shows only the last 4 digits (e.g. "For ••• 6789").
- The customer's phone shows their booking code, never the number back.
- No public API response contains the full number (covered by tests).

## Retention and erasure

The number is erased (set to NULL in SQLite) as soon as the reservation closes, in the same statement that closes it:

| How it closes | When |
|---|---|
| Staff release the hold | immediately |
| Customer cancels on their phone | immediately |
| Hold expires unpaid | after the hold time (default 10 minutes) |
| The started session ends or expires | at the next server tick (1 s) |
| Safety net | any number older than 24 hours, whatever the state |

Erasure also covers copies: responses kept for safe retries (idempotency, 24 h) are stored with phone numbers blanked; SQLite
runs with `secure_delete` so erased values are zeroed in the file; and the write-ahead log is checkpointed and truncated when a
reservation closes. A test reads the raw database and WAL files to confirm the numbers are gone (`apps/server/src/booking.test.ts`).
Server logs do not include request bodies.

## Not covered by software

- Staff writing numbers down or calling from personal phones.
- Backups of the `data/` folder taken while a reservation was open.
- The café's own PDPA notice at the counter; the consent text on the booking page is a summary, not a full notice.
