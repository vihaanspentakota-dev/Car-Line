# Car Line

Live pickup queue for elementary schools. Parents install nothing; staff get one synced screen per zone.

## Run
```bash
npm start          # http://localhost:3000   (Node 18+, no dependencies)
npm test           # end-to-end smoke test
```
- Parents: `/` (opened from the QR code on the car tag)
- Staff: `/staff` (default PIN `1234`)
- Office: `/admin` (default PIN `9999`; ships with demo families)

Set `STAFF_PIN`, `ADMIN_PIN`, and `TZ` (for example `America/Chicago`) in production.

## How it works
- Office pastes a roster (`tag,first name,zone`) and prints a QR code per family.
- A car joins the queue when the parent taps "I’m here" **or** staff type its tag, so the school never depends on adoption.
- Each zone has its own ordered queue. A car with siblings in two zones is only done when every child is sent out.
- Staff page works through weak signal: last queue stays visible, taps are saved in an outbox and replayed in arrival order.
- Wait estimate is a rolling average of the last 8 releases.

## Privacy
No location tracking, no plate detection, first names only, parents see only their own children, and the queue is wiped every day.

## Deploy
Any Node host works (Render, Railway, Fly). Start command: `npm start`.

## Not included
Authorized-pickup verification and early checkout.
