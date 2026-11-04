import { Injectable, Logger } from '@nestjs/common';
import { Op } from 'sequelize';
import { EmployeeNotificationKind, EmployeeStatus, LEARNING_REMINDER_DAYS_DEFAULT, UpdateLearningSettingsDto } from '@app/common';
import { TenantModelProviderService } from './tenant-model-provider.service';
import { writePayrollAudit as writeAudit } from './payroll-access';
import { OPEN_ASSIGNMENT_STATUSES, addDays, daysOverdue } from './learning-shared';
import { diffFields, formatDay, fullName, todayIso } from './workspace-shared';

const EMPLOYED = [EmployeeStatus.ACTIVE, EmployeeStatus.ON_LEAVE];
const CHUNK = 500;

export interface LearningNoticePrefs {
  assignmentNotices: boolean;
  deadlineReminders: boolean;
  overdueReminders: boolean;
  completionNotices: boolean;
  reminderDays: number[];
}

/** What each organization chose. No row, or a null, means the default, which is on. */
export const learningNoticePrefs = async (modelProvider: TenantModelProviderService, tenantId: string): Promise<LearningNoticePrefs> => {
  const Setting = await modelProvider.getLearningSettingModel(tenantId);
  const row: any = await Setting.findOne({ where: { tenantId } });
  const days = Array.isArray(row?.reminderDays) ? (row.reminderDays as number[]).filter((day) => Number.isInteger(day) && day > 0) : [];
  return {
    assignmentNotices: row?.assignmentNotificationsEnabled !== false,
    deadlineReminders: row?.deadlineRemindersEnabled !== false,
    overdueReminders: row?.overdueRemindersEnabled !== false,
    completionNotices: row?.completionNotificationsEnabled !== false,
    reminderDays: days.length ? [...new Set(days)].sort((a, b) => b - a) : [...LEARNING_REMINDER_DAYS_DEFAULT],
  };
};

const whenLabel = (daysLeft: number) => (daysLeft <= 0 ? 'today' : daysLeft === 1 ? 'tomorrow' : `in ${daysLeft} days`);

/**
 * The lines in the Notifications tab that Learning writes: a new course, a
 * moved or withdrawn one, a deadline coming up, a course gone overdue, and a
 * mandatory course finished. All best effort: the thing that happened is
 * already saved, and a notification that cannot be stored must not undo it.
 * Each organization can switch a kind off in Learning settings.
 */
@Injectable()
export class LearningNotificationService {
  private readonly logger = new Logger(LearningNotificationService.name);

  constructor(private readonly modelProvider: TenantModelProviderService) {}

  private settingsView(prefs: LearningNoticePrefs) {
    return {
      assignmentNotificationsEnabled: prefs.assignmentNotices,
      deadlineRemindersEnabled: prefs.deadlineReminders,
      overdueRemindersEnabled: prefs.overdueReminders,
      completionNotificationsEnabled: prefs.completionNotices,
      reminderDays: prefs.reminderDays,
    };
  }

  /** What this organization chose; everything is on, with reminders 3 and 1 days before, until it says otherwise. */
  async getSettings(tenantId: string) {
    return this.settingsView(await learningNoticePrefs(this.modelProvider, tenantId));
  }

  async updateSettings(tenantId: string, dto: UpdateLearningSettingsDto) {
    const before = await learningNoticePrefs(this.modelProvider, tenantId);
    const Setting = await this.modelProvider.getLearningSettingModel(tenantId);
    const values: Record<string, unknown> = {};
    for (const key of ['assignmentNotificationsEnabled', 'deadlineRemindersEnabled', 'overdueRemindersEnabled', 'completionNotificationsEnabled'] as const) {
      if (dto[key] !== undefined) values[key] = dto[key];
    }
    if (dto.reminderDays !== undefined) values.reminderDays = [...new Set(dto.reminderDays)].sort((a, b) => b - a);

    if (Object.keys(values).length) {
      const row: any = await Setting.findOne({ where: { tenantId } });
      if (row) await row.update(values);
      else await Setting.create({ tenantId, ...values } as any);
    }
    const after = await learningNoticePrefs(this.modelProvider, tenantId);
    const changes = diffFields(this.settingsView(before) as any, this.settingsView(after) as any);
    if (Object.keys(changes).length) await writeAudit(this.modelProvider, this.logger, tenantId, 'learning_settings', tenantId, 'UPDATE', changes);
    return this.settingsView(after);
  }

