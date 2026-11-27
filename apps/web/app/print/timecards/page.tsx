"use client";

// Printable weekly timecards, one person per page, for temp agencies and the files.
// Use the browser's Print, then "Save as PDF". Outside the app layout so no menu prints.

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import { dateTimeLabel, dayLabel, decimalHours, hm, timeLabel, weekLabel, type Approval, type Card, type CardPerson, type TimecardSettings } from "@/lib/timecards";

type PrintData = { weekStart: string; settings: TimecardSettings; cards: { employee: CardPerson; card: Card; approval: Approval }[] };

export default function PrintTimecardsPage() {
  return (
    <Suspense fallback={<p className="p-8 text-sm">Loading timecards…</p>}>
      <PrintTimecards />
    </Suspense>
  );
}

function PrintTimecards() {
  const params = useSearchParams();
  const [data, setData] = useState<PrintData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const query = new URLSearchParams();
    for (const key of ["weekOf", "tz", "employees", "agency"]) {
      const value = params.get(key);
      if (value) query.set(key, value);
    }
    api<PrintData>(`/tracking/timecards/print?${query.toString()}`)
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load the timecards."));
  }, [params]);

  if (error) return <p className="p-8 text-sm text-rust">{error}</p>;
  if (!data) return <p className="p-8 text-sm">Loading timecards…</p>;
  const zone = data.settings.timeZone;
  const agency = params.get("agency");

  return (
    <main className="mx-auto max-w-3xl bg-white p-6 text-ink print:p-0">
      <style>{`@media print { @page { margin: 14mm; } .timecard { break-after: page; } .timecard:last-child { break-after: auto; } }`}</style>
      <div className="mb-6 flex items-center justify-between gap-3 print:hidden">
        <p className="text-sm text-muted">
          {data.cards.length} timecard{data.cards.length === 1 ? "" : "s"} · week of {weekLabel(data.weekStart)}
          {agency ? ` · ${agency}` : ""}
        </p>
        <button className="btn btn-primary btn-sm" type="button" onClick={() => window.print()}>
          Print or save as PDF
        </button>
      </div>
      {data.cards.length === 0 ? <p className="text-sm">Nobody has time for this week.</p> : null}
      {data.cards.map(({ employee, card, approval }) => (
        <section key={employee.id} className="timecard mb-10 print:mb-0">
          <header className="mb-4 flex items-start justify-between gap-4 border-b-2 border-ink pb-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em]">Weekly timecard</p>
              <h1 className="text-2xl font-semibold">{employee.name}</h1>
              <p className="text-sm">
                Badge {employee.badgeCode}
                {employee.employmentType === "temp" ? ` · Temp${employee.agency ? ` · ${employee.agency}` : ""}` : " · Employee"}
              </p>
            </div>
            <div className="text-right text-sm">
              <p className="font-semibold">{weekLabel(card.weekStart)}</p>
              <p>Times in {zone}</p>
            </div>
          </header>
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-ink text-left">
                <th className="py-1.5 pr-2">Day</th>
                <th className="py-1.5 pr-2">In</th>
                <th className="py-1.5 pr-2">Out</th>
                <th className="py-1.5 pr-2 text-right">Meal</th>
                <th className="py-1.5 pr-2 text-right">Paid</th>
                <th className="py-1.5 text-right">Hours</th>
              </tr>
            </thead>
            <tbody>
              {card.days.map((day) =>
                day.shifts.length === 0 ? (
                  <tr key={day.date} className="border-b border-black/15 text-black/50">
                    <td className="py-1.5 pr-2">{dayLabel(day.date)}</td>
                    <td className="py-1.5 pr-2" colSpan={5}>
                      —
                    </td>
                  </tr>
                ) : (
                  day.shifts.map((shift, index) => (
                    <tr key={shift.id} className="border-b border-black/15">
                      <td className="py-1.5 pr-2">{index === 0 ? dayLabel(day.date) : ""}</td>
                      <td className="py-1.5 pr-2">{timeLabel(shift.clockIn, zone)}</td>
                      <td className="py-1.5 pr-2">{shift.clockOut ? timeLabel(shift.clockOut, zone) : "MISSING"}</td>
                      <td className="py-1.5 pr-2 text-right tabular-nums">{shift.mealMinutes ? hm(shift.mealMinutes) : ""}</td>
                      <td className="py-1.5 pr-2 text-right tabular-nums">
                        {hm(shift.paidMinutes)}
                        {shift.edited ? " *" : ""}
                      </td>
                      <td className="py-1.5 text-right tabular-nums">{decimalHours(shift.paidMinutes)}</td>
                    </tr>
                  ))
                ),
              )}
            </tbody>
            <tfoot>
              <tr className="font-semibold">
                <td className="pt-2" colSpan={4}>
                  Total paid
                </td>
                <td className="pt-2 pr-2 text-right tabular-nums">{hm(card.paidMinutes)}</td>
                <td className="pt-2 text-right tabular-nums">{decimalHours(card.paidMinutes)}</td>
              </tr>
              {card.dailyOvertimeMinutes || card.weeklyOvertimeMinutes ? (
                <tr>
                  <td className="pt-1" colSpan={6}>
                    Over {hm(data.settings.dailyOvertimeMinutes)} a day: {decimalHours(card.dailyOvertimeMinutes)} h · Over {hm(data.settings.weeklyOvertimeMinutes)} a week:{" "}
                    {decimalHours(card.weeklyOvertimeMinutes)} h
                  </td>
                </tr>
              ) : null}
            </tfoot>
          </table>
          {card.days.some((day) => day.shifts.some((shift) => shift.edited)) ? <p className="mt-2 text-xs">* Corrected by a manager. The reason is kept in Ops Engine.</p> : null}
          <div className="mt-10 grid grid-cols-2 gap-8 text-sm">
            <div>
              <div className="h-10 border-b border-ink" />
              <p className="mt-1">Employee signature</p>
              <p className="text-xs">{approval?.employeeConfirmedAt ? `Confirmed on the floor phone ${dateTimeLabel(approval.employeeConfirmedAt, zone)}` : "Date:"}</p>
            </div>
            <div>
              <div className="h-10 border-b border-ink" />
              <p className="mt-1">Manager signature</p>
              <p className="text-xs">{approval?.approvedAt ? `Approved by ${approval.managerName ?? "a manager"} ${dateTimeLabel(approval.approvedAt, zone)}` : "Date:"}</p>
            </div>
          </div>
        </section>
      ))}
    </main>
  );
}
