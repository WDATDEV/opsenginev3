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

## The seven floor questions

1. **Packing.** A pack needs the order and the packer's badge. Ops Engine does not track which computer was used.
2. **Who packed it.** The badge is the packer of record. The packer must be clocked in.
3. **Picking.** A pick needs the picker's badge, batch, SKU, and quantity. Ops Engine does not track which scanner was used.
4. **Receiving together.** Several employees can be active on one shipment. Each count is stored against the person who entered it.
5. **Unloading crew.** Someone badges onto the truck, a lead adds a name, or a supervisor enters the paper list. Each person has a start and an end.
6. **Carrier-bin scans.** A package is scanned into an open USPS, UPS, FedEx, DHL, or other carrier bin. A placement without a scan requires a reason.
7. **Task changes.** Starting a new task closes the previous one immediately. Home department is not a lock. There is no minimum time on a task.

## Experiences

- Desktop (`/`) is the supervisor view: who is on which task, and the boards for each department.
- Floor phone (`/phone`) is the badge flow for doing the work.
- QR gate (`/gate`) is check-in and check-out. Checking out closes the open task, station, scanner checkout, shipment join, and crew row.
