import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Op, Sequelize } from 'sequelize';
import {
  CalendarEventKind,
  CreateHolidayDto,
  HolidayType,
  UpdateHolidayDto,
  CreateCalendarEventDto,
  EmployeeStatus,
  GetCalendarQueryDto,
  UpdateCalendarEventDto,
} from '@app/common';
import { TenantModelProviderService } from './tenant-model-provider.service';
import { writePayrollAudit as writeAudit } from './payroll-access';
import { diffFields, fullName, workspaceError } from './workspace-shared';

export type CalendarEntryKind = 'EVENT' | 'HOLIDAY' | 'BIRTHDAY' | 'ANNIVERSARY';

export interface CalendarEntry {
  id: string;
  title: string;
  /** YYYY-MM-DD */
  date: string;
  kind: CalendarEntryKind;
  startTime: string | null;
  endTime: string | null;
  location: string | null;
  description: string | null;
  /** Holidays only: NATIONAL, FESTIVAL or COMPANY. */
  holidayType: string | null;
  /** Holidays only: staff may take it; the office stays open. */
  isOptional: boolean;
  /** The person a birthday or anniversary belongs to. */
  employee: { id: string; name: string; avatarUrl: string | null } | null;
  /** True for stored events the caller may change; birthdays and anniversaries never are. */
  editable: boolean;
}

/** People shown on the calendar: current staff, including those on leave. */
const CURRENT_STAFF = [EmployeeStatus.ACTIVE, EmployeeStatus.ON_LEAVE];

const pad = (n: number) => String(n).padStart(2, '0');
const isLeap = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

/**
 * The Company Calendar for one month: stored events and holidays, plus
 * birthdays and work anniversaries worked out from employee records — so they
 * follow a corrected date of birth or joining date without anyone re-entering
 * them. Only the day and month of a birthday are ever returned, never the year.
 */
@Injectable()
export class CalendarService {
  private readonly logger = new Logger(CalendarService.name);

  constructor(private readonly modelProvider: TenantModelProviderService) {}

  private toEntry(event: any, editable: boolean): CalendarEntry {
    return {
      id: event.id,
      title: event.title,
      date: event.date,
      kind: event.kind,
      startTime: event.startTime ?? null,
      endTime: event.endTime ?? null,
      location: event.location ?? null,
      description: event.description ?? null,
      holidayType: event.kind === CalendarEventKind.HOLIDAY ? (event.holidayType ?? HolidayType.COMPANY) : null,
      isOptional: event.kind === CalendarEventKind.HOLIDAY ? Boolean(event.isOptional) : false,
      employee: null,
      editable,
    };
  }

  async getMonth(tenantId: string, query: GetCalendarQueryDto, canEdit = false) {
    const { year, month } = query;
    const first = `${year}-${pad(month)}-01`;
    const last = `${year}-${pad(month)}-${pad(new Date(year, month, 0).getDate())}`;

    const Event = await this.modelProvider.getCalendarEventModel(tenantId);
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const monthOf = (column: string) => Sequelize.where(Sequelize.fn('date_part', 'month', Sequelize.col(column)), month);

    const [events, birthdays, anniversaries] = await Promise.all([
      Event.findAll({
        where: { tenantId, date: { [Op.between]: [first, last] } },
        order: [['date', 'ASC'], ['startTime', 'ASC NULLS FIRST'], ['title', 'ASC']],
      }),
      Employee.findAll({
        where: { tenantId, status: { [Op.in]: CURRENT_STAFF }, dateOfBirth: { [Op.ne]: null }, [Op.and]: [monthOf('dateOfBirth')] },
        attributes: ['id', 'firstName', 'lastName', 'avatarUrl', 'dateOfBirth'],
      }),
      Employee.findAll({
        where: {
          tenantId,
          status: { [Op.in]: CURRENT_STAFF },
          joiningDate: { [Op.ne]: null, [Op.lt]: `${year}-01-01` },
          [Op.and]: [monthOf('joiningDate')],
        },
        attributes: ['id', 'firstName', 'lastName', 'avatarUrl', 'joiningDate'],
      }),
    ]);

    const dayInMonth = (isoDay: string) => {
      const day = Number(isoDay.slice(8, 10));
      // A 29 February birthday is marked on the 28th in other years.
      return month === 2 && day === 29 && !isLeap(year) ? 28 : day;
    };
    const person = (e: any) => ({ id: e.id, name: fullName(e), avatarUrl: e.avatarUrl ?? null });

    const entries: CalendarEntry[] = [
      ...events.map((e) => this.toEntry(e, canEdit)),
      ...birthdays.map((e: any) => ({
        id: `birthday-${e.id}-${year}`,
        title: `${fullName(e)}'s birthday`,
        date: `${year}-${pad(month)}-${pad(dayInMonth(e.dateOfBirth))}`,
        kind: 'BIRTHDAY' as const,
        startTime: null,
        endTime: null,
        location: null,
        description: null,
        holidayType: null,
        isOptional: false,
        employee: person(e),
        editable: false,
      })),
      ...anniversaries.map((e: any) => {
        const years = year - Number(String(e.joiningDate).slice(0, 4));
        return {
          id: `anniversary-${e.id}-${year}`,
          title: `${fullName(e)} · ${years} year${years === 1 ? '' : 's'} at the company`,
          date: `${year}-${pad(month)}-${pad(dayInMonth(e.joiningDate))}`,
          kind: 'ANNIVERSARY' as const,
          startTime: null,
          endTime: null,
          location: null,
          description: null,
          holidayType: null,
          isOptional: false,
          employee: person(e),
          editable: false,
        };
      }),
    ].sort((a, b) => a.date.localeCompare(b.date) || (a.startTime ?? '').localeCompare(b.startTime ?? ''));

    const countOf = (kind: CalendarEntryKind) => entries.filter((e) => e.kind === kind).length;
    return {
      year,
      month,
      entries,
      stats: {
        events: countOf('EVENT'),
        holidays: countOf('HOLIDAY'),
        birthdays: countOf('BIRTHDAY'),
        anniversaries: countOf('ANNIVERSARY'),
      },
    };
  }

