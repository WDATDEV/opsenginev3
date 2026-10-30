# Ops Engine — work tracking

This repo follows the Ops Engine modular-monolith plan. The first finished module is **employee work tracking**. Identity, clients, work tasks, and audit exist only as far as tracking needs them.

Desktop: http://localhost:3010  
API: http://localhost:3011  
Supervisor: `nora@opsengine.local` / `OpsEngine!dev`  
IceCartel manager: `lina@opsengine.local` / `OpsEngine!dev`  
IceCartel client: `ice@opsengine.local` / `OpsEngine!dev`  
Jacob manager: `owen@opsengine.local` / `OpsEngine!dev`  
Jacob client: `jacob@opsengine.local` / `OpsEngine!dev`  
Floor phone: http://localhost:3010/phone  
QR gate: http://localhost:3010/gate

## Run

```bash
docker compose up -d
pnpm install
pnpm db:push
pnpm db:clear
pnpm db:seed
pnpm dev
```

See `docs/TRACKING.md` for how packing, picking, receiving, unloading, sorting, task changes, and equipment are recorded.
