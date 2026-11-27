import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { activity, breaks, employees, segments, shiftEdits, shifts, timecardApprovals, timekeepingSettings, type Database } from "@opsengine/db";
import type { Principal } from "@opsengine/kernel";
import { and, desc, eq, gte, inArray, isNull, lt } from "drizzle-orm";
import { DbService } from "../db.service.js";
import {
  buildTimecard,
  clipSpans,
  DEFAULT_SETTINGS,
  isMissedCheckOut,
  isTimeZone,
  localDate,
  planShiftEdit,
  weekRange,
  weekStartFor,
  type TimekeepingSettings,
} from "./timecard.js";

type Conn = Database;
type Shift = typeof shifts.$inferSelect;
type Employee = typeof employees.$inferSelect;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function minutesLabel(minutes: number) {
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours} h ${minutes % 60} min` : `${minutes} min`;
}

function person(row: Employee) {
  return {
    id: row.id,
    name: row.name,
    badgeCode: row.badgeCode,
    employmentType: row.employmentType,
    agency: row.agency ?? null,
    clientId: row.clientId,
    active: row.active,
  };
}

@Injectable()
export class TimecardsService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  // ---------------------------------------------------------------- settings

  async settings() {
    const [row] = await this.db.db.select().from(timekeepingSettings).where(eq(timekeepingSettings.id, 1)).limit(1);
    return {
      dailyOvertimeMinutes: row?.dailyOvertimeMinutes ?? DEFAULT_SETTINGS.dailyOvertimeMinutes,
      weeklyOvertimeMinutes: row?.weeklyOvertimeMinutes ?? DEFAULT_SETTINGS.weeklyOvertimeMinutes,
      weekStartsOn: row?.weekStartsOn ?? DEFAULT_SETTINGS.weekStartsOn,
      timeZone: row?.timeZone ?? null,
      updatedAt: row?.updatedAt ?? null,
    };
  }

  async saveSettings(
    principal: Principal,
    input: { dailyOvertimeMinutes: number; weeklyOvertimeMinutes: number; weekStartsOn: number; timeZone: string },
  ) {
    if (!isTimeZone(input.timeZone)) throw new ConflictException("That time zone is not recognised.");
    const values = { ...input, updatedBy: principal.id, updatedAt: new Date() };
    await this.db.db
      .insert(timekeepingSettings)
      .values({ id: 1, ...values })
      .onConflictDoUpdate({ target: timekeepingSettings.id, set: values });
    await this.record(
      principal.id,
      "tracking.timekeeping_settings_saved",
      "timekeeping_settings",
      "1",
      `${principal.name} set overtime to over ${minutesLabel(input.dailyOvertimeMinutes)} a day and ${minutesLabel(input.weeklyOvertimeMinutes)} a week, weeks starting on day ${input.weekStartsOn}, time zone ${input.timeZone}.`,
    );
    return { message: "Timekeeping settings saved." };
  }

  /** The settings to compute with. Until a manager sets a zone, the browser's zone is used. */
  private async effective(zoneHint?: string): Promise<TimekeepingSettings & { timeZoneSet: boolean }> {
    const saved = await this.settings();
    const timeZone = saved.timeZone ?? (zoneHint && isTimeZone(zoneHint) ? zoneHint : DEFAULT_SETTINGS.timeZone);
    return { ...saved, timeZone, timeZoneSet: Boolean(saved.timeZone) };
  }

  private weekOf(value: string | undefined, settings: TimekeepingSettings) {
    const date = value && DATE.test(value) ? value : localDate(new Date(), settings.timeZone);
    return weekStartFor(date, settings.weekStartsOn);
  }

  // ---------------------------------------------------------------- reading

  /** Shifts that start inside the week, with their task and meal time, edits and approvals. */
  private async loadWeek(conn: Conn, weekStart: string, settings: TimekeepingSettings, employeeIds?: string[]) {
    const { from, to } = weekRange(weekStart, settings.timeZone);
    if (employeeIds && employeeIds.length === 0) return { shiftRows: [], segmentRows: [], mealRows: [], editRows: [], approvalRows: [] };
    const inWeek = and(gte(shifts.clockIn, from), lt(shifts.clockIn, to));
    const shiftRows = await conn
      .select()
      .from(shifts)
      .where(employeeIds ? and(inWeek, inArray(shifts.employeeId, employeeIds)) : inWeek);
    const ids = shiftRows.map((row) => row.id);
    const people = [...new Set(shiftRows.map((row) => row.employeeId).concat(employeeIds ?? []))];
    const [segmentRows, mealRows, editRows, approvalRows] = await Promise.all([
      ids.length ? conn.select().from(segments).where(inArray(segments.shiftId, ids)) : Promise.resolve([]),
      ids.length ? conn.select().from(breaks).where(inArray(breaks.shiftId, ids)) : Promise.resolve([]),
      ids.length ? conn.select().from(shiftEdits).where(inArray(shiftEdits.shiftId, ids)).orderBy(desc(shiftEdits.createdAt)) : Promise.resolve([]),
      people.length
        ? conn
            .select()
            .from(timecardApprovals)
            .where(and(eq(timecardApprovals.weekStart, weekStart), isNull(timecardApprovals.revokedAt), inArray(timecardApprovals.employeeId, people)))
        : Promise.resolve([]),
    ]);
    return { shiftRows, segmentRows, mealRows, editRows, approvalRows };
  }

  private cardFor(employeeId: string, weekStart: string, week: Awaited<ReturnType<TimecardsService["loadWeek"]>>, settings: TimekeepingSettings, now: Date) {
    const edited = new Set(week.editRows.map((row) => row.shiftId));
    const own = week.shiftRows.filter((row) => row.employeeId === employeeId);
    const ids = new Set(own.map((row) => row.id));
    return buildTimecard({
      weekStart,
      shifts: own.map((row) => ({ id: row.id, clockIn: row.clockIn, clockOut: row.clockOut, source: row.source, edited: edited.has(row.id) })),
      segments: week.segmentRows.filter((row) => ids.has(row.shiftId)),
      meals: week.mealRows.filter((row) => ids.has(row.shiftId)),
      settings,
      now,
    });
  }

  private approvalView(row: typeof timecardApprovals.$inferSelect | undefined) {
    if (!row) return null;
    return {
      approvedAt: row.approvedAt,
      managerName: row.managerName,
      employeeConfirmedAt: row.employeeConfirmedAt,
    };
  }

  /** Everyone with time in the week, with totals and what needs a look. */
  async list(weekOf: string | undefined, zoneHint: string | undefined, clientId?: string) {
    const settings = await this.effective(zoneHint);
    const weekStart = this.weekOf(weekOf, settings);
    const week = await this.loadWeek(this.db.db, weekStart, settings);
    const ids = [...new Set(week.shiftRows.map((row) => row.employeeId))];
    const people = ids.length ? await this.db.db.select().from(employees).where(inArray(employees.id, ids)) : [];
    const now = new Date();
    const rows = people
      .filter((row) => !clientId || row.clientId === clientId)
      .map((row) => {
        const card = this.cardFor(row.id, weekStart, week, settings, now);
        return {
          employee: person(row),
          paidMinutes: card.paidMinutes,
          mealMinutes: card.mealMinutes,
          dailyOvertimeMinutes: card.dailyOvertimeMinutes,
          weeklyOvertimeMinutes: card.weeklyOvertimeMinutes,
          missedCheckOuts: card.missedCheckOuts,
          openShifts: card.openShifts,
          edited: card.days.some((day) => day.shifts.some((shift) => shift.edited)),
          days: card.days.map((day) => ({ date: day.date, paidMinutes: day.paidMinutes, overtimeMinutes: day.overtimeMinutes })),
          approval: this.approvalView(week.approvalRows.find((item) => item.employeeId === row.id)),
        };
      })
      .sort((a, b) => a.employee.name.localeCompare(b.employee.name));
    return { weekStart, settings, people: rows };
  }

  /** One person's week, day by day, with every correction made to it. */
  async card(employeeId: string, weekOf: string | undefined, zoneHint: string | undefined) {
    const settings = await this.effective(zoneHint);
    const weekStart = this.weekOf(weekOf, settings);
    const employee = await this.employee(this.db.db, employeeId);
    const week = await this.loadWeek(this.db.db, weekStart, settings, [employee.id]);
    const card = this.cardFor(employee.id, weekStart, week, settings, new Date());
    return {
      weekStart,
      settings,
      employee: person(employee),
      card,
      edits: week.editRows.map((row) => ({
        id: row.id,
        shiftId: row.shiftId,
        editorName: row.editorName,
        reason: row.reason,
        before: row.before,
        after: row.after,
        createdAt: row.createdAt,
      })),
      approval: this.approvalView(week.approvalRows[0]),
    };
  }

  /** Several timecards at once, for printing: chosen people, or one agency's temps. */
  async print(weekOf: string | undefined, zoneHint: string | undefined, filter: { employeeIds?: string[]; agency?: string }) {
    const settings = await this.effective(zoneHint);
    const weekStart = this.weekOf(weekOf, settings);
    let people: Employee[];
    if (filter.employeeIds?.length) {
      people = await this.db.db.select().from(employees).where(inArray(employees.id, filter.employeeIds));
    } else {
      const week = await this.loadWeek(this.db.db, weekStart, settings);
      const ids = [...new Set(week.shiftRows.map((row) => row.employeeId))];
      people = ids.length ? await this.db.db.select().from(employees).where(inArray(employees.id, ids)) : [];
      if (filter.agency) people = people.filter((row) => (row.agency ?? "").toLowerCase() === filter.agency!.toLowerCase());
    }
    const week = await this.loadWeek(this.db.db, weekStart, settings, people.map((row) => row.id));
    const now = new Date();
    return {
      weekStart,
      settings,
      cards: people
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((row) => ({
          employee: person(row),
          card: this.cardFor(row.id, weekStart, week, settings, now),
          approval: this.approvalView(week.approvalRows.find((item) => item.employeeId === row.id)),
        })),
    };
  }

  /** Check-outs that never happened: open shifts older than 14 h or from an earlier day. */
  async attention(zoneHint: string | undefined) {
    const settings = await this.effective(zoneHint);
    const now = new Date();
    const open = await this.db.db
      .select({ shift: shifts, employee: employees })
      .from(shifts)
      .innerJoin(employees, eq(employees.id, shifts.employeeId))
      .where(isNull(shifts.clockOut));
    return {
      missedCheckOuts: open
        .filter((row) => isMissedCheckOut(row.shift, now, settings.timeZone))
        .sort((a, b) => a.shift.clockIn.getTime() - b.shift.clockIn.getTime())
        .map((row) => ({
          shiftId: row.shift.id,
          clockIn: row.shift.clockIn,
          weekStart: weekStartFor(localDate(row.shift.clockIn, settings.timeZone), settings.weekStartsOn),
          employee: person(row.employee),
        })),
    };
  }

  // ---------------------------------------------------------------- changing

  /**
   * A manager corrects a check-in or check-out, with a reason. Task and meal time is kept inside the new times,
   * the whole before/after is saved, and that week's confirmation and approval are withdrawn.
   */
  async editShift(
    principal: Principal,
    shiftId: string,
    input: { clockIn: string; clockOut: string | null; reason: string },
    zoneHint?: string,
  ) {
    const settings = await this.effective(zoneHint);
    const now = new Date();
    return this.db.db.transaction(async (raw) => {
      const tx = raw as unknown as Conn;
      const [shift] = await tx.select().from(shifts).where(eq(shifts.id, shiftId)).limit(1);
      if (!shift) throw new NotFoundException("That shift is not on file.");
      const employee = await this.employee(tx, shift.employeeId);
      const clockIn = new Date(input.clockIn);
      const clockOut = input.clockOut ? new Date(input.clockOut) : null;
      const near = 3 * 24 * 60 * 60 * 1000;
      const others = (
        await tx
          .select()
          .from(shifts)
          .where(and(eq(shifts.employeeId, shift.employeeId), gte(shifts.clockIn, new Date(Math.min(clockIn.getTime(), shift.clockIn.getTime()) - near))))
      ).filter((row) => row.id !== shift.id);
      const plan = planShiftEdit({ shift, clockIn, clockOut, others, now });
      if (!plan.ok) throw new ConflictException(plan.reason);

      const segmentRows = await tx.select().from(segments).where(eq(segments.shiftId, shift.id));
      const mealRows = await tx.select().from(breaks).where(eq(breaks.shiftId, shift.id));
      const snapshot = (row: { clockIn: Date; clockOut: Date | null }, segs: { id: string; startedAt: Date; endedAt: Date | null; taskCode: string }[], meals: { id: string; startedAt: Date; endedAt: Date | null }[]) => ({
        clockIn: row.clockIn,
        clockOut: row.clockOut,
        tasks: segs.map((item) => ({ id: item.id, taskCode: item.taskCode, startedAt: item.startedAt, endedAt: item.endedAt })),
        meals: meals.map((item) => ({ id: item.id, startedAt: item.startedAt, endedAt: item.endedAt })),
      });
      const before = snapshot(shift, segmentRows, mealRows);

      const segmentChanges = clipSpans(segmentRows, plan.clockIn, plan.clockOut);
      for (const change of segmentChanges) {
        if (change.action === "delete") await tx.delete(segments).where(eq(segments.id, change.id));
        if (change.action === "update") {
          const original = segmentRows.find((row) => row.id === change.id);
          await tx
            .update(segments)
            .set({
              startedAt: change.startedAt,
              endedAt: change.endedAt,
              // A task that was still running when the shift closed ends with the check-out.
              endReason: original?.endedAt ? original.endReason : change.endedAt ? "clock_out" : null,
            })
            .where(eq(segments.id, change.id));
        }
      }
      const mealChanges = clipSpans(mealRows, plan.clockIn, plan.clockOut);
      for (const change of mealChanges) {
        if (change.action === "delete") await tx.delete(breaks).where(eq(breaks.id, change.id));
        if (change.action === "update") await tx.update(breaks).set({ startedAt: change.startedAt, endedAt: change.endedAt }).where(eq(breaks.id, change.id));
      }
      await tx.update(shifts).set({ clockIn: plan.clockIn, clockOut: plan.clockOut }).where(eq(shifts.id, shift.id));

      const keptSegments = segmentChanges
        .filter((change) => change.action !== "delete")
        .map((change) => ({ ...change, taskCode: segmentRows.find((row) => row.id === change.id)?.taskCode ?? "" }));
      const keptMeals = mealChanges.filter((change) => change.action !== "delete");
      const after = snapshot({ clockIn: plan.clockIn, clockOut: plan.clockOut }, keptSegments, keptMeals);
      const reason = input.reason.trim();
      await tx.insert(shiftEdits).values({
        shiftId: shift.id,
        employeeId: employee.id,
        editedBy: principal.id,
        editorName: principal.name,
        reason,
        before,
        after,
      });

      // The hours changed, so whatever was confirmed or approved for those weeks no longer stands.
      const weeks = new Set([
        weekStartFor(localDate(shift.clockIn, settings.timeZone), settings.weekStartsOn),
        weekStartFor(localDate(plan.clockIn, settings.timeZone), settings.weekStartsOn),
      ]);
      for (const week of weeks) {
        await tx
          .update(timecardApprovals)
          .set({ revokedAt: now, revokedReason: `${principal.name} corrected a shift: ${reason}` })
          .where(and(eq(timecardApprovals.employeeId, employee.id), eq(timecardApprovals.weekStart, week), isNull(timecardApprovals.revokedAt)));
      }

      const removed = segmentChanges.filter((change) => change.action === "delete").length + mealChanges.filter((change) => change.action === "delete").length;
      const fmt = (value: Date | null) => (value ? value.toISOString() : "still open");
      await this.record(
        principal.id,
        "tracking.shift_corrected",
        "shift",
        shift.id,
        `${principal.name} corrected ${employee.name}'s shift from ${fmt(shift.clockIn)}–${fmt(shift.clockOut)} to ${fmt(plan.clockIn)}–${fmt(plan.clockOut)}. Reason: ${reason}`,
        tx,
      );
      return {
        message: `${employee.name}'s shift is corrected.${removed ? ` ${removed} piece(s) of time outside the new times were removed; the history keeps a copy.` : ""}`,
      };
    });
  }

  /** A manager signs off a person's week. Not while a check-out is missing. */
  async approve(principal: Principal, employeeId: string, weekOf: string | undefined, zoneHint?: string) {
    const settings = await this.effective(zoneHint);
    const weekStart = this.weekOf(weekOf, settings);
    const employee = await this.employee(this.db.db, employeeId);
    const week = await this.loadWeek(this.db.db, weekStart, settings, [employee.id]);
    const card = this.cardFor(employee.id, weekStart, week, settings, new Date());
    if (card.openShifts > 0) throw new ConflictException(`${employee.name} still has an open shift this week. Fix the check-out first.`);
    if (card.paidMinutes === 0) throw new ConflictException(`${employee.name} has no time this week.`);
    const totals = {
      paidMinutes: card.paidMinutes,
      mealMinutes: card.mealMinutes,
      dailyOvertimeMinutes: card.dailyOvertimeMinutes,
      weeklyOvertimeMinutes: card.weeklyOvertimeMinutes,
    };
    const now = new Date();
    const current = week.approvalRows[0];
    if (current) {
      await this.db.db
        .update(timecardApprovals)
        .set({ approvedBy: principal.id, managerName: principal.name, approvedAt: now, totals })
        .where(eq(timecardApprovals.id, current.id));
    } else {
      await this.db.db.insert(timecardApprovals).values({ employeeId: employee.id, weekStart, approvedBy: principal.id, managerName: principal.name, approvedAt: now, totals });
    }
    await this.record(principal.id, "tracking.timecard_approved", "employee", employee.id, `${principal.name} approved ${employee.name}'s week of ${weekStart}: ${minutesLabel(card.paidMinutes)}.`);
    return { message: `${employee.name}'s week is approved.` };
  }

  async unapprove(principal: Principal, employeeId: string, weekOf: string | undefined, zoneHint?: string) {
    const settings = await this.effective(zoneHint);
    const weekStart = this.weekOf(weekOf, settings);
    const employee = await this.employee(this.db.db, employeeId);
    await this.db.db
      .update(timecardApprovals)
      .set({ revokedAt: new Date(), revokedReason: `${principal.name} removed the approval.` })
      .where(and(eq(timecardApprovals.employeeId, employee.id), eq(timecardApprovals.weekStart, weekStart), isNull(timecardApprovals.revokedAt)));
    await this.record(principal.id, "tracking.timecard_unapproved", "employee", employee.id, `${principal.name} removed the approval of ${employee.name}'s week of ${weekStart}.`);
    return { message: `${employee.name}'s week is no longer approved. Their confirmation was cleared too.` };
  }

  // ---------------------------------------------------------------- the employee

  /** The person's own week, for the floor phone. */
  async myWeek(badge: string, weekOf: string | undefined, zoneHint?: string) {
    const employee = await this.employeeByBadge(badge);
    const result = await this.card(employee.id, weekOf, zoneHint);
    return { weekStart: result.weekStart, card: result.card, approval: result.approval, corrections: result.edits.length };
  }

  /** The employee confirms their hours for a finished week. */
  async confirm(badge: string, weekOf: string | undefined, zoneHint?: string) {
    const settings = await this.effective(zoneHint);
    const weekStart = this.weekOf(weekOf, settings);
    const employee = await this.employeeByBadge(badge);
    const week = await this.loadWeek(this.db.db, weekStart, settings, [employee.id]);
    const card = this.cardFor(employee.id, weekStart, week, settings, new Date());
    if (card.paidMinutes === 0) throw new ConflictException("There are no hours to confirm for that week.");
    if (card.openShifts > 0) throw new ConflictException("Check out first. A week with an open shift cannot be confirmed.");
    const current = week.approvalRows[0];
    const now = new Date();
    if (current?.employeeConfirmedAt) return { message: "You already confirmed this week." };
    if (current) {
      await this.db.db.update(timecardApprovals).set({ employeeConfirmedAt: now }).where(eq(timecardApprovals.id, current.id));
    } else {
      await this.db.db.insert(timecardApprovals).values({ employeeId: employee.id, weekStart, employeeConfirmedAt: now });
    }
    await this.record(null, "tracking.timecard_confirmed", "employee", employee.id, `${employee.name} confirmed their hours for the week of ${weekStart}: ${minutesLabel(card.paidMinutes)}.`);
    return { message: `Thanks ${employee.name}. Your hours for that week are confirmed.` };
  }

  // ---------------------------------------------------------------- helpers

  private async employee(conn: Conn, id: string) {
    const [row] = await conn.select().from(employees).where(eq(employees.id, id)).limit(1);
    if (!row) throw new NotFoundException("That person is not on file.");
    return row;
  }

  private async employeeByBadge(badge: string) {
    const [row] = await this.db.db.select().from(employees).where(eq(employees.badgeCode, badge.trim().toUpperCase())).limit(1);
    if (!row || !row.active) throw new NotFoundException("That badge is not on the floor.");
    return row;
  }

  private async record(actorId: string | null, action: string, entityType: string, entityId: string, summary: string, conn: Conn = this.db.db) {
    await conn.insert(activity).values({ actorId, action, module: "tracking", entityType, entityId, after: { summary } });
  }
}

export type { Shift };