  /** Holiday attributes are kept only on holidays; an event never carries them. */
  private holidayFields(kind: CalendarEventKind, holidayType?: HolidayType, isOptional?: boolean) {
    return kind === CalendarEventKind.HOLIDAY
      ? { holidayType: holidayType ?? HolidayType.COMPANY, isOptional: Boolean(isOptional) }
      : { holidayType: null, isOptional: false };
  }

  // ==========================================
  // Holidays (Attendance › Holidays)
  // ==========================================

  /** One year's holidays, in date order, with the counts the page's summary shows. */
  async listHolidays(tenantId: string, year: number) {
    const Event = await this.modelProvider.getCalendarEventModel(tenantId);
    const rows = await Event.findAll({
      where: { tenantId, kind: CalendarEventKind.HOLIDAY, date: { [Op.between]: [`${year}-01-01`, `${year}-12-31`] } },
      order: [['date', 'ASC'], ['title', 'ASC']],
    });
    const holidays = rows.map((row) => this.toEntry(row, true));
    const count = (type: HolidayType) => holidays.filter((h) => h.holidayType === type).length;
    return {
      year,
      holidays,
      stats: {
        total: holidays.length,
        mandatory: holidays.filter((h) => !h.isOptional).length,
        optional: holidays.filter((h) => h.isOptional).length,
        national: count(HolidayType.NATIONAL),
        festival: count(HolidayType.FESTIVAL),
        company: count(HolidayType.COMPANY),
      },
    };
  }

  private async assertNoDuplicateHoliday(tenantId: string, date: string, name: string, exceptId?: string) {
    const Event = await this.modelProvider.getCalendarEventModel(tenantId);
    const clash = await Event.findOne({
      where: {
        tenantId,
        kind: CalendarEventKind.HOLIDAY,
        date,
        title: { [Op.iLike]: name },
        ...(exceptId ? { id: { [Op.ne]: exceptId } } : {}),
      },
      attributes: ['id'],
    });
    if (clash) workspaceError(`"${name}" is already a holiday on that date.`, HttpStatus.CONFLICT);
  }

  createHoliday(tenantId: string, dto: CreateHolidayDto, actorUserId?: string) {
    return this.assertNoDuplicateHoliday(tenantId, dto.date, dto.name.trim()).then(() =>
      this.create(
        tenantId,
        {
          title: dto.name,
          date: dto.date,
          kind: CalendarEventKind.HOLIDAY,
          holidayType: dto.holidayType ?? HolidayType.NATIONAL,
          isOptional: dto.isOptional ?? false,
          description: dto.description,
        },
        actorUserId,
      ),
    );
  }

