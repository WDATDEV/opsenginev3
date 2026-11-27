"use client";

// Weekly timecards. Managers fix punches (with a reason that is kept), approve each person's week,
// and print timecards for temp agencies. HR can read everything.

import { useEffect, useMemo, useState } from "react";
import { useSession } from "@/components/shell";
import { Badge, EmptyRow, Field, Flash, Notice, PageTitle, Panel, SearchBox, Segmented, SkeletonList, useResource } from "@/components/ui";
import { ApiError, canManage, post } from "@/lib/api";
import {
  addDays,
  browserZone,
  dateTimeLabel,
  dayLabel,
  fromLocalInput,
  hm,
  timeLabel,
  toLocalInput,
  todayLocal,
  WEEK_DAYS,
  weekLabel,
  type Approval,
  type Card,
  type CardPerson,
  type CardShift,
  type TimecardSettings,
} from "@/lib/timecards";

type Row = {
  employee: CardPerson;
  paidMinutes: number;
  mealMinutes: number;
  dailyOvertimeMinutes: number;
  weeklyOvertimeMinutes: number;
  missedCheckOuts: number;
  openShifts: number;
  edited: boolean;
  days: { date: string; paidMinutes: number; overtimeMinutes: number }[];
  approval: Approval;
};

type WeekList = { weekStart: string; settings: TimecardSettings; people: Row[] };

type Detail = {
  weekStart: string;
  settings: TimecardSettings;
  employee: CardPerson;
  card: Card;
  edits: {
    id: string;
    shiftId: string;
    editorName: string;
    reason: string;
    before: { clockIn: string; clockOut: string | null };
    after: { clockIn: string; clockOut: string | null };
    createdAt: string;
  }[];
  approval: Approval;
};

type Attention = { missedCheckOuts: { shiftId: string; clockIn: string; weekStart: string; employee: CardPerson }[] };

type Tab = "week" | "attention" | "settings";