  private async write(tenantId: string, rows: { employeeId: string; title: string; body: string }[]): Promise<number> {
    if (!rows.length) return 0;
    try {
      const Notification = await this.modelProvider.getEmployeeNotificationModel(tenantId);
      for (let index = 0; index < rows.length; index += CHUNK) {
        await Notification.bulkCreate(
          rows.slice(index, index + CHUNK).map((row) => ({ tenantId, kind: EmployeeNotificationKind.LEARNING, readAt: null, ...row })) as any[],
        );
      }
      return rows.length;
    } catch (error: any) {
      this.logger.warn(`Learning notifications were not saved for tenant ${tenantId}: ${error?.message ?? error}`);
      return 0;
    }
  }

  private dueText(dueDate: string | null | undefined) {
    return dueDate ? `Due ${formatDay(dueDate)}.` : 'No due date.';
  }

  /** "You have a new course", one line for each person assigned. */
  async assigned(tenantId: string, assignments: { employeeId: string; courseTitle: string; mandatory: boolean; dueDate: string | null }[]) {
    try {
      if (!assignments.length || !(await learningNoticePrefs(this.modelProvider, tenantId)).assignmentNotices) return;
      await this.write(
        tenantId,
        assignments.map((assignment) => ({
          employeeId: assignment.employeeId,
          title: `New training: ${assignment.courseTitle}`,
          body: `${assignment.mandatory ? 'Mandatory' : 'Optional'} course. ${this.dueText(assignment.dueDate)} Open My Learning to start.`,
        })),
      );
    } catch (error: any) {
      this.logger.warn(`Assignment notices skipped: ${error?.message ?? error}`);
    }
  }

  /** The due date or the mandatory flag of one assignment changed. */
  async changed(tenantId: string, assignment: { employeeId: string; courseTitle: string; mandatory: boolean; dueDate: string | null }, what: { dueDate: boolean; mandatory: boolean }) {
    try {
      if (!(what.dueDate || what.mandatory) || !(await learningNoticePrefs(this.modelProvider, tenantId)).assignmentNotices) return;
      const parts: string[] = [];
      if (what.dueDate) parts.push(assignment.dueDate ? `The due date is now ${formatDay(assignment.dueDate)}.` : 'It no longer has a due date.');
      if (what.mandatory) parts.push(assignment.mandatory ? 'It is now mandatory.' : 'It is now optional.');
      await this.write(tenantId, [{ employeeId: assignment.employeeId, title: `Training updated: ${assignment.courseTitle}`, body: parts.join(' ') }]);
    } catch (error: any) {
      this.logger.warn(`Assignment change notice skipped: ${error?.message ?? error}`);
    }
  }

  /** A course was withdrawn from someone. */
  async cancelled(tenantId: string, assignment: { employeeId: string; courseTitle: string }, reason?: string | null) {
    try {
      if (!(await learningNoticePrefs(this.modelProvider, tenantId)).assignmentNotices) return;
      await this.write(tenantId, [
        {
          employeeId: assignment.employeeId,
          title: `Training withdrawn: ${assignment.courseTitle}`,
          body: `This course is no longer assigned to you.${reason ? ` Reason: ${reason}` : ''}`,
        },
      ]);
    } catch (error: any) {
      this.logger.warn(`Cancellation notice skipped: ${error?.message ?? error}`);
    }
  }