  private async findHoliday(tenantId: string, eventId: string) {
    const event = await this.findOwn(tenantId, eventId);
    if (event.kind !== CalendarEventKind.HOLIDAY) workspaceError('Holiday not found.', HttpStatus.NOT_FOUND);
    return event;
  }

  async updateHoliday(tenantId: string, eventId: string, dto: UpdateHolidayDto) {
    const holiday = await this.findHoliday(tenantId, eventId);
    if (dto.name !== undefined || dto.date !== undefined) {
      await this.assertNoDuplicateHoliday(tenantId, dto.date ?? holiday.date, (dto.name ?? holiday.title).trim(), eventId);
    }
    return this.update(tenantId, eventId, {
      title: dto.name,
      date: dto.date,
      holidayType: dto.holidayType,
      isOptional: dto.isOptional,
      description: dto.description,
    });
  }

  async removeHoliday(tenantId: string, eventId: string) {
    await this.findHoliday(tenantId, eventId);
    return this.remove(tenantId, eventId);
  }

  private assertTimes(startTime: string | null | undefined, endTime: string | null | undefined) {
    if (endTime && !startTime) workspaceError('Add a start time before an end time.', HttpStatus.BAD_REQUEST);
    if (startTime && endTime && endTime <= startTime) {
      workspaceError('The end time must be after the start time.', HttpStatus.BAD_REQUEST);
    }
  }

  async create(tenantId: string, dto: CreateCalendarEventDto, actorUserId?: string) {
    this.assertTimes(dto.startTime, dto.endTime);
    const Event = await this.modelProvider.getCalendarEventModel(tenantId);
    const event = await Event.create({
      tenantId,
      title: dto.title.trim(),
      date: dto.date,
      kind: dto.kind ?? CalendarEventKind.EVENT,
      startTime: dto.startTime ?? null,
      endTime: dto.endTime ?? null,
      location: dto.location?.trim() || null,
      description: dto.description?.trim() || null,
      ...this.holidayFields(dto.kind ?? CalendarEventKind.EVENT, dto.holidayType, dto.isOptional),
      createdByUserId: actorUserId ?? null,
    });
    await writeAudit(this.modelProvider, this.logger, tenantId, 'calendar_events', event.id, 'CREATE', {
      title: { from: null, to: event.title },
      date: { from: null, to: event.date },
    });
    return this.toEntry(event, true);
  }

  private async findOwn(tenantId: string, eventId: string) {
    const Event = await this.modelProvider.getCalendarEventModel(tenantId);
    const event = await Event.findOne({ where: { id: eventId, tenantId } });
    if (!event) workspaceError('Event not found.', HttpStatus.NOT_FOUND);
    return event!;
  }

  async update(tenantId: string, eventId: string, dto: UpdateCalendarEventDto) {
    const event: any = await this.findOwn(tenantId, eventId);
    const startTime = dto.startTime === undefined ? event.startTime : dto.startTime;
    const endTime = dto.endTime === undefined ? event.endTime : dto.endTime;
    this.assertTimes(startTime, endTime);

    const next: Record<string, unknown> = {
      title: dto.title?.trim(),
      date: dto.date,
      kind: dto.kind,
      startTime: dto.startTime,
      endTime: dto.endTime,
      location: dto.location === undefined ? undefined : dto.location?.trim() || null,
      description: dto.description === undefined ? undefined : dto.description?.trim() || null,
      holidayType: dto.holidayType,
      isOptional: dto.isOptional,
    };
    const kind = dto.kind ?? event.kind;
    if (kind !== CalendarEventKind.HOLIDAY) {
      // An event carries no holiday attributes.
      next.holidayType = null;
      next.isOptional = false;
    } else if (event.kind !== CalendarEventKind.HOLIDAY && next.holidayType === undefined) {
      next.holidayType = HolidayType.COMPANY;
    }
    const changes = diffFields(event.get({ plain: true }), next);
    if (Object.keys(changes).length) {
      await event.update(Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined)));
      await writeAudit(this.modelProvider, this.logger, tenantId, 'calendar_events', eventId, 'UPDATE', changes);
    }
    return this.toEntry(event, true);
  }

  async remove(tenantId: string, eventId: string) {
    const event = await this.findOwn(tenantId, eventId);
    await event.destroy();
    await writeAudit(this.modelProvider, this.logger, tenantId, 'calendar_events', eventId, 'DELETE', {
      title: { from: event.title, to: null },
      date: { from: event.date, to: null },
    });
    return { success: true };
  }
}