export function TimecardsBoard() {
  const user = useSession();
  const manage = canManage(user?.role);
  const zone = useMemo(() => browserZone(), []);
  const [weekOf, setWeekOf] = useState(todayLocal());
  const [tab, setTab] = useState<Tab>("week");
  const [open, setOpen] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const week = useResource<WeekList>(`/tracking/timecards?weekOf=${weekOf}&tz=${encodeURIComponent(zone)}`);
  const attention = useResource<Attention>(`/tracking/timecards/attention?tz=${encodeURIComponent(zone)}`);

  const weekStart = week.data?.weekStart ?? weekOf;
  const settings = week.data?.settings;
  const missed = attention.data?.missedCheckOuts ?? [];
  const query = search.trim().toLowerCase();
  const rows = (week.data?.people ?? []).filter(
    (row) => !query || `${row.employee.name} ${row.employee.badgeCode} ${row.employee.agency ?? ""}`.toLowerCase().includes(query),
  );
  const agencies = [...new Set((week.data?.people ?? []).map((row) => row.employee.agency).filter((item): item is string => Boolean(item)))].sort();
  const days = Array.from({ length: 7 }, (_, index) => addDays(weekStart, index));

  function saved(text: string) {
    setError(null);
    setMessage(text);
    week.reload();
    attention.reload();
  }

  function printUrl(filter: string) {
    return `/print/timecards?weekOf=${weekStart}&tz=${encodeURIComponent(zone)}${filter}`;
  }

  return (
    <div>
      <PageTitle
        kicker="Time tracking"
        title="Timecards"
        detail="Each person's paid hours for the week, with overtime and missed check-outs flagged. Fix a punch with a reason, approve the week, and print timecards for agencies."
      />
      <Flash message={message} error={error} />
      {settings && !settings.timeZoneSet ? (
        <div className="mb-4">
          <Notice tone="warn">
            Days and weeks follow this browser&apos;s time zone ({zone}) until the warehouse time zone is set under Settings on this page.
          </Notice>
        </div>
      ) : null}

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Segmented<Tab>
          label="Timecards view"
          value={tab}
          onChange={setTab}
          options={[
            ["week", "Week"],
            ["attention", missed.length ? `Missed check-outs (${missed.length})` : "Missed check-outs"],
            ...(manage ? ([["settings", "Settings"]] as const) : []),
          ]}
        />
        {tab === "week" ? (
          <div className="flex items-center gap-2">
            <button className="btn btn-ghost btn-sm" type="button" aria-label="Previous week" onClick={() => setWeekOf(addDays(weekStart, -7))}>
              ←
            </button>
            <input className="field !min-h-[2.25rem] !w-auto !py-1.5 text-sm" type="date" value={weekOf} onChange={(event) => event.target.value && setWeekOf(event.target.value)} aria-label="Week of" />
            <button className="btn btn-ghost btn-sm" type="button" aria-label="Next week" onClick={() => setWeekOf(addDays(weekStart, 7))}>
              →
            </button>
          </div>
        ) : null}
      </div>

      {tab === "week" ? (
        <Panel
          title={`Week of ${weekLabel(weekStart)}`}
          count={rows.length}
          actions={
            <>
              <SearchBox value={search} onChange={setSearch} label="Search people" placeholder="Search name, badge, agency" />
              {agencies.length ? (
                <select
                  className="field !min-h-[2.25rem] !w-auto !py-1.5 text-sm"
                  value=""
                  aria-label="Print an agency's timecards"
                  onChange={(event) => {
                    if (event.target.value) window.open(printUrl(`&agency=${encodeURIComponent(event.target.value)}`), "_blank");
                  }}
                >
                  <option value="">Print an agency…</option>
                  {agencies.map((agency) => (
                    <option key={agency} value={agency}>
                      {agency}
                    </option>
                  ))}
                </select>
              ) : null}
              {rows.length ? (
                <a className="btn btn-ghost btn-sm" href={printUrl(`&employees=${rows.map((row) => row.employee.id).join(",")}`)} target="_blank" rel="noreferrer">
                  Print all
                </a>
              ) : null}
            </>
          }
        >
          {week.error ? <div className="p-4"><Notice tone="bad">{week.error}</Notice></div> : null}
          {week.loading && !week.data ? <div className="p-4"><SkeletonList rows={4} /></div> : null}
          {week.data && rows.length === 0 ? <EmptyRow title={query ? "Nobody matches that search" : "No time this week"}>{query ? null : "Shifts show here once people check in."}</EmptyRow> : null}
          {rows.length ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[52rem] text-sm">
                <thead className="text-left text-xs text-muted">
                  <tr className="border-b border-black/5">
                    <th className="px-4 py-2 font-medium sm:px-5">Person</th>
                    {days.map((date) => (
                      <th key={date} className="px-2 py-2 text-right font-medium">
                        {dayLabel(date).split(",")[0]}
                      </th>
                    ))}
                    <th className="px-2 py-2 text-right font-medium">Total</th>
                    <th className="px-4 py-2 font-medium sm:px-5">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <RowView
                      key={row.employee.id}
                      row={row}
                      days={days}
                      open={open === row.employee.id}
                      onToggle={() => setOpen(open === row.employee.id ? null : row.employee.id)}
                    >
                      {open === row.employee.id ? (
                        <PersonWeek
                          employeeId={row.employee.id}
                          weekOf={weekStart}
                          zone={zone}
                          manage={manage}
                          printHref={printUrl(`&employees=${row.employee.id}`)}
                          onSaved={saved}
                          onError={setError}
                        />
                      ) : null}
                    </RowView>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </Panel>
      ) : null}

      {tab === "attention" ? (
        <Panel title="Missed check-outs" count={missed.length}>
          {attention.error ? <div className="p-4"><Notice tone="bad">{attention.error}</Notice></div> : null}
          {attention.data && missed.length === 0 ? <EmptyRow title="Nothing missed">Everyone who is still on shift checked in today.</EmptyRow> : null}
          <ul className="divide-y divide-black/5">
            {missed.map((item) => (
              <li key={item.shiftId} className="space-y-2 px-4 py-3 sm:px-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="font-medium">{item.employee.name}</p>
                    <p className="text-sm text-muted">Checked in {dateTimeLabel(item.clockIn)} and never checked out.</p>
                  </div>
                  <button className="btn btn-ghost btn-sm" type="button" onClick={() => { setWeekOf(item.weekStart); setOpen(item.employee.id); setTab("week"); }}>
                    Open timecard
                  </button>
                </div>
                {manage ? (
                  <FixShift
                    shift={{ id: item.shiftId, clockIn: item.clockIn, clockOut: null }}
                    zone={zone}
                    closing
                    onSaved={saved}
                    onError={setError}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      {tab === "settings" && manage ? <SettingsForm zone={zone} onSaved={saved} onError={setError} /> : null}
    </div>
  );
}

function RowView({ row, days, open, onToggle, children }: { row: Row; days: string[]; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  const overtime = row.dailyOvertimeMinutes > 0 || row.weeklyOvertimeMinutes > 0;
  return (
    <>
      <tr className={`cursor-pointer border-b border-black/5 hover:bg-black/[0.02] ${open ? "bg-black/[0.02]" : ""}`} onClick={onToggle} aria-expanded={open}>
        <td className="px-4 py-2.5 sm:px-5">
          <p className="font-medium">{row.employee.name}</p>
          <p className="text-xs text-muted">
            {row.employee.badgeCode}
            {row.employee.employmentType === "temp" ? ` · Temp${row.employee.agency ? `, ${row.employee.agency}` : ""}` : ""}
          </p>
        </td>
        {days.map((date) => {
          const day = row.days.find((item) => item.date === date);
          return (
            <td key={date} className={`px-2 py-2.5 text-right tabular-nums ${day?.overtimeMinutes ? "font-semibold text-clay" : day?.paidMinutes ? "" : "text-muted"}`}>
              {day?.paidMinutes ? hm(day.paidMinutes) : "–"}
            </td>
          );
        })}
        <td className={`px-2 py-2.5 text-right font-semibold tabular-nums ${row.weeklyOvertimeMinutes ? "text-clay" : ""}`}>{hm(row.paidMinutes)}</td>
        <td className="px-4 py-2.5 sm:px-5">
          <div className="flex flex-wrap gap-1">
            {row.missedCheckOuts ? <Badge tone="bad">Missed check-out</Badge> : row.openShifts ? <Badge>On shift</Badge> : null}
            {overtime ? <Badge tone="warn">Overtime</Badge> : null}
            {row.edited ? <Badge>Corrected</Badge> : null}
            {row.approval?.employeeConfirmedAt ? <Badge tone="ok">Confirmed</Badge> : null}
            {row.approval?.approvedAt ? <Badge tone="ok" dot>Approved</Badge> : null}
          </div>
        </td>
      </tr>
      {children ? (
        <tr>
          <td colSpan={days.length + 3} className="border-b border-black/5 bg-black/[0.015] px-4 py-4 sm:px-5">
            {children}
          </td>
        </tr>
      ) : null}
    </>
  );
}

function PersonWeek({
  employeeId,
  weekOf,
  zone,
  manage,
  printHref,
  onSaved,
  onError,
}: {
  employeeId: string;
  weekOf: string;
  zone: string;
  manage: boolean;
  printHref: string;
  onSaved: (message: string) => void;
  onError: (message: string) => void;
}) {
  const detail = useResource<Detail>(`/tracking/timecards/${employeeId}?weekOf=${weekOf}&tz=${encodeURIComponent(zone)}`);
  const [fixing, setFixing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (detail.error) return <Notice tone="bad">{detail.error}</Notice>;
  if (!detail.data) return <SkeletonList rows={3} />;
  const { card, approval, edits, settings } = detail.data;

  async function act(path: string, done: string) {
    setBusy(true);
    try {
      const result = await post<{ message: string }>(path, { weekOf, tz: zone });
      onSaved(result.message ?? done);
      detail.reload();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Could not save that.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <div>
            <dt className="inline text-muted">Paid </dt>
            <dd className="inline font-semibold tabular-nums">{hm(card.paidMinutes)}</dd>
          </div>
          <div>
            <dt className="inline text-muted">Meals </dt>
            <dd className="inline tabular-nums">{hm(card.mealMinutes)}</dd>
          </div>
          <div>
            <dt className="inline text-muted">Over {hm(settings.dailyOvertimeMinutes)}/day </dt>
            <dd className={`inline tabular-nums ${card.dailyOvertimeMinutes ? "font-semibold text-clay" : ""}`}>{hm(card.dailyOvertimeMinutes)}</dd>
          </div>
          <div>
            <dt className="inline text-muted">Over {hm(settings.weeklyOvertimeMinutes)}/week </dt>
            <dd className={`inline tabular-nums ${card.weeklyOvertimeMinutes ? "font-semibold text-clay" : ""}`}>{hm(card.weeklyOvertimeMinutes)}</dd>
          </div>
        </dl>
        <div className="flex flex-wrap items-center gap-2">
          <a className="btn btn-ghost btn-sm" href={printHref} target="_blank" rel="noreferrer">
            Print
          </a>
          {manage ? (
            approval?.approvedAt ? (
              <button className="btn btn-ghost btn-sm" type="button" disabled={busy} onClick={() => void act(`/tracking/timecards/${employeeId}/unapprove`, "Approval removed.")}>
                Remove approval
              </button>
            ) : (
              <button className="btn btn-primary btn-sm" type="button" disabled={busy || card.openShifts > 0} onClick={() => void act(`/tracking/timecards/${employeeId}/approve`, "Approved.")}>
                Approve week
              </button>
            )
          ) : null}
        </div>
      </div>

      <p className="text-sm text-muted">
        {approval?.employeeConfirmedAt ? `${detail.data.employee.name} confirmed these hours ${dateTimeLabel(approval.employeeConfirmedAt)}. ` : `${detail.data.employee.name} has not confirmed these hours yet. `}
        {approval?.approvedAt ? `Approved by ${approval.managerName ?? "a manager"} ${dateTimeLabel(approval.approvedAt)}.` : "Not approved yet."}
        {card.openShifts > 0 ? " A shift is still open, so the week cannot be approved yet." : ""}
      </p>

      <ul className="divide-y divide-black/5 rounded-xl border border-black/10 bg-white">
        {card.days.map((day) => (
          <li key={day.date} className="px-3 py-2.5 sm:px-4">
            <div className="flex items-baseline justify-between gap-3">
              <p className="font-medium">{dayLabel(day.date, "long")}</p>
              <p className={`tabular-nums ${day.overtimeMinutes ? "font-semibold text-clay" : "text-muted"}`}>
                {day.paidMinutes ? hm(day.paidMinutes) : "No time"}
                {day.overtimeMinutes ? ` (${hm(day.overtimeMinutes)} over)` : ""}
              </p>
            </div>
            {day.shifts.map((shift) => (
              <div key={shift.id} className="mt-1.5">
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <p>
                    {timeLabel(shift.clockIn)} – {shift.clockOut ? timeLabel(shift.clockOut) : <span className={shift.missedCheckOut ? "font-semibold text-rust" : ""}>{shift.missedCheckOut ? "never checked out" : "still on shift"}</span>}
                    <span className="text-muted">
                      {" "}
                      · paid {hm(shift.paidMinutes)}
                      {shift.mealMinutes ? ` · meal ${hm(shift.mealMinutes)}` : ""}
                      {shift.source === "manual" ? " · added by a manager" : ""}
                    </span>
                    {shift.edited ? <span className="ml-1.5"><Badge>Corrected</Badge></span> : null}
                  </p>
                  {manage ? (
                    <button className="btn btn-ghost btn-sm" type="button" aria-expanded={fixing === shift.id} onClick={() => setFixing(fixing === shift.id ? null : shift.id)}>
                      Fix time
                    </button>
                  ) : null}
                </div>
                {manage && fixing === shift.id ? (
                  <div className="mt-2">
                    <FixShift
                      shift={shift}
                      zone={zone}
                      onSaved={(text) => {
                        setFixing(null);
                        onSaved(text);
                        detail.reload();
                      }}
                      onError={onError}
                    />
                  </div>
                ) : null}
              </div>
            ))}
          </li>
        ))}
      </ul>

      {edits.length ? (
        <div>
          <p className="mb-1.5 text-sm font-semibold">Corrections</p>
          <ul className="space-y-1.5 text-sm">
            {edits.map((edit) => (
              <li key={edit.id} className="rounded-lg bg-black/[0.03] px-3 py-2">
                <p>
                  <span className="font-medium">{edit.editorName}</span> changed {dateTimeLabel(edit.before.clockIn)} – {edit.before.clockOut ? timeLabel(edit.before.clockOut) : "open"} to{" "}
                  {dateTimeLabel(edit.after.clockIn)} – {edit.after.clockOut ? timeLabel(edit.after.clockOut) : "open"}
                </p>
                <p className="text-muted">
                  “{edit.reason}” · {dateTimeLabel(edit.createdAt)}
                </p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** Correct one shift's check-in and check-out. A reason is required and kept. */
function FixShift({
  shift,
  zone,
  closing = false,
  onSaved,
  onError,
}: {
  shift: Pick<CardShift, "id" | "clockIn" | "clockOut">;
  zone: string;
  /** Only the missing check-out is asked for. */
  closing?: boolean;
  onSaved: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [clockIn, setClockIn] = useState(toLocalInput(shift.clockIn));
  const [clockOut, setClockOut] = useState(toLocalInput(shift.clockOut));
  const [reason, setReason] = useState(closing ? "Forgot to check out" : "");
  const [busy, setBusy] = useState(false);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (closing && !clockOut) {
      onError("Enter when they left.");
      return;
    }
    setBusy(true);
    try {
      const result = await post<{ message: string }>(`/tracking/shifts/${shift.id}/edit?tz=${encodeURIComponent(zone)}`, {
        clockIn: fromLocalInput(clockIn),
        clockOut: fromLocalInput(clockOut),
        reason,
      });
      onSaved(result.message);
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Could not correct that shift.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="grid gap-3 rounded-xl border border-black/10 bg-white p-3 sm:grid-cols-[1fr_1fr_2fr_auto] sm:items-end" onSubmit={save}>
      {!closing ? (
        <Field label="Checked in">
          <input className="field" type="datetime-local" required value={clockIn} onChange={(event) => setClockIn(event.target.value)} />
        </Field>
      ) : null}
      <Field label={closing ? "Left at" : "Checked out"} hint={closing ? undefined : "Leave empty only if they are still on shift."}>
        <input className="field" type="datetime-local" required={closing} value={clockOut} onChange={(event) => setClockOut(event.target.value)} />
      </Field>
      <Field label="Reason">
        <input className="field" required minLength={3} maxLength={300} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why the time is changing" />
      </Field>
      <button className="btn btn-primary mb-0.5" type="submit" disabled={busy}>
        {busy ? "Saving…" : "Save"}
      </button>
    </form>
  );
}

function SettingsForm({ zone, onSaved, onError }: { zone: string; onSaved: (message: string) => void; onError: (message: string) => void }) {
  const current = useResource<{ dailyOvertimeMinutes: number; weeklyOvertimeMinutes: number; weekStartsOn: number; timeZone: string | null }>(
    "/tracking/timekeeping/settings",
  );
  const [daily, setDaily] = useState("");
  const [weekly, setWeekly] = useState("");
  const [weekStartsOn, setWeekStartsOn] = useState(1);
  const [timeZone, setTimeZone] = useState(zone);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!current.data) return;
    setDaily(String(current.data.dailyOvertimeMinutes / 60));
    setWeekly(String(current.data.weeklyOvertimeMinutes / 60));
    setWeekStartsOn(current.data.weekStartsOn);
    setTimeZone(current.data.timeZone ?? zone);
  }, [current.data, zone]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    const dailyHours = Number(daily);
    const weeklyHours = Number(weekly);
    if (!(dailyHours > 0) || !(weeklyHours > 0)) {
      onError("Enter the overtime limits in hours, such as 8 and 40.");
      return;
    }
    setBusy(true);
    try {
      const result = await post<{ message: string }>("/tracking/timekeeping/settings", {
        dailyOvertimeMinutes: Math.round(dailyHours * 60),
        weeklyOvertimeMinutes: Math.round(weeklyHours * 60),
        weekStartsOn,
        timeZone: timeZone.trim(),
      });
      onSaved(result.message);
      current.reload();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Could not save the settings.");
    } finally {
      setBusy(false);
    }
  }

  if (current.error) return <Notice tone="bad">{current.error}</Notice>;
  if (!current.data) return <SkeletonList rows={2} />;

  return (
    <form className="card max-w-2xl space-y-4 p-5" onSubmit={save}>
      <h2 className="font-semibold">Timekeeping settings</h2>
      <p className="text-sm text-muted">Overtime here is a warning on timecards. It does not change pay.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Overtime after (hours a day)">
          <input className="field" inputMode="decimal" required value={daily} onChange={(event) => setDaily(event.target.value)} />
        </Field>
        <Field label="Overtime after (hours a week)">
          <input className="field" inputMode="decimal" required value={weekly} onChange={(event) => setWeekly(event.target.value)} />
        </Field>
        <Field label="Week starts on">
          <select className="field" value={weekStartsOn} onChange={(event) => setWeekStartsOn(Number(event.target.value))}>
            {WEEK_DAYS.map((day, index) => (
              <option key={day} value={index}>
                {day}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Warehouse time zone" hint={`This browser is in ${zone}.`}>
          <input className="field" required value={timeZone} onChange={(event) => setTimeZone(event.target.value)} placeholder="America/Los_Angeles" />
        </Field>
      </div>
      <button className="btn btn-primary" type="submit" disabled={busy}>
        {busy ? "Saving…" : "Save settings"}
      </button>
    </form>
  );
}
