# Work tracking

Ops Engine records who did the work. The module is `packages/modules/tracking`. The API in `apps/api` is the only caller. The web app never reads another module’s tables.

Supporting modules used here:

| Module | What tracking uses |
|---|---|
| Identity / kernel | Supervisor login, roles, permission checks |
| Clients | A shipment and a pack can name a client |
| Work | A count that does not match opens a follow-up task |
| Audit | Every write stores a human summary |

A job belongs to one client. IceCartel and Jacob each have their own jobs, rates, and manager login. Shipments and loads hang off that job. Labor time is stored on the job, and a pause keeps the time already recorded. Draft charges use the client's rate card. QuickBooks is still out of this slice.

## The eight floor questions

1. **Packing logins.** Each packing computer is `individual` or `shared`. An individual computer belongs to one person. A shared computer keeps a station login, and the packer badges in.
2. **Who packed it.** Ops Engine always stores the employee. On an individual computer, that person is the packer. On a shared computer, the badge or the open station session is the record.
3. **Picking devices.** A personal scanner is assigned to one picker. A shared handheld must be checked out, or the picker badges at the scan.
4. **Receiving together.** Several employees can be active on one shipment. Each count is stored against the person who entered it.
5. **Unloading crew.** Someone badges onto the truck, a lead adds a name, or a supervisor enters the paper list. Each person has a start and an end.
6. **Gaylord scans.** A package is scanned into an open USPS, UPS, FedEx, DHL, or other gaylord. A placement without a scan requires a reason.
7. **Task changes.** Starting a new task closes the previous one immediately. Home department is not a lock. There is no minimum time on a task.
8. **Equipment.** Packing computers, barcode scanners, and handhelds are registered devices with a location and a live holder.

## Experiences

- Desktop (`/`) is the supervisor view: who is on which task, and the boards for each department.
- Floor phone (`/phone`) is the badge flow for doing the work.
- QR gate (`/gate`) is check-in and check-out. Checking out closes the open task, station, scanner checkout, shipment join, and crew row.
