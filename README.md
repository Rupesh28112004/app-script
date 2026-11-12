# Hotel Management & Billing — Google Apps Script version

This is the Apps Script version of the Laravel `hotel-management` project. Google Sheets is the database
(one tab per table), and the app runs as an Apps Script **Web App**.

## Files (copy each one into the Apps Script editor)

| File | Type in editor | What it does |
|---|---|---|
| `appsscript.json` | manifest (Project Settings → "Show appsscript.json") | timezone (Asia/Kolkata), web app settings |
| `Config.gs` | Script | sheet schema, default settings, default admin login |
| `Db.gs` | Script | read/write rows in the sheets |
| `Auth.gs` | Script | login, sessions, password hashing |
| `Services.gs` | Script | rooms, guests, check-in/out, billing, payments, reports, staff |
| `Code.gs` | Script | web app entry point, API router, `setup()`, Hotel menu |
| `Index.html` | HTML | page shell |
| `Styles.html` | HTML | CSS |
| `App.html` | HTML | front-end app (JavaScript) |
| `InvoicePrint.html` | HTML | printable invoice / PDF template |

In the editor, create each file with the **same name, without the extension** (for example `Config`, `App`).

## Setup (one time)

1. Open your Google Sheet, then go to **Extensions → Apps Script**.
2. Delete the default `Code.gs` content, then create and paste all the files above.
   For `appsscript.json`, go to Project Settings ⚙ → tick *Show "appsscript.json" manifest file in editor*.
3. Open `Config.gs` and change `DEFAULT_ADMIN` (email/password) if you want.
4. Select the `setup` function → **Run** → allow the permissions.
   This creates the tabs `Rooms, Guests, Bookings, Invoices, InvoiceItems, Payments, Users, Settings, ActivityLog`,
   removes the empty `Sheet1…Sheet6` tabs, and creates the admin user.
   (Optional: run `seedSampleRooms` to add 6 demo rooms.)
5. **Deploy → New deployment → Web app**
   - Execute as: **Me**
   - Who has access: **Anyone** (staff do not need Google accounts; they still have to log in to the app)
6. Open the Web App URL and log in with `admin@hotel.com` / `admin123`, then **change the password** right away
   (sidebar → Password).

After you edit the code later: **Deploy → Manage deployments → Edit → Version: New version**, so the same URL picks up the changes.

## Push from your computer with clasp (instead of copy/paste)

This folder is linked to the sheet's Apps Script project through `.clasp.json` (git-ignored).
`.claspignore` makes sure only `.gs`, `.html` and `appsscript.json` get uploaded.

```bash
npm install -g @google/clasp      # once
clasp login                       # once, with the Google account that owns the sheet
# turn on the API once: https://script.google.com/home/usersettings

clasp push        # upload local code -> Apps Script (replaces the online files)
clasp pull        # download online code -> local (careful: overwrites local files)
clasp open-script # open the project in the browser
```

To use it on another machine, create `.clasp.json` with:

```json
{ "scriptId": "<Script ID from Project Settings>", "rootDir": ".", "scriptExtensions": [".gs", ".js"], "htmlExtensions": [".html"], "jsonExtensions": [".json"] }
```

`clasp push` only updates the code. The live web app URL keeps serving the old version until you
**Deploy → Manage deployments → Edit → Version: New version** (or run `clasp create-deployment` the first time and
`clasp update-deployment <deploymentId>` after that).

## Features (same as the Laravel app)

- **Dashboard**: occupancy, in-house guests, today's revenue, outstanding balance, due check-outs, recent bookings, invoices and activity
- **Rooms**: board and list views, add/edit/delete, status (available / occupied / cleaning / maintenance), nightly + hourly prices
- **Guests**: register, search, history, total billed/paid. Only the **masked** ID number is stored (`XXXXXXXX9012`)
- **Check-in**: existing or new guest (quick check-in), nightly/hourly billing, availability check, manual price override, live estimate
- **Check-out / Cancel**: frees the room (as *cleaning* or *available*)
- **Billing**: create invoices from a booking or for a walk-in guest. Item lines (room/food/service/other/discount), GST/tax, initial payment, optional check-out at the same time
- **Invoices**: list/filter, partial payments, **Print** and **PDF download**, sequential numbers (`INV-1001`…)
- **Reports** (admin): daily check-ins, check-outs, payments by method, date-wise billing, guest history, **CSV export**
- **Staff** (admin): add receptionists/admins, activate/deactivate
- **Settings** (admin): hotel details, GSTIN, tax, invoice prefix and number, bank/UPI shown on invoices, terms

## Notes

- Billing rule: nightly stays count calendar nights (12 Nov 2 PM → 14 Nov 11 AM = **2 nights**, minimum 1).
  Hourly stays have a 1-hour minimum. If a room has no hourly price, it uses the nightly price ÷ 24.
- Every write runs under `LockService`, so two receptionists saving at the same time won't collide.
- Password hashes are in hidden columns of the `Users` tab. Share the spreadsheet itself **only with the owner/admin**.
  Staff use the web app URL, not the sheet.
- You can view data directly in the sheet. Avoid editing `id` columns or deleting rows by hand.
- Sheets works well up to a few thousand bookings. For a very large hotel, use the Laravel app.
- If the browser blocks the PDF download inside the web app, use **Print → Save as PDF**.
