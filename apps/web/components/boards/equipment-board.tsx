"use client";

import { useState } from "react";
import { useSession } from "@/components/shell";
import { Field, Notice, PageTitle, useResource } from "@/components/ui";
import { ApiError, canManage, post } from "@/lib/api";

type Device = {
  id: string;
  code: string;
  label: string;
  kind: string;
  ownership: string;
  location: string;
  warehanceLoginMode: string;
  assignedTo: string | null;
  heldBy: string | null;
  liveStatus: string;
  clientId: string | null;
};

export function EquipmentBoard({ client }: { client?: { id: string; name: string } }) {
  const board = useResource<Device[]>("/tracking/devices");
  const user = useSession();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState("barcode_scanner");
  const [ownership, setOwnership] = useState("shared_pool");
  const [loginMode, setLoginMode] = useState("none");
  const [location, setLocation] = useState("Pick aisle");
  const [assignedBadge, setAssignedBadge] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await post("/tracking/devices", {
        code,
        label,
        kind,
        ownership,
        warehanceLoginMode: loginMode,
        location,
        assignedBadge: assignedBadge || undefined,
        ...(client ? { clientId: client.id } : {}),
      });
      setMessage(`${code.toUpperCase()} is on the register.`);
      setCode("");
      setLabel("");
      board.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not register that device.");
    }
  }

  return (
    <div>
      <PageTitle
        kicker="Equipment"
        title={client ? `Equipment for ${client.name}` : "What is already on the floor"}
        detail={
          client
            ? `Devices registered here belong to ${client.name}.`
            : "Packing computers, barcode scanners, and handhelds. Personal devices belong to one person. Shared devices show who has them now."
        }
      />
      {board.error ? <Notice tone="bad">{board.error}</Notice> : null}
      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        {canManage(user?.role) ? (
          <form className="card space-y-3 p-4" onSubmit={submit}>
            <h2 className="font-semibold">Register a device</h2>
            {message ? <Notice tone="ok">{message}</Notice> : null}
            {error ? <Notice tone="bad">{error}</Notice> : null}
            <Field label="Code">
              <input className="field font-mono" value={code} onChange={(event) => setCode(event.target.value)} />
            </Field>
            <Field label="Label">
              <input className="field" value={label} onChange={(event) => setLabel(event.target.value)} />
            </Field>
            <Field label="Kind">
              <select className="field" value={kind} onChange={(event) => setKind(event.target.value)}>
                <option value="packing_computer">Packing computer</option>
                <option value="barcode_scanner">Barcode scanner</option>
                <option value="handheld">Handheld</option>
              </select>
            </Field>
            <Field label="Ownership">
              <select className="field" value={ownership} onChange={(event) => setOwnership(event.target.value)}>
                <option value="personal">Personal</option>
                <option value="shared_pool">Shared pool</option>
              </select>
            </Field>
            <Field label="Station login">
              <select className="field" value={loginMode} onChange={(event) => setLoginMode(event.target.value)}>
                <option value="none">None</option>
                <option value="individual">Individual</option>
                <option value="shared">Shared station</option>
              </select>
            </Field>
            <Field label="Location">
              <input className="field" value={location} onChange={(event) => setLocation(event.target.value)} />
            </Field>
            <Field label="Assigned badge, if personal">
              <input className="field font-mono" value={assignedBadge} onChange={(event) => setAssignedBadge(event.target.value)} />
            </Field>
            <button className="btn btn-primary w-full" type="submit">
              Add device
            </button>
          </form>
        ) : null}
        <div className="card overflow-hidden">
          <table className="w-full text-left text-sm">
            <thead className="bg-black/[0.03] text-muted">
              <tr>
                <th className="px-4 py-3 font-medium">Device</th>
                <th className="px-4 py-3 font-medium">Kind</th>
                <th className="px-4 py-3 font-medium">Login</th>
                <th className="px-4 py-3 font-medium">Who</th>
                <th className="px-4 py-3 font-medium">Now</th>
              </tr>
            </thead>
            <tbody>
              {board.data
                ?.filter((device) => (client ? device.clientId === client.id : !device.clientId))
                .map((device) => (
                <tr key={device.id} className="border-t border-black/5">
                  <td className="px-4 py-3">
                    <div className="font-mono">{device.code}</div>
                    <div className="text-muted">{device.label}</div>
                  </td>
                  <td className="px-4 py-3 capitalize">{device.kind.replaceAll("_", " ")}</td>
                  <td className="px-4 py-3 capitalize">{device.warehanceLoginMode}</td>
                  <td className="px-4 py-3">{device.assignedTo ?? device.heldBy ?? "Pool"}</td>
                  <td className="px-4 py-3 capitalize">{device.liveStatus.replaceAll("_", " ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