  /** Tell the person's manager a mandatory course is finished. */
  async completed(tenantId: string, assignment: { employeeId: string; courseTitle: string; mandatory: boolean; dueDate: string | null; completedAt: Date | string }) {
    try {
      if (!assignment.mandatory || !(await learningNoticePrefs(this.modelProvider, tenantId)).completionNotices) return;
      const Employee = await this.modelProvider.getEmployeeModel(tenantId);
      const person: any = await Employee.findOne({ where: { tenantId, id: assignment.employeeId }, attributes: ['id', 'firstName', 'lastName', 'reportingManagerId'] });
      if (!person?.reportingManagerId) return;
      const finished = new Date(assignment.completedAt).toISOString().slice(0, 10);
      const late = Boolean(assignment.dueDate) && finished > assignment.dueDate!;
      await this.write(tenantId, [
        {
          employeeId: person.reportingManagerId,
          title: `${fullName(person) || 'A team member'} completed ${assignment.courseTitle}`,
          body: `The mandatory course was completed ${late ? `late, after its due date of ${formatDay(assignment.dueDate)}` : 'on time'}.`,
        },
      ]);
    } catch (error: any) {
      this.logger.warn(`Completion notice skipped: ${error?.message ?? error}`);
    }
  }

  /**
   * Deadline and overdue notices for one organization. Each is stamped on the
   * assignment so it goes out once; moving the due date clears the stamps.
   * Returns how many notifications were written.
   */
  async sendReminders(tenantId: string, today: string = todayIso()): Promise<number> {
    const prefs = await learningNoticePrefs(this.modelProvider, tenantId);
    if (!prefs.deadlineReminders && !prefs.overdueReminders) return 0;

    const Assignment = await this.modelProvider.getTrainingAssignmentModel(tenantId);
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const horizon = addDays(today, Math.max(...prefs.reminderDays));
    const open: any[] = (await Assignment.findAll({
      where: { tenantId, status: { [Op.in]: OPEN_ASSIGNMENT_STATUSES }, dueDate: { [Op.ne]: null, [Op.lte]: horizon } },
      limit: 5000,
    })) as any[];
    if (!open.length) return 0;

    const people: any[] = (await Employee.findAll({
      where: { tenantId, id: { [Op.in]: [...new Set(open.map((assignment) => assignment.employeeId))] }, status: { [Op.in]: EMPLOYED } },
      attributes: ['id', 'firstName', 'lastName', 'reportingManagerId'],
    })) as any[];
    const byId = new Map(people.map((person) => [person.id as string, person]));

    const rows: { employeeId: string; title: string; body: string }[] = [];
    const stamps: (() => Promise<unknown>)[] = [];

    for (const assignment of open) {
      const person = byId.get(assignment.employeeId);
      if (!person) continue;
      const due = assignment.dueDate as string;
      const sent: number[] = Array.isArray(assignment.remindersSent) ? assignment.remindersSent : [];

      if (due >= today) {
        if (!prefs.deadlineReminders) continue;
        const daysLeft = Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
        const reached = prefs.reminderDays.filter((threshold) => daysLeft <= threshold);
        const fresh = reached.filter((threshold) => !sent.includes(threshold));
        if (!fresh.length) continue;
        rows.push({
          employeeId: assignment.employeeId,
          title: `Training due ${whenLabel(daysLeft)}: ${assignment.courseTitle}`,
          body: `${assignment.mandatory ? 'Mandatory' : 'Optional'} course, due ${formatDay(due)}. Open My Learning to finish it.`,
        });
        stamps.push(() => assignment.update({ remindersSent: [...new Set([...sent, ...reached])] }));
      } else {
        if (!prefs.overdueReminders || assignment.overdueNoticeSent === true) continue;
        const days = daysOverdue(due, today);
        rows.push({
          employeeId: assignment.employeeId,
          title: `Training overdue: ${assignment.courseTitle}`,
          body: `This ${assignment.mandatory ? 'mandatory ' : ''}course was due ${formatDay(due)} (${days} day${days === 1 ? '' : 's'} ago). Please finish it as soon as you can.`,
        });
        const managerId = person.reportingManagerId ?? assignment.reportingManagerId;
        if (assignment.mandatory === true && managerId) {
          rows.push({
            employeeId: managerId,
            title: `Overdue mandatory training: ${fullName(person) || 'A team member'}`,
            body: `${assignment.courseTitle} was due ${formatDay(due)} and is not finished.`,
          });
        }
        stamps.push(() => assignment.update({ overdueNoticeSent: true }));
      }
    }

    const written = await this.write(tenantId, rows);
    // Stamp only after the notices are saved, so a failure is retried on the next run.
    if (written > 0) await Promise.all(stamps.map((stamp) => stamp()));
    return written;
  }
}
